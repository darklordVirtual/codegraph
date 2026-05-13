#!/usr/bin/env node
/**
 * npm run setup
 *
 * First-time wizard:
 *  1. npm install
 *  2. wrangler deploy → captures Worker URL
 *  3. Generates MCP_AUTH_TOKEN
 *  4. Prompts for optional GitHub PAT
 *  5. Sets all Worker secrets via wrangler
 *  6. Saves config to .env.local  (used by add-repo + configure-mcp)
 *  7. Prints next steps
 */

import { spawnSync, execSync } from 'child_process';
import { randomBytes }         from 'crypto';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { createInterface }     from 'readline';
import path                    from 'path';
import { fileURLToPath }       from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── helpers ────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, fallback = '') => new Promise(res =>
  rl.question(q, ans => res(ans.trim() || fallback))
);
const dim  = s => `\x1b[2m${s}\x1b[0m`;
const bold = s => `\x1b[1m${s}\x1b[0m`;
const ok   = s => `\x1b[32m✓\x1b[0m ${s}`;
const step = s => console.log(`\n\x1b[34m▶\x1b[0m ${bold(s)}`);
const die  = s => { console.error(`\x1b[31m✗\x1b[0m ${s}`); process.exit(1); };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['inherit','pipe','pipe'], ...opts });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function setSecret(name, value) {
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    input: value + '\n',
    encoding: 'utf8',
    cwd: ROOT,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (r.status !== 0) die(`Failed to set secret ${name}`);
}

function saveEnv(vars) {
  const existing = existsSync(`${ROOT}/.env.local`)
    ? Object.fromEntries(
        readFileSync(`${ROOT}/.env.local`, 'utf8')
          .split('\n').filter(l => l.includes('='))
          .map(l => l.split('=').map(p => p.trim()))
      )
    : {};
  const merged = { ...existing, ...vars };
  writeFileSync(
    `${ROOT}/.env.local`,
    Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
  );
}

// ── main ───────────────────────────────────────────────────────

console.log('\n' + bold('CodeGraph → Cloudflare setup wizard') + '\n');

// 1. Dependencies
step('Installing Worker dependencies');
const npmInstall = run('npm', ['install'], { cwd: ROOT, stdio: 'inherit' });
if (!npmInstall.ok) die('npm install failed');

// 2. Deploy
step('Deploying Cloudflare Worker  (wrangler deploy)');
const deploy = spawnSync('npx', ['wrangler', 'deploy'], {
  encoding: 'utf8',
  cwd: ROOT,
  stdio: ['inherit', 'pipe', 'pipe'],
});
if (deploy.status !== 0) {
  console.error(deploy.stderr);
  die('wrangler deploy failed — run `npx wrangler login` first if not authenticated.');
}

const workerUrlMatch = (deploy.stdout + deploy.stderr).match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/);
const workerUrl = workerUrlMatch ? workerUrlMatch[0] : null;
if (workerUrl) console.log(ok(`Worker live at ${bold(workerUrl)}`));
else console.log(dim('(Could not auto-detect Worker URL — check Cloudflare dashboard)'));

// 3. MCP auth token
step('Generating MCP auth token');
const existingEnv   = existsSync(`${ROOT}/.env.local`) ? readFileSync(`${ROOT}/.env.local`, 'utf8') : '';
const existingToken = (existingEnv.match(/MCP_AUTH_TOKEN=(.+)/) || [])[1];
const mcpToken = existingToken || randomBytes(24).toString('hex');
if (existingToken) console.log(dim('(re-using existing token from .env.local)'));
else console.log(ok('Generated MCP_AUTH_TOKEN'));

// 4. Optional GitHub PAT
step('GitHub Personal Access Token  (optional — needed for webhook-triggered re-index)');
console.log(dim('  Needs scopes: repo, workflow'));
console.log(dim('  Create at: https://github.com/settings/tokens/new'));
const ghToken = await ask('  GitHub PAT (press Enter to skip): ');

// 5. Optional webhook secret
step('GitHub webhook secret  (optional — verifies webhook payloads)');
const whSecret = await ask('  Webhook secret (press Enter to generate): ')
  || randomBytes(16).toString('hex');

rl.close();

// 6. Set Worker secrets
step('Setting Worker secrets');
setSecret('MCP_AUTH_TOKEN', mcpToken);
console.log(ok('MCP_AUTH_TOKEN'));

setSecret('GITHUB_WEBHOOK_SECRET', whSecret);
console.log(ok('GITHUB_WEBHOOK_SECRET'));

if (ghToken) {
  setSecret('GITHUB_TOKEN', ghToken);
  console.log(ok('GITHUB_TOKEN'));
}

// 7. Save .env.local  (used by add-repo + configure-mcp)
const envVars = {
  WORKER_URL:              workerUrl || '',
  MCP_AUTH_TOKEN:          mcpToken,
  GITHUB_WEBHOOK_SECRET:   whSecret,
  CLOUDFLARE_ACCOUNT_ID:   'ca139047698b35c49bc921b778cd26b1',
  D1_DATABASE_ID:          '1555e587-2b51-4f85-b3e4-691f3dcaecd4',
};
if (ghToken) envVars.GITHUB_TOKEN = ghToken;
saveEnv(envVars);
console.log(ok('.env.local written'));

// 8. Summary
console.log('\n' + bold('─'.repeat(60)));
console.log(bold('Setup complete!'));
console.log('');
if (workerUrl) {
  console.log(`Worker URL : ${bold(workerUrl)}`);
}
console.log(`MCP token  : ${bold(mcpToken)}`);
console.log('');
console.log('Next steps:');
console.log('  1. Index a repo:');
console.log(bold(`       npm run add-repo owner/reponame`));
console.log('  2. Wire Claude Code:');
console.log(bold(`       npm run configure-mcp owner/reponame`));
if (!ghToken) {
  console.log('');
  console.log(dim('  Tip: re-run setup with a GitHub PAT to enable auto re-index on push.'));
}
console.log('');
