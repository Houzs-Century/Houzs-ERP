#!/usr/bin/env node
// Emergency production deploy — the ONLY sanctioned way to deploy outside
// GitHub Actions. Exists for exactly one scenario: Actions cannot run (minutes
// exhausted, GitHub outage) and a release cannot wait. For everything else,
// merge to main and let deploy.yml do its job.
//
// Why this is a script and not "just run wrangler": four rogue deploys have
// overwritten prod from stale clones (see deploy-watchdog.yml's header). Every
// one of them was a bare `wrangler deploy` / `pages deploy` with ambient
// credentials, no freshness check, and no trail. This script makes the
// emergency path do what CI does:
//
//   · refuses to run unless HEAD == origin/main tip and the tree is clean
//   · refuses ambient OAuth — CLOUDFLARE_API_TOKEN must be set explicitly
//     (take it from the password manager for this shell only, then close it)
//   · runs the same gates as deploy.yml (audit:routes, typecheck, tests,
//     pg-migrate, smoke checks)
//   · stamps the Worker with GIT_SHA so deploy-watchdog recognises the deploy
//     as legitimate instead of dispatching a "rogue overwrite" redeploy
//   · leaves a trail nobody has to go digging in the Cloudflare dashboard
//     for: an annotated `emergency-deploy/<stamp>` tag and a GitHub issue
//
// Usage:  node scripts/emergency-deploy.mjs --reason "why" [flags]
// Runbook with prerequisites and flag semantics: docs/emergency-deploy.md

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir, userInfo, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_SMOKE_URL = process.env.SMOKE_URL || 'https://autocount-sync-api.houzs-erp.workers.dev';
const FRONTEND_SMOKE_URL = process.env.FRONTEND_SMOKE_URL || 'https://erp.houzscentury.com';

// ---------- tiny exec helpers -------------------------------------------------
// npm/npx/gh are .cmd shims on Windows, so shelled execSync is the portable
// path. Every interpolated value below is program-derived (shas, URLs, paths);
// the only user-supplied text (--reason) travels via --body-file / -F, never
// through a shell string.
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}${opts.cwd ? `   (in ${opts.cwd})` : ''}`);
  execSync(cmd, { stdio: 'inherit', cwd: opts.cwd || repoRoot, env: { ...process.env, ...opts.env } });
}
function capture(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', cwd: opts.cwd || repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', cwd: repoRoot }).trim();
}
const die = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };
const warn = (msg) => console.warn(`\n⚠ ${msg}`);

// ---------- args --------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
if (has('-h') || has('--help')) {
  console.log(`Emergency prod deploy (see docs/emergency-deploy.md)

  node scripts/emergency-deploy.mjs --reason "<why>" [--backend-only|--frontend-only]
      [--yes] [--skip-tests] [--skip-migrations] [--ignore-active-runs]

  --reason              required; goes into the tag and the trail issue
  --backend-only        deploy only the Worker
  --frontend-only       deploy only the Pages site
  --yes                 skip the interactive confirmation
  --skip-tests          skip typecheck+tests (main already passed PR CI; use
                        only when local vitest flakes — see runbook)
  --skip-migrations     backend without DATABASE_URL; ONLY safe when no
                        migration merged since the last successful deploy
  --ignore-active-runs  proceed despite queued/in-progress Deploy runs (only
                        when they are quota-stuck; cancel them first if you can)`);
  process.exit(0);
}
const reason = valueOf('--reason');
if (!reason) die('--reason "<why>" is required — it becomes the audit trail.');
if (has('--backend-only') && has('--frontend-only')) die('Pick one of --backend-only / --frontend-only.');
const doBackend = !has('--frontend-only');
const doFrontend = !has('--backend-only');
const skipTests = has('--skip-tests');

// ---------- preflight ---------------------------------------------------------
console.log('— Preflight —');

if (!process.env.CLOUDFLARE_API_TOKEN) {
  die(`CLOUDFLARE_API_TOKEN is not set.
This script refuses ambient wrangler OAuth on purpose: the deploy credential
lives in the password manager, not on machines. Fetch it, then for THIS shell:
  PowerShell:  $env:CLOUDFLARE_API_TOKEN = "<token>"
and re-run. Close the shell when done.`);
}

// The account id is already committed in backend/wrangler.toml; exporting it
// spares `pages deploy` an account-picker prompt when the token can see more
// than one account.
const acctMatch = readFileSync(join(repoRoot, 'backend', 'wrangler.toml'), 'utf8').match(/^account_id\s*=\s*"([0-9a-f]+)"/m);
if (acctMatch && !process.env.CLOUDFLARE_ACCOUNT_ID) process.env.CLOUDFLARE_ACCOUNT_ID = acctMatch[1];

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor !== 22) warn(`CI builds on Node 22, you are on ${process.versions.node} — proceeding, but a build difference is on you.`);

try { git('fetch', 'origin'); } catch { die('git fetch origin failed — no network or no repo access. Cannot verify freshness, refusing to deploy.'); }

const head = git('rev-parse', 'HEAD');
const mainTip = git('rev-parse', 'origin/main');
if (head !== mainTip) {
  die(`HEAD (${head.slice(0, 9)}) != origin/main tip (${mainTip.slice(0, 9)}).
This is the stale-clone rollback scenario this script exists to prevent.
Check out main and fast-forward first:  git checkout main && git pull --ff-only`);
}
const dirty = git('status', '--porcelain');
if (dirty) die(`Working tree is not clean — an emergency deploy builds EXACTLY origin/main, nothing else.\n${dirty}`);

// gh powers the trail (issue) and the VITE_* variable fetch. Actions minutes
// being exhausted does NOT block the REST API, so in the intended scenario
// this works; if gh itself is broken you'll get manual instructions later.
let ghOk = true;
try { capture('gh auth status'); } catch { ghOk = false; warn('gh CLI not authenticated — variable fetch and the trail issue will need manual fallback.'); }

// Racing a live CI deploy would recreate the 2026-07-22 queue-reorder mess.
if (ghOk) {
  try {
    const active = capture('gh run list --workflow deploy.yml --branch main --status in_progress --json databaseId --jq length');
    const queued = capture('gh run list --workflow deploy.yml --branch main --status queued --json databaseId --jq length');
    if (active !== '0' || queued !== '0') {
      const msg = `Deploy runs are active (in_progress=${active}, queued=${queued}).`;
      if (has('--ignore-active-runs')) warn(`${msg} Proceeding because --ignore-active-runs was passed.`);
      else die(`${msg}\nIf they are genuinely stuck on quota, cancel them (gh run cancel <id>) or pass --ignore-active-runs.`);
    }
  } catch { warn('Could not query active Deploy runs — proceeding blind.'); }
}

if (doBackend && !process.env.DATABASE_URL && !has('--skip-migrations')) {
  die(`DATABASE_URL is not set, so pending Postgres migrations cannot be applied,
and deploying a Worker whose schema hasn't landed is how deploys break.
Either fetch the prod connection string from the password manager and set it
for this shell, or — ONLY if you are certain no migration merged since the
last successful deploy — pass --skip-migrations.`);
}
const envProdStrays = readdirSync(join(repoRoot, 'frontend')).filter((f) => f.startsWith('.env.production'));
if (doFrontend && envProdStrays.length) {
  warn(`frontend/${envProdStrays.join(', ')} exist. VITE_API_URL passed via process env still wins, but stray keys in those files WILL leak into this build.`);
}

// ---------- confirm -----------------------------------------------------------
const scope = doBackend && doFrontend ? 'backend + frontend' : doBackend ? 'backend only' : 'frontend only';
console.log(`
— About to EMERGENCY-DEPLOY to PRODUCTION —
  commit : ${head}  (origin/main tip)
  scope  : ${scope}
  reason : ${reason}
  tests  : ${skipTests ? 'SKIPPED (--skip-tests)' : 'will run'}
  pg-mig : ${doBackend ? (process.env.DATABASE_URL ? 'will run' : 'SKIPPED (--skip-migrations)') : 'n/a'}
`);
if (!has('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question('Type "deploy" to continue: ', res));
  rl.close();
  if (answer.trim() !== 'deploy') die('Aborted.');
}

// ---------- deploy ------------------------------------------------------------
// Mirrors deploy.yml step for step. If a later phase fails after an earlier
// one shipped, the trail below still gets written — a partial emergency
// deploy with no record is the worst possible outcome.
const deployed = [];
let failure = null;
try {
  if (doBackend) {
    const cwd = join(repoRoot, 'backend');
    console.log('\n— Backend (Worker) —');
    run('npm ci', { cwd });
    run('npm run audit:routes', { cwd });
    if (!skipTests) {
      run('npm run typecheck', { cwd });
      run('npm test', { cwd });
    }
    if (process.env.DATABASE_URL) run('node scripts/pg-migrate.mjs', { cwd });
    // The GIT_SHA stamp is what separates this from a rogue deploy: it is how
    // deploy-watchdog verifies the live Worker against main.
    run(`npx wrangler deploy --var GIT_SHA:${head}`, { cwd });
    // Worker secrets (FORM_INTAKE_KEY etc.) persist across deploys; CI re-pushes
    // them idempotently but an emergency deploy has no business holding them.
    run(`node scripts/smoke-check.mjs ${q(BACKEND_SMOKE_URL)}`, { cwd });
    deployed.push('backend');
  }

  if (doFrontend) {
    const cwd = join(repoRoot, 'frontend');
    console.log('\n— Frontend (Pages) —');
    run('npm ci', { cwd });
    if (!skipTests) {
      run('npm run typecheck', { cwd });
      run('npm test', { cwd });
    }
    // Same build-time variables CI injects. They are repo VARIABLES (public by
    // design, baked into client JS), so gh is allowed to hand them out.
    let viteApiUrl = process.env.VITE_API_URL;
    if (!viteApiUrl && ghOk) { try { viteApiUrl = capture('gh variable get VITE_API_URL'); } catch { /* fall through */ } }
    if (!viteApiUrl) die('VITE_API_URL unavailable (env unset, gh fetch failed) — refusing to guess the prod API origin.');
    let mapsKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!mapsKey && ghOk) { try { mapsKey = capture('gh variable get VITE_GOOGLE_MAPS_API_KEY'); } catch { /* optional: map degrades gracefully */ } }
    run('npm run build', { cwd, env: { VITE_API_URL: viteApiUrl, ...(mapsKey ? { VITE_GOOGLE_MAPS_API_KEY: mapsKey } : {}) } });
    run('npm run check:sw', { cwd });
    run('npx wrangler pages deploy ./dist --project-name=houzs-erp --commit-dirty=true', { cwd });
    run(`npm run smoke -- ${q(FRONTEND_SMOKE_URL)}`, { cwd, env: { FRONTEND_SMOKE_ATTEMPTS: '20', FRONTEND_SMOKE_RETRY_MS: '5000' } });
    deployed.push('frontend');
  }
} catch (err) {
  failure = err;
}

// ---------- trail -------------------------------------------------------------
// Cloudflare's dashboard records direct uploads, but nobody is notified and
// nobody looks there — 7-23's rogue deploy took a manual audit to find. The
// tag + issue put the record where everyone already is: the repo.
if (deployed.length) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const tagName = `emergency-deploy/${stamp}`;
  const status = failure ? `PARTIAL (${deployed.join('+')} shipped, then a later step FAILED)` : `complete (${deployed.join(' + ')})`;
  const operator = `${userInfo().username}@${hostname()}`;
  const body = `**Emergency deploy — outside GitHub Actions.**

| | |
|---|---|
| status | ${status} |
| commit | ${head} (origin/main tip at deploy time) |
| scope | ${deployed.join(' + ')} |
| reason | ${reason} |
| operator | ${operator} |
| tests | ${skipTests ? 'skipped (--skip-tests; main had green PR CI)' : 'ran locally'} |
| pg migrations | ${deployed.includes('backend') ? (process.env.DATABASE_URL ? 'applied' : 'SKIPPED — verify none were pending!') : 'n/a'} |
| tag | \`${tagName}\` |

Deployed via \`scripts/emergency-deploy.mjs\` (docs/emergency-deploy.md). The
Worker carries the GIT_SHA stamp above, so deploy-watchdog treats it as
legitimate. Next merge to main redeploys normally over this.${failure ? '\n\n**A later step failed — read the operator\'s terminal output before assuming prod is coherent.**' : ''}`;

  try {
    git('tag', '-a', tagName, '-m', `Emergency deploy: ${scope} @ ${head.slice(0, 9)} — ${reason}`);
    git('push', 'origin', tagName);
    console.log(`\n✔ trail tag pushed: ${tagName}`);
  } catch {
    warn(`Could not push tag. Do it manually:\n  git tag -a ${tagName} -m "emergency deploy" && git push origin ${tagName}`);
  }
  const bodyFile = join(tmpdir(), `emg-deploy-${stamp}.md`);
  writeFileSync(bodyFile, body);
  try {
    if (!ghOk) throw new Error('gh unauthenticated');
    run(`gh issue create --title ${q(`Emergency deploy ${stamp} — ${head.slice(0, 9)} (${deployed.join('+')}${failure ? ', PARTIAL' : ''})`)} --body-file ${q(bodyFile)}`);
  } catch {
    warn(`Could not create the trail issue. Create it manually with the body saved at:\n  ${bodyFile}`);
  } finally {
    try { rmSync(bodyFile); } catch { /* body already surfaced in the issue or the warning above */ }
  }
}

if (failure) {
  console.error(`\n✖ Deploy FAILED after: ${deployed.join('+') || 'nothing shipped'}.`);
  console.error(String(failure.message || failure));
  process.exit(1);
}
console.log(`\n✔ Emergency deploy complete: ${deployed.join(' + ')} @ ${head.slice(0, 9)}. Unset CLOUDFLARE_API_TOKEN / close this shell now.`);
