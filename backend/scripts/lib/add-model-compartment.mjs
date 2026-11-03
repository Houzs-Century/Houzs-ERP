// Pure transforms behind add-model-compartment.mjs — adding one sofa compartment
// code to a Model. No I/O: strings and objects in, the same shapes out, so the
// runner can plan, apply and verify against them and the node:test beside this
// file can pin the rules without a database.
//
// The sofa engine matches a compartment by its EXACT pool casing (see
// product-models.ts: "the engine matches case-sensitively, so the code suffix
// must equal the laid-out cell code"), so membership here is case-sensitive too:
// "G1F" and "g1f" are different codes, and a tick must use the one casing the
// pool entry and the SKU suffix share.

/** Trim a raw compartment code. Empty is the caller's error to report. */
export function normalizeCode(raw) {
  return String(raw ?? '').trim();
}

/** The SKU code a sofa compartment mints: `<MODEL>-<comp>`, model uppercased,
 *  compartment kept verbatim — mirrors product-models.ts generate/auto-create. */
export function skuCodeFor(modelCode, code) {
  return `${String(modelCode).toUpperCase()}-${code}`;
}

/** The SKU name: `SOFA <MODEL NAME> <comp>`, name uppercased and falling back to
 *  the model code when it is blank — mirrors product-models.ts. */
export function skuNameFor(modelName, modelCode, code) {
  const upper = String(modelName || modelCode).toUpperCase();
  return `SOFA ${upper} ${code}`;
}

/** The 30-char item-code ceiling the rename gate also enforces. */
export const ITEM_CODE_MAX = 30;
export function itemCodeTooLong(modelCode, code) {
  return skuCodeFor(modelCode, code).length > ITEM_CODE_MAX;
}

/** A copy of `list` with `value` appended once, case-sensitively. Absent input
 *  becomes a one-element array. `added` is false when it was already there, so a
 *  second run changes nothing. */
export function arrayWith(list, value) {
  const arr = Array.isArray(list) ? [...list] : [];
  if (arr.includes(value)) return { list: arr, added: false };
  arr.push(value);
  return { list: arr, added: true };
}

/** The master config with `code` in sofaCompartments, every other key verbatim.
 *  Not re-normalized: appending a plain token introduces no inch mark, so the
 *  inch-pool hygiene the Maintenance save runs has nothing to do here. */
export function poolWithCompartment(config, code) {
  const base = config && typeof config === 'object' ? config : {};
  const { list, added } = arrayWith(base.sofaCompartments, code);
  return { config: { ...base, sofaCompartments: list }, added };
}

/** The Model's allowed_options with `code` in compartments, other pools kept. */
export function optionsWithCompartment(options, code) {
  const base = options && typeof options === 'object' ? options : {};
  const { list, added } = arrayWith(base.compartments, code);
  return { options: { ...base, compartments: list }, added };
}
