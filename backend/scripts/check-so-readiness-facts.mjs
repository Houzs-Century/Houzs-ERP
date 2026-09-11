// Read-only: does the SO-line readiness engine keep MATTRESS + ACCESSORIES
// lines correct? It answers the owner's two questions (2026-09-11) from the
// LIVE tables, and writes NOTHING — only SELECTs, no DDL, no transaction.
//
//   1. 「mattress 跟 accessories 已经有被分配货,SO 那一边的 line 有 turn ready 吗?」
//   2. 「item line 明明收了货,by right 就应该 turn ready 啊。」
//
// Mattress + accessories are the POOLED classes (owner 2026-08-10): a line turns
// READY when its own warehouse holds enough on-hand for its
// (warehouse, item_code, variant_key) bucket, FIFO by SO age
// (scm/lib/so-stock-allocation.ts). A goods receipt raises inventory_balances
// and fires that re-walk (grns.ts). So a pooled line sitting on enough matching
// stock in a SELLING warehouse SHOULD be READY. This check finds the ones that
// are NOT — the direct answer to "确定没问题吗".
//
// WHY the match is exact and drift-free. For mattress + accessory the variant
// key is EMPTY unless the line carries special-order config (ATTRS_BY_GROUP has
// no soft attributes for these two groups; only `specials` can add anything —
// scm/shared/variant-key.ts). So a line with no specials keys to '' and matches
// on-hand rows with a blank variant_key WITHOUT this script re-deriving the
// fabric/seat/leg logic. Lines that DO carry specials, or whose warehouse is
// non-selling / unset, are reported SEPARATELY as the documented reasons a
// stocked line legitimately stays PENDING — never counted as a defect.
//
// SCOPE. (SP) mattresses are HARD-BOUND (they light off their own received PO,
// not pooled stock — owner 2026-08-29), so they are excluded from the pooled
// finding. Company 1 = Houzs Century.
//
// RE-RUN: idempotent pure read. Exit 0 for every legitimate answer INCLUDING
// "none stuck" — the answer is the output. Non-zero only when the DB is
// unreachable or a query fails (a red job means the check broke, not a finding).
//
//   DATABASE_URL  required — the only credential.
//   COMPANY_ID    default 1.
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

// SO statuses whose lines no longer wait for stock (shared/so-terminal-states).
const SO_TERMINAL = ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT'];
// DO statuses that have moved stock out (shared/do-shipped-states, LOADED joined
// 2026-08-22). A DO line in one of these has left the shelf.
const DO_SHIPPED = ['LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED'];
// warehouse.type values whose stock may NOT be promised (non-selling-warehouse).
const NON_SELLING = ['showroom', 'display', 'service'];

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

try {
  log(`company = ${CO}`);
  log('');

  /* pooled = live, non-cancelled MATTRESS/ACCESSORY lines whose SO is not
     terminal, excluding (SP) mattresses (hard-bound). remaining = qty − shipped
     + returned, exactly as the allocator computes it. on_hand_blank = live
     on-hand in the SAME warehouse + item_code under a BLANK variant_key, summed
     (a pooled mattress/accessory keys to '' unless it has specials). selling =
     the line's warehouse is not showroom/display/service. has_specials = the
     line carries special-order config, so its key is NOT blank. */
  const rows = await sql`
    WITH pooled AS (
      SELECT i.id, i.doc_no, i.item_code, i.item_group, i.warehouse_id,
             COALESCE(i.qty, 0) AS qty, i.stock_status,
             (jsonb_typeof(i.variants -> 'specials') = 'array'
                AND jsonb_array_length(i.variants -> 'specials') > 0) AS has_specials
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
      WHERE i.company_id = ${CO}
        AND i.cancelled = false
        AND s.status <> ALL(${SO_TERMINAL})
        AND (lower(i.item_group) LIKE '%mattress%' OR lower(i.item_group) LIKE '%accessor%')
        AND NOT (lower(i.item_group) LIKE '%mattress%' AND i.item_code ~* '\\(SP\\)\\s*$')
    ),
    delivered AS (
      SELECT d.so_item_id, SUM(COALESCE(d.qty, 0)) AS qty
      FROM scm.delivery_order_items d
      JOIN scm.delivery_orders o ON o.id = d.delivery_order_id
      WHERE o.status = ANY(${DO_SHIPPED})
      GROUP BY d.so_item_id
    ),
    returned AS (
      SELECT d.so_item_id, SUM(COALESCE(dr.qty_returned, 0)) AS qty
      FROM scm.delivery_return_items dr
      JOIN scm.delivery_returns r ON r.id = dr.delivery_return_id
      JOIN scm.delivery_order_items d ON d.id = dr.do_item_id
      WHERE r.status IS DISTINCT FROM 'CANCELLED'
      GROUP BY d.so_item_id
    ),
    onhand AS (
      SELECT b.warehouse_id, b.item_code, SUM(COALESCE(b.qty, 0)) AS qty
      FROM scm.inventory_balances b
      WHERE b.company_id = ${CO} AND COALESCE(b.variant_key, '') = ''
      GROUP BY b.warehouse_id, b.item_code
    )
    SELECT p.id, p.doc_no, p.item_code, p.item_group, p.stock_status, p.has_specials,
           p.qty - COALESCE(dl.qty, 0) + COALESCE(rt.qty, 0) AS remaining,
           p.warehouse_id,
           w.code AS wh_code, w.type AS wh_type,
           (p.warehouse_id IS NULL) AS no_wh,
           COALESCE(lower(w.type::text) = ANY(${NON_SELLING}), false) AS non_selling,
           COALESCE(oh.qty, 0) AS on_hand_blank
    FROM pooled p
    LEFT JOIN delivered dl ON dl.so_item_id = p.id
    LEFT JOIN returned  rt ON rt.so_item_id = p.id
    LEFT JOIN scm.warehouses w ON w.id = p.warehouse_id
    LEFT JOIN onhand oh ON oh.warehouse_id = p.warehouse_id AND oh.item_code = p.item_code
  `;

  // Only lines that still have something to deliver are candidates.
  const live = rows.filter((r) => Number(r.remaining) > 0);
  const byStatus = (s) => live.filter((r) => r.stock_status === s).length;

  log('================================================================');
  log('SECTION 1 — company-1 pooled (mattress + accessory) live SO lines');
  log('================================================================');
  log(`${live.length} live line(s) with something still to deliver, by stock_status:`);
  log(`  READY    ${byStatus('READY')}`);
  log(`  PARTIAL  ${byStatus('PARTIAL')}`);
  log(`  PENDING  ${byStatus('PENDING')}`);
  log(`  (other)  ${live.filter((r) => !['READY', 'PARTIAL', 'PENDING'].includes(r.stock_status)).length}`);
  log('');

  const pend = live.filter((r) => r.stock_status !== 'READY'); // PENDING + PARTIAL = not fully ready

  /* THE FINDING — a not-ready pooled line that SHOULD be READY: blank-variant
     line (no specials), warehouse can sell, and blank-variant on-hand in that
     warehouse for the same item_code already covers its remaining. No variant
     re-derivation: both sides are the '' bucket. */
  const shouldBeReady = pend.filter((r) =>
    !r.has_specials && !r.no_wh && !r.non_selling && Number(r.on_hand_blank) >= Number(r.remaining));

  log('================================================================');
  log('SECTION 2 — not-ready lines that SHOULD be ready (stock already covers)');
  log('================================================================');
  log(`${shouldBeReady.length} pooled line(s) are PENDING/PARTIAL while enough matching`);
  log('stock sits in their own (selling) warehouse under a blank variant key.');
  if (shouldBeReady.length === 0) {
    log('=> NONE. Every pooled line with covering stock in a sellable warehouse is');
    log('   already READY — the engine is keeping up for mattress + accessories.');
  } else {
    log('=> These are the lines the allocator should have flipped. Up to 30 shown');
    log('   (doc_no — item_code — status — remaining vs on_hand — warehouse):');
    for (const r of shouldBeReady.slice(0, 30)) {
      log(`   ${r.doc_no}  ${r.item_code}  ${r.stock_status}  need ${r.remaining} / have ${r.on_hand_blank}  @ ${r.wh_code ?? '?'}`);
    }
    if (shouldBeReady.length > 30) log(`   ... and ${shouldBeReady.length - 30} more`);
  }
  log('');

  /* Why the REST are not ready — the documented, correct reasons a stocked line
     legitimately stays PENDING. Priority order so each line is counted once. */
  let rNoWh = 0, rNonSell = 0, rSpecials = 0, rShort = 0;
  for (const r of pend) {
    if (shouldBeReady.includes(r)) continue;
    if (r.no_wh) rNoWh += 1;
    else if (r.non_selling) rNonSell += 1;
    else if (r.has_specials) rSpecials += 1;
    else rShort += 1; // no / not enough matching blank-variant on-hand → genuinely short
  }
  log('================================================================');
  log('SECTION 3 — why the other not-ready pooled lines are (correctly) PENDING');
  log('================================================================');
  log(`  genuinely short (no / not enough matching stock on hand):  ${rShort}`);
  log(`  warehouse cannot sell (showroom / display / service):      ${rNonSell}`);
  log(`  line has no warehouse assigned (sees no stock):            ${rNoWh}`);
  log(`  line carries special-order config (needs exact variant):   ${rSpecials}`);
  log('  (the last three are by-design PENDING, not engine faults; the first is');
  log('   a real shortage — nothing to order-in has arrived yet.)');
  log('');
  log('Read SECTION 2 for the answer: 0 there means yes — a mattress/accessory');
  log('line with allocated/received stock does turn ready.');

  process.exitCode = 0;
} catch (e) {
  console.error(`check failed: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
