// Windows helper：仅控制标准流承载协议，绝不输出请求或本地路径。
using System;
using System.IO;
using System.ComponentModel;
using System.Collections.Generic;
using System.Security.Principal;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class Program {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 16 };
    static readonly SecurityIdentifier Sid = WindowsIdentity.GetCurrent().User;
    static NativeOwner.Root Held;
    static SafeFileHandle Mutex, Legacy, ProcessHandle, OwnerPin;
    static string Root;
    static int Pid;
    static readonly object Gate = new object();
    [DllImport("kernel32.dll", SetLastError = true)] static extern SafeFileHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);
    sealed class Failure : Exception { internal string Code; internal Failure(string code) { Code = code; } }
    static int Number(object value) {
        if (!(value is int) || (int)value < 1) throw new Failure("PROTOCOL");
        return (int)value;
    }
    static SafeFileHandle Alive(int pid) {
        var process = OpenProcess(0x100000, false, pid);
        if (process.IsInvalid) { int error = Marshal.GetLastWin32Error(); process.Dispose(); throw new Failure(error == 87 ? "ESRCH" : "UNSAFE"); }
        if (WaitForSingleObject(process, 0) != 258) { process.Dispose(); throw new Failure("ESRCH"); }
        return process;
    }
    static int Owner(SafeFileHandle directory) { return ParsePid(NativeOwner.Read(directory, "owner", Sid)); }
    static int ParsePid(string text) {
        int pid;
        if (!Int32.TryParse(text, out pid) || pid < 1 || text != pid.ToString()) throw new Failure("UNSAFE");
        return pid;
    }
    static Dictionary<string, object> Endpoint(object candidate) {
        var endpoint = candidate as Dictionary<string, object>;
        if (endpoint == null || !endpoint.ContainsKey("version") || !Object.Equals(endpoint["version"], 1) ||
            !endpoint.ContainsKey("pid") || !endpoint.ContainsKey("port") || !endpoint.ContainsKey("token") || !endpoint.ContainsKey("coreId")) throw new Failure("PROTOCOL");
        Number(endpoint["pid"]);
        if (Number(endpoint["port"]) > 65535 || !(endpoint["token"] is string) || String.IsNullOrEmpty((string)endpoint["token"]) ||
            !(endpoint["coreId"] is string) || String.IsNullOrEmpty((string)endpoint["coreId"])) throw new Failure("PROTOCOL");
        if (System.Text.Encoding.UTF8.GetByteCount(Json.Serialize(endpoint)) > 4096) throw new Failure("PROTOCOL");
        return endpoint;
    }
    static void MissingRemove(SafeFileHandle directory, string name) {
        try { NativeOwner.Remove(directory, name, Sid); } catch (Win32Exception e) { if (e.NativeErrorCode != 2) throw; }
    }
    static void Cleanup() {
        if (Held == null) return;
        Exception failure = null;
        try { MissingRemove(Held.Handle, ".core-owner.json"); } catch (Exception e) { failure = e; }
        try {
            if (OwnerPin != null) { OwnerPin.Dispose(); OwnerPin = null; }
            if (Legacy != null) {
                try { NativeOwner.RenameWithinDirectory(Legacy, ".core-released-" + Guid.NewGuid().ToString("N"), false); }
                catch (Exception e) { if (failure == null) failure = e; }
                try { MissingRemove(Legacy, "owner"); } catch (Exception e) { if (failure == null) failure = e; }
                try { NativeOwner.Delete(Legacy); } catch (Exception e) { if (failure == null) failure = e; }
            }
        } finally {
            if (OwnerPin != null) OwnerPin.Dispose(); OwnerPin = null;
            if (Legacy != null) Legacy.Dispose(); Legacy = null;
            if (Mutex != null) Mutex.Dispose(); Mutex = null;
            if (ProcessHandle != null) ProcessHandle.Dispose(); ProcessHandle = null;
            var root = Held; Held = null; Root = null; Pid = 0;
            root.Dispose();
        }
        if (failure != null) throw failure;
    }
    static void Hold(string root, int pid) {
        if (Held != null) throw new Failure("PROTOCOL");
        var process = Alive(pid);
        NativeOwner.Root pinned = null;
        SafeFileHandle mutex = null, legacy = null;
        bool ownLegacy = false;
        try {
            pinned = NativeOwner.PinRoot(root, Sid, true);
            mutex = NativeOwner.PrivateFile(pinned.Handle, ".core-owner-native-lock", Sid, true, true);
            try {
                legacy = NativeOwner.OpenChild(pinned.Handle, ".core-lock-" + Guid.NewGuid().ToString("N"), true, NativeOwner.PrivateSecurity(Sid, true), false, true);
                NativeOwner.CreateText(legacy, "owner", Sid, pid.ToString());
                try { NativeOwner.RenameWithinDirectory(legacy, ".core-execution-lock", false); ownLegacy = true; }
                catch { MissingRemove(legacy, "owner"); NativeOwner.Delete(legacy); legacy.Dispose(); legacy = null; throw; }
            }
            catch (Win32Exception e) {
                if (e.NativeErrorCode != 183) throw;
                legacy = NativeOwner.OpenChild(pinned.Handle, ".core-execution-lock", true, null, false, true);
                NativeOwner.CheckDirectory(legacy, Sid, true);
                // 恢复标记只接受本 helper 创建的受保护私有文件；未知/旧初始化状态不抢占。
                bool recovering = false;
                try {
                    int recoveryPid = ParsePid(NativeOwner.Read(legacy, "recovering", Sid));
                    try { using (var active = Alive(recoveryPid)) {} throw new Failure("BUSY"); }
                    catch (Failure failure) { if (failure.Code != "ESRCH") throw; }
                    recovering = true;
                } catch (Win32Exception missing) { if (missing.NativeErrorCode != 2) throw; }
                int previous = 0;
                try { previous = Owner(legacy); }
                catch (Win32Exception missing) { if (missing.NativeErrorCode != 2 || !recovering) throw new Failure("UNSAFE"); }
                if (previous != 0) {
                    try { using (var active = Alive(previous)) {} throw new Failure("BUSY"); }
                    catch (Failure failure) { if (failure.Code != "ESRCH") throw; }
                }
                if (recovering) MissingRemove(legacy, "recovering");
                NativeOwner.CreateText(legacy, "recovering", Sid, pid.ToString());
                if (previous != 0 && Owner(legacy) != previous) throw new Failure("BUSY");
                MissingRemove(legacy, "owner");
                NativeOwner.CreateText(legacy, "owner", Sid, pid.ToString());
                MissingRemove(legacy, "recovering");
                ownLegacy = true;
            }
            if (ownLegacy) {
                try { NativeOwner.Read(legacy, "owner", Sid); }
                catch (Win32Exception e) { if (e.NativeErrorCode != 2) throw; NativeOwner.Write(legacy, "owner", Sid, pid.ToString()); }
            }
            // 保留 owner 的禁止写/删除共享读句柄：旧 writer 即使先读到过期 PID，
            // 也不能在本 helper 宣告 ready 后删除刚发布的业务 owner。
            OwnerPin = NativeOwner.PrivateFile(legacy, "owner", Sid, false, false);
            if (Owner(legacy) != pid) throw new Failure("BUSY");
            if (WaitForSingleObject(process, 0) != 258) throw new Failure("ESRCH");
            Held = pinned; Mutex = mutex; Legacy = legacy; ProcessHandle = process; Root = root; Pid = pid;
            pinned = null; mutex = null; legacy = null; process = null;
            var timer = new Thread(() => {
                while (true) {
                    Thread.Sleep(50);
                    lock (Gate) {
                        if (Held == null) return;
                        if (WaitForSingleObject(ProcessHandle, 0) == 258) continue;
                        try { Cleanup(); } catch {} Environment.Exit(0);
                    }
                }
            }); timer.IsBackground = true; timer.Start();
        } finally {
            if (Held == null && OwnerPin != null) { OwnerPin.Dispose(); OwnerPin = null; }
            if (legacy != null) legacy.Dispose(); if (mutex != null) mutex.Dispose();
            if (pinned != null) pinned.Dispose(); if (process != null) process.Dispose();
        }
    }
    static object Request(Dictionary<string, object> request, out bool exit) {
        exit = false;
        if (!request.ContainsKey("version") || !Object.Equals(request["version"], 1) || !request.ContainsKey("op") ||
            !(request["op"] is string) || !request.ContainsKey("root") || !(request["root"] is string)) throw new Failure("PROTOCOL");
        string op = (string)request["op"], root = (string)request["root"];
        if (op == "hold") { Hold(root, Number(request.ContainsKey("pid") ? request["pid"] : null)); return null; }
        if (op == "read" || op == "released") {
            using (var pinned = NativeOwner.PinRoot(root, Sid, false)) {
                if (op == "released") {
                    int expected = Number(request.ContainsKey("pid") ? request["pid"] : null);
                    SafeFileHandle legacy;
                    try { legacy = NativeOwner.OpenChild(pinned.Handle, ".core-execution-lock", true); }
                    catch (Win32Exception e) { if (e.NativeErrorCode != 2) throw; return true; }
                    using (legacy) {
                        NativeOwner.CheckDirectory(legacy, Sid, true);
                        try { return Owner(legacy) != expected; }
                        catch (Win32Exception e) { if (e.NativeErrorCode != 2) throw; throw new Failure("UNSAFE"); }
                    }
                }
                var endpoint = Endpoint(Json.DeserializeObject(NativeOwner.Read(pinned.Handle, ".core-owner.json", Sid)));
                int pid = Number(endpoint["pid"]);
                SafeFileHandle ownerDirectory;
                try { ownerDirectory = NativeOwner.OpenChild(pinned.Handle, ".core-execution-lock", true); }
                catch (Win32Exception e) { if (e.NativeErrorCode != 2) throw; throw new Failure("UNSAFE"); }
                using (var legacy = ownerDirectory) {
                    NativeOwner.CheckDirectory(legacy, Sid, true); try { if (Owner(legacy) != pid) throw new Failure("UNSAFE"); }
                    catch (Win32Exception e) { if (e.NativeErrorCode != 2) throw; throw new Failure("UNSAFE"); }
                    using (var active = Alive(pid)) {} return endpoint;
                }
            }
        }
        if (Held == null || !String.Equals(root, Root, StringComparison.OrdinalIgnoreCase)) throw new Failure("PROTOCOL");
        if (op == "publish") {
            var endpoint = Endpoint(request.ContainsKey("endpoint") ? request["endpoint"] : null);
            if (Number(endpoint["pid"]) != Pid || Owner(Legacy) != Pid) throw new Failure("UNSAFE");
            NativeOwner.Write(Held.Handle, ".core-owner.json", Sid, Json.Serialize(endpoint)); return null;
        }
        if (op == "remove") { MissingRemove(Held.Handle, ".core-owner.json"); return null; }
        if (op == "release") { Cleanup(); exit = true; return null; }
        throw new Failure("PROTOCOL");
    }
    static void Reply(bool ok, object data, string code) {
        var response = new Dictionary<string, object> { {"version", 1}, {"ok", ok} };
        if (ok && data != null) response["data"] = data;
        if (!ok) { response["code"] = code; response["message"] = "Core owner request rejected"; }
        Console.Out.WriteLine(Json.Serialize(response)); Console.Out.Flush();
    }
    static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--protocol-version") { Console.WriteLine("profer-core-owner/1"); return 0; }
        if (args.Length != 0) return 2;
        Console.InputEncoding = new System.Text.UTF8Encoding(false, true);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        try {
            while (true) {
                var line = new System.Text.StringBuilder(); int character;
                while ((character = Console.In.Read()) != -1 && character != '\n') { if (line.Length >= 16384) { Reply(false, null, "PROTOCOL"); return 2; } line.Append((char)character); }
                if (character == -1 && line.Length == 0) return 0;
                lock (Gate) {
                    try {
                        bool exit;
                        if (System.Text.Encoding.UTF8.GetByteCount(line.ToString()) > 16384) throw new Failure("PROTOCOL");
                        var request = Json.DeserializeObject(line.ToString()) as Dictionary<string, object>;
                        if (request == null) throw new Failure("PROTOCOL");
                        object data = Request(request, out exit); Reply(true, data, null); if (exit) return 0;
                    } catch (Failure e) { Reply(false, null, e.Code); }
                    catch (Win32Exception e) { Reply(false, null, e.NativeErrorCode == 2 || e.NativeErrorCode == 3 ? "ENOENT" : e.NativeErrorCode == 32 || e.NativeErrorCode == 183 ? "BUSY" : "UNSAFE"); }
                    catch (InvalidDataException) { Reply(false, null, "UNSAFE"); }
                    catch (ArgumentException) { Reply(false, null, "PROTOCOL"); }
                    catch { Reply(false, null, "IO"); }
                }
            }
        } finally { lock (Gate) { try { Cleanup(); } catch {} } }
    }
}
