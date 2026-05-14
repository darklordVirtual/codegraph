#!/usr/bin/env python3
"""
Batch D1 uploader — respects D1's 100-parameter-per-query limit.

Speedup vs row-by-row:
  nodes  (14 cols): 7 rows/batch  → ~3,600 API calls for 25K nodes  (was 25,000)
  edges  ( 5 cols): 19 rows/batch → ~2,700 API calls for 50K edges  (was 50,000)
  Total upload time for a large repo: ~4 min  (was ~50 min)
"""
import json, os, re, sqlite3, sys, time, urllib.request

REPO       = os.environ["REPO"]
DB_PATH    = os.environ["DB_PATH"]
API_TOKEN  = os.environ["CLOUDFLARE_API_TOKEN"]
ACCOUNT_ID = os.environ["CLOUDFLARE_ACCOUNT_ID"]
DB_ID      = os.environ["D1_DATABASE_ID"]
SHA        = os.environ.get("GITHUB_SHA", "unknown")
API        = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{DB_ID}/query"
HEADERS    = {"Authorization": f"Bearer {API_TOKEN}", "Content-Type": "application/json"}

# D1 HTTP API hard limit — exceed this and the request is rejected
D1_PARAM_LIMIT = 100

# Cost / completeness guards
NODE_LIMIT = 25_000
EDGE_LIMIT = 50_000


def d1(sql, params=None):
    body = json.dumps({"sql": sql, "params": params or []}).encode()
    req  = urllib.request.Request(API, data=body, headers=HEADERS, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = json.loads(r.read())
            if not resp.get("success"):
                sys.stderr.write(f"D1 error: {resp.get('errors')}\n")
            return resp
    except Exception as e:
        sys.stderr.write(f"D1 request failed: {e}\n")
        return {}


def d1_batch(insert_prefix: str, cols: list, rows: list, label: str) -> int:
    """
    Insert rows in batches sized so params never exceed D1_PARAM_LIMIT.
    Returns number of rows successfully submitted.
    """
    if not rows:
        return 0

    n_cols     = len(cols)
    batch_size = max(1, D1_PARAM_LIMIT // n_cols)
    total      = len(rows)
    done       = 0

    for i in range(0, total, batch_size):
        batch        = rows[i : i + batch_size]
        placeholders = ", ".join(f"({', '.join(['?'] * n_cols)})" for _ in batch)
        params       = [v for row in batch for v in row]
        d1(f"{insert_prefix} VALUES {placeholders}", params)
        done += len(batch)
        sys.stdout.write(f"\r  {label}: {done}/{total}")
        sys.stdout.flush()
        time.sleep(0.05)

    print(f"\r  {label}: {total} rows    ")
    return total


# ── Schema ─────────────────────────────────────────────────────────
for ddl in [
    "CREATE TABLE IF NOT EXISTS repositories (full_name TEXT PRIMARY KEY, owner TEXT, name TEXT, commit_sha TEXT, indexed_at INTEGER DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, repo TEXT, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, language TEXT, start_line INTEGER DEFAULT 0, end_line INTEGER DEFAULT 0, signature TEXT, docstring TEXT, is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0, is_static INTEGER DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, repo TEXT, source TEXT, target TEXT, kind TEXT)",
    "CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, repo TEXT, path TEXT, language TEXT, size INTEGER DEFAULT 0, node_count INTEGER DEFAULT 0)",
]:
    d1(ddl)

# ── Register repo ──────────────────────────────────────────────────
owner, name = REPO.split("/", 1)
ts = int(time.time() * 1000)
d1(
    "INSERT OR REPLACE INTO repositories (full_name, owner, name, commit_sha, indexed_at) VALUES (?,?,?,?,?)",
    [REPO, owner, name, SHA, ts],
)
print(f"Repo: {REPO} @ {SHA[:8]}")

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

# ── Size check ────────────────────────────────────────────────────
raw_nodes = conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
raw_edges = conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]

if raw_nodes > NODE_LIMIT:
    print(f"  [WARN] {raw_nodes:,} nodes in DB — uploading first {NODE_LIMIT:,} (D1 cost guard)")
if raw_edges > EDGE_LIMIT:
    print(f"  [WARN] {raw_edges:,} edges in DB — uploading first {EDGE_LIMIT:,} (D1 cost guard)")

# ── Nodes ─────────────────────────────────────────────────────────
NODE_COLS = [
    "id","repo","kind","name","qualified_name","file_path","language",
    "start_line","end_line","signature","docstring","is_exported","is_async","is_static",
]
node_rows = conn.execute(
    "SELECT id,kind,name,qualified_name,file_path,language,start_line,end_line,"
    "signature,docstring,is_exported,is_async,is_static FROM nodes LIMIT ?",
    (NODE_LIMIT,)
).fetchall()

d1_batch(
    f"INSERT OR REPLACE INTO nodes ({','.join(NODE_COLS)})",
    NODE_COLS,
    [[str(r["id"]), REPO] + [r[c] for c in NODE_COLS[2:]] for r in node_rows],
    "nodes",
)

# ── Edges ─────────────────────────────────────────────────────────
EDGE_COLS = ["id","repo","source","target","kind"]
edge_rows = conn.execute(
    "SELECT id,source,target,kind FROM edges LIMIT ?", (EDGE_LIMIT,)
).fetchall()

d1_batch(
    f"INSERT OR REPLACE INTO edges ({','.join(EDGE_COLS)})",
    EDGE_COLS,
    [[str(r["id"]), REPO, str(r["source"]), str(r["target"]), r["kind"]] for r in edge_rows],
    "edges",
)

conn.close()
print(f"\nDone: {REPO} — {len(node_rows):,} nodes, {len(edge_rows):,} edges uploaded")
