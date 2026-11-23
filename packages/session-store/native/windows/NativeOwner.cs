using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

internal static class NativeOwner {
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct UnicodeString {
        public ushort Length, MaximumLength;
        public IntPtr Buffer;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ObjectAttributes {
        public int Length;
        public IntPtr RootDirectory, ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor, SecurityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoStatusBlock {
        public IntPtr Status;
        public UIntPtr Information;
    }
    [DllImport("ntdll.dll")]
    static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes,
        out IoStatusBlock status, IntPtr allocationSize, uint fileAttributes, uint shareAccess,
        uint disposition, uint options, IntPtr extendedAttributes, uint extendedAttributesSize);
    [DllImport("ntdll.dll")]
    static extern int NtSetInformationFile(SafeFileHandle handle, out IoStatusBlock status, IntPtr information, uint length, int kind);
    [DllImport("ntdll.dll")]
    static extern int RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(SafeFileHandle handle, uint type, uint requested,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetVolumeNameForVolumeMountPointW(string mount, StringBuilder volume, int capacity);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetVolumeInformationByHandleW(SafeFileHandle volume, IntPtr name, uint nameSize,
        out uint serial, out uint componentLength, out uint flags, StringBuilder filesystem, uint filesystemSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass, IntPtr buffer, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool MoveFileExW(string source, string dest, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateHardLinkW(string newName, string existingName, IntPtr security);

    // 仅卷 GUID 入口使用绝对打开；后续全部相对固定父句柄遍历。
    static SafeFileHandle Open(string path, bool directory, out FileInfo info) {
        const uint readControl = 0x20000, readAttributes = 0x80, genericRead = 0x80000000, listDirectory = 1;
        const uint openExisting = 3, backupSemantics = 0x02000000, openReparse = 0x00200000;
        var handle = CreateFileW(path, readControl | readAttributes | (directory ? listDirectory : genericRead),
            directory ? 3u : 1u, IntPtr.Zero, openExisting, backupSemantics | openReparse, IntPtr.Zero);
        try {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            info = CheckType(handle, directory);
            return handle;
        } catch { handle.Dispose(); throw; }
    }

    static FileInfo CheckType(SafeFileHandle handle, bool directory) {
        const uint directoryAttribute = 0x10, reparseAttribute = 0x400;
        FileInfo info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if ((info.Attributes & reparseAttribute) != 0) throw new InvalidDataException("reparse");
        if (((info.Attributes & directoryAttribute) != 0) != directory) throw new InvalidDataException("type");
        if (!directory && info.Links != 1) throw new InvalidDataException("links");
        return info;
    }

    static void CheckChildName(string name) {
        if (String.IsNullOrEmpty(name) || name == "." || name == ".." || name.EndsWith(".") || name.EndsWith(" ") || name.IndexOfAny(new[] {'\\', '/', ':', '\0'}) >= 0)
            throw new InvalidDataException("not a child name");
    }

    internal static SafeFileHandle OpenChild(SafeFileHandle parent, string name, bool directory, byte[] newSecurity = null, bool writerLock = false, bool deleting = false) {
        CheckChildName(name);
        const uint objCaseInsensitive = 0x40, objDontReparse = 0x1000;
        const uint fileRead = 0x80120080, directoryRead = 0x120081, fileStage = 0x40130080;
        const uint openExisting = 1, createNew = 2, syncIo = 0x20, directoryFile = 1, nonDirectory = 0x40;
        IntPtr buffer = Marshal.StringToHGlobalUni(name);
        IntPtr unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
        IntPtr security = IntPtr.Zero;
        bool pinned = false;
        try {
            if (newSecurity != null) {
                security = Marshal.AllocHGlobal(newSecurity.Length);
                Marshal.Copy(newSecurity, 0, security, newSecurity.Length);
            }
            parent.DangerousAddRef(ref pinned);
            var length = checked((ushort)(name.Length * 2));
            Marshal.StructureToPtr(new UnicodeString { Buffer = buffer, Length = length, MaximumLength = length }, unicode, false);
            var attributes = new ObjectAttributes { Length = Marshal.SizeOf(typeof(ObjectAttributes)),
                RootDirectory = parent.DangerousGetHandle(), ObjectName = unicode, Attributes = objCaseInsensitive | objDontReparse,
                SecurityDescriptor = security };
            SafeFileHandle handle;
            IoStatusBlock ioStatus;
            bool create = newSecurity != null;
            int status = NtCreateFile(out handle, directory ? directoryRead | (deleting ? 0x10000u : 0u) : writerLock ? 0x12019fu : create ? fileStage | 0x80000000u : deleting ? fileRead | 0x10000u : fileRead, ref attributes, out ioStatus,
                IntPtr.Zero, 0, directory ? (name == ".core-execution-lock" ? 7u : 3u) : writerLock ? 1u : create ? 0u : 1u, writerLock ? 3u : create ? createNew : openExisting,
                syncIo | (directory ? directoryFile : nonDirectory), IntPtr.Zero, 0);
            if (status >= 0) return handle;
            if (handle != null) handle.Dispose();
            if (status == unchecked((int)0xc000050b)) throw new InvalidDataException("reparse");
            throw new Win32Exception(RtlNtStatusToDosError(status));
        } finally {
            if (security != IntPtr.Zero) Marshal.FreeHGlobal(security);
            if (pinned) parent.DangerousRelease();
            Marshal.FreeHGlobal(unicode);
            Marshal.FreeHGlobal(buffer);
        }
    }

    internal static string ReadChild(SafeFileHandle parent, string name, SecurityIdentifier sid) {
        using (var handle = OpenChild(parent, name, false)) return ReadOwner(handle, CheckType(handle, false), sid);
    }

    static RawSecurityDescriptor Security(SafeFileHandle handle) {
        IntPtr descriptor;
        uint result = GetSecurityInfo(handle, 1, 5, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor);
        if (result != 0) throw new Win32Exception((int)result);
        try {
            var data = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, data, 0, data.Length);
            return new RawSecurityDescriptor(data, 0);
        } finally { LocalFree(descriptor); }
    }

    static bool TrustedDirectoryPrincipal(SecurityIdentifier other, SecurityIdentifier user) {
        return other != null && (other.Equals(user) || other.IsWellKnown(WellKnownSidType.LocalSystemSid) ||
            other.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid) ||
            other.Value == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
    }

    internal static void CheckDirectory(SafeFileHandle handle, SecurityIdentifier sid, bool end) {
        CheckType(handle, true);
        var sd = Security(handle);
        if (sd.DiscretionaryAcl == null || !TrustedDirectoryPrincipal(sd.Owner, sid) || (end && !sid.Equals(sd.Owner)))
            throw new InvalidDataException("directory acl");
        // Strict and conservative: discard no deny ACE except a recognized standard deny;
        // reject any untrusted write/delete/reparse/ACL grant regardless of deny order.
        const uint mutable = 0x500D0152;
        foreach (GenericAce entry in sd.DiscretionaryAcl) {
            var ace = entry as CommonAce;
            if (ace == null || ace.IsCallback || (ace.AceQualifier != AceQualifier.AccessAllowed && ace.AceQualifier != AceQualifier.AccessDenied))
                throw new InvalidDataException("directory acl");
            if (ace.AceQualifier == AceQualifier.AccessDenied || TrustedDirectoryPrincipal(ace.SecurityIdentifier, sid)) continue;
            // An inherit-only grant is harmless for a traversed name but not for new files under the data root.
            if (end || ((ace.AceFlags & AceFlags.InheritOnly) == 0 && ((uint)ace.AccessMask & mutable) != 0))
                throw new InvalidDataException("directory acl");
        }
    }

    internal sealed class Root : IDisposable {
        internal readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
        internal SafeFileHandle Handle { get { return Handles[Handles.Count - 1]; } }
        public void Dispose() { for (int i = Handles.Count - 1; i >= 0; --i) Handles[i].Dispose(); }
    }
    internal static Root PinRoot(string root, SecurityIdentifier sid, bool create) {
        string drive = Path.GetPathRoot(root);
        if (drive == null || drive.Length != 3 || drive[1] != ':' || drive[2] != '\\' || GetDriveTypeW(drive) != 3 ||
            !String.Equals(root, Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase) || root.Length <= 3)
            throw new InvalidDataException("root");
        var volume = new StringBuilder(64);
        if (!GetVolumeNameForVolumeMountPointW(drive, volume, volume.Capacity)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var result = new Root();
        try {
            FileInfo info;
            result.Handles.Add(Open(volume.ToString(), true, out info));
            var fs = new StringBuilder(32); uint serial, size, flags;
            if (!GetVolumeInformationByHandleW(result.Handle, IntPtr.Zero, 0, out serial, out size, out flags, fs, (uint)fs.Capacity)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (fs.ToString() != "NTFS") throw new InvalidDataException("filesystem");
            CheckDirectory(result.Handle, sid, false);
            foreach (string part in root.Substring(3).Split('\\')) {
                SafeFileHandle next;
                try { next = OpenChild(result.Handle, part, true); }
                catch (Win32Exception e) {
                    if (!create || e.NativeErrorCode != 2) throw;
                    try { next = OpenChild(result.Handle, part, true, PrivateSecurity(sid, true)); }
                    catch (Win32Exception race) { if (race.NativeErrorCode != 183) throw; next = OpenChild(result.Handle, part, true); }
                }
                result.Handles.Add(next); CheckDirectory(next, sid, false);
            }
            CheckDirectory(result.Handle, sid, true);
            return result;
        } catch { result.Dispose(); throw; }
    }
    // The source is identified by its open handle and the destination is a simple name in that same directory.
    internal static void RenameWithinDirectory(SafeFileHandle file, string name, bool replace = true) {
        CheckChildName(name);
        byte[] text = Encoding.Unicode.GetBytes(name + "\0");
        int rootOffset = IntPtr.Size;
        int lengthOffset = rootOffset + IntPtr.Size;
        int nameOffset = lengthOffset + 4;
        byte[] bytes = new byte[nameOffset + text.Length + 4];
        Array.Copy(text, 0, bytes, nameOffset, text.Length);
        IntPtr buffer = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, buffer, bytes.Length);
            Marshal.WriteByte(buffer, 0, replace ? (byte)1 : (byte)0);
            Marshal.WriteInt32(buffer, lengthOffset, text.Length - 2);
            IoStatusBlock status;
            int result = NtSetInformationFile(file, out status, buffer, (uint)bytes.Length, 10);
            if (result < 0) throw new Win32Exception(RtlNtStatusToDosError(result));
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    internal static byte[] PrivateSecurity(SecurityIdentifier sid, bool directory) {
        var sd = new RawSecurityDescriptor("O:" + sid.Value + "D:P(A;" + (directory ? "OICI" : "") + ";FA;;;" + sid.Value + ")");
        var security = new byte[sd.BinaryLength];
        sd.GetBinaryForm(security, 0);
        return security;
    }

    static void CheckPrivateFile(SafeFileHandle handle, FileInfo info, SecurityIdentifier sid) {
        if (info.SizeHigh != 0 || info.SizeLow > 4096) throw new InvalidDataException("size");
        var sd = Security(handle);
        var acl = sd.DiscretionaryAcl;
        if (!sid.Equals(sd.Owner) || acl == null || acl.Count != 1) throw new InvalidDataException("acl");
        var ace = acl[0] as CommonAce;
        if (ace == null || ace.IsCallback || ace.AceQualifier != AceQualifier.AccessAllowed || !sid.Equals(ace.SecurityIdentifier) || ((uint)ace.AccessMask & 0x1f01ffu) != 0x1f01ffu)
            throw new InvalidDataException("acl");
    }

    static string ReadOwner(SafeFileHandle handle, FileInfo info, SecurityIdentifier sid) {
        CheckPrivateFile(handle, info, sid);
        using (var stream = new FileStream(handle, FileAccess.Read))
        using (var reader = new StreamReader(stream, new UTF8Encoding(false, true), false, 4096)) return reader.ReadToEnd();
    }

    internal static void Delete(SafeFileHandle handle) {
        IntPtr memory = Marshal.AllocHGlobal(1);
        try { Marshal.WriteByte(memory, 1); if (!SetFileInformationByHandle(handle, 4, memory, 1)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        finally { Marshal.FreeHGlobal(memory); }
    }
    internal static SafeFileHandle PrivateFile(SafeFileHandle dir, string name, SecurityIdentifier sid, bool create, bool mutex) {
        var handle = OpenChild(dir, name, false, create ? PrivateSecurity(sid, false) : null, mutex);
        try { CheckPrivateFile(handle, CheckType(handle, false), sid); return handle; } catch { handle.Dispose(); throw; }
    }
    internal static string Read(SafeFileHandle dir, string name, SecurityIdentifier sid) { return ReadChild(dir, name, sid); }
    internal static void Remove(SafeFileHandle dir, string name, SecurityIdentifier sid) {
        // DELETE permission and identity validation belong to the very same handle.
        using (var file = OpenDeleteChild(dir, name)) { CheckPrivateFile(file, CheckType(file, false), sid); Delete(file); }
    }
    internal static void CreateText(SafeFileHandle dir, string name, SecurityIdentifier sid, string text) {
        byte[] bytes = new UTF8Encoding(false, true).GetBytes(text);
        if (bytes.Length > 4096) throw new InvalidDataException("size");
        using (var file = PrivateFile(dir, name, sid, true, false))
        using (var stream = new FileStream(file, FileAccess.Write)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
    }
    internal static void Write(SafeFileHandle dir, string name, SecurityIdentifier sid, string text) {
        var bytes = new UTF8Encoding(false, true).GetBytes(text);
        if (bytes.Length > 4096) throw new InvalidDataException("size");
        try { using (var existing = PrivateFile(dir, name, sid, false, false)) {} }
        catch (Win32Exception e) { if (e.NativeErrorCode != 2) throw; }
        using (var file = PrivateFile(dir, ".core-owner-" + Guid.NewGuid().ToString("N"), sid, true, false))
        using (var stream = new FileStream(file, FileAccess.Write)) {
            try { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); RenameWithinDirectory(file, name); }
            catch { Delete(file); throw; }
        }
    }
    static SafeFileHandle OpenDeleteChild(SafeFileHandle parent, string name) { return OpenChild(parent, name, false, null, false, true); }
}
