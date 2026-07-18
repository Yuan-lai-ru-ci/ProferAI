"""Fix bridge /add: find paper by matching arxiv_id in meta.json"""
BRIDGE_PATH = "/home/ecs-user/paperpipe-bridge.py"

with open(BRIDGE_PATH, "r") as f:
    content = f.read()

# The issue: after papi add, we try to find paper by fuzzy-matching arxiv_id against paper name.
# papi assigns short names like 'gan-vocoder' that don't contain the arxiv ID.
# Fix: scan all papers' meta.json for matching arxiv_id.

old_find_paper = '''                clean_id = arxiv_id.lower().replace("v", "")
                paper = next((p for p in papers if isinstance(p, dict) and clean_id in str(p.get("id", "")).lower()), None)
                if paper:
                    pid = paper.get("id", "")
                    meta_path = Path(DATA_BASE) / str(user_id) / "papers" / pid / "meta.json"
                    if meta_path.exists():
                        try:
                            meta = json.loads(meta_path.read_text())
                            paper["authors"] = meta.get("authors", [])
                            paper["abstract"] = meta.get("abstract", "")
                            published = meta.get("published", "")
                            if published:
                                paper["year"] = int(published[:4])
                        except Exception:
                            pass

                self._send_json({
                    "success": True,
                    "message": f"已添加: {arxiv_id}",
                    "paper": paper or {
                        "id": arxiv_id, "title": arxiv_id, "authors": [],
                        "tags": tags or [], "arxivId": arxiv_id,
                    },
                })'''

new_find_paper = '''                # 扫描所有论文目录，通过 meta.json 匹配 arxiv_id
                found_paper = None
                papers_base = Path(DATA_BASE) / str(user_id) / "papers"
                clean_arxiv = arxiv_id.lower().replace("v", "")
                if papers_base.exists():
                    for paper_dir in papers_base.iterdir():
                        if not paper_dir.is_dir():
                            continue
                        meta_path = paper_dir / "meta.json"
                        if not meta_path.exists():
                            continue
                        try:
                            meta = json.loads(meta_path.read_text())
                            meta_arxiv = (meta.get("arxiv_id", "") or "").lower().replace("v", "")
                            if meta_arxiv == clean_arxiv or clean_arxiv in meta_arxiv:
                                pid = paper_dir.name
                                published = meta.get("published", "")
                                found_paper = {
                                    "id": pid,
                                    "title": meta.get("title", pid),
                                    "authors": meta.get("authors", []),
                                    "abstract": meta.get("abstract", ""),
                                    "year": int(published[:4]) if published else meta.get("year"),
                                    "tags": meta.get("tags", tags or []),
                                    "arxivId": meta.get("arxiv_id", arxiv_id),
                                    "categories": meta.get("categories", []),
                                }
                                break
                        except Exception:
                            continue

                self._send_json({
                    "success": True,
                    "message": f"已添加: {arxiv_id}",
                    "paper": found_paper or {
                        "id": arxiv_id, "title": arxiv_id, "authors": [],
                        "tags": tags or [], "arxivId": arxiv_id,
                    },
                })'''

if old_find_paper in content:
    content = content.replace(old_find_paper, new_find_paper)
    print("FIX: replaced paper lookup logic")
else:
    print("FIX: pattern NOT FOUND")
    # Find it
    idx = content.find('clean_id = arxiv_id.lower()')
    if idx >= 0:
        print(f"  Found at offset {idx}")
        print(f"  Context: {content[idx:idx+100]}")

with open(BRIDGE_PATH, "w") as f:
    f.write(content)
print("Done")
