// The reads and writes behind a duplicate-SKU merge, shared by the Actions
// script (merge-duplicate-skus.mjs) and the SKU Master "Merge codes" screen
// (src/scm/routes/mfg-product-merge.ts). The RULES live in
// duplicate-sku-merge-plan.mjs; this file only gathers its input and carries
// out its plan. `sql` is a postgres.js client; `cascade` is PRODUCT_CODE_CASCADE.
//
// Every query carries company_id: both callers use a role that bypasses RLS.
//
// NO SHEBANG: imported by the Worker.

const kindClause = (sql, c) => (c.kind ? sql`AND material_kind::text = 'mfg_product'` : sql``);

export async function readMergeColumns(sql, cascade) {
  const rows = await sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ANY(${[...new Set(cascade.map((c) => c.table))]})`;
  const cols = new Map();
  for (const r of rows) cols.set(r.table_name, (cols.get(r.table_name) ?? new Set()).add(r.column_name));
  return cols;
}

export async function readMergeWorld(sql, { co, pairs, cascade, cols }) {
  const drops = pairs.map((p) => p.drop);
  const codes = [...drops, ...pairs.map((p) => p.keep)];

  const products = await sql`
    SELECT id::text AS id, code, status::text AS status, category::text AS category
      FROM scm.mfg_products WHERE company_id = ${co} AND code = ANY(${codes})`;

  const refs = [];
  const ids = new Map();
  const missing = [];
  for (const c of cascade) {
    const have = cols.get(c.table);
    if (!have?.has(c.col) || !have.has("company_id")) { missing.push(`${c.table}.${c.col}`); continue; }
    const hasId = have.has("id");
    const rows = await sql`
      SELECT ${sql(c.col)} AS code, ${hasId ? sql`id::text` : sql`NULL::text`} AS id
        FROM ${sql(`scm.${c.table}`)}
       WHERE company_id = ${co} AND ${sql(c.col)} = ANY(${drops}) ${kindClause(sql, c)}`;
    for (const code of new Set(rows.map((r) => r.code))) {
      const mine = rows.filter((r) => r.code === code);
      refs.push({ table: c.table, col: c.col, code, rows: mine.length, hasId });
      ids.set(`${c.table}.${c.col}|${code}`, mine.map((r) => r.id));
    }
  }

  const warehouses = await sql`SELECT id::text AS id, code FROM scm.warehouses WHERE company_id = ${co}`;
  const whCode = new Map(warehouses.map((w) => [w.id, String(w.code).toUpperCase()]));
  const whOf = (id) => (id == null ? "(NO WAREHOUSE)" : whCode.get(String(id)) ?? `(OTHER ${id})`);
  const ledger = await sql`
    SELECT item_code, warehouse_id::text AS warehouse_id,
           SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                  WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END)::int AS qty
      FROM scm.inventory_movements WHERE company_id = ${co} AND item_code = ANY(${codes})
     GROUP BY item_code, warehouse_id`;
  const lots = await sql`
    SELECT item_code, warehouse_id::text AS warehouse_id, SUM(qty_remaining)::int AS qty
      FROM scm.inventory_lots WHERE company_id = ${co} AND item_code = ANY(${codes}) AND qty_remaining <> 0
     GROUP BY item_code, warehouse_id`;
  const stockMap = new Map();
  const cell = (code, wh) => {
    const k = `${code}|${wh}`;
    if (!stockMap.has(k)) stockMap.set(k, { code, warehouseCode: whOf(wh), ledgerQty: 0, lotQty: 0 });
    return stockMap.get(k);
  };
  for (const r of ledger) cell(r.item_code, r.warehouse_id).ledgerQty += Number(r.qty);
  for (const r of lots) cell(r.item_code, r.warehouse_id).lotQty += Number(r.qty);
  const stock = [...stockMap.values()].filter((s) => s.ledgerQty !== 0 || s.lotQty !== 0);

  const uniques = await sql`
    SELECT tablename, indexdef FROM pg_indexes
     WHERE schemaname = 'scm' AND indexdef ILIKE 'CREATE UNIQUE%'
       AND tablename = ANY(${[...new Set(refs.map((r) => r.table))]})`;

  const masters = await sql`
    SELECT code, to_jsonb(p) AS j FROM scm.mfg_products p WHERE company_id = ${co} AND code = ANY(${codes})`;
  const mainSuppliers = await sql`
    SELECT b.item_code, s.code AS supplier
      FROM scm.supplier_material_bindings b LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
     WHERE b.company_id = ${co} AND b.item_code = ANY(${codes})
       AND b.material_kind::text = 'mfg_product' AND b.is_main_supplier = true`;

  /* A take lists every SKU of its scope, so both codes usually sit in the same take. */
  const takeRows = await sql`
    SELECT l.id::text AS id, l.stock_take_id::text AS take_id, l.item_code, l.variant_key,
           l.system_qty::int AS system_qty, l.counted_qty::int AS counted_qty, t.status::text AS take_status
      FROM scm.stock_take_lines l JOIN scm.stock_takes t ON t.id = l.stock_take_id
     WHERE l.company_id = ${co} AND l.item_code = ANY(${codes})`;
  const keepOf = new Map(pairs.map((p) => [p.drop, p.keep]));
  const stockTakeLines = takeRows.filter((l) => keepOf.has(l.item_code)).map((l) => ({
    id: l.id, code: l.item_code, takeStatus: l.take_status, systemQty: l.system_qty, countedQty: l.counted_qty,
    collides: takeRows.some((k) => k.take_id === l.take_id && k.item_code === keepOf.get(l.item_code)
      && (k.variant_key ?? "") === (l.variant_key ?? "")),
  }));

  return { products, refs, ids, missing, stock, uniques, masters, mainSuppliers, stockTakeLines };
}

/** The row ids one re-key of a planned pair touches. */
export const rekeyIds = (world, p, r) => r.ids ?? world.ids.get(`${r.table}.${r.col}|${p.drop}`);

/**
 * Carry out every unrefused pair, each in its own transaction. Every UPDATE
 * re-asserts the code it replaces, so a row changed since the plan rolls its
 * pair back. `audit`: when not null, each pair's undo list is written to
 * audit_events INSIDE that pair's transaction, so a committed pair always has
 * its undo on record.
 *
 * @returns {Promise<{committed: object[], problems: string[], rekeyed: number}>}
 */
export async function applyMerge(sql, { co, plan, world, cascade, audit }) {
  const work = plan.pairs.filter((p) => p.refusals.length === 0 && (p.rekey.length > 0 || p.retire));
  const committed = [];
  const problems = [];
  let rekeyed = 0;
  for (const p of work) {
    try {
      let n = 0;
      await sql.begin(async (tx) => {
        for (const r of p.rekey) {
          const c = cascade.find((x) => x.table === r.table && x.col === r.col);
          const ids = rekeyIds(world, p, r);
          const staying = world.ids.get(`${r.table}.${r.col}|${p.drop}`).length - ids.length;
          const done = await tx`
            UPDATE ${tx(`scm.${r.table}`)} SET ${tx(r.col)} = ${p.keep}
             WHERE company_id = ${co} AND ${tx(r.col)} = ${p.drop} AND id::text = ANY(${ids}) ${kindClause(tx, c)}
            RETURNING id`;
          if (done.length !== ids.length) throw new Error(`scm.${r.table}: re-keyed ${done.length} of ${ids.length} - a row changed since the plan`);
          const [left] = await tx`
            SELECT COUNT(*)::int AS n FROM ${tx(`scm.${r.table}`)}
             WHERE company_id = ${co} AND ${tx(r.col)} = ${p.drop} ${kindClause(tx, c)}`;
          if (left.n !== staying) throw new Error(`scm.${r.table}: ${left.n} row(s) still carry "${p.drop}" after the re-key, planned ${staying}`);
          n += done.length;
        }
        if (p.retire) {
          const [stock] = await tx`
            SELECT COALESCE(SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                  WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END), 0)::int AS qty,
                   (SELECT COUNT(*)::int FROM scm.inventory_lots
                     WHERE company_id = ${co} AND item_code = ${p.drop} AND qty_remaining <> 0) AS open_lots
              FROM scm.inventory_movements WHERE company_id = ${co} AND item_code = ${p.drop}`;
          if (stock.qty !== 0 || stock.open_lots !== 0) throw new Error(`"${p.drop}" still holds stock ${stock.qty} / open lots ${stock.open_lots}, so not switched off`);
          const off = await tx`
            UPDATE scm.mfg_products SET status = 'INACTIVE', updated_at = now()
             WHERE company_id = ${co} AND id::text = ${p.dropRowId} AND code = ${p.drop} AND status = 'ACTIVE'
            RETURNING id`;
          if (off.length !== 1) throw new Error("the dropped catalogue row was not ACTIVE any more");
        }
        if (audit) {
          const undo = {
            company_id: co, drop: p.drop, keep: p.keep,
            rekey: p.rekey.map((r) => ({ table: r.table, col: r.col, ids: rekeyIds(world, p, r) })),
            reactivate: p.retire ? p.dropRowId : null,
          };
          await tx`
            INSERT INTO audit_events (actor_id, actor_email, action, entity_type, entity_id, summary, meta, request_id)
            VALUES (${audit.actorId}, ${audit.actorEmail}, 'scm.sku.merge', 'mfg_product', ${p.dropRowId},
                    ${`Merged "${p.drop}" into "${p.keep}": ${n} row(s) re-keyed`}, ${JSON.stringify(undo)}, ${audit.requestId})`;
        }
      });
      committed.push(p);
      rekeyed += n;
    } catch (e) {
      problems.push(`"${p.drop}" ROLLED BACK, nothing of it was written: ${String(e?.message ?? e)}`);
    }
  }
  return { committed, problems, rekeyed };
}

/** Re-read on a connection the writes did not use: what the rows now SAY. */
export async function verifyMerge(v, { co, committed, world }) {
  const problems = [];
  for (const p of committed) {
    for (const r of p.rekey) {
      const ids = rekeyIds(world, p, r);
      const rows = await v`SELECT id::text AS id, ${v(r.col)} AS code FROM ${v(`scm.${r.table}`)} WHERE company_id = ${co} AND id::text = ANY(${ids})`;
      for (const row of rows) if (row.code !== p.keep) problems.push(`scm.${r.table} ${row.id} carries "${row.code}", wanted "${p.keep}"`);
      if (rows.length !== ids.length) problems.push(`scm.${r.table}: ${ids.length - rows.length} re-keyed row(s) are gone`);
    }
    const [row] = await v`SELECT status::text AS status FROM scm.mfg_products WHERE company_id = ${co} AND id::text = ${p.dropRowId}`;
    if (p.retire && row?.status !== "INACTIVE") problems.push(`"${p.drop}" is ${row?.status ?? "gone"}, wanted INACTIVE`);
  }
  return problems;
}
