-- CodeGraph D1 Schema — multi-repo
-- Each row is scoped to a repo ('owner/name').
-- Node IDs are prefixed: '{repo}:{original_id}'

-- ============================================================
-- Repositories
-- ============================================================

CREATE TABLE IF NOT EXISTS repositories (
    full_name   TEXT PRIMARY KEY,  -- 'owner/repo'
    owner       TEXT NOT NULL,
    name        TEXT NOT NULL,
    indexed_at  INTEGER,
    commit_sha  TEXT,
    node_count  INTEGER DEFAULT 0,
    edge_count  INTEGER DEFAULT 0,
    file_count  INTEGER DEFAULT 0
);

-- ============================================================
-- Nodes — code symbols
-- ============================================================

CREATE TABLE IF NOT EXISTS nodes (
    id              TEXT PRIMARY KEY,  -- '{repo}:{original_id}'
    repo            TEXT NOT NULL,
    kind            TEXT NOT NULL,
    name            TEXT NOT NULL,
    qualified_name  TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    language        TEXT NOT NULL,
    start_line      INTEGER NOT NULL,
    end_line        INTEGER NOT NULL,
    start_column    INTEGER NOT NULL,
    end_column      INTEGER NOT NULL,
    docstring       TEXT,
    signature       TEXT,
    visibility      TEXT,
    is_exported     INTEGER DEFAULT 0,
    is_async        INTEGER DEFAULT 0,
    is_static       INTEGER DEFAULT 0,
    is_abstract     INTEGER DEFAULT 0,
    decorators      TEXT,   -- JSON array
    type_parameters TEXT,   -- JSON array
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_repo           ON nodes(repo);
CREATE INDEX IF NOT EXISTS idx_nodes_repo_kind      ON nodes(repo, kind);
CREATE INDEX IF NOT EXISTS idx_nodes_repo_name      ON nodes(repo, name);
CREATE INDEX IF NOT EXISTS idx_nodes_repo_file      ON nodes(repo, file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_repo_lname     ON nodes(repo, lower(name));

-- ============================================================
-- Edges — relationships between nodes
-- ============================================================

CREATE TABLE IF NOT EXISTS edges (
    id      TEXT PRIMARY KEY,  -- '{repo}:{src}:{tgt}:{kind}'
    repo    TEXT NOT NULL,
    source  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL,
    metadata TEXT,  -- JSON
    line    INTEGER,
    col     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_edges_repo        ON edges(repo);
CREATE INDEX IF NOT EXISTS idx_edges_src_kind    ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_tgt_kind    ON edges(target, kind);
CREATE INDEX IF NOT EXISTS idx_edges_repo_kind   ON edges(repo, kind);

-- ============================================================
-- Files — tracked source files
-- ============================================================

CREATE TABLE IF NOT EXISTS files (
    id           TEXT PRIMARY KEY,  -- '{repo}:{path}'
    repo         TEXT NOT NULL,
    path         TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    language     TEXT NOT NULL,
    size         INTEGER NOT NULL,
    modified_at  INTEGER NOT NULL,
    indexed_at   INTEGER NOT NULL,
    node_count   INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_files_repo      ON files(repo);
CREATE INDEX IF NOT EXISTS idx_files_repo_lang ON files(repo, language);

-- ============================================================
-- FTS5 — full-text search over symbols
-- ============================================================

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id            UNINDEXED,
    repo          UNINDEXED,
    name,
    qualified_name,
    docstring,
    signature,
    content='nodes',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, id, repo, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.repo, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, repo, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.repo, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, repo, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.repo, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
    INSERT INTO nodes_fts(rowid, id, repo, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.repo, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;
