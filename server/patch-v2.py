"""Patch admin UI: replace renderChannels with new version that uses models instead of apiKey/URL.
Uses external file for the new function body to avoid quoting issues."""
import sys

import os
os.chdir("D:/profer/Proma-main")
path = "server/src/admin-ui/index.html"

with open(path, "r", encoding="utf-8") as f:
    content = f.read()

# Read new function from external file
with open("server/patch-channels-func-v2.js", "r", encoding="utf-8") as f:
    new_func = f.read()

# Find renderChannels function boundaries
start = content.find("function renderChannels(c){")
assert start > 0, "renderChannels not found!"
# Find the closing brace - use the fact that next function starts with "// ---- Credits"
end_marker = "// ---- Credits ----"
end = content.find(end_marker, start)
assert end > 0, "Credits marker not found!"

# Replace
content = content[:start] + new_func + "\n" + content[end:]

with open(path, "w", encoding="utf-8") as f:
    f.write(content)

lines = content.count("\n")
print(f"patched! lines: {lines}")
print(f"has </script>: {content.count('</script>')}")
print(f"has renderCredits: {content.count('renderCredits')}")
print(f"has ch-models: {content.count('ch-models')}")
print(f"has New API: {content.count('New API 后台')}")
