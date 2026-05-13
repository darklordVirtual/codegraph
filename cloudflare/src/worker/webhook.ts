import type { Env } from './index';

// ── Types ──────────────────────────────────────────────────────

interface PushEvent {
  ref: string;
  after: string;
  repository: { full_name: string; default_branch: string };
  installation?: { id: number };
}

interface InstallationEvent {
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'new_permissions_accepted';
  installation: { id: number; account: { login: string } };
  repositories?: Array<{ full_name: string; private: boolean }>;
}

interface InstallationReposEvent {
  action: 'added' | 'removed';
  installation: { id: number };
  repositories_added?: Array<{ full_name: string }>;
}

// ── Entry ──────────────────────────────────────────────────────

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const event     = request.headers.get('X-GitHub-Event') ?? '';
  const signature = request.headers.get('X-Hub-Signature-256') ?? '';
  const body      = await request.text();

  if (env.GITHUB_WEBHOOK_SECRET) {
    if (!(await verifyHmac(body, signature, env.GITHUB_WEBHOOK_SECRET))) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const payload = JSON.parse(body);

  switch (event) {
    case 'push':
      await onPush(payload as PushEvent, env);
      break;

    case 'installation':
      await onInstallation(payload as InstallationEvent, env);
      break;

    case 'installation_repositories':
      await onInstallationRepos(payload as InstallationReposEvent, env);
      break;
  }

  return new Response('OK', { status: 200 });
}

// ── Push handler ───────────────────────────────────────────────

async function onPush(payload: PushEvent, env: Env): Promise<void> {
  const branch = payload.ref.replace('refs/heads/', '');
  if (branch !== payload.repository.default_branch) return;

  // Record commit SHA so MCP /status shows the indexed commit
  await env.DB.prepare(
    `INSERT OR REPLACE INTO repositories (full_name, owner, name, commit_sha)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(
      payload.repository.full_name,
      payload.repository.full_name.split('/')[0],
      payload.repository.full_name.split('/')[1],
      payload.after,
    )
    .run();

  // Trigger GitHub Actions workflow to re-index
  if (env.GITHUB_TOKEN) {
    await triggerWorkflow(
      payload.repository.full_name,
      payload.repository.default_branch,
      payload.after,
      env.GITHUB_TOKEN,
    );
  }
}

// ── Installation handlers ──────────────────────────────────────
// When a user installs the GitHub App, we:
//   1. Create .github/workflows/codegraph-index.yml in each new repo
//   2. Trigger the first index run (once the user sets their CF secrets)

async function onInstallation(payload: InstallationEvent, env: Env): Promise<void> {
  if (payload.action !== 'created') return;

  const repos = payload.repositories ?? [];
  for (const repo of repos) {
    await bootstrapRepo(repo.full_name, env);
  }
}

async function onInstallationRepos(payload: InstallationReposEvent, env: Env): Promise<void> {
  if (payload.action !== 'added') return;

  const repos = payload.repositories_added ?? [];
  for (const repo of repos) {
    await bootstrapRepo(repo.full_name, env);
  }
}

// ── Bootstrap a newly-installed repo ──────────────────────────

// Workflow file content (the same template users can copy manually).
// Inlined here so the Worker is self-contained.
const WORKFLOW_YML = `# Added automatically by CodeGraph GitHub App
# Set these three secrets in your repo (Settings → Secrets → Actions):
#   CLOUDFLARE_API_TOKEN
#   CLOUDFLARE_ACCOUNT_ID
#   D1_DATABASE_ID
# Then push to main — indexing starts automatically.

name: CodeGraph index

on:
  push:
    branches: [main, master]
    paths-ignore: ['**.md', '.github/workflows/**']
  workflow_dispatch:
    inputs:
      commit_sha:
        description: 'Commit SHA to record'
        required: false

concurrency:
  group: codegraph-index-\${{ github.repository }}
  cancel-in-progress: true

jobs:
  index:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install CodeGraph
        run: npm install -g @colbymchenry/codegraph@latest
      - name: Index
        run: codegraph index .
      - name: Download uploader
        run: |
          mkdir -p /tmp/cg-upload
          curl -sSfL https://raw.githubusercontent.com/darklordVirtual/codegraph/main/scripts/upload-to-d1.mjs -o /tmp/cg-upload/upload-to-d1.mjs
          curl -sSfL https://raw.githubusercontent.com/darklordVirtual/codegraph/main/scripts/package.json    -o /tmp/cg-upload/package.json
          cd /tmp/cg-upload && npm install --production
      - name: Upload to D1
        env:
          REPO: \${{ github.repository }}
          CLOUDFLARE_API_TOKEN:   \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID:  \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          D1_DATABASE_ID:         \${{ secrets.D1_DATABASE_ID }}
          GITHUB_SHA:             \${{ inputs.commit_sha || github.sha }}
          DB_PATH:                \${{ github.workspace }}/.codegraph/index.db
        run: node /tmp/cg-upload/upload-to-d1.mjs
`;

async function bootstrapRepo(fullName: string, env: Env): Promise<void> {
  if (!env.GITHUB_TOKEN) {
    console.warn(`No GITHUB_TOKEN — cannot bootstrap ${fullName}`);
    return;
  }

  const filePath = '.github/workflows/codegraph-index.yml';
  const apiBase  = `https://api.github.com/repos/${fullName}`;
  const headers  = {
    Authorization:          `Bearer ${env.GITHUB_TOKEN}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
    'User-Agent':           'codegraph-worker/1.0',
  };

  // Check if workflow already exists
  const existing = await fetch(`${apiBase}/contents/${filePath}`, { headers });
  if (existing.ok) {
    console.log(`Workflow already exists in ${fullName} — skipping`);
    return;
  }

  // Create the workflow file
  const content = btoa(WORKFLOW_YML);
  const res = await fetch(`${apiBase}/contents/${filePath}`, {
    method:  'PUT',
    headers,
    body: JSON.stringify({
      message: 'ci: add CodeGraph indexing workflow [skip ci]',
      content,
    }),
  });

  if (res.ok) {
    console.log(`Bootstrapped ${fullName} with codegraph-index.yml`);
  } else {
    const text = await res.text();
    console.error(`Failed to bootstrap ${fullName}: ${res.status} ${text}`);
  }

  // Record the repo in D1
  await env.DB.prepare(
    `INSERT OR IGNORE INTO repositories (full_name, owner, name)
     VALUES (?, ?, ?)`,
  )
    .bind(fullName, fullName.split('/')[0], fullName.split('/')[1])
    .run();
}

// ── Shared helpers ─────────────────────────────────────────────

async function triggerWorkflow(
  fullName: string,
  branch:   string,
  sha:      string,
  token:    string,
): Promise<void> {
  const [owner, repo] = fullName.split('/');
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/codegraph-index.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization:          `Bearer ${token}`,
        Accept:                 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type':         'application/json',
        'User-Agent':           'codegraph-worker/1.0',
      },
      body: JSON.stringify({ ref: branch, inputs: { commit_sha: sha } }),
    },
  );
  if (!res.ok && res.status !== 422) {
    console.error(`workflow_dispatch failed: ${res.status} ${await res.text()}`);
  }
}

async function verifyHmac(body: string, signature: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  const mac      = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const expected = 'sha256=' + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');

  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
