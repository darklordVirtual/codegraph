#!/usr/bin/env node
/**
 * npm run add-repo owner/repo
 *
 * Onboards a GitHub repository:
 *  1. Sets the 3 required CF secrets on the GitHub repo (via gh CLI)
 *  2. Creates/updates .github/workflows/codegraph-index.yml in the repo
 *  3. Triggers the first index run
 *  4. Prints the MCP config snippet
 *
 * Requires:
 *  - gh CLI  (https://cli.github.com)
 *  - .env.local  (created by `npm run setup`)
 */

import { spawnSync }        from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath }    from 'url';
import path                 from 'path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const bold = s => `\x1b[1m${s}\x1b[0m`;
const ok   = s => `\x1b[32m✓\x1b[0m ${s}`;
const warn = s => `\x1b[33m⚠\x1b[0m ${s}`;
const die  = s => { console.error(`\x1b[31m✗\x1b[0m ${s}`); process.exit(1); };

// ── Load config ────────────────────────────────────────────────

const REPO = process.argv[2];
if (!REPO || !REPO.includes('/')) {
  die('Usage: npm run add-repo owner/repo');
}

if (!existsSync(`${ROOT}/.env.local`)) {
  die('.env.local not found — run `npm run setup` first.');
}

const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env.local`, 'utf8')
    .split('\n').filter(l => l.includes('='))
    .map(l => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const WORKER_URL    = env.WORKER_URL    || '';
const MCP_TOKEN     = env.MCP_AUTH_TOKEN || '';
const CF_API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN  || env.CLOUDFLARE_API_TOKEN  || '';
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || '';
const D1_DB_ID      = process.env.D1_DATABASE_ID         || env.D1_DATABASE_ID         || '';

if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !D1_DB_ID) {
  die(
    'Missing CF credentials.\n' +
    '  Set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID in .env.local or environment.'
  );
}

// ── gh CLI check ───────────────────────────────────────────────

function gh(args, opts = {}) {
  const r = spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: opts.silent ? 'pipe' : ['inherit', 'pipe', 'pipe'],
    ...opts,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const ghCheck = gh(['auth', 'status'], { silent: true });
if (!ghCheck.ok) die('gh CLI not authenticated. Run: gh auth login');

// ── 1. Set GitHub repo secrets ─────────────────────────────────

console.log(`\n\x1b[34m▶\x1b[0m ${bold(`Onboarding ${REPO}`)}\n`);
console.log('Setting GitHub repo secrets...');

function setGhSecret(name, value) {
  const r = spawnSync('gh', ['secret', 'set', name, '--body', value, '--repo', REPO], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    console.warn(warn(`Could not set secret ${name}: ${r.stderr.trim()}`));
    return false;
  }
  console.log(ok(`  ${name}`));
  return true;
}

setGhSecret('CLOUDFLARE_API_TOKEN',  CF_API_TOKEN);
setGhSecret('CLOUDFLARE_ACCOUNT_ID', CF_ACCOUNT_ID);
setGhSecret('D1_DATABASE_ID',        D1_DB_ID);

// ── 2. Create workflow file in the repo ────────────────────────

console.log('\nCreating .github/workflows/codegraph-index.yml...');

// Workflow lives at repo root: cloudflare/../.github/workflows/codegraph-index.yml
const workflowContent = readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'codegraph-index.yml'), 'utf8');
const workflowBase64  = Buffer.from(workflowContent).toString('base64');

// Check if file already exists (need its SHA to update)
const getFile = gh([
  'api', `repos/${REPO}/contents/.github/workflows/codegraph-index.yml`,
  '--silent',
], { silent: true });

const existingSha = getFile.ok
  ? JSON.parse(getFile.stdout).sha
  : null;

const payload = JSON.stringify({
  message: 'ci: add CodeGraph indexing workflow',
  content: workflowBase64,
  ...(existingSha ? { sha: existingSha } : {}),
});

const putFile = spawnSync('gh', [
  'api',
  `repos/${REPO}/contents/.github/workflows/codegraph-index.yml`,
  '--method', 'PUT',
  '--input', '-',
], {
  input:    payload,
  encoding: 'utf8',
  stdio:    ['pipe', 'pipe', 'pipe'],
});

if (putFile.status === 0) {
  console.log(ok(existingSha ? 'Workflow updated' : 'Workflow created'));
} else {
  console.warn(warn(`Could not create workflow file: ${putFile.stderr.trim()}`));
  console.warn(warn('You may need a GitHub token with `repo` + `workflow` scopes.'));
}

// ── 3. Trigger first index run ─────────────────────────────────

console.log('\nTriggering first index run...');
const dispatch = gh([
  'workflow', 'run', 'codegraph-index.yml',
  '--repo', REPO,
]);
if (dispatch.ok) {
  console.log(ok('Workflow dispatched — check Actions tab in GitHub'));
} else {
  console.warn(warn('Could not dispatch workflow (will run on next push)'));
}

// ── 4. Print MCP config snippet ────────────────────────────────

const mcpUrl = WORKER_URL
  ? `${WORKER_URL}/${REPO}/mcp`
  : `https://codegraph.YOUR_SUBDOMAIN.workers.dev/${REPO}/mcp`;

console.log(`
${bold('─'.repeat(60))}
${bold('Done!')}  Add this to your MCP client config:

${bold('Claude Code  (~/.claude/settings.json):')}
{
  "mcpServers": {
    "codegraph-${REPO.replace('/', '-')}": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}

${bold('Or run:')}  npm run configure-mcp ${REPO}
`);
