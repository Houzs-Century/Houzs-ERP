// The planner behind rename-skus-into-model.mjs. PURE: rows in, a plan out.
//
// WHY THIS EXISTS. DEV-41 (2026-10-06): one mattress, six sizes, two Models.
// BUG-38 merged AKEMI SOLITUDE MATT (Q/S/SK/SP) into HAPPI SLEEP, but K and SS
// had no HAPPI SLEEP twin, so they kept the AKEMI code and name and stayed on
// the old "SOLITUDE" Model. The SKU list shows two names for one product and the
// HAPPI SLEEP SOLITUDE Model page shows four of its six sizes.
//
// WHAT A RENAME IS. Exactly what PATCH /mfg-products/:id does for a new code -
// every PRODUCT_CODE_CASCADE column follows it - plus the two things that route
// cannot do: the new name in the same write, and the move onto the target Model.
// The new code must be unused everywhere, so the undo is the same UPDATE back.
//
// AN ENTRY IS ALL OR NOTHING per rename; the old Model is switched off only when
// every rename commits and none of its SKUs is still ACTIVE.
//
// NO SHEBANG: tests/skuRenameIntoModelPlan.test.mjs imports this module.

import { normCode } from "./ac-mapping-csv.mjs";

const sum = (rows, f) => rows.reduce((s, r) => s + Number(f(r) ?? 0), 0);

/**
 * @param {object} w
 * @param {{category: string, fromModel: string, toModel: string, retireFromModel: boolean,
 *          renames: Array<{from: string, to: string, name: string}>}} w.entry
 * @param {Array<{id: string, model_code: string, category: string, active: boolean, sizes: string[]}>} w.models
 *   the rows matching fromModel / toModel
 * @param {Array<{id: string, code: string, name: string, status: string, category: string|null,
 *          model_id: string|null, size_code: string|null}>} w.products
 *   every SKU named by a rename (either code) and every SKU on either Model
 * @param {Array<{table: string, col: string, code: string, rows: number}>} w.refs
 *   cascade rows carrying a `from` or a `to` code
 */
export function planSkuRenameIntoModel(w) {
  const { entry } = w;
  const cat = String(entry.category).toUpperCase();
  const modelRefusals = [];
  const pickModel = (code, label) => {
    const hits = w.models.filter((m) => normCode(m.model_code) === normCode(code) && String(m.category).toUpperCase() === cat);
    if (hits.length !== 1) { modelRefusals.push(`${label} Model "${code}" (${cat}) found ${hits.length} time(s), wanted 1`); return null; }
    return hits[0];
  };
  const fromModel = pickModel(entry.fromModel, "source");
  const toModel = pickModel(entry.toModel, "target");
  if (toModel && !toModel.active) modelRefusals.push(`target Model "${entry.toModel}" is not active`);

  const byCode = new Map(w.products.map((p) => [normCode(p.code), p]));
  const seen = new Map();
  for (const r of entry.renames) for (const c of [r.from, r.to]) seen.set(normCode(c), (seen.get(normCode(c)) ?? 0) + 1);

  const renames = entry.renames.map((r) => {
    const refusals = [...modelRefusals];
    const row = byCode.get(normCode(r.from)) ?? null;
    if (normCode(r.from) === normCode(r.to)) refusals.push(`"${r.from}" is renamed to itself`);
    if ((seen.get(normCode(r.from)) ?? 0) > 1 || (seen.get(normCode(r.to)) ?? 0) > 1) refusals.push(`"${r.from}" / "${r.to}" appears in more than one rename`);
    if (!String(r.name ?? "").trim()) refusals.push(`"${r.from}" has no new name`);
    if (!row) refusals.push(`"${r.from}" is not in the catalogue`);
    else {
      if (row.status !== "ACTIVE") refusals.push(`"${r.from}" is ${row.status}, not ACTIVE`);
      if (String(row.category ?? "").toUpperCase() !== cat) refusals.push(`"${r.from}" is category ${row.category}, not ${cat}`);
      if (fromModel && row.model_id !== fromModel.id) refusals.push(`"${r.from}" is not on Model "${entry.fromModel}" any more`);
      if (toModel && row.size_code && !toModel.sizes.map((s) => s.toUpperCase()).includes(String(row.size_code).toUpperCase())) {
        refusals.push(`size ${row.size_code} is not an allowed size of "${entry.toModel}"`);
      }
      const twin = toModel && w.products.find((p) => p.model_id === toModel.id && p.status === "ACTIVE"
        && String(p.size_code ?? "").toUpperCase() === String(row.size_code ?? "").toUpperCase());
      if (twin) refusals.push(`"${entry.toModel}" already has ACTIVE size ${row.size_code} as "${twin.code}" - that is a merge, not a rename`);
    }
    if (byCode.has(normCode(r.to))) refusals.push(`the new code "${r.to}" is already a SKU (${byCode.get(normCode(r.to)).status})`);
    const onTo = w.refs.filter((x) => normCode(x.code) === normCode(r.to) && Number(x.rows) > 0);
    for (const x of onTo) refusals.push(`scm.${x.table}.${x.col} already carries the new code "${r.to}" on ${x.rows} row(s), so the rename could not be undone`);

    const refused = refusals.length > 0;
    const rekey = w.refs.filter((x) => normCode(x.code) === normCode(r.from) && Number(x.rows) > 0)
      .map((x) => ({ table: x.table, col: x.col, rows: Number(x.rows) }));
    return {
      from: r.from,
      to: r.to,
      name: String(r.name ?? "").trim(),
      productId: row?.id ?? null,
      oldName: row?.name ?? null,
      sizeCode: row?.size_code ?? null,
      refusals,
      rekey: refused ? [] : rekey,
    };
  });

  const acting = renames.filter((r) => r.refusals.length === 0);
  const movingIds = new Set(acting.map((r) => r.productId));
  const leftActive = fromModel
    ? w.products.filter((p) => p.model_id === fromModel.id && p.status === "ACTIVE" && !movingIds.has(p.id))
    : [];
  const retireFromModel = Boolean(entry.retireFromModel && fromModel?.active
    && acting.length === renames.length && leftActive.length === 0);

  return {
    fromModelId: fromModel?.id ?? null,
    toModelId: toModel?.id ?? null,
    renames,
    retireFromModel,
    leftActive: leftActive.map((p) => p.code),
    totals: {
      renames: renames.length,
      refused: renames.length - acting.length,
      rowsToRekey: sum(acting.flatMap((r) => r.rekey), (x) => x.rows),
      retireModel: retireFromModel ? 1 : 0,
    },
  };
}

/** The CONFIRM phrase carries the measured counts, so a phrase from an older run cannot fire. */
export function confirmPhrase(totals) {
  return `RENAME ${totals.renames - totals.refused} SKUS: REKEY ${totals.rowsToRekey} ROWS, RETIRE ${totals.retireModel} MODEL`;
}
