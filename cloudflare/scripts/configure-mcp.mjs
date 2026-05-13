#!/usr/bin/env node
/**
 * npm run configure-mcp owner/repo
 *
 * Adds (or updates) an MCP server entry for a repo in:
 *   ~/.claude/settings.json   (Claude Code global config)
 *
 * Safe: merges into existing config, never overwrites other keys.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const bold  = s => `\x1b[1m${s}\x1b[0m`;
const ok    = s => `\x1b[32m✓\x1b[0m ${s}`;
const die   = s => { console.error(`\x1b[31m✗\x1b[0m ${s}`); process.exit(1); };

// ── Args & config ──────────────────────────────────────────────

const REPO = process.argv[2];
if (!REPO || !REPO.includes('/')) die('Usage: npm run configure-mcp owner/repo');

if (!existsSync(`${ROOT}/.env.local`)) die('.env.local not found — run `npm run setup` first.');

const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env.local`, 'utf8')
    .split('\n').filter(l => l.includes('='))
    .map(l => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const WORKER_URL = env.WORKER_URL || '';
const MCP_TOKEN  = env.MCP_AUTH_TOKEN || '';

if (!WORKER_URL) die('WORKER_URL missing in .env.local — re-run `npm run setup`.');
if (!MCP_TOKEN)  die('MCP_AUTH_TOKEN missing in .env.local — re-run `npm run setup`.');

// ── Locate Claude Code settings ────────────────────────────────

const SETTINGS_PATH = path.join(homedir(), '.claude', 'settings.json');
const SETTINGS_DIR  = path.dirname(SETTINGS_PATH);

// ── Read existing settings ─────────────────────────────────────

let settings = {};
if (existsSync(SETTINGS_PATH)) {
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    die(`Could not parse ${SETTINGS_PATH}. Fix the JSON first.`);
  }
}

// ── Merge MCP entry ────────────────────────────────────────────

const serverKey  = `codegraph-${REPO.replace('/', '-')}`;
const mcpUrl     = `${WORKER_URL}/${REPO}/mcp`;

settings.mcpServers = settings.mcpServers ?? {};
const existing = settings.mcpServers[serverKey];

settings.mcpServers[serverKey] = {
  url: mcpUrl,
  headers: { Authorization: `Bearer ${MCP_TOKEN}` },
};

// ── Write back ─────────────────────────────────────────────────

mkdirSync(SETTINGS_DIR, { recursive: true });
writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');

console.log(`
${ok(existing ? `Updated  ${serverKey}` : `Added    ${serverKey}`)}
${ok(`Wrote to ${SETTINGS_PATH}`)}

${bold('MCP server:')}
  Name : ${serverKey}
  URL  : ${mcpUrl}

${bold('Claude Code will pick this up on next restart.')}
`);
