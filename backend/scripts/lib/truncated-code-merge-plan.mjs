// The planner behind merge-truncated-ac-codes.mjs. PURE: rows in, a plan out.
//
// WHY THIS EXISTS. AutoCount caps an item code at 30 characters, and nine book
// codes were created AT the cap, so their closing parenthesis never existed:
// "DL-CS2 NN-WINTER SLEEP MATT (K" is the book's real code. The first cutover
// pass used those strings as ERP codes and minted catalogue rows for them.
// docs/bugs/0567 re-pointed the mapping sheet at paren-closed names and the
// stock followed, but the old rows were never retired, and the 2026-09-07
// sales-order migration wrote the book's own code onto its lines. On
// 2026-09-14 the owner found six King mattress lines on one code and their two
// units on the other: the Inventory screen read 0, and allocation, MRP and the
// delivery stock guard - all keyed on the exact item code - could never see the
// stock.
//
// WHAT A PAIR BECOMES (owner, 2026-09-14: keep the mapping sheet's name).
//   lines     every sales-order line on the truncated code is re-keyed to the
//             survivor. item_code only: description, qty, price and variants
//             are the book's and do not move.
//   stock     what is left on the truncated code is judged against AutoCount at
//             that warehouse. If the survivor ALREADY holds AutoCount's balance,
//             the units on the truncated code are the same goods counted twice
//             and are written off. If survivor + truncated make AutoCount's
//             balance, the units are real and have to MOVE - reported, never
//             written here. Anything else is refused.
//   retire    the truncated catalogue row goes INACTIVE once nothing live is
//             left on it.
//
// TWO PARTS, because only one of them moves money. `lines` re-keys and retires
// the rows that hold no stock; it changes no quantity and no value. `writeoff`
// removes double-counted units, which takes their cost out of inventory value,
// so it is a separate decision taken with the figure in front of the owner
// (the precedent: docs/bugs/0721, where costing the cutover lots turned a
// count correction into a write-off).
//
// A PAIR IS ALL OR NOTHING. Any refusal in a pair empties that pair's plan, so
// no apply can leave one code half-moved.
//
// NO SHEBANG: tests/truncatedCodeMergePlan.test.mjs imports this module.

import { normCode } from "./ac-mapping-csv.mjs";

export const AC_CODE_CAP = 30;

const count = (s, ch) => String(s).split(ch).length - 1;

/** A book code cut by AutoCount's 30-character cap in the middle of a parenthesis. */
export function isTruncatedAcCode(code) {
  const s = String(code ?? "").trim();
  return s.length === AC_CODE_CAP && count(s, "(") > count(s, ")");
}

/**
 * The pairs to merge, MEASURED from the book's own item list and the mapping
 * sheet rather than typed: every truncated book code the sheet sends to a
 * different ERP code. A truncated code the sheet is silent about is returned
 * under `unmapped`, never guessed.
 *
 * @param {Iterable<string>} acItemCodes  every ItemCode in the book
 * @param {Map<string, {erp: string}>} mapping  readMappingCsv's result
 */
export function truncatedPairs(acItemCodes, mapping) {
  const pairs = [];
  const unmapped = [];
  const seen = new Set();
  for (const raw of acItemCodes) {
    const acCode = String(raw ?? "").trim();
    if (!isTruncatedAcCode(acCode) || seen.has(normCode(acCode))) continue;
    seen.add(normCode(acCode));
    const erp = mapping.get(normCode(acCode))?.erp ?? "";
    if (!erp || normCode(erp) === normCode(acCode)) unmapped.push(acCode);
    else pairs.push({ acCode, survivorCode: erp });
  }
  const byCode = (a, b) => (a.acCode ?? a).localeCompare(b.acCode ?? b);
  return { pairs: pairs.sort(byCode), unmapped: unmapped.sort(byCode) };
}

/**
 * Catalogue rows that are ONE product under two codes: the row's code is a book
 * code the mapping sheet sends to a DIFFERENT row that also exists. Report only -
 * the truncated nine are the owner-approved subset of this population.
 *
 * @param {Map<string, {erp: string}>} mapping
 * @param {Array<{code: string, status: string}>} products
 */
export function duplicateCatalogueRows(mapping, products) {
  const byCode = new Map(products.map((p) => [normCode(p.code), p]));
  const out = [];
  for (const [acKey, m] of mapping) {
    const erpKey = normCode(m?.erp);
    if (!erpKey || erpKey === acKey) continue;
    const bookRow = byCode.get(acKey);
    const survivor = byCode.get(erpKey);
    if (!bookRow || !survivor) continue;
    out.push({
      bookCode: bookRow.code, bookStatus: bookRow.status,
      survivorCode: survivor.code, survivorStatus: survivor.status,
      truncated: isTruncatedAcCode(bookRow.code),
    });
  }
  return out.sort((a, b) => a.bookCode.localeCompare(b.bookCode));
}

const sum = (rows, f) => rows.reduce((s, r) => s + Number(f(r) ?? 0), 0);
const lower = (s) => (s == null ? null : String(s).trim().toLowerCase());

/**
 * @param {object} w
 * @param {Array<{acCode: string, survivorCode: string}>} w.pairs
 * @param {Array<{id: string, code: string, status: string, category: string|null}>} w.products
 * @param {Array<{id: string, docNo: string, itemCode: string, itemGroup: string|null}>} w.soLines
 *   every sales-order line whose item_code is one of the truncated codes
 * @param {Array<{itemCode: string, table: string, rows: number}>} w.otherRefs
 *   rows on the truncated codes in any OTHER table keyed by item code
 * @param {Array<{itemCode: string, warehouseCode: string, variantKey: string|null, qty: number, lastMovementAt: string}>} w.balances
 *   movement-ledger balance per (code, warehouse, variant) for truncated AND survivor codes
 * @param {Array<{id: string, itemCode: string, warehouseCode: string, variantKey: string|null, batchNo: string|null, qtyRemaining: number, unitCostSen: number}>} w.lots
 *   lots with qty_remaining <> 0 for the same codes
 * @param {Map<string, number>} w.acBalance  `${normCode(ERP code)}|${WAREHOUSE CODE}` -> the book's balance, every book code the sheet sends to that ERP code summed
 * @param {string} w.snapshotAt  ISO instant the book balance was read at
 */
export function planTruncatedCodeMerge(w) {
  const productByCode = new Map(w.products.map((p) => [normCode(p.code), p]));
  const snapshotMs = Date.parse(w.snapshotAt);
  const out = [];

  for (const { acCode, survivorCode } of w.pairs) {
    const key = normCode(acCode);
    const refusals = [];
    const survivor = productByCode.get(normCode(survivorCode));
    const bookRow = productByCode.get(key) ?? null;

    if (!survivor) refusals.push(`the survivor "${survivorCode}" is not in the catalogue`);
    else if (survivor.status !== "ACTIVE") refusals.push(`the survivor "${survivorCode}" is ${survivor.status}, not ACTIVE`);

    const lines = w.soLines.filter((l) => normCode(l.itemCode) === key);
    if (survivor) {
      for (const l of lines) {
        const g = lower(l.itemGroup);
        const cat = lower(survivor.category);
        if (g && cat && g !== cat) {
          refusals.push(`${l.docNo} line is group "${l.itemGroup}" but the survivor is category "${survivor.category}"`);
        }
      }
    }

    for (const r of w.otherRefs.filter((x) => normCode(x.itemCode) === key && Number(x.rows) > 0)) {
      refusals.push(`${r.rows} row(s) in scm.${r.table} still carry the truncated code - not a sales-order line, so not in scope`);
    }

    const truncBal = w.balances.filter((b) => normCode(b.itemCode) === key);
    const truncLots = w.lots.filter((l) => normCode(l.itemCode) === key);
    const survBal = w.balances.filter((b) => normCode(b.itemCode) === normCode(survivorCode));
    const warehouses = [...new Set([...truncBal, ...truncLots].map((x) => x.warehouseCode))].sort();

    const writeOffs = [];
    const moves = [];
    for (const wh of warehouses) {
      const movQty = sum(truncBal.filter((b) => b.warehouseCode === wh), (b) => b.qty);
      const lotsHere = truncLots.filter((l) => l.warehouseCode === wh);
      const lotQty = sum(lotsHere, (l) => l.qtyRemaining);
      if (movQty !== lotQty) {
        refusals.push(`${wh}: the movement ledger says ${movQty} and the lots say ${lotQty} - reconcile the SKU first`);
        continue;
      }
      if (movQty === 0) continue;
      if (movQty < 0) {
        refusals.push(`${wh}: the truncated code is at ${movQty}`);
        continue;
      }
      if (lotsHere.some((l) => l.variantKey == null)) {
        refusals.push(`${wh}: a lot has no variant key, so an adjustment cannot be aimed at it`);
        continue;
      }
      const survHere = survBal.filter((b) => b.warehouseCode === wh);
      const last = Math.max(...[...truncBal.filter((b) => b.warehouseCode === wh), ...survHere]
        .map((b) => Date.parse(b.lastMovementAt)).filter(Number.isFinite));
      if (Number.isFinite(snapshotMs) && last > snapshotMs) {
        refusals.push(`${wh}: stock moved after the AutoCount snapshot (${w.snapshotAt}), so the book no longer describes it`);
        continue;
      }
      const survQty = sum(survHere, (b) => b.qty);
      const book = w.acBalance.get(`${normCode(survivorCode)}|${wh}`) ?? 0;
      if (survQty === book) {
        for (const l of lotsHere) {
          writeOffs.push({
            lotId: l.id, itemCode: l.itemCode, warehouseCode: wh, variantKey: l.variantKey,
            batchNo: l.batchNo ?? null, qty: Number(l.qtyRemaining), unitCostSen: Number(l.unitCostSen ?? 0),
            why: `AutoCount holds ${book} and "${survivorCode}" already holds ${survQty}; these ${movQty} are the same goods counted again`,
          });
        }
      } else if (survQty + movQty === book) {
        moves.push({ warehouseCode: wh, qty: movQty });
        refusals.push(`${wh}: AutoCount holds ${book} = survivor ${survQty} + truncated ${movQty}; these units are real and must MOVE, which this tool does not write`);
      } else {
        refusals.push(`${wh}: AutoCount holds ${book}, the survivor ${survQty}, the truncated code ${movQty} - neither a double count nor a move`);
      }
    }

    const refused = refusals.length > 0;
    const stockLeft = sum(truncBal, (b) => b.qty) !== 0 || truncLots.length > 0;
    out.push({
      acCode,
      survivorCode,
      bookRowId: bookRow?.id ?? null,
      bookRowStatus: bookRow?.status ?? null,
      refusals,
      moves,
      rekey: refused ? [] : lines.map((l) => ({ id: l.id, docNo: l.docNo })),
      writeOffs: refused ? [] : writeOffs,
      retireInLines: !refused && bookRow?.status === "ACTIVE" && !stockLeft,
      retireInWriteoff: !refused && bookRow?.status === "ACTIVE" && stockLeft,
    });
  }

  const applied = out.filter((p) => p.refusals.length === 0);
  return {
    pairs: out,
    totals: {
      pairs: out.length,
      refused: out.length - applied.length,
      linesToRekey: sum(applied, (p) => p.rekey.length),
      retireInLines: applied.filter((p) => p.retireInLines).length,
      unitsToWriteOff: sum(applied.flatMap((p) => p.writeOffs), (x) => x.qty),
      writeOffValueSen: sum(applied.flatMap((p) => p.writeOffs), (x) => x.qty * x.unitCostSen),
      retireInWriteoff: applied.filter((p) => p.retireInWriteoff).length,
    },
  };
}
