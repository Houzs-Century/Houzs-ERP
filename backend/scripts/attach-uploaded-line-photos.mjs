#!/usr/bin/env node
// ---------------------------------------------------------------------------
// attach-uploaded-line-photos.mjs — put a NEWLY UPLOADED AutoCount line
// photograph onto the line that has none.
//
// ── WHY A THIRD REPAIR ──────────────────────────────────────────────────────
// There were two, and neither could do this:
//   · prune-dead-line-photo-keys   drops an address whose object is gone;
//   · repoint-line-photos-to-owning-line
//                                  moves an address that is ALREADY on the
//                                  document onto the line that owns it.
// A line whose photograph was never in the bucket at all has nothing to move
// and nothing to drop. The object must be UPLOADED first — by
// upload-line-photos-r2.mjs, on the operator machine, because the R2 token can
// never be an Actions secret in a PUBLIC repository — and only then does the
// address become true. This script writes it down.
//
// ── WHY NOT JUST RE-RUN THE IMPORTER ────────────────────────────────────────
// Because that was measured before it was trusted. `import-po-line-photos.mjs
// APPLY=1` attaches EVERY key in its resolve plan that a row does not already
// carry. On 2026-09-08, company 1, that was 25 addresses and not the 10 the gap
// needed: the other 15 sit on lines that already show their picture, and R2
// holds NONE of those 15 objects (checked one at a time — 0 of 15 present,
// against a 13/13 positive control on known-good keys). Writing them would have
// been docs/bugs/0625 and docs/bugs/0668 for a third time: an address that
// names nothing, on a line that was working. The importer cannot know this —
// it has no R2 token and never will. So the liveness question is asked HERE,
// where the bucket can be asked, and the answer is carried to the writer in a
// plan file.
//
// ── IT MINTS NO KEY ─────────────────────────────────────────────────────────
// PLAN_SRC is the importer's OWN resolve output (`UPLOAD <file> -> <key>`), the
// same text upload-line-photos-r2.mjs consumes. There is one key generator in
// this repository and this is not a second one.
//
// ── THE HANDOFF, AND ITS GUARDS ─────────────────────────────────────────────
// Identical to the other two repairs (docs/bugs/0638, lib/photo-repair-plan.mjs):
//   1. on the operator machine, with the R2 token and the read-only DSN:
//        MODE=plan PLAN_SRC=<resolve log> \
//          PLAN_OUT=backend/scripts/data/photo-repair-plans/<name>.json \
//          node backend/scripts/attach-uploaded-line-photos.mjs
//   2. commit that ONE file on a short-lived branch and push it;
//   3. run "Apply line photo repair (from a plan file)" on THAT BRANCH;
//   4. delete the branch. A spent plan is not a document.
// The plan is refused if it is older than 120 minutes, does not match its own
// digest, is for another company/bucket/account/repair, or — row by row — if
// photo_urls is no longer what the plan saw. Every refusal is printed, counted,
// and exits 1. Nothing is skipped in silence.
//
// Env:
//   DATABASE_URL           required (read-only is enough for MODE=plan)
//   R2_API_TOKEN           required unless PLAN_IN is set — read, never printed
//   R2_ACCOUNT_ID          default 816e457307d7fa0491c2a08a72ad5dcd
//   R2_BUCKET              default houzs-erp
//   COMPANY                default 1
//   MODE                   plan (default) | apply
//   CONFIRM                required on apply: "ATTACH UPLOADED LINE PHOTOS"
//   PLAN_SRC               plan mode — the importer's resolve output to read
//   PLAN_OUT               plan mode — write the operations here
//   PLAN_IN                apply mode — apply these operations, ask no R2
//   PLAN_MAX_AGE_MINUTES   lower the 120-minute ceiling (never raise it)
//
// RE-RUN: safe. A line that already carries the address fails the per-row
// precondition and is REFUSED rather than written twice.
// ---------------------------------------------------------------------------
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import postgres from 'postgres';
import { acDtlKeyOf, planAttachUploaded } from './lib/line-photo-keys.mjs';
import { listObjectKeys } from './lib/r2-object-index.mjs';
import {
  ATTACH_KIND, buildPlan, checkRowPrecondition, resolveMaxAgeMinutes, verifyPlanEnvelope,
} from './lib/photo-repair-plan.mjs';

const DSN = process.env.DATABASE_URL;
const TOKEN = process.env.R2_API_TOKEN;
const ACCOUNT = process.env.R2_ACCOUNT_ID || '816e457307d7fa0491c2a08a72ad5dcd';
const BUCKET = process.env.R2_BUCKET || 'houzs-erp';
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const PLAN_SRC = process.env.PLAN_SRC || '';
const PLAN_OUT = process.env.PLAN_OUT || '';
const PLAN_IN = process.env.PLAN_IN || '';
const CONFIRM_PHRASE = 'ATTACH UPLOADED LINE PHOTOS';

const note = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
if (PLAN_IN && !APPLY) { console.error('PLAN_IN is an APPLY input. Set MODE=apply, or drop PLAN_IN to compute a fresh plan.'); process.exit(2); }
if (PLAN_OUT && APPLY) { console.error('PLAN_OUT is a PLAN output. A plan is written by the run that asks R2, never by the run that writes.'); process.exit(2); }
if (!PLAN_IN && !PLAN_SRC) { console.error('need PLAN_SRC — the importer\'s RESOLVE output. This script never mints a key of its own.'); process.exit(2); }
if (!TOKEN && !PLAN_IN) { console.error('need R2_API_TOKEN — "the photograph is really in the bucket" is a fact about the bucket. (Or apply a fresh plan file with PLAN_IN.)'); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}" — refusing.`);
  process.exit(2);
}
const MAX_AGE = resolveMaxAgeMinutes(process.env.PLAN_MAX_AGE_MINUTES);
if (MAX_AGE.error) { console.error(`${MAX_AGE.error} — refusing.`); process.exit(2); }

/* An operation names its ARM, never its table. The table is only ever read from
   this list, so nothing in a plan file can nominate what gets written to. */
const ARMS = [
  {
    name: 'SALES ORDER',
    prefix: 'so-items/',
    table: 'scm.mfg_sales_order_items',
    load: (sql, co) => sql`
      SELECT i.id::text AS id, i.doc_no AS doc, i.line_no AS "lineNo",
             i.linked_ac_dtlkey::text AS dtl, i.item_code AS "itemCode",
             COALESCE(i.photo_urls, '{}'::text[]) AS pics
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE h.company_id = ${co} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    name: 'PURCHASE ORDER',
    prefix: 'po-items/',
    table: 'scm.purchase_order_items',
    load: (sql, co) => sql`
      SELECT i.id::text AS id, p.po_number AS doc, i.id::text AS "lineNo",
             i.linked_ac_dtlkey::text AS dtl, i.item_code AS "itemCode",
             COALESCE(i.photo_urls, '{}'::text[]) AS pics
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
       WHERE p.company_id = ${co} AND p.linked_ac_docno IS NOT NULL`,
  },
];

/* Tolerant on purpose — the resolve output may arrive raw, with ::notice:: from
   an Actions run, or with the columns `gh run view --log` adds. Same regex the
   uploader uses, for the same reason: it is the same text. */
const PLAN_LINE = /UPLOAD\s+(\S+)\s+->\s+(\S+)\s*$/;
const KEY_SHAPE = /^(so|po)-items\/([^/]+)\/([0-9a-f-]{36})\/ac-(\d+)-\d+\.jpg$/;

/** The importer's resolve output, parsed into { key, doc, dtl } per arm. */
function readResolve(file) {
  const byArm = new Map(ARMS.map((a) => [a.name, []]));
  const malformed = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = PLAN_LINE.exec(line);
    if (!m) continue;
    const key = m[2];
    const shape = KEY_SHAPE.exec(key);
    /* A key that is off-scheme is REFUSED, never coerced onto a guessed prefix.
       A photograph in the wrong place is invisible until somebody opens the
       line and sees nothing. */
    if (!shape) { malformed.push(key); continue; }
    const arm = ARMS.find((a) => key.startsWith(a.prefix));
    if (!arm) { malformed.push(key); continue; }
    byArm.get(arm.name).push({ key, doc: shape[2], dtl: shape[4] });
  }
  return { byArm, malformed };
}

/* The SHAPE this repair claims, re-read on a FRESH connection: the column is
   still a text[], it now lists every address the plan added, each of those
   addresses carries THIS row's own AutoCount line key, and nothing the row
   already had was lost. Counting updated rows would report success for an
   array that gained the wrong address, or a string, or nothing at all. */
async function attachedShape(client, arm, applied) {
  if (!applied.length) return [];
  const rows = await client.unsafe(
    `SELECT id::text AS id, linked_ac_dtlkey::text AS dtl, photo_urls AS pics
       FROM ${arm.table} WHERE id = ANY($1::uuid[])`,
    [applied.map((a) => a.id)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const wrong = [];
  for (const a of applied) {
    const r = byId.get(a.id);
    if (!r || !Array.isArray(r.pics)) {
      wrong.push({ id: a.id, why: `photo_urls is ${!r ? 'a row that is no longer there' : typeof r.pics}, not an array` });
      continue;
    }
    const have = new Set(r.pics);
    for (const k of a.add) {
      if (!have.has(k)) { wrong.push({ id: a.id, why: `does NOT list the address the plan attached: ${k}` }); continue; }
      if (acDtlKeyOf(k) !== r.dtl) wrong.push({ id: a.id, why: `now lists ${k}, whose AC line is ${acDtlKeyOf(k)} and not this row's ${r.dtl}` });
    }
    for (const k of a.before) if (!have.has(k)) wrong.push({ id: a.id, why: `LOST an address it already had: ${k}` });
  }
  if (rows.length !== applied.length) wrong.push({ id: '(set)', why: `re-read ${rows.length} row(s), expected ${applied.length}` });
  return wrong;
}

/* ── COMPUTE A PLAN — asks R2, and reads the database READ-ONLY ───────────── */
async function computePlan() {
  note(`attach uploaded line photos — MODE=${APPLY ? 'apply' : 'plan'} company=${CO} bucket=${BUCKET}`);
  const { byArm, malformed } = readResolve(PLAN_SRC);
  note(`resolve source ${PLAN_SRC}`);
  for (const a of ARMS) note(`  ${a.name}: ${byArm.get(a.name).length} planned address(es)`);
  if (malformed.length) {
    bad(`REFUSING ${malformed.length} off-scheme key(s) in the resolve output — they are not uploaded and not attached:`);
    for (const k of malformed.slice(0, 20)) bad(`   ${k}`);
  }

  const liveKeys = await listObjectKeys({
    accountId: ACCOUNT, bucket: BUCKET, token: TOKEN, prefixes: ARMS.map((a) => a.prefix),
  });
  note(`R2 holds ${liveKeys.size} object(s) under ${ARMS.map((a) => a.prefix).join(' + ')}`);

  const read = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const ops = [];
  try {
    for (const arm of ARMS) {
      const rows = await arm.load(read, CO);
      const { plan, skipped } = planAttachUploaded(rows, byArm.get(arm.name), liveKeys);
      note('');
      note(`${arm.name} — ${rows.length} line(s) read`);
      note(`  TO ATTACH: ${plan.length} line(s), ${plan.reduce((s, p) => s + p.keys.length, 0)} address(es)`);
      for (const p of plan) note(`    ${p.doc} AC line ${p.dtl} -> ${p.keys.join(' , ')}`);
      const notMine = skipped.filter((s) => !/already shows/.test(s.why));
      note(`  skipped: ${skipped.length} (${skipped.length - notMine.length} already showing a picture — nothing to do)`);
      for (const s of notMine.slice(0, 40)) note(`    - ${s.doc} AC line ${s.dtl}: ${s.why}`);
      for (const p of plan) {
        ops.push({ arm: arm.name, id: p.id, doc: p.doc, dtl: p.dtl, before: p.before, add: p.keys });
      }
    }
  } finally {
    await read.end();
  }

  note('');
  if (!ops.length) {
    note('NOTHING TO ATTACH — every photographed line either shows its picture already, or its object is not in the bucket yet.');
    return;
  }
  if (!PLAN_OUT) {
    note('PLAN ONLY — nothing written. Set PLAN_OUT=<path> to hand the plan to the apply workflow.');
    return;
  }
  const out = buildPlan({ kind: ATTACH_KIND, account: ACCOUNT, bucket: BUCKET, company: CO, ops });
  mkdirSync(dirname(PLAN_OUT), { recursive: true });
  writeFileSync(PLAN_OUT, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  note(`PLAN WRITTEN — ${PLAN_OUT}`);
  note(`  ${out.count} operation(s), digest ${out.digest}`);
  note(`  Apply it within ${MAX_AGE.minutes} minute(s): "Apply line photo repair (from a plan file)", script attach-uploaded-line-photos, CONFIRM="${CONFIRM_PHRASE}" (DATABASE_URL only — no R2 token).`);
}

/* ── APPLY FROM A PLAN FILE — no R2, only DATABASE_URL ─────────────────────
   This is deliberately the LAST database work in the file, so the fresh
   connection the verification opens is also the last one opened. That is what
   `audit:release-discipline` reads (`fresh-verify`): it takes the last client
   opened after the write and asks whether anything is read back on it. With
   the plan-mode read below this, the check would point at a connection that
   never writes and report a repair that HAS a shape verify as having none. */
async function applyFromPlan() {
  let plan;
  try {
    plan = JSON.parse(readFileSync(PLAN_IN, 'utf8'));
  } catch (e) {
    bad(`REFUSING: ${PLAN_IN} could not be read as JSON — ${e.message}`);
    process.exit(2);
  }
  const verdict = verifyPlanEnvelope(plan, {
    kind: ATTACH_KIND, account: ACCOUNT, bucket: BUCKET, company: CO,
    now: new Date(), maxAgeMinutes: MAX_AGE.minutes, arms: ARMS.map((a) => a.name),
  });
  note(`plan file ${PLAN_IN}`);
  note(`  written ${plan?.generatedAt ?? '(no date)'} — ${verdict.ageMinutes === null ? 'age unknown' : `${Math.round(verdict.ageMinutes)} minute(s) ago`}; ceiling ${MAX_AGE.minutes} minute(s)`);
  note(`  ${plan?.count ?? '?'} operation(s), company ${plan?.company}, bucket ${plan?.bucket}, digest ${plan?.digest ?? '(none)'}`);
  if (!verdict.ok) {
    for (const p of verdict.problems) bad(`REFUSING THE PLAN [${p.code}]: ${p.why}`);
    bad(`${verdict.problems.length} refusal(s). Nothing was written.`);
    process.exit(2);
  }
  note('  ACCEPTED — fresh, unedited, and for this company and bucket.');
  note('  R2 was NOT asked in this run. Every "the object exists" fact above came from the plan.');

  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const refused = [];
  const appliedByArm = new Map();
  try {
    for (const arm of ARMS) {
      const ops = plan.ops.filter((o) => o.arm === arm.name);
      const applied = [];
      appliedByArm.set(arm.name, applied);
      if (!ops.length) { note(''); note(`${arm.name}: no operation in this plan`); continue; }

      const now = await sql.unsafe(
        `SELECT id::text AS id, photo_urls AS pics FROM ${arm.table} WHERE id = ANY($1::uuid[])`,
        [[...new Set(ops.map((o) => o.id))]],
      );
      const current = new Map(now.map((r) => [r.id, r.pics]));

      for (const op of ops) {
        const c = checkRowPrecondition(ATTACH_KIND, op, current.get(op.id));
        if (!c.ok) {
          refused.push({ arm: arm.name, id: op.id, doc: op.doc, dtl: op.dtl, code: c.code, why: c.why });
          continue;
        }
        await sql.unsafe(
          `UPDATE ${arm.table}
              SET photo_urls = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(photo_urls, '{}'::text[]) || $1::text[])))
            WHERE id = $2::uuid`,
          [op.add, op.id],
        );
        applied.push({ id: op.id, add: op.add, before: op.before ?? [] });
      }
      note('');
      note(`${arm.name}: APPLIED — ${applied.length} line(s) updated, ${applied.reduce((s, a) => s + a.add.length, 0)} address(es) attached`);
    }
  } finally {
    await sql.end();
  }

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let wrong = 0;
  try {
    note('');
    note('=== VERIFIED ON A FRESH CONNECTION ===');
    for (const arm of ARMS) {
      const applied = appliedByArm.get(arm.name) ?? [];
      const problems = await attachedShape(check, arm, applied);
      for (const p of problems) { bad(`  ${arm.name} ${p.id}: ${p.why}`); wrong++; }
      note(`  ${arm.name}: ${applied.length} line(s) re-read; each now lists the attached address and it carries that row's own AutoCount line: ${problems.length === 0}`);
    }
  } finally {
    await check.end();
  }

  note('');
  if (refused.length) {
    bad(`REFUSED ${refused.length} line(s) — the column moved after the plan was written:`);
    for (const r of refused) bad(`   [${r.code}] ${r.arm} ${r.doc} AC line ${r.dtl} (${r.id}): ${r.why}`);
  }
  const done = [...appliedByArm.values()].reduce((s, a) => s + a.length, 0);
  note(`APPLIED ${done} line(s), REFUSED ${refused.length} line(s), SHAPE PROBLEMS ${wrong}.`);
  if (refused.length || wrong) {
    bad('Exiting 1: a refusal is a finding, not a skip. Re-run the PLAN against R2 and apply the new file.');
    process.exit(1);
  }
}

/* PLAN_IN is the apply input and PLAN_SRC the plan input, so which half runs is
   decided by which one is set, never by MODE alone. */
const main = () => (PLAN_IN ? applyFromPlan() : computePlan());

main().catch((e) => { console.error(e); process.exit(1); });
