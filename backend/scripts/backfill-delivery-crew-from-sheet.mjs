#!/usr/bin/env node
/* Backfill the dispatch team's historical crew record onto past delivery
   orders, from the HC Delivery Updated Google Sheet.

   WHY. The TMS trip/crew chain was never run in production (0 trips in prod),
   so the ERP never captured who actually delivered each past order. That record
   lived only in the sheet's own columns: Delivery Date (col Q), lorry plate
   (AI), driver name / IC / contact (AJ/AK/AL), Driver 2 (AN), Helper 1/2
   (AO/AP). The owner wants those on the Delivery Planning board, which reads a
   delivery order's crew from scm.delivery_order_crew's TEXT snapshot columns
   (driver_1_name, driver_1_ic, driver_1_contact, driver_2_name, helper_1_name,
   helper_2_name, lorry_plate) — the exact columns this script writes.

   SOURCE. data/delivery-crew-from-sheet.json — 303 sheet rows that carry any
   crew (lorry / driver / helper). Captured once from the three regional tabs;
   each row is keyed by the sheet's Doc. No. (the AutoCount document number).
   The file is the audit trail: every value written is visible in the PR.

   WHAT IT WRITES. For each row it resolves the sheet key -> the SO
   (coalesce(linked_ac_docno, doc_no)) -> that SO's non-cancelled delivery
   orders, and for each such DO:
     - UPSERT scm.delivery_order_crew (keyed by do_id) with the sheet's free
       text in the *_name / *_ic / *_contact / lorry_plate columns, leaving the
       driver/helper/lorry *_id foreign keys NULL. company_id is taken from the
       DO. A DO that already carries crew (driver_1_name OR lorry_plate OR
       driver_1_id present) is LEFT UNTOUCHED — the owner chose not to overwrite
       the handful already recorded, and the ON CONFLICT guard enforces it in
       the database as well as in the plan.
   And once per SO:
     - UPDATE scm.mfg_sales_orders SET amended_delivery_date (the board's
       editable "Delivery Date") = the sheet's Delivery Date, ONLY where it is
       currently NULL. The original customer_delivery_date is never touched.

   DATA CLEANING. IC "N/A" -> NULL. A trailing " - update" note on a lorry plate
   is stripped; a multi-plate value ("VPC 9058/VQE 9058") is kept verbatim. A
   delivery date is parsed from either yyyy/mm/dd or m/d/yyyy; anything outside
   2023..2027, or unparseable, is reported and its date is skipped (the crew is
   still written).

   REFUSES, never guesses: a key with no SO in the ERP, a key matching more than
   one SO, and an SO with no delivery order are each listed and skipped.

   MODE=plan (default) resolves everything and prints the full plan, writing
   nothing. MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", writes, then
   re-reads on a FRESH connection and asserts the stored driver/lorry VALUES
   match what was intended (a row count is not a shape).

   RE-RUN: inert. The write set is recomputed each run as the delivery orders
   that have NO crew yet; a DO this script filled (or one a planner later set
   through the board) is excluded next time, so a second run writes nothing. The
   date update is guarded by amended_delivery_date IS NULL for the same reason. */

import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const ROWS = JSON.parse(readFileSync(new URL('./data/delivery-crew-from-sheet.json', import.meta.url), 'utf8'));

const clean = (s) => { const t = (s ?? '').trim(); return t === '' ? null : t; };
const cleanIc = (s) => { const t = clean(s); return t && t.toUpperCase() !== 'N/A' ? t : null; };
const cleanLorry = (s) => {
  let t = clean(s);
  if (!t) return null;
  t = t.replace(/\s*-\s*update\s*$/i, '').trim();  // dispatcher's "- update" note, not part of the plate
  return t === '' ? null : t;
};
/** yyyy/mm/dd or m/d/yyyy -> ISO date string, or {bad} when it will not parse
 *  or falls outside the plausible 2023..2027 window. */
const parseDate = (s) => {
  const t = clean(s);
  if (!t) return null;
  let y; let mo; let d;
  let m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else { m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t); if (m) { mo = +m[1]; d = +m[2]; y = +m[3]; } else return { bad: t }; }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2023 || y > 2027) return { bad: t };
  return { iso: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
};

const toCrew = (r) => ({
  driver_1_name: clean(r.drv),
  driver_1_ic: cleanIc(r.ic),
  driver_1_contact: clean(r.ct),
  driver_2_name: clean(r.drv2),
  helper_1_name: clean(r.h1),
  helper_2_name: clean(r.h2),
  lorry_plate: cleanLorry(r.lorry),
});
const hasCrewValue = (c) => Boolean(c.driver_1_name || c.lorry_plate || c.driver_2_name || c.helper_1_name || c.helper_2_name || c.driver_1_contact || c.driver_1_ic);

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}  source rows=${ROWS.length}`);

  const keys = [...new Set(ROWS.map((r) => r.k))];

  // key -> SO. A key matching more than one SO is ambiguous and refused.
  const soRows = await sql`SELECT doc_no, company_id, coalesce(linked_ac_docno, doc_no) AS k
                             FROM scm.mfg_sales_orders WHERE coalesce(linked_ac_docno, doc_no) = ANY(${keys})`;
  const soByKey = new Map();
  for (const r of soRows) {
    const list = soByKey.get(r.k) ?? [];
    list.push({ doc_no: r.doc_no, company_id: Number(r.company_id) });
    soByKey.set(r.k, list);
  }

  const docNos = [...new Set(soRows.map((r) => r.doc_no))];
  const doRows = docNos.length
    ? await sql`SELECT id, so_doc_no, company_id FROM scm.delivery_orders
                  WHERE so_doc_no = ANY(${docNos}) AND coalesce(status::text, '') <> 'CANCELLED'`
    : [];
  const dosByDoc = new Map();
  for (const r of doRows) {
    const list = dosByDoc.get(r.so_doc_no) ?? [];
    list.push({ id: r.id, company_id: Number(r.company_id) });
    dosByDoc.set(r.so_doc_no, list);
  }

  const doIds = doRows.map((r) => r.id);
  const crewRows = doIds.length
    ? await sql`SELECT do_id, driver_1_name, lorry_plate, driver_1_id FROM scm.delivery_order_crew
                  WHERE do_id = ANY(${doIds})`
    : [];
  const existingCrew = new Map(crewRows.map((r) => [r.do_id, Boolean(r.driver_1_name || r.lorry_plate || r.driver_1_id)]));

  const crewWrites = [];          // { do_id, company_id, crew, key }
  const dateWrites = new Map();   // doc_no -> { iso, key }
  const noSo = []; const ambiguous = []; const noDo = []; const skippedExisting = []; const badDates = []; const emptyCrew = [];

  for (const r of ROWS) {
    const sos = soByKey.get(r.k);
    if (!sos || sos.length === 0) { noSo.push(r.k); continue; }
    if (sos.length > 1) { ambiguous.push(`${r.k} -> ${sos.map((s) => s.doc_no).join(', ')}`); continue; }
    const so = sos[0];

    const crew = toCrew(r);
    if (!hasCrewValue(crew)) emptyCrew.push(r.k);

    const dos = dosByDoc.get(so.doc_no) ?? [];
    if (dos.length === 0) { noDo.push(r.k); }
    else if (hasCrewValue(crew)) {
      for (const d of dos) {
        if (existingCrew.get(d.id)) skippedExisting.push(`${r.k} (do ${d.id})`);
        else crewWrites.push({ do_id: d.id, company_id: d.company_id, crew, key: r.k });
      }
    }

    const parsed = parseDate(r.dd);
    if (parsed && parsed.bad) badDates.push(`${r.k}: "${parsed.bad}"`);
    else if (parsed && parsed.iso && !dateWrites.has(so.doc_no)) dateWrites.set(so.doc_no, { iso: parsed.iso, key: r.k });
  }

  note(`\n=== PLAN ===`);
  note(`  crew upserts (delivery orders to fill): ${crewWrites.length}`);
  note(`  delivery-date updates (amended_delivery_date, only where null): ${dateWrites.size}`);
  note(`  skipped — DO already has crew (left untouched): ${skippedExisting.length}`);
  note(`  skipped — key not an ERP order: ${noSo.length}`);
  note(`  skipped — key matches >1 SO (ambiguous): ${ambiguous.length}`);
  note(`  skipped — SO has no delivery order: ${noDo.length}`);
  note(`  rows whose crew cells were all blank after cleaning: ${emptyCrew.length}`);
  note(`  delivery dates that would not parse / out of range (date skipped): ${badDates.length}`);
  for (const x of noSo) note(`    no ERP order: ${x}`);
  for (const x of ambiguous) bad(`    AMBIGUOUS: ${x}`);
  for (const x of noDo) note(`    no DO: ${x}`);
  for (const x of badDates) bad(`    bad date: ${x}`);
  note(`\n  sample of what will be written (first 8):`);
  for (const w of crewWrites.slice(0, 8)) {
    note(`    ${w.key} do=${w.do_id} co=${w.company_id} :: driver="${w.crew.driver_1_name ?? ''}" ic="${w.crew.driver_1_ic ?? ''}" contact="${w.crew.driver_1_contact ?? ''}" lorry="${w.crew.lorry_plate ?? ''}" helper1="${w.crew.helper_1_name ?? ''}" helper2="${w.crew.helper_2_name ?? ''}"`);
  }

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== WRITING ${crewWrites.length} crew row(s) + ${dateWrites.size} date(s) ===`);
  let crewWrote = 0;
  for (const w of crewWrites) {
    const c = w.crew;
    /* onConflict(do_id) DO UPDATE guarded by the existing row being empty, so a
       DO that gained real crew between the read and here is never overwritten. */
    const back = await sql`
      INSERT INTO scm.delivery_order_crew AS existing
        (do_id, company_id, driver_1_name, driver_1_ic, driver_1_contact, driver_2_name, helper_1_name, helper_2_name, lorry_plate, assigned_at, updated_at)
      VALUES (${w.do_id}, ${w.company_id}, ${c.driver_1_name}, ${c.driver_1_ic}, ${c.driver_1_contact}, ${c.driver_2_name}, ${c.helper_1_name}, ${c.helper_2_name}, ${c.lorry_plate}, now(), now())
      ON CONFLICT (do_id) DO UPDATE SET
        driver_1_name = EXCLUDED.driver_1_name,
        driver_1_ic = EXCLUDED.driver_1_ic,
        driver_1_contact = EXCLUDED.driver_1_contact,
        driver_2_name = EXCLUDED.driver_2_name,
        helper_1_name = EXCLUDED.helper_1_name,
        helper_2_name = EXCLUDED.helper_2_name,
        lorry_plate = EXCLUDED.lorry_plate,
        updated_at = now()
      WHERE existing.driver_1_name IS NULL AND existing.lorry_plate IS NULL AND existing.driver_1_id IS NULL
      RETURNING do_id`;
    crewWrote += back.length;
  }
  note(`  crew rows written/updated: ${crewWrote} of ${crewWrites.length}`);

  let dateWrote = 0;
  for (const [docNo, v] of dateWrites) {
    const back = await sql`UPDATE scm.mfg_sales_orders SET amended_delivery_date = ${v.iso}
                             WHERE doc_no = ${docNo} AND amended_delivery_date IS NULL RETURNING doc_no`;
    dateWrote += back.length;
  }
  note(`  delivery dates set: ${dateWrote} of ${dateWrites.size} (the rest already had one)`);

  await sql.end({ timeout: 5 });

  // Verify on a FRESH connection: re-read the written crew and assert the stored
  // VALUES equal what we intended — not a count.
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const sampleIds = crewWrites.slice(0, 15).map((w) => w.do_id);
    const stored = sampleIds.length
      ? await check`SELECT do_id, driver_1_name, driver_1_ic, lorry_plate, helper_1_name FROM scm.delivery_order_crew WHERE do_id = ANY(${sampleIds})`
      : [];
    const byId = new Map(stored.map((r) => [r.do_id, r]));
    let mismatches = 0;
    for (const w of crewWrites.slice(0, 15)) {
      const got = byId.get(w.do_id);
      const want = w.crew;
      const ok = got
        && JSON.stringify([got.driver_1_name, got.driver_1_ic, got.lorry_plate, got.helper_1_name])
           === JSON.stringify([want.driver_1_name, want.driver_1_ic, want.lorry_plate, want.helper_1_name]);
      if (!ok) { mismatches += 1; bad(`    MISMATCH ${w.key} do=${w.do_id}: stored ${JSON.stringify(got)} wanted driver="${want.driver_1_name}" lorry="${want.lorry_plate}"`); }
      else note(`    ok ${w.key} do=${w.do_id}: driver="${got.driver_1_name ?? ''}" lorry="${got.lorry_plate ?? ''}" helper1="${got.helper_1_name ?? ''}"`);
    }
    note(`  verified ${Math.min(15, crewWrites.length)} crew row(s); mismatches: ${mismatches}`);

    const dateSample = [...dateWrites.entries()].slice(0, 5);
    for (const [docNo, v] of dateSample) {
      const [row] = await check`SELECT amended_delivery_date::text AS d FROM scm.mfg_sales_orders WHERE doc_no = ${docNo}`;
      note(`    ${v.key} ${docNo}: amended_delivery_date is now ${row?.d ?? '(none)'} (sheet said ${v.iso})`);
    }
    if (mismatches) { bad(`verification found ${mismatches} mismatch(es)`); process.exitCode = 1; }
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
