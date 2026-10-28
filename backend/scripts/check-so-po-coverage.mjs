// Read-only: does a purchase order PHYSICALLY carry the piece a sales-order line
// says it is SHORT of — or is the line SHORT because it was never linked?
//
// The owner, 2026-09-10, looking at HC-SO-008166 on the MRP page: three sofa
// pieces show HC-PO-009974 as coverage and one `9058-1NA` shows SHORT. His
// words: 「这个PO 都开了 你说没有order到？确定？」 — the PO is open, are you sure
// this piece was not ordered?
//
// He is right to be sceptical, and the honest answer needs the PO's OWN lines,
// not the MRP display. MRP's SHORT means "this SO line is not COVERED in the
// allocation", which is NOT the same as "no PO exists for this piece". Two
// worlds produce the identical red chip and the fix is opposite in each:
//
//   (a) the PO genuinely carries FEWER of that piece than the SO ordered
//       -> a real under-order; the PO must be corrected/topped up.
//   (b) the PO carries ENOUGH but a SO line was never linked to it
//       -> the goods ARE on order; the LINK is missing (linked_ac_dtlkey is
//          not unique across ERP lines — see docs, "A sofa is ONE book line").
//
// This prints, per SO line and per PO line, the counts and the links so the two
// are told apart on sight. It writes NOTHING.
//
// LINKS ARE TWO MECHANISMS and both are read:
//   · purchase_order_items.so_item_id      (migration 0098, one SO line/PO line)
//   · purchase_order_item_allocations       (splits a PO line's qty across SO
//                                            lines: purchase_order_item_id, so_item_id, qty)
//
//   DATABASE_URL   required
//   SO_DOC         default HC-SO-008166
//   PO_DOC         optional; when given, only that PO is detailed. Default: every
//                  PO any line of the SO is linked to.
//   COMPANY_ID     default 1
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(1); }
const SO = (process.env.SO_DOC ?? 'HC-SO-008166').trim();
const POq = (process.env.PO_DOC ?? '').trim();
const CO = Number(process.env.COMPANY_ID ?? 1);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

try {
  // ── CENSUS MODE (SO_DOC=CENSUS): how widespread is the lopsided-link pattern?
  //    A sofa/bedframe SO line reads SHORT because its OWN linked PO qty is below
  //    its need, WHILE the PO(s) touching the order carry enough of that item
  //    code for the whole order's need — the goods are on order, the links are
  //    piled on a sibling. That is world (b), and it is what a buyer must NOT
  //    re-order against. Contrasted with world (a): the code is genuinely short
  //    on the touching POs.
  if (SO.toUpperCase() === 'CENSUS') {
    const rows = await sql`
      WITH so AS (
        SELECT i.id, i.doc_no, i.item_code, i.qty::numeric AS qty,
               COALESCE((SELECT SUM(d.qty) FROM scm.delivery_order_items d
                           JOIN scm.delivery_orders h ON h.id = d.delivery_order_id
                          WHERE d.so_item_id = i.id
                            AND COALESCE(h.status::text,'') <> 'CANCELLED'), 0)::numeric AS delivered
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no AND o.company_id = i.company_id
         WHERE i.company_id = ${CO} AND i.cancelled = false
           AND lower(COALESCE(i.item_group,'')) IN ('sofa','bedframe')
           AND o.status::text NOT IN ('CANCELLED','CLOSED','DELIVERED','INVOICED','DRAFT','SHIPPED')
      ),
      lk AS (
        SELECT p.so_item_id, p.qty::numeric AS qty
          FROM scm.purchase_order_items p
          JOIN scm.purchase_orders o ON o.id = p.purchase_order_id
         WHERE o.company_id = ${CO} AND o.status::text <> 'CANCELLED' AND p.so_item_id IS NOT NULL
        UNION ALL
        SELECT a.so_item_id, a.qty::numeric
          FROM scm.purchase_order_item_allocations a
          JOIN scm.purchase_order_items p ON p.id = a.purchase_order_item_id
          JOIN scm.purchase_orders o ON o.id = p.purchase_order_id
         WHERE o.company_id = ${CO} AND o.status::text <> 'CANCELLED'
      ),
      line_linked AS (
        SELECT so.*, COALESCE((SELECT SUM(lk.qty) FROM lk WHERE lk.so_item_id = so.id), 0)::numeric AS linked
          FROM so
      ),
      grp AS (
        SELECT doc_no, item_code, SUM(qty) AS need_total, SUM(linked) AS linked_total, COUNT(*) AS lines
          FROM line_linked GROUP BY doc_no, item_code
      )
      SELECT ll.doc_no, ll.item_code, ll.qty, ll.linked,
             g.need_total, g.linked_total, g.lines,
             CASE WHEN g.linked_total >= g.need_total THEN 'b' ELSE 'a' END AS world
        FROM line_linked ll
        JOIN grp g USING (doc_no, item_code)
       WHERE ll.linked < ll.qty
       ORDER BY world, ll.doc_no, ll.item_code`;

    const b = rows.filter((r) => r.world === 'b');
    const a = rows.filter((r) => r.world === 'a');
    const bDocs = new Set(b.map((r) => r.doc_no));
    const aDocs = new Set(a.map((r) => r.doc_no));
    log(`CENSUS — company ${CO}, outstanding sofa/bedframe lines that read SHORT:`);
    log('');
    log(`WORLD (b) — goods ARE on the PO, the link is piled on a sibling:`);
    log(`  ${b.length} line(s) across ${bDocs.size} sales order(s). Re-ordering these DOUBLE-orders.`);
    for (const r of b.slice(0, 40)) {
      log(`    ${r.doc_no}  ${r.item_code}  this line needs ${r.qty}, linked ${r.linked}; `
        + `the order needs ${r.need_total} of it and the PO carries ${r.linked_total}`);
    }
    if (b.length > 40) log(`    ... and ${b.length - 40} more`);
    log('');
    log(`WORLD (a) — the code is genuinely short on the touching POs (a real top-up):`);
    log(`  ${a.length} line(s) across ${aDocs.size} sales order(s).`);
    for (const r of a.slice(0, 20)) {
      log(`    ${r.doc_no}  ${r.item_code}  needs ${r.qty}, linked ${r.linked}; `
        + `order needs ${r.need_total}, PO carries ${r.linked_total}`);
    }
    if (a.length > 20) log(`    ... and ${a.length - 20} more`);
    log('');
    log('World (b) is repaired by REDISTRIBUTING links (no new PO, no goods move); '
      + 'world (a) needs a top-up PO. Both read off the POs own lines, not the MRP display.');
    await sql.end();
    process.exit(0);
  }

  log(`company=${CO}  sales order=${SO}${POq ? `  purchase order=${POq}` : ''}`);
  log('');

  // ── The SO's own lines, with how much has shipped. ────────────────────────
  const soLines = await sql`
    SELECT i.id, i.item_code, i.qty::numeric AS qty, i.cancelled,
           COALESCE((SELECT SUM(d.qty) FROM scm.delivery_order_items d
                       JOIN scm.delivery_orders h ON h.id = d.delivery_order_id
                      WHERE d.so_item_id = i.id
                        AND COALESCE(h.status::text,'') <> 'CANCELLED'), 0)::numeric AS delivered
      FROM scm.mfg_sales_order_items i
     WHERE i.company_id = ${CO} AND i.doc_no = ${SO}
     ORDER BY i.item_code, i.id`;
  log(`SALES ORDER ${SO} — ${soLines.length} line(s):`);
  for (const l of soLines) {
    log(`  line ${l.id.slice(0, 8)}  ${l.item_code}  qty=${l.qty}  delivered=${l.delivered}${l.cancelled ? '  [CANCELLED]' : ''}`);
  }
  const soLineIds = soLines.map((l) => l.id);

  // ── Every allocation that ties a PO line to one of this SO's lines. ───────
  const alloc = soLineIds.length ? await sql`
    SELECT a.purchase_order_item_id, a.so_item_id, a.qty::numeric AS qty
      FROM scm.purchase_order_item_allocations a
     WHERE a.so_item_id = ANY(${soLineIds})` : [];
  const allocBySoLine = new Map();
  for (const a of alloc) {
    allocBySoLine.set(a.so_item_id, (allocBySoLine.get(a.so_item_id) ?? 0) + Number(a.qty));
  }
  const allocPoItemIds = [...new Set(alloc.map((a) => a.purchase_order_item_id))];

  // ── The PO lines: those directly linked (so_item_id) + those linked via an
  //    allocation + (if PO_DOC given) every line of that PO regardless of link. ─
  const directPoLines = soLineIds.length ? await sql`
    SELECT p.id, o.po_number AS doc_no, p.item_code, p.qty::numeric AS qty,
           p.received_qty::numeric AS received, p.so_item_id, o.status::text AS po_status
      FROM scm.purchase_order_items p
      JOIN scm.purchase_orders o ON o.id = p.purchase_order_id
     WHERE o.company_id = ${CO} AND p.so_item_id = ANY(${soLineIds})` : [];

  const byAllocPoLines = allocPoItemIds.length ? await sql`
    SELECT p.id, o.po_number AS doc_no, p.item_code, p.qty::numeric AS qty,
           p.received_qty::numeric AS received, p.so_item_id, o.status::text AS po_status
      FROM scm.purchase_order_items p
      JOIN scm.purchase_orders o ON o.id = p.purchase_order_id
     WHERE p.id = ANY(${allocPoItemIds})` : [];

  const poDocs = [...new Set([...directPoLines, ...byAllocPoLines].map((p) => p.doc_no))];
  if (POq && !poDocs.includes(POq)) poDocs.push(POq);

  const allPoLines = poDocs.length ? await sql`
    SELECT p.id, o.po_number AS doc_no, p.item_code, p.qty::numeric AS qty,
           p.received_qty::numeric AS received, p.so_item_id,
           o.status::text AS po_status
      FROM scm.purchase_order_items p
      JOIN scm.purchase_orders o ON o.id = p.purchase_order_id
     WHERE o.company_id = ${CO} AND o.po_number = ANY(${poDocs})
     ORDER BY o.po_number, p.item_code, p.id` : [];

  log('');
  log(`PURCHASE ORDER lines that touch ${SO} (${poDocs.join(', ') || 'none'}):`);
  const soLineById = new Map(soLines.map((l) => [l.id, l]));
  for (const p of allPoLines) {
    const link = p.so_item_id
      ? `-> SO line ${p.so_item_id.slice(0, 8)} (${soLineById.has(p.so_item_id) ? 'THIS SO' : 'another SO'})`
      : (alloc.some((a) => a.purchase_order_item_id === p.id) ? '-> via allocation' : '-> NOT linked to any SO line');
    log(`  ${p.doc_no} [${p.po_status}]  ${p.item_code}  qty=${p.qty}  received=${p.received}  ${link}${p.po_status === 'CANCELLED' ? '  [CANCELLED PO]' : ''}`);
  }

  // ── The verdict, per uncovered SO line, in the two worlds. ────────────────
  log('');
  log('VERDICT per SALES-ORDER line:');
  let realUnderOrder = 0;
  let missingLinkOnly = 0;
  for (const l of soLines) {
    if (l.cancelled) continue;
    const need = Number(l.qty);
    // Linked to this line, by either mechanism.
    const directQty = allPoLines
      .filter((p) => p.so_item_id === l.id && p.po_status !== 'CANCELLED')
      .reduce((s, p) => s + Number(p.qty), 0);
    const viaAlloc = allocBySoLine.get(l.id) ?? 0;
    const linkedQty = directQty + viaAlloc;

    // How many of THIS item code exist on the touching POs, linked or not.
    const poQtySameCode = allPoLines
      .filter((p) => p.item_code === l.item_code && p.po_status !== 'CANCELLED')
      .reduce((s, p) => s + Number(p.qty), 0);
    const poQtyLinkedElsewhere = allPoLines
      .filter((p) => p.item_code === l.item_code && p.po_status !== 'CANCELLED'
        && p.so_item_id && p.so_item_id !== l.id)
      .reduce((s, p) => s + Number(p.qty), 0);
    const poQtyUnlinkedSameCode = allPoLines
      .filter((p) => p.item_code === l.item_code && p.po_status !== 'CANCELLED' && !p.so_item_id
        && !alloc.some((a) => a.purchase_order_item_id === p.id))
      .reduce((s, p) => s + Number(p.qty), 0);

    if (linkedQty >= need) {
      log(`  ${l.item_code} (need ${need}): COVERED — ${linkedQty} linked to this line.`);
      continue;
    }
    // Not covered. Is there an unlinked PO line of the same code that COULD be it?
    if (poQtyUnlinkedSameCode > 0) {
      missingLinkOnly += 1;
      log(`  ${l.item_code} (need ${need}): only ${linkedQty} linked, but the PO carries `
        + `${poQtyUnlinkedSameCode} more ${l.item_code} NOT linked to any SO line — `
        + `WORLD (b): the goods are on order, the LINK is missing.`);
    } else {
      realUnderOrder += 1;
      log(`  ${l.item_code} (need ${need}): only ${linkedQty} linked; the touching POs carry `
        + `${poQtySameCode} of this code total (${poQtyLinkedElsewhere} linked to OTHER SO lines) — `
        + `WORLD (a): no spare ${l.item_code} on these POs, so this looks like a real under-order.`);
    }
  }

  log('');
  log(`SUMMARY: ${missingLinkOnly} line(s) look like a MISSING LINK (goods ordered), `
    + `${realUnderOrder} line(s) look like a REAL under-order (goods not on these POs).`);
  log('Both are read off the PO\'s own lines, not the MRP display. A missing link is '
    + 'repaired by linking; a real under-order needs a top-up PO.');
} catch (err) {
  console.error(`query failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
