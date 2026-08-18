#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-worker-versions.mjs — which Worker VERSION is actually deployed, which
// versions are newer than it, and WHO created them.
//
// WHY THIS EXISTS. On 2026-08-18 production could not take a backend deploy for
// nine hours. Cloudflare refused `wrangler secret bulk` with:
//
//   Secret edit failed. You attempted to modify a secret, but the latest version
//   of your Worker isn't currently deployed. [code: 10215]
//
// That error is only reachable when something uploaded a Worker VERSION without
// deploying it. Nothing in this repository does that — `grep -rn "versions
// upload"` over the workflows and wrangler.toml is empty — so the cause is
// outside CI and the repo cannot answer it by reading itself. The alternative
// was to ask the owner to go and read the dashboard, which CLAUDE.md rules out:
// build the check instead.
//
// The answer is in `metadata.source` on each version — `wrangler`, `dash`,
// `api`, `terraform`, `workers_ci`, ... A version whose source is NOT the CI
// deploy, sitting above the active deployment, is the thing that wedges the
// pipeline. See docs/deploy-secret-version-deadlock-coe.md.
//
// READ-ONLY. Two GETs. No writes, no DDL, no deploy. Exits 0 for every
// legitimate answer — including "there is a stray version", which is a FINDING,
// not a broken check. Non-zero is reserved for "I could not reach Cloudflare",
// because a red job reads as "the check itself is broken".
//
// RE-RUN: idempotent. It changes nothing, so run it as often as you like.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node backend/scripts/check-worker-versions.mjs [--script autocount-sync-api]
// ---------------------------------------------------------------------------

const API = 'https://api.cloudflare.com/client/v4';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const SCRIPT = arg('script', 'autocount-sync-api');
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;

/* A verdict computed over nothing must never read as a pass. Missing
   credentials is "I could not look", not "nothing is wrong". */
if (!TOKEN || !ACCOUNT) {
  console.error('::error::check-worker-versions: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required. Nothing was checked.');
  process.exit(1);
}

/** Never interpolate the token into a message. Only ever a header. */
async function cf(path) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    console.error(`::error::check-worker-versions: could not reach Cloudflare (${e.name}: ${e.message}).`);
    process.exit(1);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const why = body?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') ?? `HTTP ${res.status}`;
    console.error(`::error::check-worker-versions: Cloudflare refused ${path} — ${why}`);
    process.exit(1);
  }
  return body.result;
}

const short = (id) => String(id ?? '').slice(0, 8);
const when = (v) => String(v?.metadata?.created_on ?? '').replace('T', ' ').slice(0, 16) || '?';
const source = (v) => v?.metadata?.source ?? 'unknown';
const author = (v) => v?.metadata?.author_email ?? '—';
/* The deploy stamps the commit as a var, so a CI-built version can be told from
   a hand-built one by more than its source label. */
const gitSha = (v) => {
  const b = v?.resources?.bindings ?? [];
  const hit = b.find((x) => x?.name === 'GIT_SHA');
  return hit?.text ? String(hit.text).slice(0, 8) : null;
};

const deployments = await cf(`/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/deployments`);
const versionList = await cf(`/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/versions`);
const versions = versionList?.items ?? versionList ?? [];

// Corpus size on the first line, so no count has to be typed into a doc.
console.log(`check-worker-versions: ${SCRIPT} — ${versions.length} version(s), ${(deployments?.deployments ?? []).length} deployment(s) returned.`);

const active = (deployments?.deployments ?? [])[0];
const activeIds = new Set((active?.versions ?? []).map((v) => v.version_id));

if (!active) {
  console.log('\nNo deployment returned. That is the finding — this Worker has never been deployed, or the token cannot see deployments.');
  process.exit(0);
}

console.log(`\nACTIVE deployment ${short(active.id)}  created ${String(active.created_on ?? '').replace('T', ' ').slice(0, 16)}  by ${active.author_email ?? '—'}`);
for (const v of active.versions ?? []) {
  console.log(`  serving ${short(v.version_id)}  ${Math.round((v.percentage ?? 100))}%`);
}

/* Cloudflare returns versions newest-first. Anything above the active one is a
   version that exists and is NOT serving — which is exactly the state that
   makes `wrangler secret bulk` fail 10215. */
const stray = [];
for (const v of versions) {
  if (activeIds.has(v.id)) break;
  stray.push(v);
}

console.log('\nVERSIONS (newest first, up to 10):');
for (const v of versions.slice(0, 10)) {
  const mark = activeIds.has(v.id) ? '<-- SERVING' : (stray.includes(v) ? '<-- NOT DEPLOYED' : '');
  const sha = gitSha(v);
  console.log(`  ${short(v.id)}  ${when(v)}  source=${source(v)}  by ${author(v)}${sha ? `  GIT_SHA=${sha}` : '  GIT_SHA=(none)'}  ${mark}`);
}

if (stray.length === 0) {
  console.log('\nVERDICT: the newest version IS the deployed one. `wrangler secret bulk` will not hit 10215 in this state.');
  process.exit(0);
}

console.log(`\nVERDICT: ${stray.length} version(s) sit ABOVE the active deployment. While that is true, Cloudflare refuses`);
console.log('secret edits with code 10215. Since 2026-08-18 the deploy publishes BEFORE uploading secrets, so a');
console.log('normal deploy clears this by itself — but the SOURCE below is what to fix, or it recurs every time:');
for (const v of stray) {
  console.log(`  ${short(v.id)}  ${when(v)}  source=${source(v)}  by ${author(v)}`);
}
console.log('\nA source of `wrangler` with no GIT_SHA is a bare hand-run deploy. `dash` is a dashboard edit.');
console.log('`workers_ci` means the Cloudflare git integration is building this Worker in parallel with GitHub Actions,');
console.log('which is the one worth switching off — two systems publishing one Worker will keep doing this.');
// A finding is an ANSWER, not a broken check.
process.exit(0);
