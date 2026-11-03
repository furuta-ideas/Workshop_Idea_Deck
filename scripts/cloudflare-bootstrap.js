// Operator-only, one-use migration. Secrets are passed to Wrangler through stdin
// and to the dedicated Worker via HTTPS; never printed or packaged as assets.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configuration } from '../server/index.js';
import { hash } from '../server/store.js';
import { parseFacilitator } from '../server/facilitator.js';
const action = process.argv[2],
  config = configuration(),
  keyFile = config.dataDir + '/cloud-migration-key',
  originFile = config.dataDir + '/cloud-origin.json';
const originArg = process.argv.find((a) => a.startsWith('--origin='))?.slice(9);
const origin = originArg || (existsSync(originFile) && JSON.parse(readFileSync(originFile)).origin);
if (!origin || !/^https:\/\/workshop-idea-deck\.[a-z0-9-]+\.workers\.dev$/.test(origin))
  throw Error('Dedicated Worker origin required');
function wrangler(args, input) {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
      ...args,
      '--name',
      'workshop-idea-deck',
    ],
    {
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
        WRANGLER_SEND_METRICS: 'false',
      },
    },
  );
  if (result.status !== 0) {
    writeFileSync(
      config.dataDir + '/cloud-migration-error.log',
      (result.stdout || '') + (result.stderr || ''),
    );
    throw Error('Wrangler operation failed; see private data/cloud-migration-error.log');
  }
}
async function call(suffix, body = {}) {
  const token = readFileSync(keyFile, 'utf8');
  const response = await fetch(origin + '/api/_bootstrap' + suffix, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw Error('Worker operator request failed: HTTP ' + response.status);
  return response.json();
}
function snapshot() {
  const db = new DatabaseSync(config.dataDir + '/workshop.sqlite', { readOnly: true }),
    data = {};
  for (const table of ['users', 'workshops', 'kv'])
    data[table] = db
      .prepare(`SELECT ${table === 'users' ? 'email' : 'id'},body FROM ${table}`)
      .all();
  db.close();
  data.facilitator = readFileSync(config.dataDir + '/ai-facilitator.md', 'utf8');
  parseFacilitator(data.facilitator);
  return data;
}
if (action === 'configure') {
  if (!existsSync(keyFile))
    writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const secrets = {
    APP_ORIGIN: origin,
    RP_ID: new URL(origin).hostname,
    SECURE_COOKIE: 'true',
    MIGRATION_TOKEN: readFileSync(keyFile, 'utf8'),
  };
  for (const name of [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'SMTP_FROM',
    'NOTION_TOKEN',
    'NOTION_WORKSHOPS_SOURCE',
    'NOTION_POLL_SECONDS',
    'AI_APPROVED_PROVIDERS',
  ])
    if (process.env[name] !== undefined) secrets[name] = process.env[name];
  wrangler(['secret', 'bulk'], JSON.stringify(secrets));
  writeFileSync(originFile, JSON.stringify({ origin }));
  console.log(JSON.stringify({ configured: true, secretCount: Object.keys(secrets).length }));
} else if (action === 'probe') {
  const result = await call('?probe=1');
  console.log(JSON.stringify(result));
  if (!result.smtp || !result.notion) process.exitCode = 1;
} else if (action === 'import') {
  const result = await call('', snapshot());
  console.log(JSON.stringify(result));
} else if (action === 'verify') {
  const data = snapshot(),
    content = data.workshops.map((row) => {
      const w = JSON.parse(row.body);
      return {
        id: w.id,
        teams: w.teams,
        votes: w.votes,
        baseline: w.notionVoteBaseline,
        theme: w.theme,
      };
    });
  const result = await call('?verify=1');
  const contentPreserved = result.contentHash === hash(JSON.stringify(content)),
    facilitatorPreserved = result.facilitatorHash === hash(data.facilitator);
  console.log(JSON.stringify({ contentPreserved, facilitatorPreserved, topics: result.topics }));
  if (!contentPreserved || !facilitatorPreserved) process.exitCode = 1;
} else if (action === 'finish') {
  wrangler(['secret', 'delete', 'MIGRATION_TOKEN']);
  const token = readFileSync(keyFile, 'utf8');
  let removed = false;
  for (let i = 0; i < 15; i++) {
    const response = await fetch(origin + '/api/_bootstrap?verify=1', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (response.status === 404) {
      removed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!removed) throw Error('Migration credential removal has not propagated');
  unlinkSync(keyFile);
  console.log(JSON.stringify({ migrationCredentialRemoved: true }));
} else throw Error('Use configure, probe, import, verify, or finish');
