#!/usr/bin/env node
// explore-oct-history3.mjs — READ ONLY. The orders the back-fill plan shows with
// a halving / doubling or a RM 125 move: every money row of their history in
// October and their lines now (free-item marker, divan / leg / special prices).
// Writes nothing. Env: DATABASE_URL, DOCS (comma separated).
import postgres from 'postgres';

const DOCS = String(process.env.DOCS || 'HC-SO-2610-006,HC-SO-2609-397,HC-SO-013335,HC-SO-2610-063,HC-SO-2610-078,HC-SO-2609-014')
  .split(',').map((s) => s.trim()).filter(Boolean);

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    for (const doc of DOCS) {
      console.log(`ROW|===== ${doc}`);
      const lines = await sql`SELECT item_code, item_group, qty, unit_price_sen, discount_sen, total_sen, divan_price_sen, leg_price_sen, special_order_price_sen, cancelled,
          variants->'freeItem' AS free_item, variants->>'buildKey' AS build_key, created_at
        FROM scm.mfg_sales_order_items WHERE doc_no = ${doc} ORDER BY line_no NULLS FIRST, created_at`;
      for (const l of lines) console.log(`ROW|  line ${l.item_code} [${l.item_group}] qty ${l.qty} unit ${l.unit_price_sen} disc ${l.discount_sen} total ${l.total_sen} divan ${l.divan_price_sen} leg ${l.leg_price_sen} special ${l.special_order_price_sen}${l.cancelled ? ' CANCELLED' : ''}${l.free_item ? ` free=${JSON.stringify(l.free_item)}` : ''}`);
      const evs = await sql`SELECT action, source, actor_name_snapshot, created_at, field_changes, note FROM scm.mfg_so_audit_log
        WHERE so_doc_no = ${doc} AND created_at >= '2026-09-30T16:00:00Z'
          AND (action IN ('CREATE', 'ADD_LINE', 'DELETE_LINE', 'AMENDMENT_SO_APPROVED') OR (action = 'UPDATE_LINE' AND coalesce(source, 'web') <> 'auto-allocation'))
        ORDER BY created_at`;
      for (const e of evs) {
        const f = (e.field_changes ?? []).filter((x) => !/^(lineDeliveryDate|lineDeliveryDateOverridden|stockStatus|photoAdded|photoRemoved|remark|unitCostSen)$/.test(x.field));
        console.log(`ROW|  ${new Date(new Date(e.created_at).getTime() + 8 * 3600e3).toISOString().slice(0, 19)} ${e.action} ${e.source} ${e.actor_name_snapshot ?? '-'} ${JSON.stringify(f).slice(0, 700)}${e.note ? ` note=${String(e.note).slice(0, 100)}` : ''}`);
      }
    }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
