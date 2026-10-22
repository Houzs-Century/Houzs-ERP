import { describe, it, expect } from "vitest";
import {
  PAGES,
  resolvePositionAccessFromRows,
  type AccessLevel,
} from "../src/services/pageAccess";

// ---------------------------------------------------------------------------
// The ZERO-CHANGE proof for the Transportation sub-page split (owner 2026-10-20,
// batch 2). services/pageAccess.ts adds eight per-page Transportation keys as
// children of scm.transportation.drivers. This asserts that, for every
// transportation shape that exists in production (anogrigyjbduyzclzjgn,
// 2026-10-21), login resolves each new key to EXACTLY what
// scm.transportation.drivers resolves to — so no role gains or loses
// transportation access on deploy.
//
// WHY PARENT = scm.transportation.drivers AND NOT scm.transportation. Prod holds
// only three transportation shapes across 24 roles: transportation=full /
// drivers=full (11 roles), transportation=view / drivers=view (4 roles — scm
// umbrella off, may only SEE the pages), and all-none (9 roles). In every shape
// drivers resolves EQUAL to its parent scm.transportation, so neither parent
// would over-grant; parenting on the drivers LEAF mirrors the Finance batch-1
// safety rule (inherit the key the pages actually carry, never the area parent)
// and keeps the mapping faithful. The "see-only roles keep view" case below is
// the safety assertion the rebuild must never break.
//
// WHY BOTH "no row" AND "backfilled row" are proven. On deploy the new keys have
// no stored row and inherit via the cascade (the no-op). The backfill migration
// (20261021T0900) then writes an explicit row per role = that role's drivers
// level, so the role matrix / Excel replace-set does not re-persist the key as
// none on the owner's next save. Both resolve to the same map — the migration
// changes nothing it touches.
// ---------------------------------------------------------------------------

const NEW_KEYS = [
  "scm.transportation.overview",
  "scm.transportation.planning",
  "scm.transportation.dp_orders",
  "scm.transportation.last_mile",
  "scm.transportation.lorry_map",
  "scm.transportation.lorry_capacity",
  "scm.transportation.crew_leave",
  "scm.transportation.coverage",
] as const;

type Row = { page_key: string; level: string };

/** A role's transportation rows as stored BEFORE the split (no new-key rows). */
function transportRows(scm: AccessLevel, trans: AccessLevel, drivers: AccessLevel): Row[] {
  return [
    { page_key: "scm", level: scm },
    { page_key: "scm.transportation", level: trans },
    { page_key: "scm.transportation.drivers", level: drivers },
  ];
}

const SHAPES: Array<{ label: string; drivers: AccessLevel; rows: Row[] }> = [
  { label: "9 none-roles", drivers: "none", rows: transportRows("none", "none", "none") },
  { label: "4 see-only roles", drivers: "view", rows: transportRows("none", "view", "view") },
  { label: "11 full-transport roles", drivers: "full", rows: transportRows("full", "full", "full") },
];

describe("Transportation sub-page split is structurally sound", () => {
  it("all eight new keys exist and are children of scm.transportation.drivers", () => {
    for (const k of NEW_KEYS) {
      const def = PAGES.find((p) => p.key === k);
      expect(def, `${k} must be in the catalogue`).toBeTruthy();
      expect(def!.parent, `${k} must inherit scm.transportation.drivers`).toBe(
        "scm.transportation.drivers",
      );
    }
  });
});

describe("Transportation sub-page split is a byte-for-byte no-op at login", () => {
  for (const shape of SHAPES) {
    it(`${shape.label}: every new key resolves == scm.transportation.drivers (no stored row)`, () => {
      const out = resolvePositionAccessFromRows(shape.rows);
      // The parent the split hangs off is unchanged...
      expect(out["scm.transportation.drivers"]).toBe(shape.drivers);
      // ...and every new key inherits exactly it.
      for (const k of NEW_KEYS) {
        expect(out[k], `${shape.label} ${k}`).toBe(shape.drivers);
      }
      // The parent-area key the split does NOT touch is untouched.
      expect(out["scm.transportation"]).toBe(
        shape.rows.find((r) => r.page_key === "scm.transportation")!.level,
      );
    });

    it(`${shape.label}: the backfill (explicit new-key rows = drivers) resolves identically`, () => {
      const before = resolvePositionAccessFromRows(shape.rows);
      const backfilled = [
        ...shape.rows,
        ...NEW_KEYS.map((k) => ({ page_key: k, level: shape.drivers })),
      ];
      const after = resolvePositionAccessFromRows(backfilled);
      for (const p of PAGES) {
        expect(after[p.key], `${shape.label} ${p.key} after backfill`).toBe(before[p.key]);
      }
    });
  }

  it("safety: the 4 see-only roles keep VIEW (never full) on every transportation sub-page", () => {
    const out = resolvePositionAccessFromRows(transportRows("none", "view", "view"));
    for (const k of NEW_KEYS) {
      expect(out[k], `${k} must stay view for a see-only role`).toBe("view");
    }
  });
});
