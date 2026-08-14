#!/usr/bin/env node
// ----------------------------------------------------------------------------
// ERP -> AutoCount write-back: the TEST-BOOK trial harness.
//
// Posts the payload set in scripts/autocount-service/trial-payloads.json to a
// running AcSyncService, one document chain end to end, printing every request
// and every response. It exists so the first time these payloads meet a real
// AutoCount SDK, somebody is watching, and it is not the company's live book.
//
// IT DOES NOT RUN BY DEFAULT AND IT CANNOT REACH PRODUCTION.
//
//   With no environment at all it prints the payloads it WOULD send and exits.
//   Zero network calls. That is the default, and it is the safe thing to run
//   first.
//
//   To actually post, FOUR independent gates must all open:
//
//     1. AC_TRIAL_CONFIRM=yes-testing-book   exactly, no other value
//     2. AC_TRIAL_URL                        the service to talk to
//     3. that URL must not be the production one — which is not a list this
//        script gets to define: it is whatever the Worker is configured with
//        (AC_SYNC_URL in the environment or uncommented in wrangler.toml),
//        plus AC_PROD_URL if you want to name another
//     4. GET /health must answer with a book that is NOT the production book,
//        and IS the one you said to expect (AC_TRIAL_EXPECT_BOOK, default
//        AED_TESTING)
//
//   Gate 4 is the one that matters, because it is an OBSERVATION rather than a
//   setting: the service says which book it is bound to and the harness stops
//   unless that is the test one. Note that AcSyncService reports a compile-time
//   constant there, so the build pointed at the test database must have had its
//   BOOK constant changed to match. If it was not, this refuses to run — which
//   is the correct way round: it fails closed.
//
// Usage:
//   node backend/scripts/ac-trial-dry-run.mjs                # print only
//   node backend/scripts/ac-trial-dry-run.mjs --only create-so
//   AC_TRIAL_CONFIRM=yes-testing-book AC_TRIAL_URL=http://host:8900 \
//     AC_TRIAL_EXPECT_BOOK=AED_TESTING node backend/scripts/ac-trial-dry-run.mjs
//
// AC_TRIAL_KEY is the service's X-API-KEY. It is a CREDENTIAL: it is read from
// the environment, sent as a header, and never printed — the log shows the
// header name and the word REDACTED.
// ----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAYLOADS = path.join(HERE, 'autocount-service', 'trial-payloads.json');
const SERVICE_CS = path.join(HERE, 'autocount-service', 'AcSyncService.cs');
const WRANGLER = path.join(HERE, '..', 'wrangler.toml');

/* A refusal unwinds to the bottom of the file rather than calling
   process.exit(): on Windows, process.exit() while console output is still
   buffered aborts the process with 0xC0000409 instead of the code you asked
   for, which would make a refusal indistinguishable from a crash. */
class Refusal extends Error {}
const die = (msg) => { throw new Refusal(msg); };
const say = (msg = '') => console.log(msg);

/** The production book name, read out of the service's own source. */
function productionBook() {
  const src = readFileSync(SERVICE_CS, 'utf8');
  const m = src.match(/const\s+string\s+BOOK\s*=\s*"([^"]+)"/);
  if (!m) die('cannot read the production book name out of AcSyncService.cs; refusing to guess it');
  return m[1];
}

/** Any AC_SYNC_URL the Worker is actually configured with IS production. */
function productionUrls() {
  const out = new Set();
  if (process.env.AC_SYNC_URL) out.add(process.env.AC_SYNC_URL);
  if (process.env.AC_PROD_URL) out.add(process.env.AC_PROD_URL);
  try {
    for (const line of readFileSync(WRANGLER, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.startsWith('#')) continue;              // the commented-out example
      const m = t.match(/^AC_SYNC_URL\s*=\s*"([^"]+)"/);
      if (m) out.add(m[1]);
    }
  } catch { /* no wrangler.toml in this checkout is not an error */ }
  return [...out];
}

const norm = (u) => String(u).trim().replace(/\/+$/, '').toLowerCase();

// ── payloads ────────────────────────────────────────────────────────────────

const doc = JSON.parse(readFileSync(PAYLOADS, 'utf8'));
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;
const steps = doc.steps.filter((s) => !only || s.id === only);

/** Replace "@<step>.docNo" and "@env.NAME" in a payload, in place. */
function resolve(value, docNos) {
  if (Array.isArray(value)) return value.map((v) => resolve(v, docNos));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, docNos)]));
  }
  if (typeof value !== 'string' || !value.startsWith('@')) return value;
  const env = value.match(/^@env\.([A-Z0-9_]+)$/);
  if (env) {
    const v = process.env[env[1]];
    return v === undefined ? null : (/^\d+$/.test(v) ? Number(v) : v);
  }
  const ref = value.match(/^@([a-z0-9-]+)\.docNo$/);
  if (ref) {
    if (!(ref[1] in docNos)) return { __unresolved: value };
    return docNos[ref[1]];
  }
  return value;
}

const pretty = (v) => JSON.stringify(v, null, 2);

// ── print-only mode: the default ────────────────────────────────────────────

async function main() {
if (only && steps.length === 0) die(`no step called "${only}" in trial-payloads.json`);

const confirm = process.env.AC_TRIAL_CONFIRM ?? '';
if (!confirm) {
  say('AutoCount write-back trial — PRINT ONLY. Nothing was sent; no network call was made.');
  say('');
  say(`Payload set: ${path.relative(process.cwd(), PAYLOADS)}`);
  say(`Production book (from AcSyncService.cs): ${productionBook()}`);
  const prod = productionUrls();
  say(`Production service URL(s) this run would refuse: ${prod.length ? prod.join(', ') : '(none configured)'}`);
  say('');
  for (const step of steps) {
    say('-'.repeat(78));
    say(`STEP ${step.id}   POST ${step.route}`);
    say(`WHY  ${step.why}`);
    if (step.needs) say(`NEEDS ${step.needs.join(', ')}`);
    if (step.expect === 'refusal') say('EXPECT a refusal from AutoCount (a 500 is the PASS here)');
    say(pretty(step.payload));
  }
  say('-'.repeat(78));
  say('');
  say('To post these at a TEST book:');
  say('  1. Build AcSyncService on the AutoCount host against the TEST database,');
  say('     with its BOOK constant changed to the test book name (gate 4 reads it).');
  say('  2. Start it, and check http://<host>:<port>/health answers with that book.');
  say('  3. AC_TRIAL_CONFIRM=yes-testing-book AC_TRIAL_URL=http://<host>:<port> \\');
  say('       AC_TRIAL_EXPECT_BOOK=AED_TESTING AC_TRIAL_KEY=<the service key> \\');
  say('       node backend/scripts/ac-trial-dry-run.mjs');
  return 0;
}

// ── the four gates ──────────────────────────────────────────────────────────

if (confirm !== 'yes-testing-book') {
  die(`AC_TRIAL_CONFIRM must be exactly "yes-testing-book" (got ${JSON.stringify(confirm)})`);
}

const url = (process.env.AC_TRIAL_URL ?? '').trim().replace(/\/+$/, '');
if (!url) die('AC_TRIAL_URL is not set. There is no default, on purpose.');
if (!/^https?:\/\//.test(url)) die(`AC_TRIAL_URL must be an http(s) URL (got ${JSON.stringify(url)})`);

const PROD_URLS = productionUrls();
if (PROD_URLS.some((p) => norm(p) === norm(url))) {
  die(`AC_TRIAL_URL is the PRODUCTION service URL. This harness does not post to production, ever.`);
}

const PROD_BOOK = productionBook();
const EXPECT_BOOK = (process.env.AC_TRIAL_EXPECT_BOOK ?? 'AED_TESTING').trim();
if (EXPECT_BOOK === PROD_BOOK) {
  die(`AC_TRIAL_EXPECT_BOOK is the production book (${PROD_BOOK}). That is not a test book.`);
}

const KEY = process.env.AC_TRIAL_KEY ?? null;
const headers = { 'content-type': 'application/json', ...(KEY ? { 'X-API-KEY': KEY } : {}) };
const printableHeaders = { ...headers, ...(KEY ? { 'X-API-KEY': 'REDACTED' } : {}) };

say(`AutoCount write-back trial — LIVE against ${url}`);
say(`Gate 1 confirm         OK`);
say(`Gate 2 url             OK  ${url}`);
say(`Gate 3 not production  OK  (refused set: ${PROD_URLS.length ? PROD_URLS.join(', ') : 'none configured'})`);

let health;
try {
  const res = await fetch(`${url}/health`, { headers });
  health = await res.json();
  say(`Gate 4 health          ${res.status} ${JSON.stringify(health)}`);
} catch (e) {
  die(`/health is unreachable at ${url}: ${e.message}`);
}
if (!health || typeof health.book !== 'string' || !health.book) {
  die('/health did not name a book. Refusing to post to a service that will not say which book it is bound to.');
}
if (health.book === PROD_BOOK) {
  die(`/health says this service is bound to the PRODUCTION book (${PROD_BOOK}). Stopping.`);
}
if (health.book !== EXPECT_BOOK) {
  die(`/health says "${health.book}" but AC_TRIAL_EXPECT_BOOK is "${EXPECT_BOOK}". Stopping rather than guessing which is right.`);
}
say(`Gate 4 book            OK  ${health.book}`);
say('');

// ── post the chain ──────────────────────────────────────────────────────────

const docNos = {};
let failures = 0;

for (const step of steps) {
  say('='.repeat(78));
  say(`STEP ${step.id}   POST ${url}${step.route}`);
  say(step.why);

  const missing = (step.needs ?? []).filter((n) => !process.env[n]);
  if (missing.length) {
    say(`SKIPPED: needs ${missing.join(', ')}, which is not set.`);
    say('');
    continue;
  }

  const payload = resolve(step.payload, docNos);
  const unresolved = JSON.stringify(payload).match(/"__unresolved":"([^"]+)"/);
  if (unresolved) {
    say(`SKIPPED: ${unresolved[1]} has not been produced (an earlier step did not run or did not return a docNo).`);
    say('');
    continue;
  }

  say('REQUEST HEADERS ' + JSON.stringify(printableHeaders));
  say('REQUEST BODY');
  say(pretty(payload));

  let res;
  let text;
  try {
    res = await fetch(`${url}${step.route}`, { method: 'POST', headers, body: JSON.stringify(payload) });
    text = await res.text();
  } catch (e) {
    say(`RESPONSE  transport failure: ${e.message}`);
    failures += 1;
    say('');
    continue;
  }

  say(`RESPONSE  ${res.status}`);
  say(text);

  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* printed raw above */ }

  const refused = !res.ok || body.ok === false;
  if (step.expect === 'refusal') {
    if (refused) say('PASS — AutoCount refused it, which is what this step is here to show.');
    else { say('FAIL — AutoCount ACCEPTED an operation it should have refused.'); failures += 1; }
  } else if (refused) {
    say('FAIL');
    failures += 1;
  } else {
    if (body.docNo) { docNos[step.id] = body.docNo; say(`docNo ${body.docNo}`); }
    say('PASS');
  }
  say('');
}

say('='.repeat(78));
say(`Document numbers created: ${Object.entries(docNos).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
say(failures === 0 ? 'All steps behaved as expected.' : `${failures} step(s) did not behave as expected.`);
say('');
say('Now go and LOOK at the book. What the HTTP responses cannot tell you:');
say('  - which UDF spelling landed on TRIAL-SO-0002 (see the udf-probe step)');
say('  - whether the line Location / Description / Desc2 are blank where the ERP sent null');
say('  - whether the sofa shows as ONE line or as three');
say('  - whether the DO / GRN / invoice kept a Ref, and what document numbers they got');
say('  - whether the edit UPDATED line DtlKey or appended a new one');
say('Then cancel the TRIAL- documents so the test book does not keep them.');

return failures === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  console.error('');
  console.error(`REFUSED: ${e.message}`);
  console.error('');
  process.exitCode = 1;
}
