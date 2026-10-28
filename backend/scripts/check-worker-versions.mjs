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

/** Never interpolate the token into a message. Only ever a header.
 *
 *  `soft: true` returns null instead of exiting. Used ONLY for the per-version
 *  detail fetches: one unreadable version must not take down the answer to the
 *  question actually being asked (is the newest version deployed?). The two
 *  reads that ARE the answer stay hard — if either fails we know nothing, and
 *  saying nothing is the honest outcome. */
async function cf(path, { soft = false } = {}) {
  const fail = (msg) => {
    if (soft) return null;
    console.error(`::error::check-worker-versions: ${msg}`);
    process.exit(1);
  };
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return fail(`could not reach Cloudflare (${e.name}: ${e.message}).`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const why = body?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') ?? `HTTP ${res.status}`;
    return fail(`Cloudflare refused ${path} — ${why}`);
  }
  return body.result;
}

const short = (id) => String(id ?? '').slice(0, 8);
/* SECONDS, not minutes. The first run of this script printed `03:55` against two
   different versions and left the ORDER of the pair unknowable — and the order is
   the whole question when you are asking which of `deploy` and `secret bulk`
   created which version. Truncating a timestamp threw away the only field that
   answers it. */
const when = (v) => String(v?.metadata?.created_on ?? '').replace('T', ' ').slice(0, 19) || '?';
const source = (v) => v?.metadata?.source ?? 'unknown';
const author = (v) => v?.metadata?.author_email ?? '—';

/* GIT_SHA lives in the version's bindings, and THE LIST ENDPOINT DOES NOT RETURN
   BINDINGS. The first version of this script read `v.resources.bindings` off the
   list response, so every row printed `GIT_SHA=(none)` — including deploys that
   demonstrably set it, since /health serves that exact var. Harmless on its own;
   not harmless beside the line this script used to print, "a source of wrangler
   with no GIT_SHA is a bare hand-run deploy", which turned a field this script
   could not read into an accusation against every deploy we make.
   A column that cannot be populated must not be reported as a finding.

   So the value is fetched per version, and the three cases are kept apart:
     - a sha        -> stamped by CI
     - (none)       -> read the bindings, GIT_SHA genuinely absent = hand-run
     - (unreadable) -> the detail fetch failed; we do not know, and say so */
async function gitShaOf(versionId) {
  let detail;
  try {
    detail = await cf(`/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/versions/${versionId}`, { soft: true });
  } catch {
    return '(unreadable)';
  }
  if (!detail) return '(unreadable)';
  const bindings = detail?.resources?.bindings ?? detail?.bindings ?? [];
  const hit = bindings.find((x) => x?.name === 'GIT_SHA');
  const text = hit?.text ?? hit?.value;
  return text ? String(text).slice(0, 8) : '(none)';
}

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

const shown = versions.slice(0, 10);
/* One detail fetch per printed version, in parallel — ten small GETs, and the
   whole point of the column is that it is populated. */
const shas = await Promise.all(shown.map((v) => gitShaOf(v.id)));

console.log('\nVERSIONS (newest first, up to 10):');
shown.forEach((v, i) => {
  const mark = activeIds.has(v.id) ? '<-- SERVING' : (stray.includes(v) ? '<-- NOT DEPLOYED' : '');
  console.log(`  ${short(v.id)}  ${when(v)}  source=${source(v)}  by ${author(v)}  GIT_SHA=${shas[i]}  ${mark}`);
});

/* Two versions per deploy is NORMAL here, and it looked alarming until the
   seconds were printed. `wrangler deploy` creates one; the `secret bulk` step
   that follows it creates another, because in Cloudflare's model a secret change
   IS a new version. Both carry source=wrangler and the same CI author, so only
   the timestamp tells them apart — which is why `when` prints seconds. */
const stamps = shown.map((v) => String(v?.metadata?.created_on ?? ''));
const sameSecond = stamps.filter((s, i) => s && s === stamps[i + 1]).length;
if (sameSecond > 0) {
  console.log(`\nNote: ${sameSecond} adjacent pair(s) share a timestamp to the second. If that is every pair,`);
  console.log('the two-versions-per-deploy pattern is deploy + secret bulk, and is expected.');
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
console.log('\nReading the SOURCE column:');
console.log('  dash        a dashboard edit.');
console.log('  api         something driving the REST API directly.');
console.log('  workers_ci  the Cloudflare git integration is building this Worker IN PARALLEL with GitHub Actions.');
console.log('              That is the one worth switching off — two systems publishing one Worker keep reproducing this.');
console.log('  wrangler    our own deploy, OR a bare hand-run `wrangler deploy` from someone\'s machine.');
console.log('              GIT_SHA is what separates those two: our deploy passes --var GIT_SHA, a hand-run one does not.');
console.log('              Trust that column ONLY when it reads a sha or (none); `(unreadable)` means the detail fetch');
console.log('              failed and the version is unclassified, not that it is rogue.');
// A finding is an ANSWER, not a broken check.
process.exit(0);
