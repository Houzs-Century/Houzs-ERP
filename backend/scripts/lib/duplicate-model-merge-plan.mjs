// The planner behind merge-duplicate-models.mjs. PURE: rows in, a plan out.
//
// WHY THIS EXISTS. HC-0202 (Sim, 2026-11-02): one mattress or bedframe family
// sits under two or three Product Models ("CS2 VISCO BLISS" beside "COOLSILK 2.0
// VISCO BLISS", "ECOZONE-C (BLANK)" holding the SP of "ECOZONE-C", one flat
// Model per size for "DUNLOPILLO COOLSILK 2.0 ... MATT (K)"), so the SO line
// picker shows the family twice and each Model's sizes are only part of it.
//
// WHAT A GROUP BECOMES. The reporter picks the Model that stays (or names a new
// one). Every ACTIVE SKU of the group is sorted by size:
//   - one SKU of a size: it moves under the kept Model as it is;
//   - two or more: one product under two codes. The survivor is picked by
//     survivorRank (spelling, then ACTIVE, then main supplier, then use), moves
//     under the kept Model, and the others merge into it with the duplicate-SKU
//     merge (duplicate-sku-merge-plan.mjs), which re-keys lines and stock;
//   - a survivor with no main supplier takes the main binding of the code it
//     absorbs (that binding is also what AutoCount calls the item), and blank
//     prices / cost are filled from it.
// The kept Model's size pool gains every size that now lives on it; the folded
// Models switch off (active = false). A folded Model's INACTIVE SKUs move under
// the kept Model too (inactiveMoves), so the folded Model ends with no SKU at all
// instead of lingering in Modular with codes that were merged away (2026-11-10:
// "AMIRA PREMUIM" stayed with 4 SKUs after its codes merged into AMIRA PREMIUM).
//
// A GROUP IS REFUSED WHOLE when its ACTIVE SKUs, on any of its Models and of any
// size, are bound to more than one main supplier (owner, 2026-11-10: Models of
// different suppliers are never merged). Twins of one size bound to different
// suppliers are the sharpest case: two products with similar names, not one
// under two codes. Only a book group that says `ruledOneProduct` (the owner ruled
// that very pair one product) passes; the Modular screen never sets it.
//
// NO SHEBANG: tests/duplicateModelMergePlan.test.mjs imports this module.

/** Codes that are a misspelling or a placeholder of their twin; never the survivor while a clean twin exists. */
export const BAD_SPELLING = [/\(BLANK\)/i, /\bLUXURTY?\b/i, /\bPREMUIM\b/i, /\bROY\b/i, /\bSANTUARY\b/i, /\bIYASH\b/i, /\)\s*\(-\(/];

/** Price and cost columns a survivor takes from the code it absorbs when its own is blank. */
export const FILL_FIELDS = ["base_price_sen", "sell_price_sen", "pwp_price_sen", "cost_price_sen", "price1_sen", "price2_sen", "price3_sen", "price4_sen"];

/** The size a SKU stands for: its size_code, else the "(X)" / "(X" its code ends with. */
export function sizeOf(sku) {
  const sc = String(sku.size_code ?? "").trim().toUpperCase();
  if (sc) return sc;
  const m = String(sku.code).match(/\(([A-Z0-9+]{1,4})\)?\s*$/i);
  return m ? m[1].toUpperCase() : "";
}

const badSpelling = (code) => BAD_SPELLING.some((re) => re.test(code));
const blank = (v) => v == null || v === 0 || v === "0";

/** Higher sorts first. `use` = { lines, stock }; `main` = main supplier code or null. */
export function survivorRank(s, keptModelId) {
  return [
    badSpelling(s.code) ? 0 : 1,
    s.status === "ACTIVE" ? 1 : 0,
    s.main ? 1 : 0,
    s.use.lines,
    s.use.stock,
    s.model_id === keptModelId ? 1 : 0,
  ];
}
const cmpRank = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
  return 0;
};

/**
 * @param {object} w
 * @param {{category: string, keep: string|null, newModel?: string, drops: string[], skip?: string, sizes?: Record<string, string>}} w.group
 *   `sizes`: the size of a SKU whose code and size_code carry none, by SKU code
 * @param {Array<{id: string, model_code: string, category: string, active: boolean, allowed_options: any, branding?: string|null}>} w.models
 * @param {Array<{id: string, code: string, status: string, size_code: string|null, model_id: string|null, base_model: string|null,
 *                main: string|null, use: {lines: number, stock: number}, master: Record<string, unknown>}>} w.skus
 *   every SKU of the group's Models
 */
export function planModelGroup({ group, models, skus }) {
  const refusals = [];
  const label = group.keep ?? group.newModel;
  if (group.skip) refusals.push(`left out: ${group.skip}`);
  const inCat = (code) => models.filter((m) => m.model_code === code && m.category === group.category);
  let kept = null;
  if (group.keep) {
    const k = inCat(group.keep);
    if (k.length !== 1) refusals.push(`kept Model "${group.keep}" ${k.length === 0 ? "is not" : "is more than once"} in ${group.category}`);
    else kept = k[0];
  } else if (inCat(group.newModel).length > 0) {
    kept = inCat(group.newModel)[0];
  }
  const folds = [];
  for (const d of group.drops) {
    const f = inCat(d);
    if (f.length !== 1) refusals.push(`folded Model "${d}" ${f.length === 0 ? "is not" : "is more than once"} in ${group.category}`);
    else if (f[0].id !== kept?.id) folds.push(f[0]);
  }
  const keptId = kept?.id ?? null;
  const groupModelIds = new Set([keptId, ...folds.map((f) => f.id)].filter(Boolean));
  const mine = skus.filter((s) => groupModelIds.has(s.model_id));
  const active = mine.filter((s) => s.status === "ACTIVE");
  /* Owner rule 2026-11-10, Models of different suppliers are never merged, for
     the codes the supplier check below does not see: a fold now moves a folded
     Model's INACTIVE (merged-away) codes too, so their supplier counts. */
  const mainsOf = (id, st) => new Set(mine.filter((s) => s.model_id === id && s.main && (st === null || s.status !== "ACTIVE")).map((s) => s.main));
  const keptMains = mainsOf(keptId, null);
  if (keptMains.size > 0 && !group.ruledOneProduct) {
    for (const f of folds) {
      const other = [...mainsOf(f.id, "INACTIVE")].filter((m) => !keptMains.has(m));
      if (other.length > 0) refusals.push(`different supplier: Model "${f.model_code}" has switched-off codes supplied by ${other.join(", ")}, "${label}" by ${[...keptMains].join(", ")}`);
    }
  }
  const supByModel = new Map();
  for (const s of active) if (s.main) supByModel.set(s.model_id, new Set([...(supByModel.get(s.model_id) ?? []), s.main]));
  const groupMains = new Set([...supByModel.values()].flatMap((x) => [...x]));
  if (groupMains.size > 1 && !group.ruledOneProduct) {
    const name = (id) => models.find((m) => m.id === id)?.model_code ?? id;
    refusals.push(`the Models are bound to different main suppliers (${[...supByModel.entries()].map(([id, x]) => `"${name(id)}" ${[...x].sort().join("/")}`).join(" vs ")}) - Models of different suppliers are never merged`);
  }

  const bySize = new Map();
  for (const s of active) {
    const z = group.sizes?.[s.code] ?? sizeOf(s);
    if (!z) { refusals.push(`"${s.code}" has no size`); continue; }
    bySize.set(z, [...(bySize.get(z) ?? []), s]);
  }

  const pairs = [];
  const moves = [];
  const fills = [];
  const sizes = [];
  for (const [size, twins] of [...bySize.entries()].sort()) {
    const ranked = [...twins].sort((a, b) => cmpRank(survivorRank(a, keptId), survivorRank(b, keptId)));
    const survivor = ranked[0];
    sizes.push(size);
    if (survivor.model_id !== keptId) moves.push({ id: survivor.id, code: survivor.code, size, fromModelId: survivor.model_id, setSizeCode: !survivor.size_code });
    else if (!survivor.size_code && group.sizes?.[survivor.code]) moves.push({ id: survivor.id, code: survivor.code, size, fromModelId: survivor.model_id, setSizeCode: true });
    for (const t of ranked.slice(1)) pairs.push({ drop: t.code, keep: survivor.code, size });
    const donors = ranked.slice(1);
    if (!survivor.main) {
      const donor = donors.find((t) => t.main);
      if (donor) fills.push({ code: survivor.code, field: "main supplier", from: donor.code, supplier: donor.main });
    }
    for (const f of FILL_FIELDS) {
      if (!(f in (survivor.master ?? {})) || !blank(survivor.master[f])) continue;
      const donor = donors.find((t) => !blank(t.master?.[f]));
      if (donor) fills.push({ code: survivor.code, field: f, from: donor.code, value: donor.master[f] });
    }
  }
  const poolSizes = (m) => (Array.isArray(m?.allowed_options?.sizes) ? m.allowed_options.sizes.map((x) => String(x).toUpperCase()) : []);
  const addSizes = sizes.filter((z) => !poolSizes(kept).includes(z));

  const refused = refusals.length > 0;
  return {
    label,
    category: group.category,
    keptModelId: keptId,
    createModel: !refused && !kept ? { code: group.newModel, template: folds[0] ?? null } : null,
    activateKept: !refused && Boolean(kept) && !kept.active && sizes.length > 0,
    refusals,
    pairs: refused ? [] : pairs,
    moves: refused ? [] : moves,
    fills: refused ? [] : fills,
    addSizes: refused ? [] : addSizes,
    foldModels: refused ? [] : folds.filter((f) => f.active).map((f) => ({ id: f.id, code: f.model_code })),
    inactiveMoves: refused ? [] : mine.filter((s) => s.status !== "ACTIVE" && s.model_id !== keptId)
      .map((s) => ({ id: s.id, code: s.code, fromModelId: s.model_id })),
    leftInactive: mine.filter((s) => s.status !== "ACTIVE" && (refused || s.model_id === keptId)).map((s) => s.code),
  };
}

/**
 * A SKU merge left a Model with no ACTIVE code: the planned fold of it, when that
 * fold is ONLY a fold. A plan that would also merge, move or fill an ACTIVE code
 * (two codes of one size on the kept Model) is a Model merge of its own, which a
 * person decides on the "Merge models" screen; so is waking a switched-off Model.
 * @returns {{ok: true, plan: object} | {ok: false, reason: string}}
 */
export function foldOnlyPlan(plan, keptModelActive) {
  if (plan.refusals.length > 0) {
    const supplier = plan.refusals.some((r) => /different (main )?supplier/.test(r)) && !plan.refusals[0].startsWith("different supplier");
    return { ok: false, reason: `${supplier ? "different supplier: " : ""}${plan.refusals.join("; ")}` };
  }
  if (plan.pairs.length > 0) {
    return { ok: false, reason: `Model "${plan.label}" holds two codes of one size (${plan.pairs.map((p) => `${p.drop} / ${p.keep}`).join(", ")}); settle them with Merge models` };
  }
  if (plan.moves.length > 0 || plan.fills.length > 0) return { ok: false, reason: "it would also move ACTIVE codes; use Merge models" };
  if (!keptModelActive) return { ok: false, reason: `Model "${plan.label}" is switched off` };
  return { ok: true, plan: { ...plan, createModel: null, activateKept: false, addSizes: [] } };
}

/**
 * Which Models a SKU merge leaves with no ACTIVE code, so they fold into the kept
 * code's Model. `retiring`: codes still ACTIVE that the merge is about to switch
 * off (the preview); empty after the merge, when the rows already say it.
 * @param {{pairs: Array<{drop: string, keep: string}>,
 *          codeModels: Map<string, {model_id: string|null, model_code: string|null, status: string}>,
 *          activeByModel: Map<string, number>, retiring: Set<string>}} w
 */
export function foldTargets({ pairs, codeModels, activeByModel, retiring }) {
  const byFrom = new Map();
  for (const p of pairs) {
    const d = codeModels.get(p.drop);
    const k = codeModels.get(p.keep);
    if (!d?.model_id || !k?.model_id || d.model_id === k.model_id) continue;
    const t = byFrom.get(d.model_id) ?? { fromModelId: d.model_id, from: d.model_code, into: new Map() };
    t.into.set(k.model_id, k.model_code);
    byFrom.set(d.model_id, t);
  }
  return [...byFrom.values()].map((t) => {
    const leaving = [...codeModels.entries()].filter(([code, r]) => retiring.has(code) && r.model_id === t.fromModelId && r.status === "ACTIVE").length;
    const activeLeft = Math.max(0, (activeByModel.get(t.fromModelId) ?? 0) - leaving);
    const intos = [...t.into.entries()];
    const base = { fromModelId: t.fromModelId, from: t.from, intoModelId: intos.length === 1 ? intos[0][0] : null, into: intos.map(([, c]) => c).join(" / ") };
    if (intos.length > 1) return { ...base, fold: false, reason: `its codes went into more than one Model (${base.into})` };
    if (activeLeft > 0) return { ...base, fold: false, reason: `it still has ${activeLeft} active code(s)` };
    return { ...base, fold: true, reason: null };
  });
}

/** A Model on the idle list switches off, with its ACTIVE SKUs, only with no stock and no open sales-order line. */
export function planIdleModel({ entry, models, skus }) {
  const m = models.filter((x) => x.model_code === entry.model && x.category === entry.category);
  if (m.length !== 1) return { label: entry.model, refusals: [`Model ${m.length === 0 ? "not found" : "found more than once"} in ${entry.category}`], modelId: null, skuIds: [] };
  const mine = skus.filter((s) => s.model_id === m[0].id);
  const units = mine.reduce((a, s) => a + Math.max(0, s.use.stock), 0);
  const open = mine.reduce((a, s) => a + s.use.openSo, 0);
  const refusals = [];
  if (units > 0) refusals.push(`${units} unit(s) in stock`);
  if (open > 0) refusals.push(`${open} open sales-order line(s)`);
  const refused = refusals.length > 0;
  return {
    label: entry.model,
    refusals,
    modelId: refused || !m[0].active ? null : m[0].id,
    skuIds: refused ? [] : mine.filter((s) => s.status === "ACTIVE").map((s) => s.id),
    skuCodes: refused ? [] : mine.filter((s) => s.status === "ACTIVE").map((s) => s.code),
  };
}

/** The CONFIRM phrase carries the measured counts, so a phrase from an older run cannot fire. */
export function confirmPhrase(t) {
  return `MERGE ${t.groups} MODELS: ${t.pairs} SKU MERGES, MOVE ${t.moves} SKUS, MOVE ${t.inactive} SWITCHED-OFF, FILL ${t.fills}, FOLD ${t.folds}, IDLE OFF ${t.idleModels}/${t.idleSkus}`;
}
