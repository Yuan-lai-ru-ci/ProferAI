"""Patch bridge.py: add bge-small semantic search with pre-computed embeddings"""
import re

BRIDGE_PATH = "/home/ecs-user/paperpipe-bridge.py"

with open(BRIDGE_PATH, "r") as f:
    content = f.read()

# === PATCH 1: Add model loading at module level (after imports, before run_papi) ===
model_init_code = '''
# ---- bge-small embedding model (lazy-load, shared across requests) ----
_embed_model = None

def get_embed_model():
    """Lazy-load BAAI/bge-small-en-v1.5 for semantic search"""
    global _embed_model
    if _embed_model is None:
        import numpy as np
        from sentence_transformers import SentenceTransformer
        print("[bridge] Loading embedding model BAAI/bge-small-en-v1.5...", flush=True)
        _embed_model = SentenceTransformer("BAAI/bge-small-en-v1.5")
        print("[bridge] Embedding model loaded (384-dim)", flush=True)
    return _embed_model

def compute_and_save_embedding(user_id, paper_id, text):
    """Compute embedding for paper text and save as .npy"""
    try:
        import numpy as np
        model = get_embed_model()
        emb = model.encode(text[:3000], normalize_embeddings=True)
        emb_path = Path(DATA_BASE) / str(user_id) / "papers" / paper_id / "embedding.npy"
        np.save(str(emb_path), emb)
        return True
    except Exception as e:
        print(f"[bridge] Embedding save failed for {paper_id}: {e}", flush=True)
        return False

def semantic_search(user_id, query, top_k=5):
    """Semantic search: embed query → cosine similarity against all cached embeddings"""
    import numpy as np
    model = get_embed_model()
    q_emb = model.encode(query, normalize_embeddings=True)

    papers_dir = Path(DATA_BASE) / str(user_id) / "papers"
    if not papers_dir.exists():
        return []

    results = []
    for paper_dir in papers_dir.iterdir():
        if not paper_dir.is_dir():
            continue
        emb_path = paper_dir / "embedding.npy"
        if not emb_path.exists():
            continue
        try:
            d_emb = np.load(str(emb_path))
            sim = float(np.dot(q_emb, d_emb))
            paper_id = paper_dir.name
            # Read metadata
            meta_path = paper_dir / "meta.json"
            meta = {}
            if meta_path.exists():
                meta = json.loads(meta_path.read_text())
            snippet = ""
            summary_path = paper_dir / "summary.md"
            if summary_path.exists():
                snippet = summary_path.read_text()[:200]
            results.append({
                "paperId": paper_id,
                "title": meta.get("title", paper_id),
                "authors": meta.get("authors", []),
                "abstract": meta.get("abstract", ""),
                "year": int(meta.get("published", "0000")[:4]) if meta.get("published") else meta.get("year"),
                "tags": meta.get("tags", []),
                "arxivId": meta.get("arxiv_id", ""),
                "snippet": snippet,
                "score": sim,
            })
        except Exception as e:
            print(f"[bridge] Semantic search skip {paper_dir.name}: {e}", flush=True)

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:top_k]
'''

# Find insertion point: after run_papi function, before class BridgeHandler
insert_marker = "class BridgeHandler(BaseHTTPRequestHandler):"
if insert_marker in content:
    content = content.replace(insert_marker, model_init_code + "\n" + insert_marker)
    print("PATCH 1 (model loading): OK")
else:
    print("PATCH 1 (model loading): NOT FOUND")

# === PATCH 2: Add embedding computation after /add success ===
old_add_after_import = '''            if result["ok"]:
                # 重建 FTS5 搜索索引
                run_papi(user_id, ["index", "--backend", "search"], timeout=60)

                # 用 list 获取新论文信息'''

new_add_after_import = '''            if result["ok"]:
                # 重建 FTS5 搜索索引
                run_papi(user_id, ["index", "--backend", "search"], timeout=60)

                # 预计算语义嵌入
                clean_id_final = arxiv_id.lower().replace("v", "")
                summary_path = Path(DATA_BASE) / str(user_id) / "papers" / clean_id_final / "summary.md"
                if summary_path.exists():
                    compute_and_save_embedding(user_id, clean_id_final, summary_path.read_text())

                # 用 list 获取新论文信息'''

if old_add_after_import in content:
    content = content.replace(old_add_after_import, new_add_after_import)
    print("PATCH 2 (add embedding): OK")
else:
    print("PATCH 2 (add embedding): NOT FOUND")

# === PATCH 3: Update /search to support mode=semantic ===
# Find the search handler's endpoint and add mode support
old_search_result_line = '            self._send_json({"results": results, "query": query})'

if old_search_result_line in content:
    # Find the search handler body and replace the query reading part
    old_query_read = '''            top_k = body.get("topK", 5)
            # FTS5 ranked search (offline, no network needed)
            result = run_papi(user_id, ["search", "--fts", "--limit", str(top_k), query])'''

    new_query_read = '''            mode = body.get("mode", "fts")  # "fts" | "semantic" | "hybrid"
            top_k = body.get("topK", 5)

            # Semantic search: bge-small embedding → cosine similarity
            if mode == "semantic":
                results = semantic_search(user_id, query, top_k)
                self._send_json({"results": results, "query": query, "mode": "semantic"})
                return

            # FTS5 ranked search (offline, no network needed)
            result = run_papi(user_id, ["search", "--fts", "--limit", str(top_k), query])'''

    if old_query_read in content:
        content = content.replace(old_query_read, new_query_read)
        print("PATCH 3a (search mode): OK")

        # Also add hybrid mode: FTS5 results + semantic reranking
        old_search_end = '            self._send_json({"results": results, "query": query})'
        # Replace only the second occurrence (the FTS5 fallback one)
        # Find it by looking for the FTS5 result enrichment block
        fts5_end_marker = '''            if not results:
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

            self._send_json({"results": results, "query": query})'''

        new_fts5_end = '''            if not results:
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

            # Hybrid mode: FTS5 results → semantic reranking
            if mode == "hybrid" and results:
                try:
                    semantic_results = semantic_search(user_id, query, top_k * 2)
                    sem_map = {r["paperId"]: r["score"] for r in semantic_results}
                    for r in results:
                        sem_score = sem_map.get(r.get("paperId", ""), 0.0)
                        r["ftsScore"] = r.get("score", 0.0)
                        r["semScore"] = sem_score
                        # Combined score: 0.3 * FTS5 + 0.7 * semantic
                        r["score"] = 0.3 * r["ftsScore"] + 0.7 * sem_score
                    results.sort(key=lambda r: r.get("score", 0), reverse=True)
                except Exception as e:
                    print(f"[bridge] Hybrid rerank failed: {e}", flush=True)

            self._send_json({"results": results, "query": query, "mode": mode})'''

        if fts5_end_marker in content:
            content = content.replace(fts5_end_marker, new_fts5_end)
            print("PATCH 3b (hybrid mode): OK")
        else:
            print("PATCH 3b (hybrid mode): NOT FOUND")
    else:
        print("PATCH 3a (search mode): NOT FOUND")
else:
    print("PATCH 3: search result line NOT FOUND")

# === PATCH 4: Clean up embedding on /remove ===
old_remove_cleanup = '''            if result["ok"]:
                # 重建 FTS5 搜索索引
                run_papi(user_id, ["index", "--backend", "search"], timeout=60)'''

new_remove_cleanup = '''            if result["ok"]:
                # 重建 FTS5 搜索索引
                run_papi(user_id, ["index", "--backend", "search"], timeout=60)
                # 清理语义嵌入缓存
                emb_path = Path(DATA_BASE) / str(user_id) / "papers" / paper_name / "embedding.npy"
                if emb_path.exists():
                    emb_path.unlink()'''

if old_remove_cleanup in content:
    content = content.replace(old_remove_cleanup, new_remove_cleanup)
    print("PATCH 4 (remove embedding): OK")
else:
    print("PATCH 4 (remove embedding): NOT FOUND")

with open(BRIDGE_PATH, "w") as f:
    f.write(content)

print("All done, writing to", BRIDGE_PATH)
