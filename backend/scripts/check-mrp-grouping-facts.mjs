// Read-only: three facts behind the owner's MRP grouping questions. It answers
// them by reading the LIVE tables, not the MRP display and not any doc, and it
// writes NOTHING — only SELECTs, no DDL, no transaction.
//
// The owner, looking at the MRP page, asked three things this check settles:
//
//   1. 「确保 lead time 有跑」 — is the base lead-time table actually populated?
//      An empty table is invisible downstream: every line silently subtracts 0
//      days, so the PO asks the supplier to deliver ON the customer's own date,
//      and a zero lead day and a missing row look identical (see
//      scm/lib/lead-time.ts). SECTION 1 prints the table's real contents.
//
//   2. 「皮套是不是在 accessories 分类」 — on a sofa order, the companion items
//      (covers / pillows / cushions) — what product CATEGORY do they carry?
//      SECTION 2 takes every SO that has a SOFA line, looks at the NON-sofa
//      lines on it, and reports their category mix, flagging the cover-like ones.
//
//   3. 「为什么一张单两个 bedframe 开了两张 PO」 — when one order's bedframes are
//      covered by more than one purchase order, is that CORRECT (the pieces go
//      to different suppliers, per the owner's rule) or the known limitation
//      (the SAME supplier, split only because they were converted in separate
//      batches)? SECTION 3 lists the split orders and classifies each.
//
// RE-RUN: idempotent. It is a pure read, so running it twice — or a hundred
//   times — changes nothing and always reports the current state.
//
//   DATABASE_URL   required — the only credential; there is no other.
//   COMPANY_ID     default 1 (1 = Houzs Century).
//
// Exit 0 for every legitimate answer, INCLUDING "the table is empty" or "no
// split orders" — the answer is the output. Non-zero only when the DB cannot be
// reached or a query fails (a red job must read as "the check broke", never as
// a business finding).
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID ?? 1);

const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

// The four CORE product categories. Anything else (DINING, BEDLINES, DIFFUSER,
// CARPET, SERVICE, or a line whose item_code matches no product) is "Others".
const CORE = new Set(['SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY']);
// A companion line reads as a cover / pillow / cushion when its product name,
// item code or description carries one of these (case-insensitive; POSIX ~*,
// so `/` and the CJK chars are literal, `|` is alternation).
const COVER_RE = '皮|cover|cushion|pillow|枕|sarung|casing|c/cover|cvr';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

try {
  log(`company = ${CO}`);
  log('');

  // ── SECTION 1 — the owner's base lead-time table, printed verbatim. ─────────
  //    「确保 lead time 有跑」: is it populated at all, and with what?
  log('================================================================');
  log('SECTION 1 — base lead-time table contents (scm.mrp_category_lead_times)');
  log('================================================================');
  const leadRows = await sql`
    SELECT lt.warehouse_id, w.code AS wh_code, w.name AS wh_name,
           lt.category, lt.lead_days
      FROM scm.mrp_category_lead_times lt
      LEFT JOIN scm.warehouses w ON w.id = lt.warehouse_id
     WHERE lt.company_id = ${CO}
     ORDER BY lt.category, (lt.warehouse_id IS NOT NULL), w.code`;

  if (leadRows.length === 0) {
    log(`The base lead-time table is EMPTY for company ${CO} — every line`);
    log('currently subtracts 0 days, i.e. every PO asks the supplier to deliver');
    log("ON the customer's own delivery date. This is the invisible failure the");
    log('resolver warns about (a zero lead day and a missing row are the same');
    log('number downstream).');
  } else {
    log(`${leadRows.length} row(s) — warehouse_id NULL = the GLOBAL DEFAULT bucket`);
    log('(applies to every warehouse for that category):');
    for (const r of leadRows) {
      const wh = r.warehouse_id
        ? `${r.wh_code ?? '?'}${r.wh_name ? ` (${r.wh_name})` : ''}`
        : 'GLOBAL DEFAULT (all warehouses)';
      log(`  ${r.category.padEnd(10)}  ${String(r.lead_days).padStart(4)} day(s)   <- ${wh}`);
    }
    const globals = leadRows.filter((r) => !r.warehouse_id);
    const perWh = leadRows.filter((r) => r.warehouse_id);
    const zeros = leadRows.filter((r) => Number(r.lead_days) === 0);
    log('');
    log(`  ${globals.length} global-default row(s), ${perWh.length} per-warehouse override(s).`);
    log(`  ${zeros.length} of ${leadRows.length} row(s) are set to 0 days`
      + `${zeros.length ? ' (those categories subtract nothing)' : ''}.`);
  }
  log('');

  // ── SECTION 2 — where do sofa covers / pillows live? ────────────────────────
  //    「皮套是不是在 accessories 分类」
  log('================================================================');
  log('SECTION 2 — on sofa orders, what category do the companion items carry?');
  log('================================================================');

  // Category mix of the NON-sofa lines that sit on an order which has a sofa.
  const mix = await sql`
    WITH sofa_docs AS (
      SELECT DISTINCT i.doc_no
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = i.company_id
       WHERE i.company_id = ${CO} AND i.cancelled = false AND p.category::text = 'SOFA'
    )
    SELECT COALESCE(p.category::text, '(no product match)') AS category, COUNT(*)::int AS lines
      FROM scm.mfg_sales_order_items i
      JOIN sofa_docs sd ON sd.doc_no = i.doc_no
      LEFT JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = i.company_id
     WHERE i.company_id = ${CO} AND i.cancelled = false
       AND COALESCE(p.category::text, '') <> 'SOFA'
     GROUP BY 1
     ORDER BY lines DESC`;

  const totalCompanion = mix.reduce((s, r) => s + r.lines, 0);
  const sofaDocCount = (await sql`
    SELECT COUNT(DISTINCT i.doc_no)::int AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = i.company_id
     WHERE i.company_id = ${CO} AND i.cancelled = false AND p.category::text = 'SOFA'`)[0].n;

  log(`${sofaDocCount} sales order(s) carry at least one SOFA line.`);
  if (totalCompanion === 0) {
    log('Those orders have NO non-sofa companion lines at all — nothing to categorise.');
  } else {
    log(`Across them, ${totalCompanion} non-sofa companion line(s), by product category:`);
    for (const r of mix) {
      const bucket = CORE.has(r.category) ? '' : '  [Others — not one of the 4 core]';
      log(`  ${r.category.padEnd(20)} ${String(r.lines).padStart(6)}`
        + `  (${((r.lines / totalCompanion) * 100).toFixed(1)}% of companion lines)${bucket}`);
    }
    const dominant = mix[0];
    log('');
    log(`  Dominant companion category: ${dominant.category} `
      + `(${dominant.lines} of ${totalCompanion} companion lines).`);
  }
  log('');

  // The cover-like companion lines specifically — the direct answer to the
  // owner's question. Their own category breakdown tells us whether covers land
  // in ACCESSORY or somewhere in "Others".
  const coverRows = await sql`
    WITH sofa_docs AS (
      SELECT DISTINCT i.doc_no
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = i.company_id
       WHERE i.company_id = ${CO} AND i.cancelled = false AND p.category::text = 'SOFA'
    )
    SELECT i.item_code,
           COALESCE(p.name, i.description, '') AS item_name,
           COALESCE(p.category::text, '(no product match)') AS category
      FROM scm.mfg_sales_order_items i
      JOIN sofa_docs sd ON sd.doc_no = i.doc_no
      LEFT JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = i.company_id
     WHERE i.company_id = ${CO} AND i.cancelled = false
       AND COALESCE(p.category::text, '') <> 'SOFA'
       AND (COALESCE(p.name, '') || ' ' || COALESCE(i.item_code, '') || ' ' || COALESCE(i.description, '')) ~* ${COVER_RE}
     ORDER BY category, i.item_code`;

  log(`Cover / pillow / cushion-like companion lines (name, code or description`);
  log(`matches ${COVER_RE}): ${coverRows.length} of ${totalCompanion} companion line(s).`);
  if (coverRows.length > 0) {
    const byCat = new Map();
    for (const r of coverRows) byCat.set(r.category, (byCat.get(r.category) ?? 0) + 1);
    const catList = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cat, n] of catList) {
      const bucket = CORE.has(cat) ? '' : '  [Others — not one of the 4 core]';
      log(`    ${cat.padEnd(20)} ${String(n).padStart(5)}${bucket}`);
    }
    const [topCat, topN] = catList[0];
    const landing = topCat === 'ACCESSORY' ? 'in ACCESSORY'
      : (CORE.has(topCat) ? `in the core category ${topCat}` : `in "Others" (${topCat})`);
    log('');
    log(`  => On sofa orders, the cover/pillow lines land predominantly ${landing} `
      + `(${topN} of ${coverRows.length}).`);
    log('');
    log(`  Up to 25 sample cover-like lines (item_code — name — category):`);
    for (const r of coverRows.slice(0, 25)) {
      log(`    ${r.item_code}  —  ${r.item_name.slice(0, 60)}  —  ${r.category}`);
    }
    if (coverRows.length > 25) log(`    ... and ${coverRows.length - 25} more`);
  } else {
    log('  No cover-like companion lines matched — either covers are recorded');
    log('  under names the keywords do not catch, or they are not on these orders.');
  }
  log('');

  // ── SECTION 3 — bedframe orders split across more than one PO. ──────────────
  //    「为什么一张单两个 bedframe 开了两张 PO」
  log('================================================================');
  log('SECTION 3 — bedframe orders whose bedframes are split across >1 PO');
  log('================================================================');

  // Every (SO doc, PO, supplier) that covers a bedframe line of this company,
  // by EITHER link mechanism (direct so_item_id, or an allocation), deduped.
  // CANCELLED POs are excluded — a cancelled PO is not covering anything.
  const covering = await sql`
    WITH bedframe_lines AS (
      SELECT i.id, i.doc_no
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = i.company_id
       WHERE i.company_id = ${CO} AND i.cancelled = false AND p.category::text = 'BEDFRAME'
    ),
    links AS (
      SELECT bl.doc_no, po.po_number, po.supplier_id
        FROM bedframe_lines bl
        JOIN scm.purchase_order_items poi ON poi.so_item_id = bl.id
        JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
       WHERE po.company_id = ${CO} AND po.status::text <> 'CANCELLED'
      UNION
      SELECT bl.doc_no, po.po_number, po.supplier_id
        FROM bedframe_lines bl
        JOIN scm.purchase_order_item_allocations a ON a.so_item_id = bl.id
        JOIN scm.purchase_order_items poi ON poi.id = a.purchase_order_item_id
        JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
       WHERE po.company_id = ${CO} AND po.status::text <> 'CANCELLED'
    )
    SELECT l.doc_no, l.po_number, l.supplier_id,
           s.code AS supplier_code, s.name AS supplier_name
      FROM links l
      LEFT JOIN scm.suppliers s ON s.id = l.supplier_id
     ORDER BY l.doc_no, l.po_number`;

  // Group by SO doc; a split order is one covered by >1 DISTINCT po_number.
  const bySo = new Map();
  for (const r of covering) {
    if (!bySo.has(r.doc_no)) bySo.set(r.doc_no, new Map());
    bySo.get(r.doc_no).set(r.po_number, r); // one supplier per PO
  }
  const split = [...bySo.entries()].filter(([, pos]) => pos.size > 1);

  const diffSupplier = [];
  const sameSupplier = [];
  for (const [doc, pos] of split) {
    const suppliers = new Set([...pos.values()].map((r) => r.supplier_id));
    (suppliers.size > 1 ? diffSupplier : sameSupplier).push([doc, pos]);
  }

  log(`${bySo.size} sales order(s) with bedframe line(s) are covered by a PO.`);
  log(`Of those, ${split.length} are split across more than one purchase order:`);
  log(`  - DIFFERENT SUPPLIER (correct per the owner's rule): ${diffSupplier.length}`);
  log(`  - SAME SUPPLIER across POs (the separate-convert-batch limitation): ${sameSupplier.length}`);
  log('');

  if (sameSupplier.length === 0) {
    log('None of the split orders are SAME-supplier. That means every "two POs"');
    log('the owner saw was a legitimately-different-supplier split — the pieces of');
    log('the order go to different suppliers, which is exactly the intended behaviour.');
  } else {
    log(`SAME-SUPPLIER split orders (up to 15 shown) — these are the real`);
    log('limitation: one supplier, one order, split only because the lines were');
    log('converted to PO in separate batches:');
    for (const [doc, pos] of sameSupplier.slice(0, 15)) {
      const first = [...pos.values()][0];
      const poNos = [...pos.keys()].join(', ');
      log(`  ${doc}  ->  ${pos.size} POs [${poNos}]`
        + `  all from supplier ${first.supplier_code ?? '?'} (${first.supplier_name ?? 'unknown'})`);
    }
    if (sameSupplier.length > 15) log(`  ... and ${sameSupplier.length - 15} more`);
  }

  // A couple of different-supplier examples so the "correct" case is visible too.
  if (diffSupplier.length > 0) {
    log('');
    log(`For contrast, up to 5 DIFFERENT-SUPPLIER split orders (these are correct):`);
    for (const [doc, pos] of diffSupplier.slice(0, 5)) {
      const parts = [...pos.values()].map((r) => `${r.po_number}=${r.supplier_code ?? '?'}`).join(', ');
      log(`  ${doc}  ->  ${parts}`);
    }
  }

  await sql.end();
  process.exit(0);
} catch (err) {
  console.error(`query failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
  await sql.end();
}
