#!/usr/bin/env node
/**
 * upload-to-d1.mjs
 *
 * Reads a CodeGraph SQLite index (.codegraph/index.db) produced by
 * `codegraph index .` and uploads it to a Cloudflare D1 database.
 *
 * Required env vars:
 *   REPO                   – 'owner/name'
 *   CLOUDFLARE_API_TOKEN   – CF API token with D1 write access
 *   CLOUDFLARE_ACCOUNT_ID  – CF account ID
 *   D1_DATABASE_ID         – D1 database ID (from wrangler d1 create)
 *
 * Optional:
 *   DB_PATH                – path to index.db (default: .codegraph/index.db)
 *   GITHUB_SHA             – commit SHA to record
 *   ROWS_PER_BATCH         – rows per INSERT batch (default: 50)
 *   CONCURRENCY            – parallel API calls (default: 5)
 */

import Database from 'better-sqlite3';

const REPO       = env('REPO');
const TOKEN      = env('CLOUDFLARE_API_TOKEN');
const ACCOUNT_ID = env('CLOUDFLARE_ACCOUNT_ID');
const DB_ID      = env('D1_DATABASE_ID');
const DB_PATH    = process.env.DB_PATH    || '.codegraph/index.db';
const COMMIT_SHA = process.env.GITHUB_SHA || '';
const BATCH_SIZE = Number(process.env.ROWS_PER_BATCH ?? 50);
const CONCURRENCY= Number(process.env.CONCURRENCY    ?? 5);

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}`;

// ──────────────────────────────────────────────────────────────
// D1 REST helpers
// ──────────────────────────────────────────────────────────────

async function d1Query(sql, params = []) {
  const res = await fetch(`${BASE}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(`D1 query error: ${JSON.stringify(data.errors)}\nSQL: ${sql}`);
  return data.result;
}

async function d1Batch(statements) {
  // Each element: { sql, params }
  const res = await fetch(`${BASE}/batch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      batch: statements.map(s => ({ sql: s.sql, params: s.params ?? [] })),
    }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(`D1 batch error: ${JSON.stringify(data.errors)}`);
  return data.result;
}

// Execute array of statements with multi-row INSERTs, BATCH_SIZE rows each,
// CONCURRENCY requests in parallel.
async function bulkInsert(label, rows, buildStmt) {
  if (!rows.length) { console.log(`  ${label}: 0 rows — skipping`); return; }

  const chunks = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    chunks.push(rows.slice(i, i + BATCH_SIZE));
  }

  let done = 0;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const group = chunks.slice(i, i + CONCURRENCY);
    await Promise.all(group.map(chunk => {
      const stmt = buildStmt(chunk);
      return d1Batch([stmt]);
    }));
    done += group.reduce((s, g) => s + g.length, 0);
    process.stdout.write(`  ${label}: ${done}/${rows.length}\r`);
  }
  console.log(`  ${label}: ${rows.length} rows ✓`);
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nCodeGraph → D1: ${REPO}`);
  console.log(`  DB path  : ${DB_PATH}`);
  console.log(`  Commit   : ${COMMIT_SHA || '(none)'}\n`);

  const localDb = new Database(DB_PATH, { readonly: true });

  const nodes = localDb.prepare('SELECT * FROM nodes').all();
  const edges = localDb.prepare('SELECT * FROM edges').all();
  const files = localDb.prepare('SELECT * FROM files').all();
  localDb.close();

  console.log(`Loaded: ${nodes.length} nodes, ${edges.length} edges, ${files.length} files`);

  // Clear existing data for this repo (cascade deletes edges/files via FK won't help
  // since we manage IDs manually; delete in dependency order).
  console.log('\nClearing existing data...');
  await d1Query('DELETE FROM edges WHERE repo = ?', [REPO]);
  await d1Query('DELETE FROM nodes WHERE repo = ?', [REPO]);
  await d1Query('DELETE FROM files WHERE repo = ?', [REPO]);

  const now = Date.now();

  // ── Files ────────────────────────────────────────────────────
  console.log('\nUploading files...');
  await bulkInsert('files', files, chunk => {
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
    const params = chunk.flatMap(f => [
      `${REPO}:${f.path}`,
      REPO,
      f.path,
      f.content_hash,
      f.language,
      f.size,
      f.modified_at,
      f.indexed_at || now,
      f.node_count || 0,
    ]);
    return {
      sql: `INSERT OR REPLACE INTO files (id,repo,path,content_hash,language,size,modified_at,indexed_at,node_count) VALUES ${placeholders}`,
      params,
    };
  });

  // ── Nodes ────────────────────────────────────────────────────
  console.log('\nUploading nodes...');
  await bulkInsert('nodes', nodes, chunk => {
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const params = chunk.flatMap(n => [
      `${REPO}:${n.id}`,
      REPO,
      n.kind,
      n.name,
      n.qualified_name,
      n.file_path,
      n.language,
      n.start_line,
      n.end_line,
      n.start_column,
      n.end_column,
      n.docstring   || null,
      n.signature   || null,
      n.visibility  || null,
      n.is_exported ? 1 : 0,
      n.is_async    ? 1 : 0,
      n.is_static   ? 1 : 0,
      n.is_abstract ? 1 : 0,
      n.decorators      || null,
      n.type_parameters || null,
      n.updated_at || now,
    ]);
    return {
      sql: `INSERT OR REPLACE INTO nodes (id,repo,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,docstring,signature,visibility,is_exported,is_async,is_static,is_abstract,decorators,type_parameters,updated_at) VALUES ${placeholders}`,
      params,
    };
  });

  // ── Edges ────────────────────────────────────────────────────
  // Filter out edges whose source or target doesn't exist in our node set
  // (unresolved references would violate FK constraints).
  console.log('\nUploading edges...');
  const nodeIds = new Set(nodes.map(n => `${REPO}:${n.id}`));
  const validEdges = edges.filter(
    e => nodeIds.has(`${REPO}:${e.source}`) && nodeIds.has(`${REPO}:${e.target}`)
  );
  if (validEdges.length < edges.length) {
    console.log(`  (${edges.length - validEdges.length} edges with unresolved targets skipped)`);
  }

  await bulkInsert('edges', validEdges, chunk => {
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?)').join(',');
    const params = chunk.flatMap((e, i) => [
      `${REPO}:${e.id ?? i}`,
      REPO,
      `${REPO}:${e.source}`,
      `${REPO}:${e.target}`,
      e.kind,
      e.metadata || null,
      e.line      || null,
      e.col       || null,
    ]);
    return {
      sql: `INSERT OR REPLACE INTO edges (id,repo,source,target,kind,metadata,line,col) VALUES ${placeholders}`,
      params,
    };
  });

  // ── Repository metadata ──────────────────────────────────────
  await d1Query(
    `INSERT OR REPLACE INTO repositories (full_name,owner,name,indexed_at,commit_sha,node_count,edge_count,file_count)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      REPO,
      REPO.split('/')[0],
      REPO.split('/')[1],
      now,
      COMMIT_SHA,
      nodes.length,
      validEdges.length,
      files.length,
    ],
  );

  console.log(`\n✓ Done — ${REPO} is live on Cloudflare D1`);
}

// ──────────────────────────────────────────────────────────────
// Util
// ──────────────────────────────────────────────────────────────

function env(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing env var: ${name}`); process.exit(1); }
  return v;
}

main().catch(err => { console.error(err); process.exit(1); });
