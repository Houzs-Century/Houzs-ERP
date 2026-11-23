/* How many stock positions hold more in open FIFO lots than their movement balance (or than zero when the
   balance is negative). One position = company + warehouse + item + variant key. Shared by the stock repair
   scripts so each plan, apply and re-check reports the same number the 23 Nov 2026 investigation used. */

/** Positions and units above the balance, company `co`, read through `client` (a postgres.js sql or tx). */
export async function lotsAboveBalance(client, co) {
  const [r] = await client.unsafe(`
    WITH pm AS (
      SELECT warehouse_id, item_code, COALESCE(variant_key, '') AS vk,
             SUM(CASE movement_type::text WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END) AS bal
        FROM scm.inventory_movements WHERE company_id = $1 GROUP BY 1, 2, 3),
    pl AS (
      SELECT warehouse_id, item_code, COALESCE(variant_key, '') AS vk, SUM(qty_remaining) AS lq
        FROM scm.inventory_lots WHERE company_id = $1 GROUP BY 1, 2, 3),
    pos AS (
      SELECT COALESCE(bal, 0) AS bal, COALESCE(lq, 0) AS lq
        FROM pm FULL JOIN pl ON pm.warehouse_id = pl.warehouse_id AND pm.item_code = pl.item_code AND pm.vk = pl.vk)
    SELECT count(*)::int AS positions,
           count(*) FILTER (WHERE lq > GREATEST(bal, 0))::int AS above,
           COALESCE(sum(lq - GREATEST(bal, 0)) FILTER (WHERE lq > GREATEST(bal, 0)), 0)::int AS units
      FROM pos`, [co]);
  return r;
}

/** Signed movement total per (warehouse, item), ignoring the variant key: what re-keying must not change. */
export async function totalsByWarehouseItem(client, co) {
  const rows = await client.unsafe(`
    SELECT warehouse_id::text AS w, item_code AS i,
           SUM(CASE movement_type::text WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END)::bigint AS q
      FROM scm.inventory_movements WHERE company_id = $1 GROUP BY 1, 2`, [co]);
  return new Map(rows.map((r) => [`${r.w}|${r.i}`, Number(r.q)]));
}

/** Keys whose total differs between two totalsByWarehouseItem maps. */
export function totalsDiffer(a, b) {
  const out = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) out.push(k);
  return out;
}
