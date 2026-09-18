#!/usr/bin/env node
/* fix-cutover-lot-age-2026-09-09 — make a cutover stock lot say when the goods
 * actually arrived, not when the migration ran.
 *
 * Owner, 2026-09-09: 「从 AutoCount 来的 stock 全部，你都要跟着 AutoCount 那边去
 * 拿到它的 variant、它的 stock、COGS 跟它的那个年龄」 — age is the fourth of the
 * four, and the only one still untouched.
 *
 * WHY IT MATTERS TWICE. The Stock Breakdown screen sorts by Age so the owner can
 * see what has sat longest — the owner's own words on 2026-08-06:
 * 「age 的计算为什么不是根据库存？当我 sort 的时候…我就看不到到底是哪一个东西放得
 * 最久」. A lot stamped with the migration date reads as brand new. And
 * `received_at` is also the FIFO ORDER: consumption walks oldest-first, so a
 * wrong date does not merely mislabel a row, it sends the next delivery order to
 * the wrong layer and books the wrong cost.
 *
 * ── THE ONLY SOURCE THIS TRUSTS ───────────────────────────────────────────
 * `import-ac-stock-layers.mjs` rebuilt the opening balance out of AutoCount's own
 * receipt history and wrote the source document into each movement's note,
 * verbatim: `AC GR GR-004679 2026-05-28`. That date is the book's own statement
 * of when those goods arrived. Where it disagrees with the lot's `received_at`,
 * the note is right and the lot is corrected.
 *
 * NOTHING ELSE IS TOUCHED. A flat opening lot carries a note with no date
 * (`AutoCount <code> @ <loc>: AC 5 vs ERP 3`) and a sofa opening lot carries the
 * AutoCount PO, not a receipt — so for those the arrival date is genuinely not
 * recorded on our side, and inventing one would put a plausible number where
 * there is no fact. They are COUNTED AND LISTED, not guessed. Owner:
 * 「如果没有 variant，那就算了」 — the same rule applies to a date.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN, printing every lot and both dates.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   Every UPDATE names the exact date being replaced, so a lot somebody has
 *   re-dated since this was measured matches nothing and is reported.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE: every lot
 *   this run moved now carries the book's date, no lot moved to a date the book
 *   did not state, and the lot count, quantities and inventory value are
 *   unchanged — this writes one column and must not move stock or money.
 *
 * RE-RUN: idempotent — a second run finds the dates already matching and reports
 * 0 to write.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 *       COMPANY_ID (default 1)
 */
import postgres from 'postgres';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'fix cutover lot age 2026-09-09';
const APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}

/* `AC GR GR-004679 2026-05-28` — the source document and its date, written by
   import-ac-stock-layers.mjs when it replaced the flat opening balance with the
   book's real receipt layers. */
const NOTE_RE = /^AC\s+(\w+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s*$/i;

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  log(`MODE=${MODE}  company ${CO}`);

  /* `to_char`, not `::date`. A date column arrives from postgres.js as a JS Date,
     and comparing it to a string is how the costing pass silently found nothing
     (docs/bugs/0770). Text on both sides, compared as text. */
  const lots = await sql`
    SELECT l.id, l.item_code, l.qty_remaining::numeric AS qty,
           to_char(l.received_at, 'YYYY-MM-DD') AS at,
           l.source_doc_type, l.source_doc_no, m.notes
      FROM scm.inventory_lots l
      LEFT JOIN scm.inventory_movements m ON m.id = l.movement_id
     WHERE l.company_id = ${CO} AND l.qty_remaining > 0
     ORDER BY l.item_code, l.received_at`;
  log(`lots on hand: ${lots.length}`);

  const plan = [];
  const skip = new Map();
  const bump = (k, units) => {
    const e = skip.get(k) ?? { lots: 0, units: 0 };
    e.lots += 1; e.units += units; skip.set(k, e);
  };

  for (const l of lots) {
    const units = Number(l.qty);
    const m = NOTE_RE.exec(String(l.notes ?? '').trim());
    if (!m) {
      bump(l.source_doc_type === 'AC_CUTOVER'
        ? 'cutover lot whose note names no receipt date — the book never told us when it arrived'
        : 'not a cutover lot — its date comes from our own receipt and is already real', units);
      continue;
    }
    const bookDate = m[3];
    if (!l.at) { bump('the lot carries no received date at all', units); continue; }
    if (l.at === bookDate) { bump('already matches the book', units); continue; }
    plan.push({ id: l.id, code: l.item_code, qty: units,
      from: l.at, to: bookDate, doc: m[2] });
  }

  const units = plan.reduce((a, p) => a + p.qty, 0);
  log(`\n=== WOULD RE-DATE: ${plan.length} lot(s) / ${units} unit(s) ===`);
  let older = 0;
  let newer = 0;
  for (const p of plan) {
    if (p.to < p.from) older += 1; else newer += 1;
    log(`  ${p.code.padEnd(30)} ${String(p.qty).padStart(4)}u  ${p.from} -> ${p.to}   (${p.doc})`);
  }
  log(`  of those, ${older} move OLDER (they have sat longer than the screen says) and ${newer} move newer`);

  log('\n  LEFT ALONE:');
  for (const [k, v] of [...skip].sort((a, b) => b[1].units - a[1].units)) {
    log(`    ${String(v.lots).padStart(4)} lot(s) / ${String(v.units).padStart(5)} unit(s) — ${k}`);
  }

  if (!APPLY) {
    log('\nPLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }

  const [before] = await sql`
    SELECT count(*)::int AS lots, coalesce(sum(qty_remaining), 0)::text AS qty,
           coalesce(sum(qty_remaining * coalesce(unit_cost_sen, 0)), 0)::text AS value_sen
      FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining > 0`;

  let wrote = 0;
  for (const p of plan) {
    const done = await sql`
      UPDATE scm.inventory_lots
         SET received_at = ${`${p.to}T00:00:00Z`}
       WHERE id = ${p.id} AND to_char(received_at, 'YYYY-MM-DD') = ${p.from}
      RETURNING id`;
    wrote += done.length;
  }
  log(`\nAPPLIED: ${wrote} lot(s) re-dated.`);
  await sql.end();

  const check = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
  const [after] = await check`
    SELECT count(*)::int AS lots, coalesce(sum(qty_remaining), 0)::text AS qty,
           coalesce(sum(qty_remaining * coalesce(unit_cost_sen, 0)), 0)::text AS value_sen
      FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining > 0`;
  /* Every lot this run moved must now read EXACTLY the date the book stated —
     a count of updated rows would pass even if the write landed a day out
     through a timezone. Compare the stored TEXT against the note's text. */
  let landed = 0;
  let strayed = 0;
  for (const p of plan) {
    const [row] = await check`
      SELECT to_char(received_at, 'YYYY-MM-DD') AS at FROM scm.inventory_lots WHERE id = ${p.id}`;
    if (!row) { strayed += 1; continue; }
    if (row.at === p.to) landed += 1;
    else if (row.at !== p.from) strayed += 1;
  }
  await check.end();

  const ok = {
    'every lot this run moved now reads the book\'s own date': landed === wrote,
    'no lot landed on a date the book did not state': strayed === 0,
    'lot count unchanged': after.lots === before.lots,
    'quantities unchanged': after.qty === before.qty,
    'inventory value unchanged': after.value_sen === before.value_sen,
  };
  log('\n=== VERIFY (fresh connection) ===');
  let bad = 0;
  for (const [k, v] of Object.entries(ok)) {
    if (!v) bad += 1;
    log(`  ${v ? 'OK   ' : 'WRONG'} ${k}`);
  }
  log(`  ${landed} of ${plan.length} planned lot(s) now carry the book's date`);
  if (bad) { console.error('VERIFY FAILED.'); process.exit(1); }
  log('VERIFY OK — one column written, no stock and no money moved.');
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
