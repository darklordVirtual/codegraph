// MCP tool definitions and D1-backed implementations.

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

interface DbNode {
  id: string;
  repo: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  docstring: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
}

// ──────────────────────────────────────────────────────────────
// Tool registry
// ──────────────────────────────────────────────────────────────

export function listTools(): ToolDef[] {
  return [
    {
      name: 'codegraph_search',
      description:
        'Search for symbols (functions, classes, types, etc.) by name or keyword using full-text search.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms' },
          kind: {
            type: 'string',
            description:
              'Filter by kind: function | method | class | interface | variable | constant | enum | route | component',
          },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'codegraph_callers',
      description: 'Find all code that calls a specific function or method.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Function or method name' },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'codegraph_callees',
      description: 'Find all functions/methods called by a specific symbol.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Function or method name' },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'codegraph_impact',
      description:
        'Analyze the impact radius of changing a symbol — what code would be transitively affected.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol name to analyse' },
          depth: { type: 'number', description: 'Max traversal depth 1-5 (default 3)' },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'codegraph_explore',
      description:
        'Deep exploration of a topic, symbol, or file — comprehensive context in one call.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic, symbol name, or file path' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'codegraph_node',
      description: 'Get full details about a specific symbol: location, signature, doc, and relationships.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol name or qualified name' },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'codegraph_files',
      description: 'List indexed files, optionally filtered by path pattern or language.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Path substring filter (e.g. "src/api")' },
          language: { type: 'string', description: 'Language filter (e.g. "typescript")' },
        },
      },
    },
    {
      name: 'codegraph_status',
      description: 'Get indexing statistics for this repository.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

export async function executeTool(
  db: D1Database,
  repo: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'codegraph_search':  return searchSymbols(db, repo, args);
    case 'codegraph_callers': return findCallers(db, repo, args);
    case 'codegraph_callees': return findCallees(db, repo, args);
    case 'codegraph_impact':  return analyzeImpact(db, repo, args);
    case 'codegraph_explore': return exploreTopicFull(db, repo, args);
    case 'codegraph_node':    return getNode(db, repo, args);
    case 'codegraph_files':   return listFiles(db, repo, args);
    case 'codegraph_status':  return getStatus(db, repo);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function nodeLabel(n: DbNode): string {
  const flags = [n.is_exported && 'exported', n.is_async && 'async', n.is_static && 'static']
    .filter(Boolean)
    .join(', ');
  const sig = n.signature ? `\n  Signature: \`${n.signature}\`` : '';
  const doc = n.docstring ? `\n  Doc: ${n.docstring.slice(0, 120)}` : '';
  const fl = flags ? `\n  [${flags}]` : '';
  return `**${n.kind}** \`${n.name}\`\n  ${n.file_path}:${n.start_line}${sig}${doc}${fl}`;
}

/** Find a node by exact name, qualified name, or case-insensitive name. */
async function findNode(db: D1Database, repo: string, symbol: string): Promise<DbNode | null> {
  const exact = await db
    .prepare(
      `SELECT * FROM nodes WHERE repo = ? AND (name = ? OR qualified_name = ?) LIMIT 1`,
    )
    .bind(repo, symbol, symbol)
    .first<DbNode>();
  if (exact) return exact;

  return db
    .prepare(`SELECT * FROM nodes WHERE repo = ? AND lower(name) = lower(?) LIMIT 1`)
    .bind(repo, symbol)
    .first<DbNode>();
}

// ──────────────────────────────────────────────────────────────
// Tool implementations
// ──────────────────────────────────────────────────────────────

async function searchSymbols(
  db: D1Database,
  repo: string,
  args: Record<string, unknown>,
): Promise<string> {
  const query = String(args.query ?? '').trim();
  const kind  = args.kind ? String(args.kind) : null;
  const limit = Math.min(Number(args.limit ?? 20), 50);

  if (!query) return 'Provide a search query.';

  let rows: DbNode[];

  // FTS5 first; fall back to LIKE on syntax error
  try {
    const fts = kind
      ? `SELECT n.* FROM nodes_fts JOIN nodes n ON nodes_fts.id = n.id
         WHERE nodes_fts MATCH ? AND n.repo = ? AND n.kind = ? LIMIT ?`
      : `SELECT n.* FROM nodes_fts JOIN nodes n ON nodes_fts.id = n.id
         WHERE nodes_fts MATCH ? AND n.repo = ? LIMIT ?`;

    const stmt = kind
      ? db.prepare(fts).bind(query, repo, kind, limit)
      : db.prepare(fts).bind(query, repo, limit);

    rows = (await stmt.all<DbNode>()).results;
  } catch {
    const like = kind
      ? `SELECT * FROM nodes WHERE repo = ? AND lower(name) LIKE ? AND kind = ? LIMIT ?`
      : `SELECT * FROM nodes WHERE repo = ? AND lower(name) LIKE ? LIMIT ?`;

    const stmt = kind
      ? db.prepare(like).bind(repo, `%${query.toLowerCase()}%`, kind, limit)
      : db.prepare(like).bind(repo, `%${query.toLowerCase()}%`, limit);

    rows = (await stmt.all<DbNode>()).results;
  }

  if (!rows.length) return `No symbols found for "${query}".`;

  return [`Found **${rows.length}** symbol(s) for "${query}":\n`, ...rows.map(nodeLabel)].join(
    '\n\n',
  );
}

async function findCallers(
  db: D1Database,
  repo: string,
  args: Record<string, unknown>,
): Promise<string> {
  const symbol = String(args.symbol ?? '').trim();
  if (!symbol) return 'Provide a symbol name.';

  const node = await findNode(db, repo, symbol);
  if (!node) return `Symbol "${symbol}" not found in the index.`;

  const { results } = await db
    .prepare(
      `SELECT DISTINCT n.* FROM edges e
       JOIN nodes n ON n.id = e.source
       WHERE e.target = ? AND e.kind = 'calls' AND n.repo = ?
       LIMIT 30`,
    )
    .bind(node.id, repo)
    .all<DbNode>();

  if (!results.length)
    return `No callers for \`${symbol}\`. It may be an entry point or uncalled.`;

  const lines = [`**Callers of \`${symbol}\`** (${results.length}):\n`];
  for (const n of results) {
    lines.push(`- ${n.kind} \`${n.name}\` → \`${n.file_path}:${n.start_line}\``);
  }
  return lines.join('\n');
}

async function findCallees(
  db: D1Database,
  repo: string,
  args: Record<string, unknown>,
): Promise<string> {
  const symbol = String(args.symbol ?? '').trim();
  if (!symbol) return 'Provide a symbol name.';

  const node = await findNode(db, repo, symbol);
  if (!node) return `Symbol "${symbol}" not found in the index.`;

  const { results } = await db
    .prepare(
      `SELECT DISTINCT n.* FROM edges e
       JOIN nodes n ON n.id = e.target
       WHERE e.source = ? AND e.kind = 'calls' AND n.repo = ?
       LIMIT 30`,
    )
    .bind(node.id, repo)
    .all<DbNode>();

  if (!results.length)
    return `\`${symbol}\` makes no tracked calls, or all targets are external.`;

  const lines = [`**\`${symbol}\` calls** (${results.length}):\n`];
  for (const n of results) {
    lines.push(`- ${n.kind} \`${n.name}\` → \`${n.file_path}:${n.start_line}\``);
  }
  return lines.join('\n');
}

async function analyzeImpact(
  db: D1Database,
  repo: string,
  args: Record<string, unknown>,
): Promise<string> {
  const symbol = String(args.symbol ?? '').trim();
  const depth  = Math.min(Math.max(Number(args.depth ?? 3), 1), 5);
  if (!symbol) return 'Provide a symbol name.';

  const node = await findNode(db, repo, symbol);
  if (!node) return `Symbol "${symbol}" not found in the index.`;

  // Recursive CTE: find everything that transitively calls/imports/references this node.
  // The path string is used to break cycles.
  const { results } = await db
    .prepare(
      `WITH RECURSIVE impact(id, depth, path) AS (
         SELECT ?, 0, ?
         UNION ALL
         SELECT e.source, impact.depth + 1, impact.path || '|' || e.source
         FROM edges e
         JOIN nodes n ON n.id = e.source AND n.repo = ?
         JOIN impact  ON impact.id = e.target
         WHERE impact.depth < ?
           AND e.kind IN ('calls', 'imports', 'references')
           AND instr(impact.path, e.source) = 0
       )
       SELECT DISTINCT n.*, i.depth FROM impact i
       JOIN nodes n ON n.id = i.id
       WHERE n.repo = ? AND i.id != ?
       ORDER BY i.depth, n.file_path
       LIMIT 60`,
    )
    .bind(node.id, node.id, repo, depth, repo, node.id)
    .all<DbNode & { depth: number }>();

  if (!results.length)
    return `No impact found for \`${symbol}\` at depth ${depth}. Likely a leaf.`;

  const byDepth = new Map<number, (DbNode & { depth: number })[]>();
  for (const r of results) {
    if (!byDepth.has(r.depth)) byDepth.set(r.depth, []);
    byDepth.get(r.depth)!.push(r);
  }

  const lines = [`## Impact radius: \`${symbol}\` (depth ${depth})\n`];
  for (const [d, nodes] of byDepth) {
    lines.push(`**Depth ${d}** — ${nodes.length} symbol(s):`);
    for (const n of nodes) {
      lines.push(`  - ${n.kind} \`${n.name}\` (${n.file_path}:${n.start_line})`);
    }
  }
  lines.push(`\n**Total affected:** ${results.length} symbols`);
  return lines.join('\n');
}

async function getNode(
  db: D1Database,
  repo: string,
  args: Record<string, unknown>,
): Promise<string> {
  const symbol = String(args.symbol ?? '').trim();
  if (!symbol) return 'Provide a symbol name.';

  const node = await findNode(db, repo, symbol);
  if (!node) return `Symbol "${symbol}" not found.`;

  type EdgeRow = { name: string; kind: string; file_path: string; start_line: number };

  const [callersR, calleesR, relationsR] = await db.batch([
    db.prepare(
      `SELECT n.name, n.kind, n.file_path, n.start_line FROM edges e
       JOIN nodes n ON n.id = e.source
       WHERE e.target = ? AND e.kind = 'calls' AND n.repo = ? LIMIT 10`,
    ).bind(node.id, repo),
    db.prepare(
      `SELECT n.name, n.kind, n.file_path, n.start_line FROM edges e
       JOIN nodes n ON n.id = e.target
       WHERE e.source = ? AND e.kind = 'calls' AND n.repo = ? LIMIT 10`,
    ).bind(node.id, repo),
    db.prepare(
      `SELECT n.name, n.kind, n.file_path, e.kind as rel FROM edges e
       JOIN nodes n ON n.id = e.target
       WHERE e.source = ? AND e.kind IN ('imports','extends','implements','decorates') AND n.repo = ? LIMIT 8`,
    ).bind(node.id, repo),
  ]);

  const callers   = callersR.results   as EdgeRow[];
  const callees   = calleesR.results   as EdgeRow[];
  const relations = relationsR.results as (EdgeRow & { rel: string })[];

  const flags = [
    node.is_exported && 'exported',
    node.is_async    && 'async',
    node.is_static   && 'static',
  ].filter(Boolean).join(', ');

  const lines = [
    `## ${node.kind}: \`${node.name}\``,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| File | \`${node.file_path}:${node.start_line}–${node.end_line}\` |`,
    `| Language | ${node.language} |`,
    `| Qualified | \`${node.qualified_name}\` |`,
  ];
  if (node.signature) lines.push(`| Signature | \`${node.signature}\` |`);
  if (flags)          lines.push(`| Flags | ${flags} |`);
  if (node.docstring) lines.push(``, `**Doc:** ${node.docstring}`);

  if (callers.length) {
    lines.push(``, `**Called by (${callers.length}):**`);
    for (const r of callers) lines.push(`  - ${r.kind} \`${r.name}\` (${r.file_path}:${r.start_line})`);
  }
  if (callees.length) {
    lines.push(``, `**Calls (${callees.length}):**`);
    for (const r of callees) lines.push(`  - ${r.kind} \`${r.name}\` (${r.file_path}:${r.start_line})`);
  }
  if (relations.length) {
    lines.push(``, `**Relationships:**`);
    for (const r of relations) lines.push(`  - ${r.rel} \`${r.name}\` (${r.file_path})`);
  }

  return lines.join('\n');
}

async function exploreTopicFull(
  db: D1Database,
  repo: string,
  args: Record<string, unknown>,
): Promise<string> {
  const topic = String(args.topic ?? '').trim();
  if (!topic) return 'Provide a topic.';

  let nodes: DbNode[];
  try {
    nodes = (
      await db
        .prepare(
          `SELECT n.* FROM nodes_fts JOIN nodes n ON nodes_fts.id = n.id
           WHERE nodes_fts MATCH ? AND n.repo = ? LIMIT 8`,
        )
        .bind(topic, repo)
        .all<DbNode>()
    ).results;
  } catch {
    nodes = (
      await db
        .prepare(`SELECT * FROM nodes WHERE repo = ? AND lower(name) LIKE ? LIMIT 8`)
        .bind(repo, `%${topic.toLowerCase()}%`)
        .all<DbNode>()
    ).results;
  }

  if (!nodes.length) return `No symbols found for topic "${topic}".`;

  const lines = [`# Exploration: "${topic}"\n`, `Found **${nodes.length}** relevant symbol(s).\n`];

  for (const node of nodes.slice(0, 5)) {
    lines.push(`## ${node.kind}: \`${node.name}\``);
    lines.push(`**File:** ${node.file_path}:${node.start_line}`);
    if (node.signature) lines.push(`**Signature:** \`${node.signature}\``);
    if (node.docstring)  lines.push(`**Doc:** ${node.docstring.slice(0, 200)}`);

    const [cIn, cOut] = await db.batch([
      db.prepare(
        `SELECT n.name, n.kind FROM edges e JOIN nodes n ON n.id = e.source
         WHERE e.target = ? AND e.kind = 'calls' AND n.repo = ? LIMIT 5`,
      ).bind(node.id, repo),
      db.prepare(
        `SELECT n.name, n.kind FROM edges e JOIN nodes n ON n.id = e.target
         WHERE e.source = ? AND e.kind = 'calls' AND n.repo = ? LIMIT 5`,
      ).bind(node.id, repo),
    ]);

    type Simple = { name: string; kind: string };
    if (cIn.results.length)
      lines.push(`**Called by:** ${(cIn.results as Simple[]).map(r => `\`${r.name}\``).join(', ')}`);
    if (cOut.results.length)
      lines.push(`**Calls:** ${(cOut.results as Simple[]).map(r => `\`${r.name}\``).join(', ')}`);

    lines.push('');
  }

  const filePaths = [...new Set(nodes.map(n => n.file_path))];
  lines.push(`## Related files`);
  for (const fp of filePaths) lines.push(`- \`${fp}\``);

  return lines.join('\n');
}

async function listFiles(
  db: D1Database,
  repo: string,
  args: Record<string, unknown>,
): Promise<string> {
  const pattern  = args.pattern  ? String(args.pattern)  : null;
  const language = args.language ? String(args.language) : null;

  let sql    = `SELECT path, language, size, node_count FROM files WHERE repo = ?`;
  const bind: unknown[] = [repo];

  if (pattern)  { sql += ` AND path LIKE ?`;     bind.push(`%${pattern}%`); }
  if (language) { sql += ` AND language = ?`;    bind.push(language); }
  sql += ` ORDER BY path LIMIT 100`;

  type FileRow = { path: string; language: string; size: number; node_count: number };
  const { results } = await db.prepare(sql).bind(...bind).all<FileRow>();

  if (!results.length)
    return pattern ? `No files matching "${pattern}".` : 'No files indexed yet.';

  const lines = [`**${results.length} files**${pattern ? ` matching "${pattern}"` : ''}:\n`];
  for (const f of results) {
    lines.push(`- \`${f.path}\` (${f.language}, ${f.node_count} symbols, ${(f.size / 1024).toFixed(1)} KB)`);
  }
  return lines.join('\n');
}

async function getStatus(db: D1Database, repo: string): Promise<string> {
  const [nRes, eRes, fRes, rRes] = await db.batch([
    db.prepare(`SELECT COUNT(*) as c, COUNT(DISTINCT kind) as k FROM nodes WHERE repo = ?`).bind(repo),
    db.prepare(`SELECT COUNT(*) as c, COUNT(DISTINCT kind) as k FROM edges WHERE repo = ?`).bind(repo),
    db.prepare(`SELECT COUNT(*) as c, COUNT(DISTINCT language) as l FROM files WHERE repo = ?`).bind(repo),
    db.prepare(`SELECT * FROM repositories WHERE full_name = ?`).bind(repo),
  ]);

  type Counts   = { c: number; k?: number; l?: number };
  type RepoInfo = { indexed_at: number | null; commit_sha: string | null };

  const n = (nRes.results[0] ?? { c: 0, k: 0 }) as Counts;
  const e = (eRes.results[0] ?? { c: 0, k: 0 }) as Counts;
  const f = (fRes.results[0] ?? { c: 0, l: 0 }) as Counts;
  const r = (rRes.results[0] ?? {})              as RepoInfo;

  const lines = [
    `## CodeGraph status: ${repo}`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Nodes | ${n.c} (${n.k} kinds) |`,
    `| Edges | ${e.c} (${e.k} kinds) |`,
    `| Files | ${f.c} (${f.l} languages) |`,
  ];

  if (r.indexed_at) {
    lines.push(`| Last indexed | ${new Date(r.indexed_at).toISOString()} |`);
    if (r.commit_sha) lines.push(`| Commit | \`${r.commit_sha.slice(0, 8)}\` |`);
  } else {
    lines.push(`| Last indexed | *not yet indexed* |`);
  }

  return lines.join('\n');
}
