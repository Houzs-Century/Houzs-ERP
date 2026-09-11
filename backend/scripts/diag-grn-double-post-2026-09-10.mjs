#!/usr/bin/env node
/* diag-grn-double-post - EVERY stock movement a goods receipt wrote, in the
 * order it wrote them, beside the receipt's own header and audit trail.
 * READ-ONLY. SELECTs only, no writes, no DDL, no transaction.
 *
 * WHY IT EXISTS. `check-duplicate-movements` (production run 34450169671)
 * reported FOUR hard double-posts, all goods receipts, all created 2026-09-10 -
 * today, not cutover residue:
 *
 *     GRN  HC-GRN-2609-012  IN  2 rows  2 units  JAGER-(Q)
 *     GRN  HC-GRN-2609-032  IN  2 rows  2 units  AKEMI ARMOUR MATT (...)
 *     GRN  HC-GRN-2609-028  IN  2 rows  2 units  AKEMI ARMOUR MATT (...)
 *     GRN  HC-GRN-2609-028  IN  2 rows  2 units  AKEMI BASTION MATT (...)
 *
 * and `check-stock-vs-autocount` (run 34449850723) independently reports those
 * same three item/warehouse cells as the ERP holding MORE than the book.
 * Goods receipts have NO unique index backstop on inventory_movements
 * (docs/inventory-idempotency-audit.md), so nothing at the database level stops
 * a second post.
 *
 * THE QUESTION THIS ANSWERS, AND WHY IT NEEDS ASKING RATHER THAN REASONING.
 * Two INs to one warehouse for one receipt has at least three causes that a
 * bucket COUNT cannot tell apart:
 *
 *   1. the confirm posted twice (a double submit, a retry) - stock is genuinely
 *      inflated and the fix is a repair plus an idempotency guard;
 *   2. the receipt's WAREHOUSE was changed and changed BACK. grns.ts writes
 *      OUT(old) + IN(new) on every change, so A->B->A leaves two IN(A) rows and
 *      one OUT(A) - the bucket count says 2 and the BALANCE is correct;
 *   3. the receipt was edited and re-posted with a delta.
 *
 * Only the rows in creation order, with their warehouses and their notes, say
 * which. `grns.ts` labels the warehouse-change pair
 * "GRN warehouse changed - out of old warehouse", so cause 2 identifies itself.
 *
 * WHAT IT ACTUALLY FOUND, 2026-09-10 (production run 34452823201): NOTHING WAS
 * DOUBLE POSTED. All three receipts carry the SAME PRODUCT ON SEVERAL LINES -
 * HC-GRN-2609-032 has two AKEMI ARMOUR MATT (K) lines, HC-GRN-2609-028 has two
 * ARMOUR and two BASTION, HC-GRN-2609-012 has four JAGER-(Q) - and every
 * movement matches its line one for one. Two rows in one bucket, one row per
 * line, correct balance. See docs/bugs/0780.
 *
 * IT PROPOSES NOTHING AND REPAIRS NOTHING. What to do about an inflated stock
 * balance is a separate, plan-gated tool and the owner's ruling.
 *
 *   DATABASE_URL   required
 *   DOCS           optional, comma-separated GRN numbers. Default: the four
 *                  buckets above. "ALL" scans every receipt with >1 IN row in
 *                  one bucket.
 *   COMPANY_ID     optional, default 1
 */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const RAW = String(process.env.DOCS || 'HC-GRN-2609-012,HC-GRN-2609-028,HC-GRN-2609-032').trim();
const ALL = RAW.toUpperCase() === 'ALL';
const DOCS = ALL ? [] : RAW.split(',').map((s) => s.trim()).filter(Boolean);

const line = (s = '') => console.log(`::notice::${s}`);
const rule = () => line('-'.repeat(78));
const head = (s) => { line('='.repeat(78)); line(s); line('='.repeat(78)); };
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  let docs = DOCS;
  if (ALL) {
    const found = await sql`
      SELECT m.source_doc_no AS doc
        FROM scm.inventory_movements m
       WHERE m.source_doc_type = 'GRN'
       GROUP BY m.source_doc_no, m.warehouse_id, m.item_code,
                coalesce(m.variant_key, ''), coalesce(m.batch_no, ''), m.movement_type
      HAVING count(*) > 1`;
    docs = [...new Set(found.map((r) => r.doc))].sort();
    line(`DOCS=ALL: ${docs.length} goods receipt(s) have a bucket with more than one row`);
  }

  head(`GRN MOVEMENT TRACE - ${docs.length} receipt(s), company ${CO}`);
  line('READ-ONLY. Rows are shown in the order they were CREATED, which is the only');
  line('thing that separates a double submit from a warehouse change and back.');

  for (const doc of docs) {
    const g = await sql`
      SELECT id, grn_number, status::text AS status, warehouse_id,
             to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created,
             to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated,
             company_id
        FROM scm.grns
       WHERE grn_number = ${doc} AND company_id = ${CO}`;

    rule();
    if (!g.length) { line(`${doc}: no such goods receipt in company ${CO}`); continue; }
    const h = g[0];
    line(`${doc}   status ${h.status}   warehouse ${h.warehouse_id}`);
    line(`   created ${h.created}   updated ${h.updated}`);

    const mv = await sql`
      SELECT m.id, m.movement_type::text AS type, m.qty, m.item_code,
             coalesce(m.variant_key, '') AS vk, coalesce(m.batch_no, '') AS batch,
             m.warehouse_id, m.unit_cost_sen, m.performed_by,
             coalesce(m.notes, '') AS notes,
             to_char(m.created_at, 'YYYY-MM-DD HH24:MI:SS.MS') AS at
        FROM scm.inventory_movements m
       WHERE m.source_doc_type = 'GRN' AND m.source_doc_id = ${h.id}
       ORDER BY m.created_at, m.id`;

    line(`   ${mv.length} movement row(s):`);
    for (const m of mv) {
      line(`      ${m.at}  ${m.type.padEnd(4)} ${String(m.qty).padStart(4)}  `
        + `${String(m.item_code).slice(0, 26).padEnd(27)} wh ${m.warehouse_id}  `
        + `${rm(m.unit_cost_sen)}${m.notes ? `  "${m.notes.slice(0, 46)}"` : ''}`);
    }

    /* The receipt's own lines, so a doubled MOVEMENT can be told from a doubled
       LINE - two rows for the same item on the document is not a double post. */
    const items = await sql`
      SELECT item_code, qty_accepted, coalesce(item_group, '') AS grp
        FROM scm.grn_items
       WHERE grn_id = ${h.id}
       ORDER BY item_code`;
    line(`   ${items.length} receipt line(s): ${items.map((i) => `${i.item_code} x${i.qty_accepted}`).join(' | ') || '(none)'}`);

    /* Net per ITEM, against the SUM of that item's receipt lines.
       THE SUM, not one line: a receipt may legitimately carry the same product
       on several lines (two mattresses entered separately), and comparing the
       net against a single line reports every such receipt as doubled. That is
       the false positive this whole investigation turned out to be. */
    const net = new Map();
    for (const m of mv) {
      const k = `${m.item_code}::${m.warehouse_id}`;
      net.set(k, (net.get(k) ?? 0) + (m.type === 'IN' ? Number(m.qty) : -Number(m.qty)));
    }
    const wantByItem = new Map();
    for (const i of items) {
      wantByItem.set(i.item_code, (wantByItem.get(i.item_code) ?? 0) + Number(i.qty_accepted ?? 0));
    }
    const linesByItem = new Map();
    for (const i of items) linesByItem.set(i.item_code, (linesByItem.get(i.item_code) ?? 0) + 1);

    line('   net movement per item, against the SUM of that item\'s receipt lines:');
    for (const [k, v] of [...net.entries()].sort()) {
      const [code, wh] = k.split('::');
      const want = wantByItem.get(code);
      const nLines = linesByItem.get(code) ?? 0;
      const many = nLines > 1 ? `  [${nLines} receipt lines for this item]` : '';
      const flag = want === undefined
        ? '   <- NO RECEIPT LINE for this item'
        : (Number(want) === v ? '   <- agrees with the receipt' : `   <- RECEIPT TOTALS ${want}, MOVEMENTS ${v}`);
      line(`      ${code.slice(0, 26).padEnd(27)} wh ${wh}  net ${String(v).padStart(4)}${flag}${many}`);
    }
  }

  head('READ-ONLY. Nothing above was written.');
  line('A pair labelled "GRN warehouse changed" is the relocate path writing OUT(old)');
  line('+ IN(new) - two IN rows in one warehouse with an OUT between them is a change');
  line('and change back, and its BALANCE is right. Two INs with no OUT is a real');
  line('double post. What to do about one is a separate tool and the owner\'s ruling.');
} finally {
  await sql.end({ timeout: 5 });
}
