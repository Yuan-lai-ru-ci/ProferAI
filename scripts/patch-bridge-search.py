#!/usr/bin/env python3
"""Patch paperpipe-bridge.py search handler for FTS5"""
import re, json
from pathlib import Path

DATA_BASE = "/data/paperpipe"
BRIDGE_PATH = "/home/ecs-user/paperpipe-bridge.py"

with open(BRIDGE_PATH, "r") as f:
    content = f.read()

# Add import re at the top
content = content.replace(
    "import json\nimport os\nimport subprocess",
    "import json\nimport os\nimport re\nimport subprocess"
)
print("import re: added" if "import re" in content else "import re: FAILED")

# Find and replace the search handler
old_start_marker = 'elif path == "/search":'
old_end_marker = 'self._send_json({"results": results, "rawOutput": result["stdout"][:5000]})'

start_idx = content.find(old_start_marker)
end_idx = content.find(old_end_marker)

if start_idx < 0 or end_idx < 0:
    print(f"ERROR: markers not found: start={start_idx}, end={end_idx}")
    exit(1)

end_idx += len(old_end_marker)

new_search = """        elif path == "/search":
            body = self._read_body()
            query = body.get("query", "").strip()
            if not query:
                self._send_json({"error": "搜索关键词不能为空"}, 400)
                return

            top_k = body.get("topK", 5)
            # FTS5 ranked search (offline, no network needed)
            result = run_papi(user_id, ["search", "--fts", "--limit", str(top_k), query])
            stdout = result["stdout"]

            results = []
            current_paper = None
            for line in stdout.split("\\n"):
                line = line.strip()
                if not line:
                    continue
                # Parse "paperId (score: X.XX)" format from FTS5 output
                score_match = re.match(r'^(\\S+)\\s+\\(score:\\s+([\\d.e+-]+)\\)$', line)
                if score_match:
                    if current_paper:
                        results.append(current_paper)
                    current_paper = {
                        "paperId": score_match.group(1),
                        "score": float(score_match.group(2)),
                        "snippet": "",
                    }
                elif current_paper and line.startswith("  "):
                    current_paper["snippet"] = line.strip()
                elif current_paper:
                    current_paper["snippet"] += " " + line

            if current_paper:
                results.append(current_paper)

            # Enrich with meta.json (authors, year, abstract)
            for r in results:
                pid = r.get("paperId", "")
                meta_path = Path(DATA_BASE) / str(user_id) / "papers" / pid / "meta.json"
                if meta_path.exists():
                    try:
                        meta = json.loads(meta_path.read_text())
                        r["title"] = meta.get("title", pid)
                        r["authors"] = meta.get("authors", [])
                        r["abstract"] = meta.get("abstract", "")
                        published = meta.get("published", "")
                        r["year"] = int(published[:4]) if published else meta.get("year")
                        r["tags"] = meta.get("tags", [])
                        r["arxivId"] = meta.get("arxiv_id", "")
                    except Exception:
                        r["title"] = pid
                        r["authors"] = []

            # Fallback: basic grep search if FTS5 returned nothing
            if not results:
                result2 = run_papi(user_id, ["search", query])
                lines2 = result2["stdout"].split("\\n") if result2["stdout"] else []
                for line in lines2:
                    line = line.strip()
                    if not line:
                        continue
                    if ":" in line:
                        paper_ref, snippet = line.split(":", 1)
                        results.append({
                            "paperId": paper_ref.strip(),
                            "snippet": snippet.strip(),
                            "score": 0.0,
                            "title": paper_ref.strip(),
                            "authors": [],
                        })

            self._send_json({"results": results, "query": query})"""

content = content[:start_idx] + new_search + content[end_idx:]
print(f"PATCH search: replaced {end_idx - start_idx} chars with {len(new_search)} chars")

with open(BRIDGE_PATH, "w") as f:
    f.write(content)

print("Done")
