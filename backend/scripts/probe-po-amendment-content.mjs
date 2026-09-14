#!/usr/bin/env node
/* READ-ONLY. What did a purchase-order amendment actually change?
 *
 * `propose-supplier-sofa-corrections` skips a PO "WE AMENDED AFTER THEIR CUT",
 * on the owner's rule that an amendment we raised after the supplier's export
 * is NEWER than the export. On 2026-09-14 that bucket named HC-PO-010086
 * (A1 APPROVED, raised 2026-09-10, supplier cut 2026-09-01) - one of the four
 * POs the owner had just ruled 「要跟工厂一样」.
 *
 * Those two rules point opposite ways on this document, and which one governs
 * depends on WHAT the amendment changed. If it changed the sofa's pieces, ours
 * is the newer instruction and it is the FACTORY that may be building the old
 * version. If it changed something else - a date, a price - the pieces are still
 * the export's to decide. This prints the amendment's reason, header changes and
 * every line change beside the line's before-snapshot, so the answer is read,
 * not assumed.
 *
 * Columns are selected with `*` and printed by name: the amendment line table
 * carried `new_unit_price_centi` when it was created (0194) and the money
 * columns were renamed since, and a named column that no longer exists is 42703,
 * which fails the whole statement.
 *
 * IT WRITES NOTHING. SELECT only, no DDL, no transaction.
 * RE-RUN: read-only and stateless.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     optional, default 1
 *   DOCS           required, comma-separated PO numbers
 */
import postgres from 'postgres';

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = String(process.env.DOCS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!DOCS.length) { console.error('need DOCS'); process.exit(2); }
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const show = (v) => (v === null || v === undefined ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v));

const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });
try {
  for (const doc of DOCS) {
    line('='.repeat(78));
    const [po] = await sql`
      SELECT id, po_number, status::text AS status FROM scm.purchase_orders
       WHERE company_id = ${CO} AND po_number = ${doc}`;
    if (!po) { line(`${doc}: NOT FOUND for company ${CO}`); continue; }
    line(`${po.po_number}   status ${po.status}`);

    const current = await sql`
      SELECT id::text AS id, item_code, coalesce(qty,0)::numeric AS qty,
             coalesce(received_qty,0)::numeric AS recv, linked_ac_dtlkey::text AS dtlkey
        FROM scm.purchase_order_items WHERE purchase_order_id = ${po.id} ORDER BY id`;
    line(`   current lines: ${current.map((c) => `${c.item_code} x${Number(c.qty)}${Number(c.recv) ? ` (recv ${Number(c.recv)})` : ''}`).join(' | ')}`);

    const amends = await sql`
      SELECT * FROM scm.po_amendments WHERE po_id = ${po.id} ORDER BY created_at`;
    if (!amends.length) { line('   no amendments'); continue; }
    for (const a of amends) {
      line(`   AMENDMENT ${a.amendment_no}   ${a.status}   raised ${show(a.created_at)}   approved ${show(a.approved_at)}`);
      line(`      reason: ${show(a.reason)}`);
      if (a.header_changes) line(`      header changes: ${show(a.header_changes)}`);
      if (a.resolution) line(`      resolution: ${show(a.resolution)}`);
      const lines = await sql`SELECT * FROM scm.po_amendment_lines WHERE amendment_id = ${a.id} ORDER BY id`;
      if (!lines.length) line('      (no line changes)');
      for (const l of lines) {
        const fields = Object.entries(l)
          .filter(([k, v]) => /^(change_type|new_|old_snapshot)/.test(k) && v !== null && v !== undefined)
          .map(([k, v]) => `${k}=${show(v)}`);
        line(`      LINE ${show(l.purchase_order_item_id)}: ${fields.join('   ')}`);
      }
    }
  }
  line('='.repeat(78));
  line('READ-ONLY — nothing was written.');
} finally {
  await sql.end({ timeout: 5 });
}
