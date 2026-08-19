#!/usr/bin/env node
// READ-ONLY. Why a purchase order's lines do not appear in the GRN-from-PO picker.
//
// THE OWNER'S QUESTION, 2026-08-17: `HC-PO-2608-001` shows two lines, each
// `Ordered 1 / Received 0 / Balance 1`, status "Submitted", receipt progress
// 0 / 2 — and `/scm/grns/from-po?poId=<it>` says `0 OF 0 ROWS`, "No outstanding
// PO lines — every line has been received (or there are no outstanding POs)."
// Two screens of the same ERP contradict each other about one document, so one
// of them is wrong and this prints the inputs that say which.
//
// ANSWERED, and the read has since been FIXED — see the note below before you
// read a verdict off this script. The picker is `GET /outstanding-po-items`
// (scm/routes/grns.ts, read now in scm/lib/outstanding-po-lines.ts). It USED to
// be one PostgREST statement followed by TWO JavaScript filters:
//
//   SELECT ... FROM scm.purchase_order_items poi
//   JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id  -- `po:...!inner`
//   WHERE poi.company_id = <active>                               -- scopeToCompany
//   ORDER BY poi.purchase_order_id DESC                           -- a UUID column
//   LIMIT 500
//   -- then, in JS:
//   .filter(po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED')
//   .filter(qty - (received_qty ?? 0) > 0)
//
// It evaluates the gates ONE AT A TIME and NAMES the one that drops each line,
// rather than reporting "not there". On its first dispatch (run 32028603860)
// that named the WINDOW gate, which no code comment mentioned:
// `purchase_order_id` is a uuid, so `ORDER BY ... DESC` is random with respect
// to age and `LIMIT 500` took an ARBITRARY sample. For company HOUZS: 875 PO
// lines, 356 outstanding, and the picker could see 188 of them.
//
// >>> THE WINDOW GATE NO LONGER EXISTS. PR #2367 (2026-08-17) moved the status
// >>> filter into the statement and replaced the cap with paginateAll. The gate
// >>> is kept here as an INFORMATIONAL section — a probe that keeps reporting a
// >>> gate the code has dropped is a stale fact that gets believed, and this
// >>> repo has paid for that repeatedly. `HISTORICAL_LIMIT` below is thus the
// >>> HISTORICAL cap, used only to show what it WOULD have hidden. Section F is
// >>> the live one: it evaluates the CURRENT read and says whether the picker
// >>> returns this document's lines today.
//
// NOTHING IS WRITTEN. One connection, SELECTs only, no DDL, no transaction.
//
// RE-RUN: idempotent and side-effect free. Run it as often as you like.
//
//   DOC_NO=HC-PO-2608-001 node backend/scripts/why-po-not-receivable.mjs
//
// ENUM TRAP (inherited from the other audits here): status columns are ENUMS,
// so COALESCE(col,'') coerces '' INTO the enum and throws. Always ::text first.
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL missing'); process.exit(1); }

/* Default is the order the owner asked about; any PO number may be passed. */
const DOC_NO = process.env.DOC_NO || 'HC-PO-2608-001';
/* Blank = resolve the active company from the document itself, which is what
   the owner's session would have been on. An explicit value overrides. */
const COMPANY_IN = String(process.env.COMPANY_ID ?? '').trim();

/* HISTORICAL. The cap the read carried until PR #2367 removed it. Kept so the
   window section can still show what it WOULD have hidden; it is no longer a
   gate and must not be reported as one. */
const HISTORICAL_LIMIT = 500;
/* Live. RECEIVABLE_PO_STATUSES in scm/routes/grns.ts — a change there is a
   change here. */
const OPEN_STATUSES = ['SUBMITTED', 'PARTIALLY_RECEIVED'];

const sql = postgres(DSN, { ssl: 'require', max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(`::notice::${m}`);
const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
const iso = (d) => d?.toISOString?.() ?? (d ?? '(NULL)');

async function main() {
  notice(`purchase order ${DOC_NO} — READ ONLY, no writes, no DDL`);

  /* ── A — the header, found WITHOUT a company predicate ───────────────────
     Deliberately unscoped: if the document lives in a company the picker was
     never asked about, that IS the finding, and a scoped lookup would report it
     as "no such document" and hide it. `SELECT *` rather than a column list —
     the scm tables were vendored, not created by a migration in this repo, so
     there is no CREATE TABLE here to check an optional column against. Enum
     columns come back as their text label, which is safe; only SQL-side
     COALESCE / comparison on them needs the ::text cast. */
  const companies = await sql`SELECT id, code, name, is_active FROM public.companies ORDER BY id`;
  notice(`companies master: ${companies.map((r) => `${r.id}=${r.code}${r.is_active ? '' : ' (inactive)'}`).join(', ') || '(empty)'}`);

  const headers = await sql`SELECT * FROM scm.purchase_orders WHERE po_number = ${DOC_NO}`;

  if (headers.length === 0) {
    notice(`A — no purchase_orders row with po_number = ${DOC_NO} in ANY company. Nothing further to check.`);
    return;
  }
  if (headers.length > 1) {
    notice(`A — WARNING: ${headers.length} rows carry po_number ${DOC_NO}. Every one is printed below.`);
  }

  for (const po of headers) {
    console.log('');
    notice(`A — header ${po.po_number}`);
    notice(`  id            = ${po.id}`);
    notice(`  status        = ${po.status}`);
    notice(`  company_id    = ${po.company_id ?? '(NULL)'}`
      + ` (${companies.find((x) => Number(x.id) === Number(po.company_id))?.code ?? 'unknown code'})`);
    notice(`  supplier_id   = ${po.supplier_id ?? '(NULL)'}`);
    if (po.supplier_id) {
      const [sup] = await sql`SELECT code, name, company_id FROM scm.suppliers WHERE id = ${po.supplier_id}`;
      notice(`  supplier      = ${sup ? `${sup.code} / ${sup.name} (company_id ${sup.company_id ?? '(NULL)'})` : '(no suppliers row — the !inner-less embed would render blank)'}`);
    }
    notice(`  po_date       = ${po.po_date ?? '(NULL)'}`);
    notice(`  expected_at   = ${po.expected_at ?? '(NULL)'}`);
    notice(`  purchase_location_id = ${po.purchase_location_id ?? '(NULL)'}`);
    notice(`  subtotal_sen=${po.subtotal_sen ?? '(NULL)'} total_sen=${po.total_sen ?? '(NULL)'}`);
    notice(`  created_at    = ${iso(po.created_at)}`);
    notice(`  linked_ac_docno = ${po.linked_ac_docno ?? '(none)'}`);

    /* THE COMPANY THE PICKER WOULD HAVE BEEN ASKED FOR. The operator was looking
       at this document, so their switcher was on this document's company; an
       explicit COMPANY_ID overrides for a what-if. */
    const ACTIVE = COMPANY_IN ? Number(COMPANY_IN) : Number(po.company_id);
    notice(`  ACTIVE COMPANY USED FOR THE GATES BELOW: ${ACTIVE}`
      + `${COMPANY_IN ? ' (from the COMPANY_ID input)' : " (the header's own company — what the operator's switcher was on)"}`);

    /* ── B — the lines ────────────────────────────────────────────────────── */
    const lines = await sql`
      SELECT * FROM scm.purchase_order_items
      WHERE purchase_order_id = ${po.id}
      ORDER BY item_code, id`;

    console.log('');
    notice(`B — ${lines.length} line(s) on this purchase order`);
    console.log(`${pad('ITEM', 18)} ${pad('CO', 5)} ${pad('QTY', 6)} ${pad('RECV', 6)} `
      + `${pad('BAL', 6)} ${pad('UNIT_SEN', 11)} ${pad('WAREHOUSE_ID', 38)} ${pad('ID', 38)}`);
    for (const l of lines) {
      const bal = Number(l.qty ?? 0) - Number(l.received_qty ?? 0);
      console.log(`${pad(l.item_code, 18)} ${pad(l.company_id ?? 'NULL', 5)} ${pad(l.qty, 6)} `
        + `${pad(l.received_qty ?? 0, 6)} ${pad(bal, 6)} ${pad(l.unit_price_sen, 11)} `
        + `${pad(l.warehouse_id ?? '(NULL)', 38)} ${pad(l.id, 38)}`);
    }

    /* The effective ship-into warehouse the picker computes — the detail
       screen's "TRANSFER TO" comes from the same pair of columns. */
    const whIds = [...new Set(lines.map((l) => l.warehouse_id).concat([po.purchase_location_id]).filter(Boolean))];
    const whById = new Map();
    if (whIds.length > 0) {
      for (const w of await sql`SELECT id, code, name, company_id FROM scm.warehouses WHERE id IN ${sql(whIds)}`) {
        whById.set(w.id, w);
      }
    }
    for (const l of lines) {
      const eff = l.warehouse_id ?? po.purchase_location_id ?? null;
      const w = eff ? whById.get(eff) : null;
      notice(`  ${l.item_code}: effective warehouse = ${eff ?? '(none)'}`
        + `${w ? ` -> ${w.code} / ${w.name} (company_id ${w.company_id ?? '(NULL)'})` : ''}`);
    }

    /* ── The HISTORICAL window, measured before the verdicts need it ────────
       ORDER BY purchase_order_id DESC over a UUID column: the sort key was the
       random uuid, not a date, so "the first 500" was an arbitrary sample of
       the company's PO lines rather than the newest ones. Rank this PO's lines
       in that ordering by counting how many rows sort strictly ahead of them.
       REMOVED FROM THE CODE by PR #2367 — reported below as history, never as
       a live verdict. */
    const [{ ahead }] = await sql`
      SELECT count(*)::int AS ahead
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
      WHERE poi.company_id = ${ACTIVE}
        AND poi.purchase_order_id > ${po.id}::uuid`;
    const [{ ties }] = await sql`
      SELECT count(*)::int AS ties
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
      WHERE poi.company_id = ${ACTIVE}
        AND poi.purchase_order_id = ${po.id}::uuid`;
    /* Every line of one PO shares the sort key, so they occupy positions
       [ahead+1 .. ahead+ties] as a block. Inside the window iff the block
       STARTS before the cut; wholly outside iff it starts at or after it. */
    const windowHeld = ahead < HISTORICAL_LIMIT;
    const windowHeldAll = ahead + ties <= HISTORICAL_LIMIT;

    console.log('');
    notice('B2 — the LIVE gates of GET /outstanding-po-items, one at a time');
    notice(`  (the window gate is gone since PR #2367; its inputs are printed under B3 as history)`);
    for (const l of lines) {
      const drops = [];
      /* GATE 1 EXISTS is true by construction here — the line came out of this
         very table — and is named so the printed chain is the whole chain. */
      if (Number(l.company_id) !== ACTIVE) {
        drops.push(`GATE 2 COMPANY SCOPE — line company_id ${l.company_id ?? 'NULL'} != active ${ACTIVE}`);
      }
      /* GATE 3 INNER JOIN — po:purchase_orders!inner. The parent resolves by
         construction here (we read the lines through its id). */
      if (!OPEN_STATUSES.includes(String(po.status))) {
        drops.push(`GATE 5 PO STATUS — ${po.status} is not one of ${OPEN_STATUSES.join(' / ')}`);
      }
      const bal = Number(l.qty ?? 0) - Number(l.received_qty ?? 0);
      if (!(bal > 0)) {
        drops.push(`GATE 6 REMAINING QTY — qty ${l.qty} - received ${l.received_qty ?? 0} = ${bal}, not > 0`);
      }
      notice(`  ${l.item_code}: ${drops.length ? `DROPPED BY ${drops.join(' ; ALSO ')}` : 'PASSES EVERY LIVE GATE — the picker returns this line'}`);
    }

    /* ── B3 — the gate that USED to fire here, kept as history ────────────── */
    console.log('');
    notice('B3 — HISTORY: the window gate PR #2367 removed');
    notice(`  ${ahead} row(s) sorted ahead of this PO, ${ties} shared its sort key, cap was ${HISTORICAL_LIMIT}`);
    notice(`  under the OLD read this document would have been: ${
      windowHeld ? (windowHeldAll ? 'inside the window' : 'split across the cut') : 'OUTSIDE the window — invisible to the picker'}`);

    /* ── C — what the old window cost, against the real population ────────── */
    console.log('');
    notice(`C — HISTORY: what the ${HISTORICAL_LIMIT}-row window cost company ${ACTIVE}`);
    const [pop] = await sql`
      SELECT count(*)::int AS total_lines
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
      WHERE poi.company_id = ${ACTIVE}`;
    const [openAll] = await sql`
      SELECT count(*)::int AS outstanding
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
      WHERE poi.company_id = ${ACTIVE}
        AND p.status::text IN ${sql(OPEN_STATUSES)}
        AND poi.qty - COALESCE(poi.received_qty, 0) > 0`;
    const [inWin] = await sql`
      WITH win AS (
        SELECT poi.id, poi.qty, poi.received_qty, p.status::text AS st
        FROM scm.purchase_order_items poi
        JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
        WHERE poi.company_id = ${ACTIVE}
        ORDER BY poi.purchase_order_id DESC
        LIMIT ${HISTORICAL_LIMIT}
      )
      SELECT count(*)::int AS window_rows,
             count(*) FILTER (
               WHERE st IN ('SUBMITTED', 'PARTIALLY_RECEIVED')
                 AND qty - COALESCE(received_qty, 0) > 0
             )::int AS outstanding_in_window
      FROM win`;
    notice(`  purchase_order_items in this company (joined to a live PO): ${pop.total_lines}`);
    notice(`  genuinely OUTSTANDING lines (open status + balance > 0):    ${openAll.outstanding}`);
    notice(`  rows the OLD window read:                                   ${inWin.window_rows} (cap ${HISTORICAL_LIMIT})`);
    notice(`  OUTSTANDING lines the OLD window could see:                 ${inWin.outstanding_in_window}`);
    notice(`  outstanding lines it HID (0 today — the cap is gone):       ${openAll.outstanding - inWin.outstanding_in_window}`);

    /* ── D — the company stamp on this document's own rows, then table-wide ── */
    console.log('');
    notice('D — company stamping');
    const stamps = await sql`
      SELECT COALESCE(company_id::text, '(NULL)') AS co, count(*)::int AS n
      FROM scm.purchase_order_items WHERE purchase_order_id = ${po.id}
      GROUP BY 1 ORDER BY 1`;
    notice(`  header company_id = ${po.company_id ?? '(NULL)'}`);
    for (const s of stamps) notice(`  line company_id ${s.co}: ${s.n} row(s)`);
    const headerCo = String(po.company_id ?? '(NULL)');
    notice(`  lines whose company_id differs from the header: `
      + `${stamps.filter((s) => s.co !== headerCo).reduce((a, s) => a + s.n, 0)}`);

    /* The same question across the WHOLE table, so a one-document answer is not
       mistaken for a system-wide one in either direction. */
    const [drift] = await sql`
      SELECT count(*)::int AS n
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
      WHERE poi.company_id IS DISTINCT FROM p.company_id`;
    const [nullco] = await sql`
      SELECT count(*)::int AS n FROM scm.purchase_order_items WHERE company_id IS NULL`;
    notice(`  TABLE-WIDE: purchase_order_items whose company_id != their PO header's: ${drift.n}`);
    notice(`  TABLE-WIDE: purchase_order_items with a NULL company_id:                ${nullco.n}`);

    /* ── E — has anything already been received against these lines? ──────── */
    console.log('');
    notice('E — goods received notes already pointing at these PO lines');
    if (lines.length === 0) {
      notice('  no PO lines, so nothing can point at them');
    } else {
      const grnRows = await sql`
        SELECT g.grn_number, g.status::text AS status, g.company_id,
               gi.qty_received, gi.qty_accepted, gi.purchase_order_item_id
        FROM scm.grn_items gi
        JOIN scm.grns g ON g.id = gi.grn_id
        WHERE gi.purchase_order_item_id IN ${sql(lines.map((l) => l.id))}
        ORDER BY g.grn_number`;
      notice(`  ${grnRows.length} GRN line(s) reference these PO lines`);
      for (const g of grnRows) {
        notice(`    ${g.grn_number} ${g.status} company_id=${g.company_id ?? '(NULL)'} `
          + `qty_received=${g.qty_received} qty_accepted=${g.qty_accepted} poItem=${g.purchase_order_item_id}`);
      }
    }

    /* ── F — WHAT THE CURRENT READ RETURNS ────────────────────────────────
       The sections above evaluate gates one at a time, which is how you find a
       cause; this one runs the whole live statement and asks the only question
       the operator has. It is the SQL equivalent of what
       scm/lib/outstanding-po-lines.ts now issues: company scope, the `!inner`
       parent join, the status filter IN THE QUERY, the (purchase_order_id, id)
       total order, no cap — then the remaining-qty test the JS still applies
       because PostgREST cannot compare two columns.

       It is a REPLICA and says so. It cannot prove PostgREST translates
       `.not('po.status','in',…)` across the embed the way this JOIN predicate does;
       only the running endpoint proves that. What it does prove is that the
       rows exist and satisfy every condition the new read asks for, which is
       the half a replica can get right. */
    console.log('');
    notice('F — LIVE: what the CURRENT read returns for this document');
    const visible = await sql`
      SELECT poi.id, poi.item_code
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
      WHERE poi.company_id = ${ACTIVE}
        AND p.status::text IN ${sql(OPEN_STATUSES)}
        AND poi.qty - COALESCE(poi.received_qty, 0) > 0
        AND poi.purchase_order_id = ${po.id}::uuid
      ORDER BY poi.purchase_order_id DESC, poi.id`;
    notice(`  lines of ${po.po_number} the picker now returns: ${visible.length} of ${lines.length}`);
    for (const v of visible) notice(`    ${v.item_code} (${v.id})`);
    const [{ n: allVisible }] = await sql`
      SELECT count(*)::int AS n
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
      WHERE poi.company_id = ${ACTIVE}
        AND p.status::text IN ${sql(OPEN_STATUSES)}
        AND poi.qty - COALESCE(poi.received_qty, 0) > 0`;
    notice(`  company-wide, the picker now returns ${allVisible} outstanding line(s)`);
    notice(`  VERDICT: ${
      visible.length === lines.filter((l) => Number(l.qty ?? 0) - Number(l.received_qty ?? 0) > 0).length
        ? 'every line of this document with a balance is now reachable'
        : 'SOME line with a balance is still not reachable — read B2 for which gate'}`);
  }

  console.log('');
  notice('READ THE RESULT LIKE THIS:');
  notice('  DROPPED BY GATE 2 -> the conversion mis-stamped company_id; the conversion is the bug and the rows need repair');
  notice('  DROPPED BY GATE 5 -> the PO carries a status the picker does not open; decide which status a converted PO should carry');
  notice('  DROPPED BY GATE 6 -> it really is received; the detail screen is the one that is wrong');
  notice('  PASSES EVERY LIVE GATE -> the server returns it; any remaining loss is client-side in GrnFromPo.tsx');
  notice('  B3/C are HISTORY — the window they describe was removed by PR #2367 and is not a verdict');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
