import { describe, expect, test } from "vitest";
import {
  DORMANT_PAGE_KEYS,
  PAGES,
  fullAccessMap,
  isDormantPageKey,
  isValidPageKey,
  pageAccessFromPermissions,
  resolvePositionAccessFromRows,
} from "../src/services/pageAccess";

/* Owner 2026-07-17: "不能留着了，然后「頁面灰色」点不到吗？最重要是我要它的 UI"
   — a switch that does nothing must stop pretending, must be unclickable, and
   the ROW MUST STAY. DORMANT_PAGE_KEYS is how the editor knows which rows to
   grey.

   THE ACCEPTANCE TEST IS THAT NOTHING MOVES. Greying is a UI fact; hydration
   must not learn about it. These pin that the resolvers are blind to the list —
   a dormant key with a `= none` row still resolves to exactly "none", and a
   dormant key riding its parent still inherits. If greying ever starts changing
   what a cell resolves to, this file fails before anyone is locked out on the
   Monday after. */

/** Minimal D1 stand-in — the resolvers only ever prepare/bind/all one SELECT. */
describe("dormant page keys — the greyed rows", () => {
  test("every dormant key is a REAL catalogue key (greying a typo greys nothing)", () => {
    for (const key of DORMANT_PAGE_KEYS) {
      expect(isValidPageKey(key), `${key} is not in PAGES[]`).toBe(true);
    }
  });

  test("the list is exactly the seven measured dead cells", () => {
    // feat/jd-rules-from-record counted six; `team.members` was the seventh — the
    // Team nav gates on the PARENT key `team` plus a flat users.read, so all four
    // team.* children are read by nothing. Re-swept 2026-07-17.
    // `scm.warehouse.adjustments` was briefly the eighth (fused onto
    // scm.warehouse.inventory), but the owner split stock ADJUSTMENT off Inventory
    // on 2026-07-18: it now has a real area-guard (POST /inventory/adjustments), a
    // live FE nav + route, and (under the new position policy) the full cohort's
    // grant — so it is no longer dormant.
    expect([...DORMANT_PAGE_KEYS].sort()).toEqual([
      "service_cases.by_creditor",
      "service_cases.pnl",
      "service_cases.settings",
      "team.departments",
      "team.members",
      "team.org_chart",
      "team.roles",
    ]);
  });

  test("no PARENT is dormant — greying a parent would grey a live sub-tree", () => {
    const parents = new Set(PAGES.filter((p) => p.parent).map((p) => p.parent!));
    for (const key of DORMANT_PAGE_KEYS) {
      expect(parents.has(key), `${key} is a parent and must not be greyed`).toBe(false);
    }
  });

  test("the wildcard map is untouched — `*` still resolves full on every key", () => {
    const full = fullAccessMap();
    for (const key of DORMANT_PAGE_KEYS) expect(full[key]).toBe("full");
  });

  /* THE ONE THAT MATTERS. A dormant key carrying an explicit `= none` must keep
     meaning "none" — the seed writes exactly this for hr_manager (team.roles +
     team.departments, seed-user-management.mjs:71). If greying ever severed it,
     the value would move the moment someone wires the key. */
  test("POSITION: an explicit `none` on a dormant key still resolves none, under a full parent", async () => {
    const out = resolvePositionAccessFromRows([
      { page_key: "team", level: "full" },
      { page_key: "team.roles", level: "none" },
      { page_key: "team.departments", level: "none" },
    ]);
    expect(out["team"]).toBe("full");
    expect(out["team.roles"]).toBe("none");
    expect(out["team.departments"]).toBe("none");
    // …and a dormant key with NO row still INHERITS. Absent is not "none".
    expect(out["team.members"]).toBe("full");
    expect(out["team.org_chart"]).toBe("full");
  });

  test("ROLE: the legacy matrix resolves dormant keys by its own cascade, unchanged", async () => {
    const out = pageAccessFromPermissions(new Set(["service_cases.read"]));
    // parent "partial" → children keep their own backfill, dormant or not.
    expect(out["service_cases.by_creditor"]).toBe("partial");
    // supportsPartial:false pages backfill on service_cases.manage, which this
    // role lacks — so "none", exactly as before the list existed.
    expect(out["service_cases.pnl"]).toBe("none");
    expect(out["service_cases.settings"]).toBe("none");
  });

  test("dormancy is INERT in hydration — resolution ignores the list entirely", async () => {
    // Same rows, resolved twice; the only thing that differs between a dormant
    // and a live key here is that one is on the list. Their resolution must not.
    const out = resolvePositionAccessFromRows([{ page_key: "service_cases", level: "full" }]);
    expect(isDormantPageKey("service_cases.by_creditor")).toBe(true);
    expect(isDormantPageKey("service_cases.cases")).toBe(false);
    // The live child and the dormant child inherit identically.
    expect(out["service_cases.cases"]).toBe("full");
    expect(out["service_cases.by_creditor"]).toBe("full");
  });
});
