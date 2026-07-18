"""Patch bridge.py to rebuild FTS5 index after add/remove"""
import re

BRIDGE_PATH = "/home/ecs-user/paperpipe-bridge.py"
with open(BRIDGE_PATH, "r") as f:
    content = f.read()

# Patch /add: add index rebuild after successful import
old_add_success_marker = """"success": True,
                    "paper": paper or {"""
new_add_success_marker = """"success": True,
                    "message": f"已添加: {arxiv_id}",
                    "paper": paper or {"""

# Instead of inline replace, let's find and replace the whole add success block
old_block = '''            if result["ok"]:
                # 用 list 获取新论文信息
                list_result = run_papi(user_id, ["list", "--json"])'''

new_block = '''            if result["ok"]:
                # 重建 FTS5 搜索索引
                run_papi(user_id, ["index", "--backend", "search"], timeout=60)

                # 用 list 获取新论文信息
                list_result = run_papi(user_id, ["list", "--json"])'''

if old_block in content:
    content = content.replace(old_block, new_block)
    print("PATCH /add rebuild index: OK")
else:
    print("PATCH /add rebuild index: NOT FOUND")

# Patch /remove: add index rebuild after deletion
old_remove = '''        if path.startswith("/remove/"):
            paper_name = unquote(path.split("/remove/")[1])
            print(f"[bridge] 用户 {user_id} 删除论文: {paper_name}", flush=True)
            result = run_papi(user_id, ["remove", paper_name], timeout=30)
            self._send_json({"success": result["ok"]})'''

new_remove = '''        if path.startswith("/remove/"):
            paper_name = unquote(path.split("/remove/")[1])
            print(f"[bridge] 用户 {user_id} 删除论文: {paper_name}", flush=True)
            result = run_papi(user_id, ["remove", paper_name], timeout=30)
            if result["ok"]:
                # 重建 FTS5 搜索索引
                run_papi(user_id, ["index", "--backend", "search"], timeout=60)
            self._send_json({"success": result["ok"]})'''

if old_remove in content:
    content = content.replace(old_remove, new_remove)
    print("PATCH /remove rebuild index: OK")
else:
    print("PATCH /remove rebuild index: NOT FOUND")

with open(BRIDGE_PATH, "w") as f:
    f.write(content)

print("Done")
