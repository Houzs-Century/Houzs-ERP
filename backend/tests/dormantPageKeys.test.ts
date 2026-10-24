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

  test("the list is exactly the two remaining dead cells", () => {
    // Once seven (feat/jd-rules-from-record counted six; `team.members` was the
    // seventh). RBAC rebuild batch 3 (owner 2026-10-20 "全部拆开") WIRED five of
    // them: the Team nav repointed Directory / Roles & Permissions / Org Chart /
    // Departments off the parent `team` onto team.members / .roles / .org_chart /
    // .departments, and service_cases.settings now gates the Service Maintenance
    // tab. Only two stay dormant — no sidebar entry reads them: by_creditor has
    // no nav row, and pnl is an in-page figure, not a tab.
    expect([...DORMANT_PAGE_KEYS].sort()).toEqual([
      "service_cases.by_creditor",
      "service_cases.pnl",
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
     meaning "none". If greying ever severed it, the value would move the moment
     someone wires the key. (Pre-batch-3 this was shown with hr_manager's seeded
     team.roles / team.departments = none; those keys are now WIRED, so the proof
     moved to the two service_cases keys that remain dormant.) */
  test("POSITION: an explicit `none` on a dormant key still resolves none, under a full parent", async () => {
    const out = resolvePositionAccessFromRows([
      { page_key: "service_cases", level: "full" },
      { page_key: "service_cases.pnl", level: "none" },
    ]);
    expect(out["service_cases"]).toBe("full");
    expect(out["service_cases.pnl"]).toBe("none");
    // …and a dormant key with NO row still INHERITS. Absent is not "none".
    expect(out["service_cases.by_creditor"]).toBe("full");
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
