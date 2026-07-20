#!/usr/bin/env python3
"""
paperpipe HTTP Bridge — 将 papi CLI 封装为 JSON HTTP API
供 Docker 容器内的 Profer Team Server 调用。

启动: python3 paperpipe-bridge.py --port 9876
"""

import json
import hmac
import os
import re
import subprocess
import sys
import tempfile
import shutil
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import unquote, parse_qs
from pathlib import Path

PAPI_BIN = os.environ.get("PAPI_BIN", "/home/ecs-user/.local/bin/papi")
DATA_BASE = os.environ.get("PAPERPIPE_DATA_BASE", "/data/paperpipe")
PORT = int(os.environ.get("BRIDGE_PORT", "9876"))
BRIDGE_SECRET = os.environ.get("PAPERPIPE_BRIDGE_SECRET", "")


def run_papi(user_id, args, timeout=120, input_data=None):
    """运行 papi 命令，自动设置 PAPER_DB_PATH"""
    env = os.environ.copy()
    env["PAPER_DB_PATH"] = str(Path(DATA_BASE) / str(user_id))
    env["PYTHONUNBUFFERED"] = "1"

    try:
        result = subprocess.run(
            [PAPI_BIN] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            input=input_data,
        )
        return {
            "ok": result.returncode == 0,
            "stdout": result.stdout or "",
            "stderr": result.stderr or "",
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"命令超时 ({timeout}s)", "stdout": "", "stderr": ""}
    except FileNotFoundError:
        return {"ok": False, "error": "papi 未安装", "stdout": "", "stderr": ""}
    except Exception as e:
        return {"ok": False, "error": str(e), "stdout": "", "stderr": ""}



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

class BridgeHandler(BaseHTTPRequestHandler):
    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw.decode("utf-8", errors="replace")}

    def _is_authorized(self):
        """校验仅由 Profer Server 持有的服务间密钥。"""
        supplied = self.headers.get("X-Paperpipe-Internal-Key", "")
        return bool(BRIDGE_SECRET) and hmac.compare_digest(supplied, BRIDGE_SECRET)

    def _require_authorization(self):
        if self._is_authorized():
            return True
        self._send_json({"error": "unauthorized"}, 401)
        return False

    def _get_user_id(self):
        """业务路由必须显式携带用户 ID，禁止回退 default 用户。"""
        return self.headers.get("X-User-Id", "").strip()

    def _require_user_id(self):
        user_id = self._get_user_id()
        if user_id:
            return user_id
        self._send_json({"error": "missing user id"}, 400)
        return None

    def log_message(self, format, *args):
        print(f"[bridge] {args[0]}", flush=True)

    # ---- 路由 ----

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if not self._require_authorization():
            return

        if path == "/health":
            # 不使用任意用户数据目录，也不产生数据。
            result = run_papi("_healthcheck", ["--version"], timeout=10)
            self._send_json({"available": result["ok"], "version": result["stdout"].strip()}, 200 if result["ok"] else 503)
            return

        user_id = self._require_user_id()
        if not user_id:
            return

        elif path == "/list":
            result = run_papi(user_id, ["list", "--json"])
            papers = []
            if result["ok"]:
                try:
                    raw = json.loads(result["stdout"])
                    if isinstance(raw, dict):
                        papers = [{"id": k, **v} for k, v in raw.items()]
                    elif isinstance(raw, list):
                        papers = raw
                except json.JSONDecodeError:
                    papers = []
            # 用 meta.json 补充 authors / year / abstract
            for p in papers:
                pid = p.get("id", "")
                meta_path = Path(DATA_BASE) / str(user_id) / "papers" / pid / "meta.json"
                if meta_path.exists():
                    try:
                        meta = json.loads(meta_path.read_text())
                        p["authors"] = meta.get("authors", [])
                        p["abstract"] = meta.get("abstract", "")
                        published = meta.get("published", "")
                        if published:
                            p["year"] = int(published[:4]) if published else None
                        if "year" not in p or p["year"] is None:
                            p["year"] = meta.get("year")
                        p["categories"] = meta.get("categories", [])
                    except Exception:
                        pass
            self._send_json({"papers": papers})

        elif path.startswith("/show/"):
            paper_name = unquote(path.split("/show/")[1])
            paper_dir = Path(DATA_BASE) / str(user_id) / "papers" / paper_name

            # 如果按名称找不到，尝试按 arxiv_id 查找
            if not paper_dir.exists():
                papers_base = Path(DATA_BASE) / str(user_id) / "papers"
                clean_query = paper_name.lower().replace("v", "")
                if papers_base.exists():
                    for pd in papers_base.iterdir():
                        if not pd.is_dir():
                            continue
                        mp = pd / "meta.json"
                        if not mp.exists():
                            continue
                        try:
                            m = json.loads(mp.read_text())
                            mid = (m.get("arxiv_id", "") or "").lower().replace("v", "")
                            if mid == clean_query or clean_query in mid:
                                paper_name = pd.name
                                paper_dir = pd
                                break
                        except Exception:
                            continue

            # 读取 meta.json
            meta_path = Path(DATA_BASE) / str(user_id) / "papers" / paper_name / "meta.json"
            meta = {}
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text())
                except Exception:
                    pass

            # 读取内容
            summary = ""
            for fname in ["summary.md", "tldr.md"]:
                p = Path(DATA_BASE) / str(user_id) / "papers" / paper_name / fname
                if p.exists():
                    summary = p.read_text()
                    break

            equations = ""
            eq_path = Path(DATA_BASE) / str(user_id) / "papers" / paper_name / "equations.md"
            if eq_path.exists():
                equations = eq_path.read_text()

            self._send_json({
                "id": meta.get("id", paper_name),
                "title": meta.get("title", paper_name),
                "authors": meta.get("authors", []),
                "year": meta.get("year"),
                "tags": meta.get("tags", []),
                "arxivId": meta.get("arxiv_id") or meta.get("arxivId"),
                "summary": summary,
                "equations": equations,
                "markdown": summary,
            })

        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        if not self._require_authorization():
            return
        user_id = self._require_user_id()
        if not user_id:
            return

        if path == "/add":
            body = self._read_body()
            arxiv_id = (body.get("arxivId") or "").strip()
            if not arxiv_id:
                self._send_json({"error": "请提供 arXiv ID"}, 400)
                return

            tags = body.get("tags", [])
            args = ["add", arxiv_id]
            if tags:
                args.extend(["--tags", ",".join(tags)])

            print(f"[bridge] 用户 {user_id} 添加论文: {arxiv_id}", flush=True)
            result = run_papi(user_id, args, timeout=300)

            if result["ok"]:
                # 重建 FTS5 搜索索引
                run_papi(user_id, ["index", "--backend", "search"], timeout=60)
                # 用 list 获取新论文信息
                list_result = run_papi(user_id, ["list", "--json"])
                papers = []
                try:
                    raw = json.loads(list_result["stdout"])
                    if isinstance(raw, dict):
                        papers = [{"id": k, **v} for k, v in raw.items()]
                    elif isinstance(raw, list):
                        papers = raw
                except Exception:
                    pass

                # 通过扫描 meta.json 按 arxiv_id 精确匹配论文
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
                                # 预计算语义嵌入
                                summary_path = paper_dir / "summary.md"
                                if summary_path.exists():
                                    compute_and_save_embedding(user_id, pid, summary_path.read_text())
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
                })
            else:
                self._send_json({"error": result.get("error") or result["stderr"]}, 502)

        elif path == "/upload":
            # multipart upload
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self._send_json({"error": "需要 multipart/form-data"}, 400)
                return

            boundary = content_type.split("boundary=")[1].strip()
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)

            parts = raw.split(b"--" + boundary.encode())
            for part in parts:
                if b"Content-Disposition" not in part:
                    continue
                header_end = part.find(b"\r\n\r\n")
                if header_end < 0:
                    continue
                header = part[:header_end].decode("utf-8", errors="replace")
                if 'name="file"' not in header:
                    continue

                # Content-Disposition 后可能紧跟独立的 Content-Type 行；不能用分号拆完整 header。
                # 仅接受 filename 参数本身，并移除路径/控制字符以防写出临时目录。
                filename_match = re.search(r'(?:^|;)\s*filename="?([^";\r\n]+)', header, re.IGNORECASE)
                fname = Path(filename_match.group(1)).name if filename_match else "paper.pdf"
                fname = re.sub(r"[\x00-\x1f\\\\/]", "_", fname)[:180] or "paper.pdf"

                file_data = part[header_end + 4:]
                if file_data.endswith(b"\r\n"):
                    file_data = file_data[:-2]

                # 客户端本地 paper UUID 是上传幂等键。papi 的 --name 直接作为稳定远端 ID：
                # 重试前先检查目录，已完成的同一上传直接返回，避免再次解析/创建重复论文。
                client_paper_id = self.headers.get("X-Client-Paper-Id", "").strip()
                if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", client_paper_id, re.IGNORECASE):
                    self._send_json({"error": "缺少或无效的客户端论文标识"}, 400)
                    return
                paper_dir = Path(DATA_BASE) / str(user_id) / "papers" / client_paper_id
                if paper_dir.is_dir():
                    self._send_json({"success": True, "remoteId": client_paper_id, "id": client_paper_id, "idempotent": True})
                    return

                tmp_dir = Path(tempfile.gettempdir()) / "profer-paperpipe" / str(user_id)
                tmp_dir.mkdir(parents=True, exist_ok=True)
                tmp_path = tmp_dir / f"{os.urandom(8).hex()}-{fname}"
                tmp_path.write_bytes(file_data)

                try:
                    print(f"[bridge] 用户 {user_id} 上传 PDF: {fname} ({len(file_data)} bytes)", flush=True)
                    title = Path(fname).stem or "本地 PDF"
                    result = run_papi(user_id, ["add", "--pdf", str(tmp_path), "--title", title, "--name", client_paper_id, "--no-llm"], timeout=300)
                    if result["ok"]:
                        run_papi(user_id, ["index", "--backend", "search"], timeout=60)
                        self._send_json({"success": True, "message": f"已添加: {fname}", "remoteId": client_paper_id, "id": client_paper_id})
                    else:
                        self._send_json({"error": result.get("error") or result["stderr"]}, 502)
                finally:
                    try:
                        tmp_path.unlink()
                    except Exception:
                        pass
                return

            self._send_json({"error": "未找到上传文件"}, 400)

        elif path == "/search":
            body = self._read_body()
            query = body.get("query", "").strip()
            if not query:
                self._send_json({"error": "搜索关键词不能为空"}, 400)
                return

            mode = body.get("mode", "fts")  # "fts" | "semantic" | "hybrid"
            top_k = body.get("topK", 5)

            # Semantic search: bge-small embedding → cosine similarity
            if mode == "semantic":
                results = semantic_search(user_id, query, top_k)
                self._send_json({"results": results, "query": query, "mode": "semantic"})
                return

            # FTS5 ranked search (offline, no network needed)
            result = run_papi(user_id, ["search", "--fts", "--limit", str(top_k), query])
            stdout = result["stdout"]

            results = []
            current_paper = None
            for line in stdout.split("\n"):
                line = line.strip()
                if not line:
                    continue
                # Parse "paperId (score: X.XX)" format from FTS5 output
                score_match = re.match(r'^(\S+)\s+\(score:\s+([\d.e+-]+)\)$', line)
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
                lines2 = result2["stdout"].split("\n") if result2["stdout"] else []
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

            self._send_json({"results": results, "query": query, "mode": mode})

        else:
            self._send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        path = self.path.split("?")[0].rstrip("/")
        if not self._require_authorization():
            return
        user_id = self._require_user_id()
        if not user_id:
            return

        if path.startswith("/remove/"):
            paper_name = unquote(path.split("/remove/")[1])
            print(f"[bridge] 用户 {user_id} 删除论文: {paper_name}", flush=True)
            result = run_papi(user_id, ["remove", paper_name], timeout=30)
            if result["ok"]:
                # 重建 FTS5 搜索索引
                run_papi(user_id, ["index", "--backend", "search"], timeout=60)
                # 清理语义嵌入缓存
                emb_path = Path(DATA_BASE) / str(user_id) / "papers" / paper_name / "embedding.npy"
                if emb_path.exists():
                    emb_path.unlink()
            self._send_json({"success": result["ok"]})


def main():
    import argparse
    parser = argparse.ArgumentParser(description="paperpipe HTTP Bridge")
    parser.add_argument("--port", type=int, default=PORT, help=f"监听端口 (默认 {PORT})")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址 (默认 127.0.0.1)")
    args = parser.parse_args()

    Path(DATA_BASE).mkdir(parents=True, exist_ok=True)

    server = HTTPServer((args.host, args.port), BridgeHandler)
    print(f"[bridge] paperpipe HTTP Bridge 启动: http://{args.host}:{args.port}")
    print(f"[bridge] PAPI_BIN={PAPI_BIN}")
    print(f"[bridge] DATA_BASE={DATA_BASE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[bridge] 已停止")


if __name__ == "__main__":
    main()
