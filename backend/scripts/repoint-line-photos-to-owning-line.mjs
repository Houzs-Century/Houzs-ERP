#!/usr/bin/env node
/* Put each AutoCount photograph back on the line it belongs to — without
 * uploading anything.
 *
 * WHAT THE OPERATOR SEES. A document lists the same product twice. The first
 * line shows two photographs; the second line shows none. Both pictures are
 * really in the system — they are just both hanging on the first line.
 *
 * THE ROOT CAUSE, traced in import-so-line-photos.mjs /
 * import-po-line-photos.mjs. Those scripts find the ERP row for a photograph
 * by ITEM CODE and take the FIRST match:
 *      const cands = byDocCode.get(`${m.DocNo}|${norm(erp)}`);   ...  cands[0]
 * The book identifies a photograph by its LINE (DtlKey), not by its item code.
 * So when one document carries the same code — or, for sofa, the same model —
 * on two lines, every photograph for that code lands on the first row and the
 * later rows get nothing. Measured on prod 2026-09-03: 34 AutoCount lines on
 * 30 documents, 25 of which show nothing at all and 9 of which show only a
 * broken tile left behind by the round-1 backfill.
 *
 * WHY THIS NEEDS NO UPLOAD. The photograph is already in R2 — under the FIRST
 * row's path. The read routes authorise by MEMBERSHIP of photo_urls, never by
 * key shape ("AUTHZ is MEMBERSHIP, never key shape" —
 * mfg-purchase-orders.ts, poItemPhotoSignedHandler), so listing that same
 * address on the line that owns the AutoCount key makes the tile render. This
 * is the same move backfill-photo-urls-from-keys.mjs already makes with the
 * round-1 keys, and 686 addresses in production are served that way today.
 *
 * WHAT IT LEAVES ALONE. A sofa build is ONE AutoCount line held as several ERP
 * compartment rows, and the owner's rule is one photo on the first piece
 * (2026-08-10: 「每个 SKU 的照片都一样,留第一个就可以了」). A line is skipped the
 * moment ANY of its rows already shows a live picture of it, so the blank
 * compartments stay blank — attaching there is exactly what
 * prune-duplicate-sofa-photos.mjs exists to undo.
 *
 * THE R2 OBJECTS ARE NEVER TOUCHED. This appends to one column and uploads,
 * deletes and moves nothing.
 *
 * MODE=plan (default) reads and prints; MODE=apply needs
 * CONFIRM="REPOINT LINE PHOTOS" and then verifies on a FRESH connection that
 * every line it touched now lists a live address FOR ITS OWN AutoCount key.
 *
 * ── THE PLAN-FILE HANDOFF ─────────────────────────────────────────────────
 * The repair needs an R2 token ("the picture exists" is a fact about the
 * bucket) AND a WRITING database URL in one process. This repository is PUBLIC,
 * so the R2 token can never be an Actions secret — it reads every photograph
 * the company owns — and the operator machine's DSN is read-only. So:
 *
 *   PLAN_OUT=<path>   on the PLAN run, writes the exact operations plus a
 *                     header (generatedAt, account, bucket, company, count,
 *                     digest). This is the run that asks R2.
 *   PLAN_IN=<path>    on the APPLY run, reads that file INSTEAD of asking R2,
 *                     so the apply needs only DATABASE_URL. See
 *                     .github/workflows/apply-line-photo-repair.yml.
 *
 * A plan file IS a key log, and replaying a stale key log is exactly the
 * failure this repo already paid for (docs/bugs/0625-…). So the apply REFUSES:
 * a plan older than PLAN_MAX_AGE_MINUTES (default 120, may be lowered and never
 * raised); a plan that does not match its own digest; a plan for another
 * company, bucket, account or repair; and — per row, at apply time — a row
 * whose photo_urls is no longer what the plan saw, either because it lost an
 * address the plan expected or because it already carries one the plan was
 * going to add. Every refusal is printed and counted, the run exits 1, and
 * nothing is skipped silently. The rules live in
 * scripts/lib/photo-repair-plan.mjs and are pinned by
 * backend/tests/photoRepairPlanHandoff.test.ts.
 *
 * WHAT THE PER-ROW CHECK CANNOT SEE, said plainly: the sofa rule above is a
 * fact about the OTHER rows of the same AutoCount line and about R2, so an
 * apply-from-plan cannot re-judge it. That half is certified by the plan and
 * bounded by the two-hour ceiling — which is why the ceiling is two hours and
 * not two days.
 *
 * RE-RUN: inert. A line that now shows a live picture of itself is skipped, and
 * an address already present is filtered out, so a second run writes nothing.
 * Re-applying the SAME plan file is NOT inert-by-silence: every row is REFUSED
 * (`drifted-present` — it already carries the address the plan was going to
 * add), reported, and the run exits 1. Regenerate the plan instead.
 *
 *   DATABASE_URL           required
 *   R2_API_TOKEN           required unless PLAN_IN is set — read, never printed
 *   R2_ACCOUNT_ID          default 816e457307d7fa0491c2a08a72ad5dcd
 *   R2_BUCKET              default houzs-erp
 *   COMPANY                default 1
 *   PLAN_OUT               plan mode only — write the operations here
 *   PLAN_IN                apply mode only — apply these operations, ask no R2
 *   PLAN_MAX_AGE_MINUTES   apply-from-plan only — default and ceiling 120
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import postgres from 'postgres';
import { acDtlKeyOf, planRepoint } from './lib/line-photo-keys.mjs';
import { listObjectKeys } from './lib/r2-object-index.mjs';
import {
  REPOINT_KIND, buildPlan, checkRowPrecondition, resolveMaxAgeMinutes, verifyPlanEnvelope,
} from './lib/photo-repair-plan.mjs';

const DSN = process.env.DATABASE_URL;
const TOKEN = process.env.R2_API_TOKEN;
const ACCOUNT = process.env.R2_ACCOUNT_ID || '816e457307d7fa0491c2a08a72ad5dcd';
const BUCKET = process.env.R2_BUCKET || 'houzs-erp';
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const PLAN_OUT = process.env.PLAN_OUT || '';
const PLAN_IN = process.env.PLAN_IN || '';
const CONFIRM_PHRASE = 'REPOINT LINE PHOTOS';

const note = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
if (PLAN_IN && !APPLY) { console.error('PLAN_IN is an APPLY input. Set MODE=apply, or drop PLAN_IN to compute a fresh plan.'); process.exit(2); }
if (PLAN_OUT && APPLY) { console.error('PLAN_OUT is a PLAN output. A plan is written by the run that asks R2, never by the run that writes.'); process.exit(2); }
if (!TOKEN && !PLAN_IN) { console.error('need R2_API_TOKEN — "the picture exists" is a fact about the bucket. (Or apply a fresh plan file with PLAN_IN.)'); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}" — refusing.`);
  process.exit(2);
}
const MAX_AGE = resolveMaxAgeMinutes(process.env.PLAN_MAX_AGE_MINUTES);
if (MAX_AGE.error) { console.error(`${MAX_AGE.error} — refusing.`); process.exit(2); }

const ARMS = [
  {
    name: 'SALES ORDER',
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
/* An operation names its ARM, never its table. The table is only ever read from
   the list above, so nothing in a plan file can nominate what gets written to —
   and an op naming an arm that is not here fails the envelope check outright
   rather than being quietly filtered away. */

/* The SHAPE this repair claims: the row is still a text[], and it now lists at
   least one LIVE address whose embedded DtlKey is the row's OWN AutoCount key.
   Counting updated rows would report success for an array that appended the
   wrong address, or a string, or nothing at all. */
async function repointedShape(client, arm, plan, liveKeys) {
  if (!plan.length) return [];
  const rows = await client.unsafe(
    `SELECT id::text AS id, linked_ac_dtlkey::text AS dtl, photo_urls AS pics
       FROM ${arm.table} WHERE id = ANY($1::uuid[])`,
    [plan.map((p) => p.id)],
  );
  const wrong = [];
  for (const r of rows) {
    if (!Array.isArray(r.pics)) {
      wrong.push({ id: r.id, why: `photo_urls is ${typeof r.pics}, not an array` });
      continue;
    }
    const own = r.pics.filter((k) => liveKeys.has(k) && acDtlKeyOf(k) === r.dtl);
    if (!own.length) wrong.push({ id: r.id, why: `still lists no live address for its own AC line ${r.dtl}` });
  }
  if (rows.length !== plan.length) wrong.push({ id: '(set)', why: `re-read ${rows.length} row(s), expected ${plan.length}` });
  return wrong;
}

/* The same shape question when R2 was never asked. Liveness came from the plan;
   what this asserts is that the column now IS what the operation said it would
   be — every planned address present, carrying THIS row's own AutoCount key,
   and nothing the row already had lost along the way. */
async function repointedShapeFromPlan(client, arm, applied) {
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
      if (!have.has(k)) { wrong.push({ id: a.id, why: `does NOT list the address the plan added: ${k}` }); continue; }
      if (acDtlKeyOf(k) !== r.dtl) wrong.push({ id: a.id, why: `now lists ${k}, whose AC line is ${acDtlKeyOf(k)} and not this row's ${r.dtl}` });
    }
    for (const k of a.before) if (!have.has(k)) wrong.push({ id: a.id, why: `LOST an address it already had: ${k}` });
  }
  if (rows.length !== applied.length) wrong.push({ id: '(set)', why: `re-read ${rows.length} row(s), expected ${applied.length}` });
  return wrong;
}

/* ── APPLY FROM A PLAN FILE — no R2, only DATABASE_URL ───────────────────── */
async function applyFromPlan() {
  let plan;
  try {
    plan = JSON.parse(readFileSync(PLAN_IN, 'utf8'));
  } catch (e) {
    bad(`REFUSING: ${PLAN_IN} could not be read as JSON — ${e.message}`);
    process.exit(2);
  }
  const verdict = verifyPlanEnvelope(plan, {
    kind: REPOINT_KIND, account: ACCOUNT, bucket: BUCKET, company: CO,
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
  note('  R2 was NOT asked in this run. Every liveness fact above came from the plan.');

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
        const pics = current.get(op.id);
        const c = checkRowPrecondition(REPOINT_KIND, op, pics);
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
      note(`${arm.name}: APPLIED — ${applied.length} line(s) updated, ${applied.reduce((s, a) => s + a.add.length, 0)} address(es) added`);
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
      const problems = await repointedShapeFromPlan(check, arm, applied);
      for (const p of problems) { bad(`  ${arm.name} ${p.id}: ${p.why}`); wrong++; }
      note(`  ${arm.name}: ${applied.length} line(s) re-read; each now lists the planned address and it carries that row's own AutoCount line: ${problems.length === 0}`);
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

async function main() {
  if (PLAN_IN) { await applyFromPlan(); return; }

  note(`re-point line photos onto the line that owns them — MODE=${APPLY ? 'apply' : 'plan'} company=${CO} bucket=${BUCKET}`);
  const liveKeys = await listObjectKeys({
    accountId: ACCOUNT, bucket: BUCKET, token: TOKEN, prefixes: ['so-items/', 'po-items/'],
  });
  note(`R2 holds ${liveKeys.size} object(s) under so-items/ + po-items/`);

  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const work = [];
  for (const arm of ARMS) {
    const rows = await arm.load(sql, CO);
    const plan = planRepoint(rows, liveKeys);
    const byRow = new Map(rows.map((r) => [r.id, r]));
    note('');
    note(`${arm.name}: ${rows.length} AutoCount-linked line(s) read`);
    note(`  AutoCount lines whose picture is in R2 but hangs on another row of the same document: ${plan.length}`);
    for (const p of plan) note(`     ${p.doc}  AC line ${p.dtl}  ${p.code}  <- ${p.keys.join(' , ')}`);
    work.push({ arm, plan, byRow });
  }

  if (!APPLY) {
    const lines = work.reduce((s, w) => s + w.plan.length, 0);
    const keys = work.reduce((s, w) => s + w.plan.reduce((t, p) => t + p.keys.length, 0), 0);
    note('');
    note(`PLAN ONLY — ${lines} line(s) would gain ${keys} address(es). No object is uploaded, nothing was written.`);
    if (PLAN_OUT) {
      const ops = work.flatMap(({ arm, plan: rows, byRow }) => rows.map((p) => ({
        arm: arm.name, id: p.id, doc: p.doc, dtl: p.dtl, code: p.code,
        add: p.keys,
        /* The column exactly as the plan saw it. The apply re-reads the row and
           refuses if it is no longer this — that is what stops a plan that was
           true when it was written from being applied to a row that moved. */
        before: byRow.get(p.id)?.pics ?? [],
      })));
      const out = buildPlan({ kind: REPOINT_KIND, account: ACCOUNT, bucket: BUCKET, company: CO, ops });
      mkdirSync(dirname(PLAN_OUT), { recursive: true });
      writeFileSync(PLAN_OUT, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
      note('');
      note(`PLAN WRITTEN — ${PLAN_OUT}`);
      note(`  generatedAt ${out.generatedAt}, ${out.count} operation(s), digest ${out.digest}`);
      note(`  Apply it within ${MAX_AGE.minutes} minute(s): MODE=apply CONFIRM="${CONFIRM_PHRASE}" PLAN_IN=${PLAN_OUT} (DATABASE_URL only — no R2 token).`);
    } else {
      note(`Set MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write, or PLAN_OUT=<path> to hand the plan to the apply workflow.`);
    }
    await sql.end();
    return;
  }

  for (const { arm, plan } of work) {
    for (const p of plan) {
      await sql.unsafe(
        `UPDATE ${arm.table}
            SET photo_urls = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(photo_urls, '{}'::text[]) || $1::text[])))
          WHERE id = $2::uuid`,
        [p.keys, p.id],
      );
    }
    note(`${arm.name}: APPLIED — ${plan.length} line(s) updated`);
  }

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let wrong = 0;
  try {
    note('');
    note('=== VERIFIED ON A FRESH CONNECTION ===');
    for (const { arm, plan } of work) {
      const problems = await repointedShape(check, arm, plan, liveKeys);
      for (const p of problems) { bad(`  ${arm.name} ${p.id}: ${p.why}`); wrong++; }
      note(`  ${arm.name}: ${plan.length} line(s) re-read; each now lists a live address for its own AutoCount line: ${problems.length === 0}`);
    }
  } finally {
    await check.end();
  }
  await sql.end();
  if (wrong) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
