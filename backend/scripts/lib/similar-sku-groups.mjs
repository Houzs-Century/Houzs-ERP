// The grouping behind report-similar-skus.mjs. PURE: rows in, groups out.
//
// HC-0147 (Sim, 2026-10-22): "DUNLOPILLO ROY EXECUTIVE LUXE 2.0 MATT (K)" sat next
// to "DUNLOPILLO ROYAL EXECUTIVE LUXE 2.0 MATT (K)", and she asked whether other
// SKUs are doubled the same way. Three signals, strongest first:
//   - same AutoCount item: two ACTIVE codes whose supplier bindings send the same
//     AutoCount ItemCode (BUG-38, HC-0141 and HC-0147 all had this);
//   - same code once spaces and punctuation are ignored ("LUXE2.0" / "LUXE 2.0");
//   - near-identical code: same category and size suffix, at most 3 letters apart.
//     Codes that differ only in digits are different models (9058-1 / 9058-2) and
//     are not reported.
// A group is a suggestion for a person to rule on, never a merge.
//
// NO SHEBANG: tests/similarSkuGroups.test.mjs imports this module.

import { normCode } from "./ac-mapping-csv.mjs";

const compact = (code) => normCode(code).replace(/[^A-Z0-9]/g, "");
const sizeSuffix = (code) => normCode(code).match(/\(([^()]*)\)\s*$/)?.[1].replace(/\s+/g, "") ?? "";

function distanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

export const REASONS = {
  ac: "same AutoCount item",
  spacing: "same code ignoring spaces and punctuation",
  near: "near-identical code",
};

/**
 * @param {object} w
 * @param {Array<{code: string, category: string|null, status: string}>} w.products
 * @param {Array<{itemCode: string, acCode: string|null}>} w.bindings
 *   mfg_product supplier bindings; acCode = ac_item_code, else supplier_sku
 * @returns {Array<{codes: string[], reasons: string[], acCodes: string[]}>}
 */
export function groupSimilarSkus(w) {
  const active = w.products.filter((p) => String(p.status).toUpperCase() === "ACTIVE");
  const byKey = new Map(active.map((p) => [normCode(p.code), p]));
  const keys = [...byKey.keys()];

  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k) => (parent.get(k) === k ? k : find(parent.get(k)));
  const reasonsOf = new Map();
  const link = (a, b, reason) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
    for (const k of [a, b]) reasonsOf.set(k, (reasonsOf.get(k) ?? new Set()).add(reason));
  };
  const linkAll = (members, reason) => {
    for (let i = 1; i < members.length; i++) link(members[0], members[i], reason);
  };
  const bucket = (keyOf) => {
    const m = new Map();
    for (const k of keys) {
      const b = keyOf(k);
      if (b == null) continue;
      m.set(b, [...(m.get(b) ?? []), k]);
    }
    return [...m.values()].filter((v) => v.length > 1);
  };

  const acOf = new Map();
  for (const b of w.bindings) {
    const k = normCode(b.itemCode);
    const ac = normCode(b.acCode);
    if (!byKey.has(k) || !ac) continue;
    acOf.set(k, (acOf.get(k) ?? new Set()).add(ac));
  }
  const byAc = new Map();
  for (const [k, acs] of acOf) for (const ac of acs) byAc.set(ac, [...(byAc.get(ac) ?? []), k]);
  for (const members of byAc.values()) if (members.length > 1) linkAll(members, REASONS.ac);

  for (const members of bucket((k) => compact(k))) linkAll(members, REASONS.spacing);

  const nearBuckets = bucket((k) => `${String(byKey.get(k).category ?? "").toUpperCase()}|${sizeSuffix(k)}`);
  for (const members of nearBuckets) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = compact(members[i]);
        const b = compact(members[j]);
        if (a === b || Math.min(a.length, b.length) < 12) continue;
        if (a.replace(/[0-9]/g, "") === b.replace(/[0-9]/g, "")) continue;
        if (distanceAtMost(a, b, 3)) link(members[i], members[j], REASONS.near);
      }
    }
  }

  const groups = new Map();
  for (const k of reasonsOf.keys()) groups.set(find(k), [...(groups.get(find(k)) ?? []), k]);
  return [...groups.values()]
    .map((members) => ({
      codes: members.map((k) => byKey.get(k).code).sort(),
      reasons: Object.values(REASONS).filter((r) => members.some((k) => reasonsOf.get(k)?.has(r))),
      acCodes: [...new Set(members.flatMap((k) => [...(acOf.get(k) ?? [])]))].sort(),
    }))
    .sort((a, b) => a.codes[0].localeCompare(b.codes[0]));
}
