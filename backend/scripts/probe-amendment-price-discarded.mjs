#!/usr/bin/env node
/* Read-only: did an APPROVED Sales Order amendment's unit price actually land?
 *
 * THE DEFECT (proven locally by src/scm/lib/so-revision.amendmentPrice.test.ts,
 * which fails 6/12 against origin/main). so-revision.ts derives
 *
 *     const amendTrust = soIsMigrated ? 'including-zero' : false;
 *
 * and threads it into the honest-pricing recompute. With `false`, the recompute's
 * trust overwrite (mfg-pricing-recompute.ts, `if (trustOperatorSelling && …)`)
 * never runs, and `unitToPersistSen` keeps the CATALOGUE figure it was assigned a
 * few lines earlier. So on a NATIVE (non-AutoCount-migrated) order, approving an
 * amendment writes mfg_products.sell_price_sen onto the line — not the price the
 * amendment requested and the approver signed. The ADD path passes no trust at
 * all, so it does the same on every order.
 *
 * A code path nobody takes is not a live bug. This counts the takings.
 *
 * WHAT IT COMPARES
 *   requested = scm.so_amendment_lines.new_unit_price_sen  (what was approved)
 *   landed    = scm.mfg_sales_order_items.unit_price_centi (what is on the order)
 *   catalogue = scm.mfg_products.sell_price_sen            (what the bug writes)
 *
 * WHAT IT CANNOT PROVE, AND SAYS SO. A line can be edited by other paths after an
 * amendment applies, so `landed != requested` alone is only a discrepancy. The
 * ATTRIBUTABLE bucket is the narrower one that carries this bug's fingerprint:
 * landed != requested AND landed == the authoritative figure the recompute would
 * have computed (catalogue + the line's own persisted surcharges) AND the order is
 * native AND the SKU is not a SOFA (sofa prices from module SKUs, not sell_price).
 * Only the latest approved amendment per line is compared, because an earlier one
 * is legitimately superseded.
 *
 * Writes nothing: SELECTs only, no DDL, no transaction.
 *
 * RE-RUN: safe and idempotent — it is a read. Numbers move as amendments are
 * approved, so re-run rather than quoting an earlier run.
 */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;

async function main() {
  const [scale] = await sql`
    SELECT
      (SELECT count(*)::int FROM scm.so_amendments)                          AS amendments,
      (SELECT count(*)::int FROM scm.so_amendments WHERE so_approved_at IS NOT NULL) AS approved,
      (SELECT count(*)::int FROM scm.so_amendment_lines)                     AS lines`;
  note(`scm.so_amendments: ${scale.amendments} total, ${scale.approved} SO-approved`);
  note(`scm.so_amendment_lines: ${scale.lines} total`);

  if (scale.approved === 0) {
    note(`\nNo amendment has ever been SO-approved on this database. The path exists and is untaken.`);
    await sql.end({ timeout: 5 });
    return;
  }

  /* ── SPEC / QTY: the line already exists, so requested vs landed is exact ──
     DISTINCT ON keeps only the LATEST approved amendment per SO line: an earlier
     amendment's price is legitimately superseded by a later one, and counting it
     would manufacture mismatches the system never made. */
  const rows = await sql`
    SELECT DISTINCT ON (l.sales_order_item_id)
      a.id                AS amendment_id,
      a.amendment_no,
      a.so_doc_no,
      a.so_approved_at,
      l.change_type,
      l.new_unit_price_sen                       AS requested_sen,
      i.id                AS item_id,
      i.item_code,
      i.qty,
      i.unit_price_centi                         AS landed_sen,
      coalesce(i.divan_price_sen, 0)
        + coalesce(i.leg_price_sen, 0)
        + coalesce(i.special_order_price_sen, 0) AS surcharges_sen,
      p.sell_price_sen                           AS catalogue_sen,
      p.category,
      so.company_id,
      so.linked_ac_docno
    FROM scm.so_amendments a
    JOIN scm.so_amendment_lines l   ON l.amendment_id = a.id
    JOIN scm.mfg_sales_orders   so  ON so.doc_no = a.so_doc_no
    JOIN scm.mfg_sales_order_items i ON i.id = l.sales_order_item_id
    LEFT JOIN scm.mfg_products  p   ON p.code = coalesce(l.new_item_code, i.item_code)
                                   AND p.company_id = so.company_id
    WHERE a.so_approved_at IS NOT NULL
      AND upper(l.change_type) IN ('SPEC', 'QTY')
      AND l.new_unit_price_sen IS NOT NULL
    ORDER BY l.sales_order_item_id, a.so_approved_at DESC`;

  note(`\n=== SPEC / QTY lines on an approved amendment that REQUESTED a price ===`);
  note(`  compared (latest approved amendment per line): ${rows.length}`);

  const mismatched = rows.filter((r) => Number(r.landed_sen) !== Number(r.requested_sen));
  /* The fingerprint: the landed figure IS what the recompute computes. Written as
     an OR over "catalogue" and "catalogue + this line's own persisted surcharges"
     because the surcharges ride on top of sell_price_sen since 2026-08-11, and a
     line priced before that carries neither. The fabric-tier Δ is NOT reproduced
     here — a line carrying one is counted only in the broad bucket, so this
     UNDER-counts rather than over-claims. */
  const attributable = mismatched.filter((r) => {
    if (r.linked_ac_docno != null) return false;                 // migrated — protected since #1954
    if (String(r.category ?? '').toUpperCase() === 'SOFA') return false;
    const cat = Number(r.catalogue_sen ?? 0);
    if (cat <= 0) return false;                                  // no authoritative figure to overwrite with
    const landed = Number(r.landed_sen);
    return landed === cat || landed === cat + Number(r.surcharges_sen ?? 0);
  });

  const money = (list) => list.reduce(
    (t, r) => t + Math.abs(Number(r.landed_sen) - Number(r.requested_sen)) * Math.max(1, Number(r.qty ?? 1)), 0);

  note(`  landed != requested (ANY cause, incl. a later edit):  ${mismatched.length}   ${rm(money(mismatched))}`);
  note(`  ATTRIBUTABLE to the recompute overwrite:              ${attributable.length}   ${rm(money(attributable))}`);
  note(`     (native order, non-sofa, landed == the authoritative figure)`);

  const overcharged = attributable.filter((r) => Number(r.landed_sen) > Number(r.requested_sen));
  const undercharged = attributable.filter((r) => Number(r.landed_sen) < Number(r.requested_sen));
  note(`     of which the customer was billed ABOVE the approved price: ${overcharged.length}   ${rm(money(overcharged))}`);
  note(`     of which the customer was billed BELOW the approved price: ${undercharged.length}   ${rm(money(undercharged))}`);

  const byCo = new Map();
  for (const r of attributable) byCo.set(r.company_id, (byCo.get(r.company_id) ?? 0) + 1);
  if (byCo.size) {
    note(`\n  by company_id:`);
    for (const [co, n] of [...byCo].sort((a, b) => b[1] - a[1])) note(`     company ${co}: ${n} lines`);
  }

  note(`\n=== the attributable lines (newest approval first, max 40) ===`);
  const shown = [...attributable]
    .sort((a, b) => String(b.so_approved_at).localeCompare(String(a.so_approved_at)))
    .slice(0, 40);
  if (!shown.length) note(`  none`);
  for (const r of shown) {
    note(
      `  ${String(r.so_doc_no).padEnd(20)} ${String(r.amendment_no ?? '-').padEnd(10)} ` +
      `${String(r.change_type).padEnd(5)} ${String(r.item_code).padEnd(18)} ` +
      `qty ${String(r.qty).padStart(4)}  approved ${rm(r.requested_sen).padStart(13)} ` +
      `-> landed ${rm(r.landed_sen).padStart(13)}  (catalogue ${rm(r.catalogue_sen)})  ` +
      `${String(r.so_approved_at).slice(0, 10)}`);
  }

  /* ── The categories that SURVIVE, so the blast radius is a measured number
        rather than an argument from the source. */
  const survived = rows.length - mismatched.length;
  const noCatalogue = rows.filter((r) => Number(r.catalogue_sen ?? 0) <= 0).length;
  const sofa = rows.filter((r) => String(r.category ?? '').toUpperCase() === 'SOFA').length;
  const migrated = rows.filter((r) => r.linked_ac_docno != null).length;
  note(`\n=== why a line survives ===`);
  note(`  landed == requested:                       ${survived} of ${rows.length}`);
  note(`  SKU has no catalogue sell price (RM0):     ${noCatalogue}`);
  note(`  SKU is a SOFA (prices from module SKUs):   ${sofa}`);
  note(`  order is AutoCount-migrated (protected):   ${migrated}`);

  /* ── ADD lines: BEST EFFORT ONLY, and labelled as such ────────────────────
     so_amendment_lines.sales_order_item_id is NULL for an ADD, so there is no
     key back to the row the apply inserted. Matching on (doc_no, item_code, qty)
     can pick the wrong row when the order already carries that SKU, so this
     section is a LIKELY signal, never a count to quote. */
  const adds = await sql`
    SELECT a.so_doc_no, a.amendment_no, a.so_approved_at,
           l.new_item_code, l.new_qty, l.new_unit_price_sen AS requested_sen,
           i.id AS item_id, i.unit_price_centi AS landed_sen,
           p.sell_price_sen AS catalogue_sen, p.category, so.linked_ac_docno
      FROM scm.so_amendments a
      JOIN scm.so_amendment_lines l  ON l.amendment_id = a.id
      JOIN scm.mfg_sales_orders   so ON so.doc_no = a.so_doc_no
      LEFT JOIN LATERAL (
        SELECT x.id, x.unit_price_centi FROM scm.mfg_sales_order_items x
         WHERE x.doc_no = a.so_doc_no AND x.item_code = l.new_item_code
           AND x.qty = l.new_qty
         ORDER BY x.id LIMIT 1
      ) i ON true
      LEFT JOIN scm.mfg_products p ON p.code = l.new_item_code AND p.company_id = so.company_id
     WHERE a.so_approved_at IS NOT NULL
       AND upper(l.change_type) = 'ADD'
       AND l.new_unit_price_sen IS NOT NULL`;

  const addMismatch = adds.filter((r) => r.landed_sen != null && Number(r.landed_sen) !== Number(r.requested_sen));
  note(`\n=== ADD lines (BEST EFFORT — no id links an ADD row to the line it created) ===`);
  note(`  approved ADD lines that requested a price: ${adds.length}`);
  note(`  matched a live line whose price differs:   ${addMismatch.length}   <- LIKELY, not proven`);
  for (const r of addMismatch.slice(0, 20)) {
    note(`  ${String(r.so_doc_no).padEnd(20)} ${String(r.new_item_code).padEnd(18)} ` +
         `approved ${rm(r.requested_sen).padStart(13)} -> landed ${rm(r.landed_sen).padStart(13)} ` +
         `(catalogue ${rm(r.catalogue_sen)})  ${String(r.so_approved_at).slice(0, 10)}`);
  }

  /* Is it still happening? A historical-only count needs a backfill decision; a
     live one needs the code fixed before any backfill is worth doing. */
  const [recent] = await sql`
    SELECT count(*)::int AS n FROM scm.so_amendments
     WHERE so_approved_at > now() - interval '30 days'`;
  note(`\n  amendments SO-approved in the last 30 days: ${recent.n}` +
       `${Number(recent.n) ? '  <- the path is live' : '  (none recently)'}`);

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
