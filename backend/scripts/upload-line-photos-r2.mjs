#!/usr/bin/env node
/* Upload the exported AutoCount line photographs to R2, under the SAME
   deterministic keys the round-1 attach scripts compute.

   ── IT DOES NOT COMPUTE A KEY, AND THAT IS THE POINT ──────────────────────
   A second key scheme would be a second answer to "where does this photo
   live", and the ERP already holds 536 SO + 97 PO keys built by the first one.
   So this script INVENTS NOTHING: it reads the plan that
   `import-so-line-photos.mjs` / `import-po-line-photos.mjs` already print in
   their default RESOLVE mode —

       UPLOAD SO-000368__34553_1.jpg -> so-items/SO-2506-001/91f3.../ac-34553-1.jpg

   — and uploads exactly those. Every key is then checked against the shape
   those scripts document (`<side>-items/<doc>/<item id>/ac-<DtlKey>-<n>.jpg`)
   and a plan line that does not match is REFUSED, not uploaded to a guessed
   prefix. A malformed plan must fail loudly; a photograph in the wrong place
   is invisible until an operator opens the line and sees nothing.

   ── THE TOKEN ─────────────────────────────────────────────────────────────
   R2_TOKEN_FILE (default C:\Users\User\Desktop\.r2-token.txt) holds a
   Cloudflare R2 API token with Object Read & Write on the bucket. It is read
   into memory, handed to wrangler through the child process ENVIRONMENT, and
   never printed: every line this script emits passes through redact(), which
   replaces the token with <redacted> even if wrangler echoes it back in an
   error. The token is never written to a file, a log or an argv — argv is
   world-readable in a process list.

   ── THE FOUR GATES ────────────────────────────────────────────────────────
     1. MODE defaults to `plan`. Plan mode contacts R2 for nothing but the
        optional sample probe and uploads nothing.
     2. MODE=apply is refused without CONFIRM="I HAVE REVIEWED THE PLAN".
     3. MODE=verify is the verification, and it is a SEPARATE INVOCATION on
        fresh wrangler processes: it DOWNLOADS a random sample of uploaded
        keys and compares the sha256 of the bytes that came back against the
        export manifest. A count of objects is not a shape — an empty object
        and a truncated one both "exist".
     4. RE-RUN: safe and idempotent. Uploading the same bytes to the same key
        overwrites it with itself. A second apply run skips every key in the
        local done-list, so the normal cost of a re-run is zero uploads; the
        done-list is only a SPEED optimisation, never a correctness claim —
        delete it and the run is still correct, just slower.

   ── RESUMABLE ─────────────────────────────────────────────────────────────
   `<PHOTO_DIR>/.uploaded.txt` gains one key per line as each upload succeeds,
   flushed immediately. Kill the run and start it again: the keys already in
   that file are skipped. CHECK_REMOTE=1 additionally asks R2 itself about
   every key before uploading (slow — wrangler has no HEAD, so an existence
   check is a full GET — but it is the honest check when the done-list has
   been lost).

   Env:
     PLAN          the resolve output to read (required unless --plan is given)
     PHOTO_DIR     directory holding the JPEGs the plan names (required)
     MANIFEST      export manifest .json.gz for the sha256 shape check
                   (default: the sibling manifest next to PHOTO_DIR)
     MODE          plan (default) | apply | verify
     CONFIRM       required on apply: "I HAVE REVIEWED THE PLAN"
     R2_TOKEN_FILE default C:\Users\User\Desktop\.r2-token.txt
     R2_ACCOUNT_ID default 816e457307d7fa0491c2a08a72ad5dcd (the COMPANY account;
                   this machine's wrangler login is a personal account with no
                   r2 scope and answers 403)
     R2_BUCKET     default houzs-erp
     BATCH         uploads before a progress line (default 25)
     SAMPLE        keys re-read in verify mode (default 20)
     CHECK_REMOTE  1 = ask R2 about every key, not just the done-list

   Usage:
     PLAN=so-resolve.log PHOTO_DIR=.../line-photos/so node backend/scripts/upload-line-photos-r2.mjs
     PLAN=so-resolve.log PHOTO_DIR=.../line-photos/so MODE=apply \
       CONFIRM="I HAVE REVIEWED THE PLAN" node backend/scripts/upload-line-photos-r2.mjs
     PLAN=so-resolve.log PHOTO_DIR=.../line-photos/so MODE=verify node backend/scripts/upload-line-photos-r2.mjs
*/
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const MODE = (process.env.MODE || 'plan').toLowerCase();
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE PLAN';
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '816e457307d7fa0491c2a08a72ad5dcd';
const BUCKET = process.env.R2_BUCKET || 'houzs-erp';
const TOKEN_FILE = process.env.R2_TOKEN_FILE || 'C:\\Users\\User\\Desktop\\.r2-token.txt';
const BATCH = Number(process.env.BATCH || 25);
const SAMPLE = Number(process.env.SAMPLE || 20);
const CHECK_REMOTE = process.env.CHECK_REMOTE === '1';

/* The key shape the round-1 scripts build. This is a GUARD, not a generator:
   nothing here ever constructs a key, it only refuses one that is off-scheme. */
const KEY_SHAPE = /^(so|po)-items\/[^/]+\/[^/]+\/ac-\d+-\d+\.jpg$/;
/* Tolerant on purpose: the plan may arrive raw, with ::notice:: from a GitHub
   Actions run, or with the job/step/timestamp columns `gh run view --log` adds. */
const PLAN_LINE = /UPLOAD\s+(\S+)\s+->\s+(\S+)\s*$/;

let TOKEN = null;
const redact = (s) => (TOKEN && s ? String(s).split(TOKEN).join('<redacted>') : String(s ?? ''));
const log = (m) => console.log(redact(m));
const bad = (m) => { console.error(`ERROR: ${redact(m)}`); process.exit(2); };

function readToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    bad(`no R2 token at ${TOKEN_FILE}\n` +
        '  The owner creates it in the Cloudflare dashboard: R2 -> API -> Create API token,\n' +
        `  Object Read & Write on bucket "${BUCKET}", then saves the token value into that file.\n` +
        '  Nothing here ever prints it.');
  }
  const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!t) bad(`${TOKEN_FILE} is empty`);
  if (/\s/.test(t)) bad(`${TOKEN_FILE} holds whitespace inside the value — it should hold the token and nothing else`);
  return t;
}

/* wrangler, with the credential in the environment and NEVER in argv. */
function wrangler(args) {
  const r = spawnSync('npx', ['wrangler', ...args], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  /* `r.error` and `r.signal` are CARRIED, not dropped. spawnSync reports a
     process that never STARTED (ENOENT, EAGAIN) or one KILLED by a signal with
     `status === null` and BOTH streams empty — so a caller reading only
     stdout/stderr prints a failure with no reason at all.

     Measured 2026-09-07 during the line-photo upload: sixteen keys failed and
     every one logged `!! <key>: ` with nothing after the colon. Sixteen
     failures that could not be told apart from each other, or from a failure
     we already understand. Same shape as the connector's old "AutoCount login
     failed" with no user id (fixed the same day): a message that cannot
     distinguish its causes is not a message. */
  const why = r.error ? `spawn failed: ${r.error.message}`
            : r.signal ? `killed by ${r.signal}`
            : r.status === null ? 'exited with no status and no output'
            : '';
  return {
    ok: r.status === 0,
    out: redact(r.stdout || ''),
    err: redact(r.stderr || '') || why,
    code: r.status,
    signal: r.signal ?? null,
  };
}

function objectPut(key, file) {
  return wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, '--remote', '--file', file, '--content-type', 'image/jpeg']);
}

/* wrangler exposes no HEAD, so "does it exist" is a GET into a scratch file. */
function objectGet(key, dst) {
  return wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--file', dst]);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function loadPlan(planPath) {
  if (!planPath) bad('PLAN must name the resolve output from import-so-line-photos.mjs / import-po-line-photos.mjs');
  if (!fs.existsSync(planPath)) bad(`no plan file at ${planPath}`);
  const rows = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of fs.readFileSync(planPath, 'utf8').split(/\r?\n/)) {
    const m = PLAN_LINE.exec(raw.trim());
    if (!m) continue;
    const [, file, key] = m;
    if (!KEY_SHAPE.test(key)) { rejected.push({ file, key }); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ file, key });
  }
  return { rows, rejected };
}

function loadManifest(dir) {
  /* The manifest gives the sha256 verify compares against. Absent, verify can
     still prove the object round-trips, but not that the BYTES are the ones we
     sent — so its absence is reported, never quietly tolerated. */
  const explicit = process.env.MANIFEST;
  const candidates = explicit ? [explicit] : [
    path.join(path.dirname(dir), 'ac-photo-manifest.json.gz'),
    path.join(path.dirname(dir), 'ac-po-photo-manifest.json.gz'),
  ];
  const byFile = new Map();
  let found = null;
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(c)).toString('utf8'));
    for (const r of rows) if (r.file && r.sha256) byFile.set(r.file, r);
    found = found ? `${found}, ${c}` : c;
  }
  return { byFile, found };
}

function doneListPath(dir) { return path.join(dir, '.uploaded.txt'); }

function loadDone(dir) {
  const p = doneListPath(dir);
  if (!fs.existsSync(p)) return new Set();
  return new Set(fs.readFileSync(p, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
}

function main() {
  const dir = process.env.PHOTO_DIR;
  if (!dir) bad('PHOTO_DIR must name the directory holding the exported JPEGs');
  if (!fs.existsSync(dir)) bad(`no photo directory at ${dir}`);
  if (!['plan', 'apply', 'verify'].includes(MODE)) bad(`MODE must be plan | apply | verify (got ${MODE})`);
  if (MODE === 'apply' && process.env.CONFIRM !== CONFIRM_PHRASE) {
    bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"\n` +
        '  Read the plan output first. Nothing has been uploaded.');
  }

  const { rows, rejected } = loadPlan(process.env.PLAN);
  const { byFile, found: manifestPath } = loadManifest(dir);
  const done = loadDone(dir);

  log(`mode=${MODE}  bucket=${BUCKET}  account=${ACCOUNT_ID}`);
  log(`plan: ${rows.length} key(s) from ${process.env.PLAN}`);
  log(`photos: ${dir}`);
  log(`manifest: ${manifestPath || 'NONE FOUND — verify cannot compare bytes, only existence'}`);
  log(`local done-list: ${done.size} key(s) already uploaded by an earlier run`);

  if (rejected.length) {
    log('');
    log(`REFUSED ${rejected.length} plan line(s) whose key is not the round-1 scheme`);
    log('  (expected <side>-items/<doc>/<item id>/ac-<DtlKey>-<n>.jpg):');
    for (const r of rejected.slice(0, 10)) log(`    ${r.key}`);
    bad('the plan is not the shape this uploader accepts — nothing was uploaded');
  }
  if (!rows.length) bad('the plan holds no UPLOAD lines — is it the RESOLVE output?');

  /* Which of the planned keys still need bytes, and is the file even here? */
  const missingFile = [];
  const todo = [];
  for (const r of rows) {
    const src = path.join(dir, r.file);
    if (!fs.existsSync(src)) { missingFile.push(r); continue; }
    if (done.has(r.key)) continue;
    todo.push({ ...r, src });
  }
  log('');
  log(`to upload: ${todo.length}; already done locally: ${rows.length - todo.length - missingFile.length}; ` +
      `file not exported: ${missingFile.length}`);
  if (missingFile.length) {
    log('  the export has not produced these files yet — run export-ac-line-photos.py first:');
    for (const r of missingFile.slice(0, 10)) log(`    ${r.file}`);
  }

  if (MODE === 'verify') return verify(rows, dir, byFile);

  if (MODE === 'plan') {
    for (const r of todo.slice(0, 20)) log(`  PUT ${r.file} -> ${r.key}`);
    if (todo.length > 20) log(`  ... and ${todo.length - 20} more`);
    log('');
    log(`PLAN ONLY — nothing uploaded. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to upload,`);
    log('then MODE=verify to re-read a sample from R2 on a fresh connection.');
    return;
  }

  // ── APPLY ───────────────────────────────────────────────────────────────
  TOKEN = readToken();
  const doneFh = fs.openSync(doneListPath(dir), 'a');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'r2check-'));
  let uploaded = 0, skipped = 0, failed = 0;
  const failures = [];
  for (let i = 0; i < todo.length; i++) {
    const r = todo[i];
    if (CHECK_REMOTE) {
      const probe = objectGet(r.key, path.join(scratch, 'probe.bin'));
      if (probe.ok) {
        skipped++;
        fs.writeSync(doneFh, r.key + '\n');
        continue;
      }
    }
    const res = objectPut(r.key, r.src);
    if (res.ok) {
      uploaded++;
      fs.writeSync(doneFh, r.key + '\n');   // flushed per key: a kill loses nothing
    } else {
      failed++;
      /* Never RECORD an empty reason either. `wrangler()` now supplies one for
         the no-output cases; this is the belt to that brace, so whatever
         happens the row says something a reader can act on. */
      const reason = (res.err || res.out).trim().split('\n').slice(-3).join(' | ')
        || `no output; exit code ${res.code}${res.signal ? `, signal ${res.signal}` : ''}`;
      failures.push({ key: r.key, err: reason });
      log(`  !! ${r.key}: ${failures.at(-1).err}`);
      if (failed >= 5 && uploaded === 0) {
        fs.closeSync(doneFh);
        bad('five failures and no success — stopping rather than hammering R2.\n' +
            '  A 403 here means the token lacks Object Read & Write on this bucket,\n' +
            `  or CLOUDFLARE_ACCOUNT_ID is not the company account ${ACCOUNT_ID}.`);
      }
    }
    if ((i + 1) % BATCH === 0) log(`  ... ${i + 1}/${todo.length} (uploaded ${uploaded}, already there ${skipped}, failed ${failed})`);
  }
  fs.closeSync(doneFh);
  log('');
  log(`APPLIED. uploaded: ${uploaded}; already in R2: ${skipped}; failed: ${failed}`);
  if (failures.length) {
    log(`FAILED ${failures.length} key(s):`);
    for (const f of failures.slice(0, 20)) log(`  ${f.key}: ${f.err}`);
  }
  log(`RE-RUN: safe — the ${uploaded + skipped} key(s) above are in ${doneListPath(dir)} and will be skipped.`);
  log('NEXT: MODE=verify (a fresh invocation, fresh wrangler processes) before attaching.');
  if (failures.length) process.exit(1);
}

// ── verification: a fresh invocation that re-reads the SHAPE ──────────────
function verify(rows, dir, byFile) {
  /* Cheapest refusal first: with nothing uploaded there is nothing to verify,
     and saying "no token" there would send the reader after the wrong problem. */
  const done = loadDone(dir);
  const pool = rows.filter((r) => done.has(r.key));
  log('');
  if (!pool.length) bad('nothing has been uploaded yet (the done-list is empty) — run MODE=apply first');
  TOKEN = readToken();
  const pick = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.min(SAMPLE, pool.length));
  log(`VERIFY: re-reading ${pick.length} of ${pool.length} uploaded key(s) from R2 on fresh processes`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'r2verify-'));
  let ok = 0, gone = 0, wrong = 0, unchecked = 0;
  for (const r of pick) {
    const dst = path.join(scratch, 'obj.bin');
    if (fs.existsSync(dst)) fs.rmSync(dst);
    const res = objectGet(r.key, dst);
    if (!res.ok || !fs.existsSync(dst)) {
      gone++;
      log(`  MISSING  ${r.key}`);
      continue;
    }
    const got = fs.readFileSync(dst);
    /* SHAPE, not existence: it must be a JPEG, and it must be the bytes the
       export recorded. An empty or truncated object passes an existence test
       and fails both of these. */
    const isJpeg = got.length > 3 && got[0] === 0xff && got[1] === 0xd8 && got[2] === 0xff;
    const expect = byFile.get(r.file);
    if (!isJpeg) {
      wrong++;
      log(`  NOT A JPEG  ${r.key} (${got.length} bytes, starts ${[...got.slice(0, 3)].map((b) => b.toString(16)).join(' ')})`);
    } else if (!expect) {
      unchecked++;
      log(`  present, ${got.length} bytes, JPEG — but not in the manifest, so its bytes are UNVERIFIED: ${r.key}`);
    } else if (sha256(got) !== expect.sha256) {
      wrong++;
      log(`  BYTES DIFFER  ${r.key}: R2 sha256=${sha256(got).slice(0, 16)}… manifest=${expect.sha256.slice(0, 16)}…`);
    } else {
      ok++;
    }
  }
  log('');
  log(`VERIFY: ${ok} byte-identical to the manifest; ${unchecked} present but unverifiable; ` +
      `${gone} missing; ${wrong} wrong`);
  if (gone || wrong) {
    log('VERDICT: FAILED — do NOT attach these keys to the ERP lines yet.');
    process.exit(1);
  }
  if (unchecked && !ok) {
    log('VERDICT: INCONCLUSIVE — every sampled key exists, but no manifest row was found to');
    log('         compare bytes against. Point MANIFEST at the export manifest and re-run.');
    process.exit(1);
  }
  log('VERDICT: PASSED. Attach with import-so-line-photos.mjs / import-po-line-photos.mjs APPLY=1.');
}

main();
