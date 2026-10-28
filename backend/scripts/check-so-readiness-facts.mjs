// Read-only: does the SO-line readiness engine keep MATTRESS + ACCESSORIES
// lines correct? It answers the owner's two questions (2026-09-11) from the
// LIVE tables, and writes NOTHING — only SELECTs, no DDL, no transaction.
//
//   1. 「mattress 跟 accessories 已经有被分配货,SO 那一边的 line 有 turn ready 吗?」
//   2. 「item line 明明收了货,by right 就应该 turn ready 啊。」
//
// Mattress + accessories are the POOLED classes (owner 2026-08-10): a line turns
// READY when its own warehouse holds enough on-hand for its
// (warehouse, item_code, variant_key) bucket, allocated FIFO by effective
// delivery date (scm/lib/so-stock-allocation.ts). A goods receipt raises
// inventory_balances and fires that re-walk (grns.ts).
//
// TWO gates the allocator applies, which a naive "is there stock?" check would
// MISS and therefore massively over-report (both modelled here):
//
//   A. PROCESSING-DATE GATE (owner 2026-08-10, go-live): an order with NO
//      Processing Date is NOT allocated and NEVER shows READY, on purpose
//      ("有 processing date 才来分配"). so-stock-allocation.ts builds `allocGated`
//      from exactly `processing_date IS NULL`. Such a line is CORRECTLY PENDING
//      — not a fault — so it is reported under SECTION 3, never as a defect.
//   B. FIFO CONTENTION: on-hand is shared. If a (warehouse, item_code) bucket's
//      total non-gated demand EXCEEDS its on-hand, only the earliest-due lines
//      turn READY and the rest correctly wait. So "this one line needs 1 and the
//      warehouse holds 484" does NOT mean the line should be READY if 500 older
//      lines also want that stock. SECTION 2 only calls a line a DEFECT when its
//      whole bucket is NON-CONTENDED (on-hand covers ALL its non-gated demand),
//      so every line in it should be READY regardless of FIFO order. Contended
//      buckets are reported separately as "waiting for restock", not defects.
//
// WHY the bucket match is exact and drift-free. For mattress + accessory the
// variant key is EMPTY unless the line carries special-order config
// (scm/shared/variant-key.ts). So a non-special line keys to '' and matches
// on-hand rows with a blank variant_key WITHOUT re-deriving fabric/seat/leg
// logic. Lines that DO carry specials, or whose warehouse is non-selling /
// unset, are reported SEPARATELY under SECTION 3.
//
// SCOPE. (SP) mattresses are HARD-BOUND (they light off their own received PO,
// not pooled stock — owner 2026-08-29), so they are excluded. Company 1 = HC.
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
     terminal, excluding (SP) mattresses. remaining = qty − shipped + returned.
     gated = the SO has NO processing date, so the allocator never allocates it
     (owner gate A above). on_hand_blank = live on-hand in the SAME warehouse +
     item_code under a BLANK variant_key. has_specials = the line carries
     special-order config, so its key is NOT blank. */
  const rows = await sql`
    WITH pooled AS (
      SELECT i.id, i.doc_no, i.item_code, i.item_group, i.warehouse_id,
             COALESCE(i.qty, 0) AS qty, i.stock_status,
             (s.processing_date IS NULL) AS gated,
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
    SELECT p.id, p.doc_no, p.item_code, p.item_group, p.stock_status, p.has_specials, p.gated,
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
  const num = (v) => Number(v) || 0;
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

  /* Bucket demand = total remaining of the lines that ACTUALLY draw the blank
     pool: live, NON-gated (allocator skips gated), NON-special (specials key to
     their own variant, not ''), with a warehouse. Keyed per-warehouse+item, so
     it matches the allocator's per-warehouse buckets. Gated + special + no-wh
     lines never consume this pool, so they are excluded from the sum. */
  const bucketKey = (r) => `${r.warehouse_id}::${r.item_code}`;
  const bucketDemand = new Map();
  for (const r of live) {
    if (r.gated || r.has_specials || r.no_wh) continue;
    const k = bucketKey(r);
    bucketDemand.set(k, (bucketDemand.get(k) ?? 0) + num(r.remaining));
  }

  const pend = live.filter((r) => r.stock_status !== 'READY'); // PENDING + PARTIAL = not fully ready

  /* THE FINDING (SECTION 2) — a genuine engine fault: a line that the allocator
     SHOULD have flipped READY but did not. Conditions, all required:
       - not gated (its SO has a processing date, so it IS being allocated),
       - not special, has a warehouse, warehouse can sell,
       - its whole bucket is NON-CONTENDED: on-hand covers the bucket's ENTIRE
         non-gated demand, so FIFO order cannot leave this line short.
     A line meeting all of these yet still not READY is a real defect. */
  const shouldBeReady = pend.filter((r) => {
    if (r.gated || r.has_specials || r.no_wh || r.non_selling) return false;
    return num(r.on_hand_blank) >= (bucketDemand.get(bucketKey(r)) ?? 0);
  });

  log('================================================================');
  log('SECTION 2 — not-ready lines that SHOULD be ready (a real engine fault)');
  log('================================================================');
  log(`${shouldBeReady.length} pooled line(s) are PENDING/PARTIAL even though their SO has a`);
  log('processing date AND their warehouse holds enough blank-variant on-hand to');
  log('cover EVERY competing (non-gated) line in the same bucket — so FIFO cannot');
  log('be the reason. These are the ones the allocator should have flipped.');
  if (shouldBeReady.length === 0) {
    log('=> NONE. Every processing-dated, uncontended, stocked mattress/accessory');
    log('   line in a sellable warehouse is already READY — the engine keeps up.');
  } else {
    log('=> Up to 30 shown (doc_no — item_code — status — need vs bucket on_hand — wh):');
    for (const r of shouldBeReady.slice(0, 30)) {
      log(`   ${r.doc_no}  ${r.item_code}  ${r.stock_status}  need ${r.remaining} / have ${r.on_hand_blank}  @ ${r.wh_code ?? '?'}`);
    }
    if (shouldBeReady.length > 30) log(`   ... and ${shouldBeReady.length - 30} more`);
  }
  log('');

  /* Why the REST are not ready — the documented, correct reasons. Priority
     order so each line is counted once. Gated first: it is the owner's own
     "no processing date -> do not allocate" rule and applies before anything
     about stock or warehouse. */
  let rGated = 0, rNoWh = 0, rNonSell = 0, rSpecials = 0, rContended = 0;
  for (const r of pend) {
    if (shouldBeReady.includes(r)) continue;
    if (r.gated) rGated += 1;              // owner gate A: SO has no processing date
    else if (r.no_wh) rNoWh += 1;
    else if (r.non_selling) rNonSell += 1;
    else if (r.has_specials) rSpecials += 1;
    else rContended += 1; // processing-dated, selling, blank-variant, but bucket demand > on-hand → FIFO waits / genuinely short
  }
  log('================================================================');
  log('SECTION 3 — why the other not-ready pooled lines are (correctly) PENDING');
  log('================================================================');
  log(`  SO has no processing date yet (allocator skips it, by owner rule): ${rGated}`);
  log(`  stock shared out — bucket demand exceeds on-hand (FIFO / short):   ${rContended}`);
  log(`  warehouse cannot sell (showroom / display / service):             ${rNonSell}`);
  log(`  line has no warehouse assigned (sees no stock):                   ${rNoWh}`);
  log(`  line carries special-order config (needs exact variant):          ${rSpecials}`);
  log('  (all of these are by-design PENDING, not engine faults: the first waits');
  log('   for someone to set a Processing Date; the second waits for restock.)');
  log('');
  log('Read SECTION 2 for the answer: 0 there means yes — a mattress/accessory');
  log('line that is being processed and has covering stock DOES turn ready.');

  process.exitCode = 0;
} catch (e) {
  console.error(`check failed: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
