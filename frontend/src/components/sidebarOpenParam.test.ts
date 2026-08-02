import { describe, it, expect } from "vitest";
import { NAV_TABS, type NavTab } from "./Sidebar";

/**
 * NO SIDEBAR DESTINATION MAY CARRY `?open=`.
 *
 * `?open=` belongs to `useOpenSections` (CollapsibleSection.tsx) and holds WHICH
 * SECTIONS ARE EXPANDED. It is not a view selector. Two nav rows pointing at
 * `?open=a` and `?open=b` on the same route therefore render the SAME screen,
 * differing only in which chevron starts open — a sidebar that looks navigable
 * and is not.
 *
 * That shipped: Transportation > Maintenance had three children on
 * `/scm/delivery-maintenance?open=coverage-fleet|zones|carriers`, and the owner
 * reported it as "sidebar 是那样 里面内容却是全部?" (2026-08-02, BUG-HISTORY).
 *
 * The query-string destinations this repo DOES use — `/assr?view=cases`,
 * `/projects?view=calendar`, `/team?tab=members` — are fine and stay fine: each
 * renders a different screen. `?view=` and `?tab=` pick a page; `?open=` does
 * not. If a nav row must land somewhere specific, give it a route.
 */
const flatten = (tabs: readonly NavTab[]): NavTab[] =>
  tabs.flatMap((t) => [t, ...(t.children ? flatten(t.children) : [])]);

describe("sidebar destinations", () => {
  it("never uses ?open= as a nav destination", () => {
    const offenders = flatten(NAV_TABS)
      .filter((t) => typeof t.to === "string" && /[?&]open=/.test(t.to))
      .map((t) => `${t.label} -> ${t.to}`);

    expect(offenders).toEqual([]);
  });

  it("gives each child of a group its own destination", () => {
    const dupes: string[] = [];
    for (const tab of flatten(NAV_TABS)) {
      const kids = (tab.children ?? []).filter((c) => typeof c.to === "string");
      const seen = new Map<string, string>();
      for (const kid of kids) {
        const prev = seen.get(kid.to!);
        if (prev) dupes.push(`${tab.label}: "${prev}" and "${kid.label}" both -> ${kid.to}`);
        else seen.set(kid.to!, kid.label);
      }
    }
    expect(dupes).toEqual([]);
  });
});
