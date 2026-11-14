---
name: user-sense
description: Maintain and use cross-workspace user memory from normal conversations: explicitly disclosed background, lasting goals and stable preferences, plus high-confidence inferences supported by multiple conversations. Routine conversation capture uses append_global_memory and does not require a device scan. Also supports an optional local environment scan after explaining its scope and obtaining consent; never scan without consent. Trigger when user information is relevant, preferences are corrected, or the user asks to understand them better.
group: profer
version: "1.1.0"
---

# UserSense (User Sense)

Profer's default Skill, distributed with the application and available to all users out of the box. Responsibility: **build, maintain, and consume a local user profile**.

A profile is a set of user-level information stored in the global memory directory (`global-memory/` under the active Profer configuration root). Keep user-confirmed facts separate from inferred conclusions: `user-profile.md` is for facts the user stated or explicitly confirmed; `user-sense.md` is for clearly labelled inferences from repeated conversation signals or consented local scans. Do not write inferred conclusions into `user-profile.md`, and do not treat an inference as confirmed fact.

## Hard privacy constraints (must come before everything else)

1. **Local storage**: conclusions are stored as local Markdown. Do not upload files or call a separate remote analysis service; ordinary conversation context may be sent to the user's configured model, so do not promise that model analysis never leaves the device.
2. **Store conclusions, not source data**: the profile records only inferred conclusions and **never records** specific file paths, filenames, or site URLs.
3. **Consent before scanning**: before building a profile for the first time, explain that the following scopes will be scanned (system information / installed applications / file-type statistics / recently opened files / browser bookmark categories), explain that no file contents are collected and nothing leaves the local machine, and obtain consent before running the scan.
4. **User control**: use the existing “我的画像” interface to view and edit memory. Respect source exclusions or deletion instructions; do not claim that per-source switches or one-click controls exist without checking the current UI.
5. When the user explicitly declines, skip profile construction and proceed directly to the session without repeatedly persuading them.

## Conversation memory (default; no device scan)

Check for useful user memory during ordinary conversation, without waiting for an explicit “remember this”. Use the actual `append_global_memory` tool only when available and outside plan mode; never bypass a disabled memory capability with file tools. An empty profile is not a reason to scan the device.

- Explicitly disclosed background and lasting goals → `profile`; stable preferences → `preferences`.
- High-confidence, consistent signals from at least two distinct conversations → `inference`. Supply `confidence: high` and `evidence` containing real session IDs, dates and observations. Do not invent unseen past conversations or store single-choice guesses. No verified evidence means no inferred memory.
- Search/read the target first, avoid duplicates and contradictions, and keep one concise conclusion per entry. This append-only tool cannot correct existing statements; ask about a conflicting fact rather than appending both.
- Never automatically store secrets, health/financial/political or other sensitive information, third-party personal information, temporary state, or project-only facts. Respect “do not remember” and deletion; do not reconstruct removed information.
- After a successful write, briefly say what was remembered and point to “我的画像” for viewing/editing. No candidate means no write and no noisy “nothing remembered” notice.
- Conversation capture is separate from the optional scan below. It never authorizes reading unrelated files or collecting local source data.

## Trigger and decision flow

For an explicitly requested environment scan, make decisions in the following order:

1. Read `global-memory/user-profile.md` and, if relevant, `global-memory/user-sense.md`; distinguish confirmed facts from inferences.
2. Profile missing → explain the scan scope to the user and obtain consent; after consent, run "initial construction"
3. Profile exists but `updated` is more than 30 days old → propose an incremental update (not mandatory)
4. Profile exists and is fresh → consume it directly (use profile information in the conversation without scanning again)

## Initial profile construction flow

Run the following layers in L0→L4 order. Each layer performs statistics only and writes conclusions only. The commands below are reference commands for Windows:

### L0 System and schedule
```powershell
# System information (OS/architecture/language/time zone)
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSLanguage, MUILanguages
Get-TimeZone | Select-Object Id
# Schedule pattern: count the hour-of-day distribution of creation times for local Agent session files (~/.profer/agent-sessions/*.jsonl)
Get-ChildItem "$env:USERPROFILE\.profer\agent-sessions" -Filter *.jsonl -ErrorAction SilentlyContinue |
  ForEach-Object { (Get-Date $_.CreationTime).Hour } | Group-Object | Sort-Object Count -Descending | Select-Object -First 3 Name, Count
```
Example conclusion: `Activity is concentrated between 1–5 AM (source: system/session history, confidence: medium)`.

### L1 Installed applications
```powershell
# Registry Uninstall keys (HKLM 64/32-bit + HKCU), deduplicated and counted by DisplayName
Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*, HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*, HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue |
  Where-Object DisplayName | Select-Object -ExpandProperty DisplayName | Sort-Object -Unique
```
Example conclusion: `VS Code/JetBrains and other development tools are installed; infer a developer profile (source: applications, confidence: high)`. Classification dimensions: development / office / design / entertainment / games / communications.

### L2 File-type statistics
```powershell
# Count extension distribution in common user directories (count only; do not list filenames)
Get-ChildItem "$env:USERPROFILE\Downloads", "$env:USERPROFILE\Documents", "$env:USERPROFILE\Desktop" -File -Recurse -Depth 1 -ErrorAction SilentlyContinue |
  Group-Object Extension | Sort-Object Count -Descending | Select-Object -First 8 Name, Count
```
Example conclusion: `Recent downloads are primarily PDFs (30+); infer paper/document reading activity (source: files, confidence: medium)`. **Never record any filename or path**.

### L3 Recently opened files
```powershell
# Windows Recent directory (.lnk shortcuts); count by extension only and do not resolve target paths
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Recent" -Filter *.lnk -ErrorAction SilentlyContinue |
  ForEach-Object { $_.BaseName -replace '.*\.', '.' } | Group-Object | Sort-Object Count -Descending | Select-Object -First 6 Name, Count
```
Example conclusion: `Recently handled .xlsx files frequently; infer an operations/data context (source: recent files, confidence: medium)`.

### L4 Browser bookmark categories (enabled by default)
```powershell
# Chrome/Edge bookmark JSON; count and classify only top-level folder children and names; do not output site URLs
$paths = @("$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Bookmarks", "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Bookmarks")
foreach ($p in $paths) {
  if (Test-Path $p) {
    $bookmarks = Get-Content $p -Raw | ConvertFrom-Json
    $bookmarks.roots.bookmark_bar.children | Where-Object type -eq 'folder' | Select-Object -ExpandProperty name
  }
}
```
Example conclusion: `Bookmark categories are primarily video/games/learning; infer a stable interest in entertainment content (source: bookmarks, confidence: medium)`. **Write category proportions only, never specific sites**.

## Profile file format requirements

Update `global-memory/user-sense.md` as follows; do not edit `user-profile.md`, which contains user-confirmed facts:

1. Write automatic conclusions only in this inference file; never overwrite user-confirmed facts in `user-profile.md`.
2. Format each conclusion as: `- **<conclusion>** (source: <system/applications/files/recent files/bookmarks>, confidence: <high/medium/low>, date: YYYY-MM-DD)`
3. Update frontmatter `updated: YYYY-MM-DD`
4. Do not write the same conclusion again when it already exists and is not stale (<30 days)
5. If the user disabled a source in a Capability Center, never scan or write that source again

## How to consume the profile

- **Personalize the conversation**: cite profile information when relevant to the task (for example, recommend a close-reading workflow to a research user or default to a code-standard context for a developer), but **do not proactively output profile contents** unless the user asks
- **Connect to proactive service**: profile signals are inputs to Proactive Center (late-night activity → suggest a work mode, a pile of PDFs → remind the user to organize or read closely, frequent project switching → recommend quick switching); when a matching signal is found, you may make a suggestion to the user
- **Profile staleness/change**: when the user's behavior changes clearly (for example, many new design tools are added), propose an incremental update rather than scanning without permission

- User-confirmed facts belong in `user-profile.md` and may be added or corrected only when the user explicitly provides or confirms them.
- Inferred conclusions belong in `user-sense.md`; conversation inferences require cross-session evidence as above, while a new device scan requires separate scope explanation and consent. Neither is user confirmation.
- Do not store credentials, secrets, or specific server IP/hostnames unless the user explicitly asks to store them in the appropriate global memory file.
- Record source and last-checked date for information that can change.
- Do not write or update user-level profile information in a workspace `memory-archive`; that archive is reserved for project/workspace facts.
- Do not upload or perform remote analysis
- When the user declines or disables collection, respect the choice and do not ask repeatedly
- This Skill defines the workflow. The main-process ProfileScanner (faster and more comprehensive native scanning) is a later enhancement; once implemented, it automatically takes over collection, while this Skill's consumption and maintenance requirements remain unchanged
