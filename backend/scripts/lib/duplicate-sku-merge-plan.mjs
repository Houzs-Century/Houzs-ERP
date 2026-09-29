// The planner behind merge-duplicate-skus.mjs. PURE: rows in, a plan out.
//
// WHY THIS EXISTS. One product can end up under two catalogue codes when the
// AutoCount mapping sheet mints a NEW ERP code for a book item the ERP already
// carried under another name. BUG-38 (2026-09-29): the sheet sent
// AK-SOLITUDE MATT (Q/S/SK/SP) to new "HAPPI SLEEP SOLITUDE MATT (x)" rows while
// "AKEMI SOLITUDE MATT (x)" already existed, so sales orders, purchase orders
// and stock for one mattress were split across two codes and allocation, MRP
// and the Inventory screen - all keyed on the exact code - each saw half.
//
// WHAT A PAIR BECOMES. Everything that FOLLOWS a rename (PRODUCT_CODE_CASCADE,
// docs/modules/product-code-rename.md) moves from the dropped code onto the kept
// one, except the catalogue-side rows in STAYS_ON_DROP: the kept SKU already has
// its own supplier binding, prices and costs, and a second set would collide or
// double up. Those stay on the dropped code, inert once its row is INACTIVE.
// The PATCH rename cannot do this: it refuses a code that is already taken.
//
// Stock moves by re-keying its ledger rows, exactly as a rename does, so
// quantity and FIFO cost are unchanged; only which code holds them changes.
//
// STOCK TAKE LINES are the one re-keyed table with a unique key on the code:
// (stock_take_id, item_code, variant_key). A take usually lists both codes, so
// the dropped line would collide with the kept one. A line of a POSTED or
// CANCELLED take is the record of that count and stays; a line of an OPEN take
// moves when the kept code has no line there, stays when it is empty (posting
// books nothing), and otherwise refuses the pair until the take is closed.
//
// A PAIR IS ALL OR NOTHING. Any refusal empties that pair's plan.
//
// NO SHEBANG: tests/duplicateSkuMergePlan.test.mjs imports this module.

import { normCode } from "./ac-mapping-csv.mjs";

/** Catalogue-side rows the kept SKU already has its own copy of. */
export const STAYS_ON_DROP = new Set([
  "supplier_material_bindings",
  "supplier_binding_price_history",
  "master_price_history",
  "mfg_product_price_history",
  "mfg_product_cost_history",
  "product_dept_configs",
  "hr_item_kpi",
]);

const sum = (rows, f) => rows.reduce((s, r) => s + Number(f(r) ?? 0), 0);

/**
 * @param {object} w
 * @param {Array<{drop: string, keep: string}>} w.pairs
 * @param {Array<{id: string, code: string, status: string, category: string|null}>} w.products
 * @param {Array<{table: string, col: string, code: string, rows: number, hasId: boolean}>} w.refs
 *   rows on each DROP code, one entry per cascade column that holds any
 * @param {Array<{code: string, warehouseCode: string, ledgerQty: number, lotQty: number}>} w.stock
 *   per dropped code and warehouse: the movement-ledger balance and the open lots
 * @param {Array<{id: string, code: string, takeStatus: string, collides: boolean, systemQty: number|null, countedQty: number|null}>} w.stockTakeLines
 *   every stock take line on a DROP code; `collides` = the kept code has a line in the same take and variant
 */
export function planDuplicateSkuMerge(w) {
  const productByCode = new Map(w.products.map((p) => [normCode(p.code), p]));
  const roles = new Map();
  for (const { drop, keep } of w.pairs) {
    for (const [code, role] of [[drop, "drop"], [keep, "keep"]]) {
      const k = normCode(code);
      roles.set(k, [...(roles.get(k) ?? []), role]);
    }
  }

  const out = [];
  for (const { drop, keep } of w.pairs) {
    const refusals = [];
    const dk = normCode(drop);
    const dropRow = productByCode.get(dk) ?? null;
    const keepRow = productByCode.get(normCode(keep)) ?? null;

    if (dk === normCode(keep)) refusals.push(`"${drop}" is merged into itself`);
    if ((roles.get(dk) ?? []).length > 1) refusals.push(`"${drop}" appears in more than one pair`);
    if ((roles.get(normCode(keep)) ?? []).includes("drop")) refusals.push(`the kept code "${keep}" is also being merged away`);
    if (!dropRow) refusals.push(`"${drop}" is not in the catalogue`);
    if (!keepRow) refusals.push(`the kept code "${keep}" is not in the catalogue`);
    else if (keepRow.status !== "ACTIVE") refusals.push(`the kept code "${keep}" is ${keepRow.status}, not ACTIVE`);
    if (dropRow && keepRow && String(dropRow.category ?? "").toUpperCase() !== String(keepRow.category ?? "").toUpperCase()) {
      refusals.push(`"${drop}" is category ${dropRow.category} but "${keep}" is ${keepRow.category}`);
    }

    const refs = w.refs.filter((r) => normCode(r.code) === dk && Number(r.rows) > 0 && r.table !== "stock_take_lines");
    const rekey = refs.filter((r) => !STAYS_ON_DROP.has(r.table));
    const stay = refs.filter((r) => STAYS_ON_DROP.has(r.table));

    const takeLines = w.stockTakeLines.filter((l) => normCode(l.code) === dk);
    const takeMove = takeLines.filter((l) => l.takeStatus === "OPEN" && !l.collides);
    const takeStay = takeLines.filter((l) => !takeMove.includes(l));
    for (const l of takeStay) {
      if (l.takeStatus === "OPEN" && (Number(l.systemQty ?? 0) !== 0 || Number(l.countedQty ?? 0) !== 0)) {
        refusals.push(`an OPEN stock take counts "${drop}" (system ${l.systemQty ?? "-"}, counted ${l.countedQty ?? "-"}) where "${keep}" also has a line - post or cancel that take first`);
      }
    }
    if (takeMove.length > 0) rekey.push({ table: "stock_take_lines", col: "item_code", rows: takeMove.length, hasId: true, ids: takeMove.map((l) => l.id) });
    if (takeStay.length > 0) stay.push({ table: "stock_take_lines", col: "item_code", rows: takeStay.length });
    for (const r of rekey) {
      if (!r.hasId) refusals.push(`scm.${r.table} has no id column, so a re-key could not be undone row by row`);
    }

    const stock = w.stock.filter((s) => normCode(s.code) === dk);
    for (const s of stock) {
      if (s.ledgerQty !== s.lotQty) {
        refusals.push(`${s.warehouseCode}: the movement ledger says ${s.ledgerQty} and the open lots say ${s.lotQty} - reconcile "${drop}" first`);
      } else if (s.ledgerQty < 0) {
        refusals.push(`${s.warehouseCode}: "${drop}" is at ${s.ledgerQty}`);
      }
    }

    const refused = refusals.length > 0;
    out.push({
      drop,
      keep,
      dropRowId: dropRow?.id ?? null,
      dropRowStatus: dropRow?.status ?? null,
      refusals,
      rekey: refused ? [] : rekey.map((r) => ({ table: r.table, col: r.col, rows: Number(r.rows), ...(r.ids ? { ids: r.ids } : {}) })),
      stay: stay.map((r) => ({ table: r.table, col: r.col, rows: Number(r.rows) })),
      unitsMoved: refused ? 0 : sum(stock, (s) => s.ledgerQty),
      retire: !refused && dropRow?.status === "ACTIVE",
    });
  }

  const acting = out.filter((p) => p.refusals.length === 0);
  return {
    pairs: out,
    totals: {
      pairs: out.length,
      refused: out.length - acting.length,
      rowsToRekey: sum(acting.flatMap((p) => p.rekey), (r) => r.rows),
      unitsMoved: sum(acting, (p) => p.unitsMoved),
      toRetire: acting.filter((p) => p.retire).length,
    },
  };
}

/** The CONFIRM phrase carries the measured counts, so a phrase from an older run cannot fire. */
export function confirmPhrase(totals) {
  return `MERGE ${totals.pairs - totals.refused} CODES: REKEY ${totals.rowsToRekey} ROWS, MOVE ${totals.unitsMoved} UNITS, RETIRE ${totals.toRetire}`;
}
