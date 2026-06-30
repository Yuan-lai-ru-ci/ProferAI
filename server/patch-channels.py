"""Patch admin-ui/index.html: replace renderChannels function."""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else 'src/admin-ui/index.html'

with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# read function body from external file to avoid escaping hell
new = open('server/patch-channels-func.js', 'r', encoding='utf-8').read()

result = lines[:190] + [new + '\n'] + lines[231:]
with open(path, 'w', encoding='utf-8') as f:
    f.writelines(result)

print('patched! lines:', len(result))
