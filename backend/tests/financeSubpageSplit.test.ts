import { describe, it, expect } from "vitest";
import {
  PAGES,
  resolvePositionAccessFromRows,
  type AccessLevel,
} from "../src/services/pageAccess";

// ---------------------------------------------------------------------------
// The ZERO-CHANGE proof for the Finance sub-page split (owner 2026-10-20, batch
// 1). services/pageAccess.ts adds seven per-group Finance keys as children of
// scm.finance.accounting. This asserts that, for every finance shape that exists
// in production (anogrigyjbduyzclzjgn, 2026-10-20), login resolves each new key
// to EXACTLY what scm.finance.accounting resolves to — so no role gains or loses
// finance access on deploy, money-write included.
//
// WHY PARENT = scm.finance.accounting AND NOT scm.finance. Prod holds only three
// finance shapes across 24 roles: all-none (13 roles), finance=full/accounting=
// VIEW (7 roles — may see the books, may not post), finance=full/accounting=full
// (4 roles). Parenting on scm.finance would make the 7 view-roles inherit FULL
// and silently gain money-write. Parenting on scm.finance.accounting makes them
// inherit VIEW. The "see-only roles keep view" case below is the money-safety
// assertion the rebuild must never break.
//
// WHY BOTH "no row" AND "backfilled row" are proven. On deploy the new keys have
// no stored row and inherit via the cascade (the no-op). The backfill migration
// (20261020T1730) then writes an explicit row per role = that role's accounting
// level, so the role matrix / Excel replace-set does not re-persist the key as
// none on the owner's next save. Both resolve to the same map — the migration
// changes nothing it touches.
// ---------------------------------------------------------------------------

const NEW_KEYS = [
  "scm.finance.money_in",
  "scm.finance.money_out",
  "scm.finance.bank",
  "scm.finance.books",
  "scm.finance.reports",
  "scm.finance.forecast",
  "scm.finance.setup",
] as const;

type Row = { page_key: string; level: string };

/** A role's finance rows as stored BEFORE the split (no new-key rows yet). */
function financeRows(fin: AccessLevel, acc: AccessLevel, outs: AccessLevel): Row[] {
  return [
    { page_key: "scm", level: fin === "none" ? "none" : "full" },
    { page_key: "scm.finance", level: fin },
    { page_key: "scm.finance.accounting", level: acc },
    { page_key: "scm.finance.outstanding", level: outs },
  ];
}

const SHAPES: Array<{ label: string; acc: AccessLevel; rows: Row[] }> = [
  { label: "13 none-roles", acc: "none", rows: financeRows("none", "none", "none") },
  { label: "7 see-only roles", acc: "view", rows: financeRows("full", "view", "view") },
  { label: "4 full-finance roles", acc: "full", rows: financeRows("full", "full", "full") },
];

describe("Finance sub-page split is structurally sound", () => {
  it("all seven new keys exist and are children of scm.finance.accounting", () => {
    for (const k of NEW_KEYS) {
      const def = PAGES.find((p) => p.key === k);
      expect(def, `${k} must be in the catalogue`).toBeTruthy();
      expect(def!.parent, `${k} must inherit scm.finance.accounting`).toBe(
        "scm.finance.accounting",
      );
    }
  });
});

describe("Finance sub-page split is a byte-for-byte no-op at login", () => {
  for (const shape of SHAPES) {
    it(`${shape.label}: every new key resolves == scm.finance.accounting (no stored row)`, () => {
      const out = resolvePositionAccessFromRows(shape.rows);
      // The parent the split hangs off is unchanged...
      expect(out["scm.finance.accounting"]).toBe(shape.acc);
      // ...and every new key inherits exactly it.
      for (const k of NEW_KEYS) {
        expect(out[k], `${shape.label} ${k}`).toBe(shape.acc);
      }
      // The sibling keys the split does NOT touch are untouched.
      expect(out["scm.finance"]).toBe(shape.rows.find((r) => r.page_key === "scm.finance")!.level);
      expect(out["scm.finance.outstanding"]).toBe(
        shape.rows.find((r) => r.page_key === "scm.finance.outstanding")!.level,
      );
    });

    it(`${shape.label}: the backfill (explicit new-key rows = accounting) resolves identically`, () => {
      const before = resolvePositionAccessFromRows(shape.rows);
      const backfilled = [
        ...shape.rows,
        ...NEW_KEYS.map((k) => ({ page_key: k, level: shape.acc })),
      ];
      const after = resolvePositionAccessFromRows(backfilled);
      for (const p of PAGES) {
        expect(after[p.key], `${shape.label} ${p.key} after backfill`).toBe(before[p.key]);
      }
    });
  }

  it("money safety: the 7 see-only roles keep VIEW (never full) on every finance sub-page", () => {
    const out = resolvePositionAccessFromRows(financeRows("full", "view", "view"));
    for (const k of NEW_KEYS) {
      expect(out[k], `${k} must stay view for a see-only role`).toBe("view");
    }
  });
});
