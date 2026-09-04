#!/usr/bin/env node
/* Take the broken photo tiles off the AutoCount-imported lines.
 *
 * WHAT THE OPERATOR SEES. A line shows two thumbnails of what should be one
 * photograph: one opens, the other is a broken tile. 53 rows on 50 documents
 * look like this (measured on prod 2026-09-03).
 *
 * WHAT IT IS. A line's photo_urls column holds ADDRESSES of objects in R2:
 *   <so|po>-items/<doc no>/<ERP row id>/ac-<AutoCount DtlKey>-<n>.jpg
 * The 2026-08-28 re-import replaced every ERP row id, so the addresses minted
 * in round 1 (2026-08-10) name row ids that no longer exist. That is harmless
 * by itself — the read routes authorise by MEMBERSHIP of photo_urls, never by
 * key shape (mfg-purchase-orders.ts, poItemPhotoSignedHandler) — and 686 of
 * those round-1 addresses still open their object. But
 * backfill-photo-urls-from-keys.mjs replayed the round-1 attach LOG
 * (data/r2-*-photo-keys-2026-08-10.txt), and 64 of the addresses in that log
 * name an object that was never uploaded. All 64 answer 404 {"code":10007}.
 *
 * WHAT THIS REMOVES, AND WHAT IT REFUSES TO. Only an address that is dead in
 * R2 AND whose OWN ROW still carries a working address for the SAME AutoCount
 * line — the same photograph, reachable, already on screen. Nothing here can
 * be the last copy of a picture. A dead address whose row would be left blank
 * is NOT touched: it is printed under WOULD GO BLANK and left for the owner,
 * because removing it turns a broken tile into no tile at all, and that is a
 * decision about what he wants to see, not a repair. It is deliberately NOT
 * written into the plan file either — a decision is not an operation.
 *
 * THE R2 OBJECTS ARE NEVER TOUCHED. This writes one column and uploads,
 * deletes and moves nothing.
 *
 * MODE=plan (default) reads and prints; MODE=apply needs
 * CONFIRM="PRUNE DEAD PHOTO KEYS", writes one row at a time, and then verifies
 * on a FRESH connection that every surviving address on every row it touched
 * is a real object in R2.
 *
 * ── THE PLAN-FILE HANDOFF ─────────────────────────────────────────────────
 * The repair needs an R2 token (deadness is a fact about the bucket) AND a
 * WRITING database URL in one process. This repository is PUBLIC, so the R2
 * token can never be an Actions secret — it reads every photograph the company
 * owns — and the operator machine's DSN is read-only. So:
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
 * that no longer carries what the plan expected to find. Every refusal is
 * printed and counted, the run exits 1, and nothing is skipped silently.
 * The rules live in scripts/lib/photo-repair-plan.mjs and are pinned by
 * backend/tests/photoRepairPlanHandoff.test.ts.
 *
 * RE-RUN: inert. The addresses it removes are gone from the column, so a second
 * run finds nothing dead to prune and writes nothing. Re-applying the SAME plan
 * file is NOT inert-by-silence: every row is REFUSED (`drifted-missing` — the
 * address it was going to drop is already gone), reported, and the run exits 1.
 * Regenerate the plan rather than re-applying one.
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
import { planDeadKeyPrune } from './lib/line-photo-keys.mjs';
import { listObjectKeys, verifyKeyAbsent } from './lib/r2-object-index.mjs';
import {
  PRUNE_KIND, buildPlan, checkRowPrecondition, resolveMaxAgeMinutes, verifyPlanEnvelope,
} from './lib/photo-repair-plan.mjs';

const DSN = process.env.DATABASE_URL;
const TOKEN = process.env.R2_API_TOKEN;
const ACCOUNT = process.env.R2_ACCOUNT_ID || '816e457307d7fa0491c2a08a72ad5dcd';
const BUCKET = process.env.R2_BUCKET || 'houzs-erp';
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const PLAN_OUT = process.env.PLAN_OUT || '';
const PLAN_IN = process.env.PLAN_IN || '';
const CONFIRM_PHRASE = 'PRUNE DEAD PHOTO KEYS';

const note = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
if (PLAN_IN && !APPLY) { console.error('PLAN_IN is an APPLY input. Set MODE=apply, or drop PLAN_IN to compute a fresh plan.'); process.exit(2); }
if (PLAN_OUT && APPLY) { console.error('PLAN_OUT is a PLAN output. A plan is written by the run that asks R2, never by the run that writes.'); process.exit(2); }
if (!TOKEN && !PLAN_IN) { console.error('need R2_API_TOKEN — deadness is a fact about the bucket, not a list in this repo. (Or apply a fresh plan file with PLAN_IN.)'); process.exit(2); }
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
       WHERE h.company_id = ${co} AND array_length(i.photo_urls, 1) > 0`,
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
       WHERE p.company_id = ${co} AND array_length(i.photo_urls, 1) > 0`,
  },
];
/* An operation names its ARM, never its table. The table is only ever read from
   the list above, so nothing in a plan file can nominate what gets written to —
   and an op naming an arm that is not here fails the envelope check outright
   rather than being quietly filtered away. */

/* The SHAPE the repair claims to leave behind: photo_urls is still a text[],
   and every importer-minted address left in it opens a real object. A row
   COUNT cannot see this — a repair that wrote the wrong array would report the
   same count (docs/jsonb-double-encoding-coe.md is the whole reason this rule
   exists). */
async function survivingShape(client, arm, ids, liveKeys) {
  if (!ids.length) return [];
  const rows = await client.unsafe(
    `SELECT id::text AS id, photo_urls AS pics FROM ${arm.table} WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const wrong = [];
  for (const r of rows) {
    if (!Array.isArray(r.pics)) {
      wrong.push({ id: r.id, why: `photo_urls is ${typeof r.pics}, not an array` });
      continue;
    }
    for (const k of r.pics) {
      if (/\/ac-\d+-\d+\.jpg$/.test(k) && !liveKeys.has(k)) {
        wrong.push({ id: r.id, why: `still lists a dead address ${k}` });
      }
    }
  }
  return wrong;
}

/* The same shape question when R2 was never asked, which is the whole point of
   applying from a plan. Liveness came from the plan; what this asserts is that
   the column now IS what the operation said it would be — the dropped
   addresses gone, and every address that licensed the drop still present. A
   count would report success for an array that lost the wrong entries. */
async function prunedShape(client, arm, applied) {
  if (!applied.length) return [];
  const rows = await client.unsafe(
    `SELECT id::text AS id, photo_urls AS pics FROM ${arm.table} WHERE id = ANY($1::uuid[])`,
    [applied.map((a) => a.id)],
  );
  const byId = new Map(rows.map((r) => [r.id, r.pics]));
  const wrong = [];
  for (const a of applied) {
    const pics = byId.get(a.id);
    if (!Array.isArray(pics)) {
      wrong.push({ id: a.id, why: `photo_urls is ${pics === undefined ? 'a row that is no longer there' : typeof pics}, not an array` });
      continue;
    }
    const have = new Set(pics);
    for (const k of a.dropped) if (have.has(k)) wrong.push({ id: a.id, why: `still lists the address the plan removed: ${k}` });
    for (const k of a.keeps) if (!have.has(k)) wrong.push({ id: a.id, why: `LOST the working address that licensed the prune: ${k}` });
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
    kind: PRUNE_KIND, account: ACCOUNT, bucket: BUCKET, company: CO,
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

      const byRow = new Map();
      for (const op of ops) {
        if (!byRow.has(op.id)) byRow.set(op.id, []);
        byRow.get(op.id).push(op);
      }
      const now = await sql.unsafe(
        `SELECT id::text AS id, photo_urls AS pics FROM ${arm.table} WHERE id = ANY($1::uuid[])`,
        [[...byRow.keys()]],
      );
      const current = new Map(now.map((r) => [r.id, r.pics]));

      for (const [id, rowOps] of byRow) {
        const pics = current.get(id);
        /* Per row, against the column as it is RIGHT NOW. A plan that was true
           when it was written and is not any more dies here, one row at a time,
           without taking its siblings with it. */
        const refusal = rowOps.map((op) => [op, checkRowPrecondition(PRUNE_KIND, op, pics)]).find(([, c]) => !c.ok);
        if (refusal) {
          refused.push({ arm: arm.name, id, doc: refusal[0].doc, dtl: refusal[0].dtl, code: refusal[1].code, why: refusal[1].why });
          continue;
        }
        const dropped = [...new Set(rowOps.map((o) => o.drop))];
        const keeps = [...new Set(rowOps.flatMap((o) => o.keeps ?? []))];
        const dead = new Set(dropped);
        const next = pics.filter((k) => !dead.has(k));
        await sql.unsafe(`UPDATE ${arm.table} SET photo_urls = $1::text[] WHERE id = $2::uuid`, [next, id]);
        applied.push({ id, dropped, keeps });
      }
      note('');
      note(`${arm.name}: APPLIED — ${applied.length} row(s) updated, ${applied.reduce((s, a) => s + a.dropped.length, 0)} address(es) removed`);
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
      const problems = await prunedShape(check, arm, applied);
      for (const p of problems) { bad(`  ${arm.name} ${p.id}: ${p.why}`); wrong++; }
      note(`  ${arm.name}: ${applied.length} row(s) re-read; each dropped address is gone and every licensing address survives: ${problems.length === 0}`);
    }
  } finally {
    await check.end();
  }

  note('');
  if (refused.length) {
    bad(`REFUSED ${refused.length} row(s) — the column moved after the plan was written:`);
    for (const r of refused) bad(`   [${r.code}] ${r.arm} ${r.doc} AC line ${r.dtl} (${r.id}): ${r.why}`);
  }
  const done = [...appliedByArm.values()].reduce((s, a) => s + a.length, 0);
  note(`APPLIED ${done} row(s), REFUSED ${refused.length} row(s), SHAPE PROBLEMS ${wrong}.`);
  if (refused.length || wrong) {
    bad('Exiting 1: a refusal is a finding, not a skip. Re-run the PLAN against R2 and apply the new file.');
    process.exit(1);
  }
}

async function main() {
  if (PLAN_IN) { await applyFromPlan(); return; }

  note(`prune dead line-photo addresses — MODE=${APPLY ? 'apply' : 'plan'} company=${CO} bucket=${BUCKET}`);
  const liveKeys = await listObjectKeys({
    accountId: ACCOUNT, bucket: BUCKET, token: TOKEN, prefixes: ['so-items/', 'po-items/'],
  });
  note(`R2 holds ${liveKeys.size} object(s) under so-items/ + po-items/`);

  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const work = [];
  for (const arm of ARMS) {
    const rows = await arm.load(sql, CO);
    const { prune, wouldBlank } = planDeadKeyPrune(rows, liveKeys);
    const byRow = new Map(rows.map((r) => [r.id, r]));
    note('');
    note(`${arm.name}: ${rows.length} row(s) carry a photo`);
    note(`  dead addresses that are a STALE DUPLICATE — the row still shows that picture: ${prune.length}`);
    for (const p of prune) note(`     ${p.doc}  AC line ${p.dtl}  drop ${p.drop}`);
    note(`  dead addresses that are the row's ONLY one — LEFT ALONE, owner decides: ${wouldBlank.length}`);
    for (const w of wouldBlank) note(`     WOULD GO BLANK  ${w.doc}  AC line ${w.dtl}  ${w.dead}`);
    work.push({ arm, prune, byRow });
  }

  if (!APPLY) {
    const keys = work.reduce((s, w) => s + w.prune.length, 0);
    const rows = new Set(work.flatMap((w) => w.prune.map((p) => p.id))).size;
    note('');
    note(`PLAN ONLY — ${keys} address(es) would be removed from ${rows} row(s). Nothing was written.`);
    if (PLAN_OUT) {
      const ops = work.flatMap(({ arm, prune }) => prune.map((p) => ({
        arm: arm.name, id: p.id, doc: p.doc, dtl: p.dtl, drop: p.drop, keeps: p.keeps,
      })));
      const plan = buildPlan({ kind: PRUNE_KIND, account: ACCOUNT, bucket: BUCKET, company: CO, ops });
      mkdirSync(dirname(PLAN_OUT), { recursive: true });
      writeFileSync(PLAN_OUT, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
      note('');
      note(`PLAN WRITTEN — ${PLAN_OUT}`);
      note(`  generatedAt ${plan.generatedAt}, ${plan.count} operation(s), digest ${plan.digest}`);
      note(`  Apply it within ${MAX_AGE.minutes} minute(s): MODE=apply CONFIRM="${CONFIRM_PHRASE}" PLAN_IN=${PLAN_OUT} (DATABASE_URL only — no R2 token).`);
      note('  The WOULD GO BLANK addresses are deliberately NOT in the file: they are the owner\'s decision, not an operation.');
    } else {
      note(`Set MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write, or PLAN_OUT=<path> to hand the plan to the apply workflow.`);
    }
    await sql.end();
    return;
  }

  /* Ask the bucket directly about the first few addresses about to be dropped.
     The listing is one authority; a per-key 404 is a second one, and a delete
     licensed by a mis-read listing is the failure worth four requests. */
  const sample = work.flatMap((w) => w.prune).slice(0, 4);
  for (const s of sample) {
    const state = await verifyKeyAbsent({ accountId: ACCOUNT, bucket: BUCKET, token: TOKEN, key: s.drop });
    if (state !== 'absent') {
      bad(`REFUSING: ${s.drop} is ${state} in R2 — the listing and the object disagree`);
      await sql.end();
      process.exit(1);
    }
  }
  note(`spot-checked ${sample.length} address(es) against the bucket directly: absent`);

  const touched = [];
  for (const { arm, prune, byRow } of work) {
    const drops = new Map();
    for (const p of prune) {
      if (!drops.has(p.id)) drops.set(p.id, new Set());
      drops.get(p.id).add(p.drop);
    }
    for (const [id, dead] of drops) {
      const next = (byRow.get(id).pics ?? []).filter((k) => !dead.has(k));
      await sql.unsafe(`UPDATE ${arm.table} SET photo_urls = $1::text[] WHERE id = $2::uuid`, [next, id]);
      touched.push({ arm, id });
    }
    note(`${arm.name}: APPLIED — ${drops.size} row(s) updated, ${prune.length} address(es) removed`);
  }

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let wrong = 0;
  try {
    note('');
    note('=== VERIFIED ON A FRESH CONNECTION ===');
    for (const arm of ARMS) {
      const ids = touched.filter((t) => t.arm === arm).map((t) => t.id);
      const problems = await survivingShape(check, arm, ids, liveKeys);
      for (const p of problems) { bad(`  ${arm.name} ${p.id}: ${p.why}`); wrong++; }
      note(`  ${arm.name}: ${ids.length} row(s) re-read; every remaining importer address opens a real object: ${problems.length === 0}`);
    }
  } finally {
    await check.end();
  }
  await sql.end();
  if (wrong) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
