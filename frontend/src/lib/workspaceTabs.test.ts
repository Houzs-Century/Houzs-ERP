import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_TABS_KEY,
  activateWorkspaceTab,
  closeWorkspaceTab,
  getWorkspaceTabsSnapshot,
  markWorkspaceDocumentIntent,
  markWorkspaceOpenIntent,
  moveWorkspaceTab,
  recordWorkspaceVisit,
  resetWorkspaceTabsForTests,
  sectionKeyFor,
} from "./workspaceTabs";
import {
  bindBrowserStorageIdentity,
  clearBrowserStorageIdentity,
} from "./storageIdentity";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearBrowserStorageIdentity();
  resetWorkspaceTabsForTests();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearBrowserStorageIdentity();
  resetWorkspaceTabsForTests();
});

const hrefs = () => getWorkspaceTabsSnapshot().tabs.map((t) => t.href);
const activeHref = () => {
  const { tabs, activeId } = getWorkspaceTabsSnapshot();
  return tabs.find((t) => t.id === activeId)?.href ?? null;
};
/** A sidebar click followed by its navigation. */
const openVia = (pathname: string, search = "") => {
  markWorkspaceOpenIntent();
  recordWorkspaceVisit(pathname, search);
};

describe("sectionKeyFor", () => {
  it("groups a document under its sidebar-level list", () => {
    expect(sectionKeyFor("/")).toBe("/");
    expect(sectionKeyFor("/assr")).toBe("/assr");
    expect(sectionKeyFor("/assr/123")).toBe("/assr");
    expect(sectionKeyFor("/projects/9")).toBe("/projects");
    expect(sectionKeyFor("/scm")).toBe("/scm");
    expect(sectionKeyFor("/scm/sales-orders")).toBe("/scm/sales-orders");
    expect(sectionKeyFor("/scm/sales-orders/SO-2507-0001")).toBe("/scm/sales-orders");
    expect(sectionKeyFor("/scm/sales-orders/new/guided")).toBe("/scm/sales-orders");
  });

  it("keeps the deeper SCM families apart — they are distinct sidebar destinations", () => {
    expect(sectionKeyFor("/scm/hr/commission")).toBe("/scm/hr/commission");
    expect(sectionKeyFor("/scm/hr/settings")).toBe("/scm/hr/settings");
    expect(sectionKeyFor("/scm/reports/sales-order-detail-listing")).toBe(
      "/scm/reports/sales-order-detail-listing",
    );
    expect(sectionKeyFor("/reports/fair-report")).toBe("/reports/fair-report");
  });

  it("resolves aliases so a guessed URL and its canonical page group together", () => {
    expect(sectionKeyFor("/sales-orders")).toBe("/scm/sales-orders");
    expect(sectionKeyFor("/trips")).toBe("/scm/trips");
  });

  it("normalises trailing slashes", () => {
    expect(sectionKeyFor("/assr/")).toBe("/assr");
  });
});

describe("browser-model navigation", () => {
  beforeEach(() => bindBrowserStorageIdentity(1));

  it("the first location of a session creates the first tab", () => {
    recordWorkspaceVisit("/", "");
    expect(hrefs()).toEqual(["/"]);
    expect(activeHref()).toBe("/");
  });

  it("in-content navigation FOLLOWS in the same tab — hub → group → DO never spawns", () => {
    // The owner's exact flow: Supply Chain hub → Sales Order group hub →
    // Delivery Orders. One tab, wandering.
    openVia("/scm", "");
    recordWorkspaceVisit("/scm/sales-order", "");
    recordWorkspaceVisit("/scm/delivery-orders", "");
    expect(hrefs()).toEqual(["/scm/delivery-orders"]);
    expect(activeHref()).toBe("/scm/delivery-orders");
  });

  it("a sidebar click spawns a second tab and the first keeps its spot", () => {
    openVia("/scm/sales-orders", "");
    recordWorkspaceVisit("/scm/sales-orders/SO-1", "");
    openVia("/assr", "?view=hub");
    expect(hrefs()).toEqual(["/scm/sales-orders/SO-1", "/assr?view=hub"]);
    expect(activeHref()).toBe("/assr?view=hub");
  });

  it("a sidebar click onto a section some tab already shows ACTIVATES it — no duplicate", () => {
    openVia("/scm/sales-orders", "");
    openVia("/assr", "?view=hub");
    openVia("/scm/sales-orders", "");
    const { tabs, activeId } = getWorkspaceTabsSnapshot();
    expect(tabs.map((t) => t.href)).toEqual(["/scm/sales-orders", "/assr?view=hub"]);
    expect(activeId).toBe(tabs[0].id);
  });

  it("the sidebar dedup matches by section, so a tab deep in a detail is found", () => {
    openVia("/scm/sales-orders", "");
    recordWorkspaceVisit("/scm/sales-orders/SO-1", "");
    openVia("/assr", "");
    openVia("/scm/sales-orders", "");
    // Back on the SO tab (re-pointed to the list — the click asked for it).
    const { tabs, activeId } = getWorkspaceTabsSnapshot();
    expect(tabs).toHaveLength(2);
    expect(activeId).toBe(tabs[0].id);
    expect(tabs[0].href).toBe("/scm/sales-orders");
  });

  it("an expired open-intent is ignored — a stale flag must not turn a hub click into a spawn", () => {
    openVia("/scm/sales-orders", "");
    markWorkspaceOpenIntent();
    // Simulate the flag outliving its TTL (no navigation followed the click).
    const realNow = Date.now;
    try {
      const base = realNow();
      Date.now = () => base + 10_000;
      recordWorkspaceVisit("/scm/delivery-orders", "");
    } finally {
      Date.now = realNow;
    }
    expect(hrefs()).toEqual(["/scm/delivery-orders"]);
  });

  it("activateWorkspaceTab hands back the tab's href and moves the pointer", () => {
    openVia("/scm/sales-orders", "");
    recordWorkspaceVisit("/scm/sales-orders/SO-1", "");
    openVia("/assr", "");
    const soTab = getWorkspaceTabsSnapshot().tabs[0];
    expect(activateWorkspaceTab(soTab.id)).toBe("/scm/sales-orders/SO-1");
    expect(activeHref()).toBe("/scm/sales-orders/SO-1");
    // The navigation that follows re-points nothing — it's already there.
    recordWorkspaceVisit("/scm/sales-orders/SO-1", "");
    expect(hrefs()).toEqual(["/scm/sales-orders/SO-1", "/assr"]);
  });

  it("survives a reload of the same window (sessionStorage), active pointer included", () => {
    openVia("/scm/sales-orders", "");
    openVia("/assr", "");
    const before = getWorkspaceTabsSnapshot();

    resetWorkspaceTabsForTests(); // module state dies with the old document
    bindBrowserStorageIdentity(1);
    const after = getWorkspaceTabsSnapshot();
    expect(after.tabs).toEqual(before.tabs);
    expect(after.activeId).toBe(before.activeId);
  });

  it("never inherits another user's strip", () => {
    openVia("/scm/sales-orders", "");
    resetWorkspaceTabsForTests();
    clearBrowserStorageIdentity();
    bindBrowserStorageIdentity(2);
    expect(hrefs()).toEqual([]);
  });

  it("claims a strip recorded before identity was known", () => {
    clearBrowserStorageIdentity();
    resetWorkspaceTabsForTests();
    recordWorkspaceVisit("/assr", "");
    bindBrowserStorageIdentity(7);
    expect(hrefs()).toEqual(["/assr"]);
    const raw = JSON.parse(sessionStorage.getItem(WORKSPACE_TABS_KEY)!);
    expect(raw.user).toBe(7);
  });

  it("drops a corrupt or hostile stored blob instead of rendering junk tabs", () => {
    sessionStorage.setItem(WORKSPACE_TABS_KEY, "{not json");
    expect(hrefs()).toEqual([]);

    resetWorkspaceTabsForTests();
    sessionStorage.setItem(
      WORKSPACE_TABS_KEY,
      JSON.stringify({
        user: 1,
        company: 0,
        activeId: "t9", // dangling pointer — not one of the surviving tabs
        nextId: 2, // lies below the real max id — must be re-derived
        tabs: [
          { id: "t3", href: "//evil.example/phish" }, // protocol-relative
          { id: "nope", href: "/x" }, // malformed id
          { id: "t5", href: "/scm/sales-orders" }, // valid
          { id: "t5", href: "/scm/sales-orders/dup" }, // duplicate id
        ],
      }),
    );
    const snap = getWorkspaceTabsSnapshot();
    expect(snap.tabs).toEqual([{ id: "t5", href: "/scm/sales-orders" }]);
    expect(snap.activeId).toBeNull();
    // Next spawn must mint an id ABOVE the surviving t5, not recycle t2.
    openVia("/assr", "");
    expect(getWorkspaceTabsSnapshot().tabs.map((t) => t.id)).toEqual(["t5", "t6"]);
  });
});

describe("moveWorkspaceTab", () => {
  let ids: string[];
  beforeEach(() => {
    bindBrowserStorageIdentity(1);
    openVia("/", "");
    openVia("/scm/sales-orders", "");
    openVia("/assr", "");
    ids = getWorkspaceTabsSnapshot().tabs.map((t) => t.id); // [/, SO, assr]
  });

  it("reorders without touching hrefs or the active pointer", () => {
    moveWorkspaceTab(ids[0], 2); // Overview to the end
    expect(hrefs()).toEqual(["/scm/sales-orders", "/assr", "/"]);
    expect(activeHref()).toBe("/assr"); // assr was active and stays active
    moveWorkspaceTab(ids[2], 0); // assr (active) to the front — still active
    expect(hrefs()).toEqual(["/assr", "/scm/sales-orders", "/"]);
    expect(activeHref()).toBe("/assr");
  });

  it("clamps out-of-range targets and no-ops same-position / unknown ids", () => {
    moveWorkspaceTab(ids[0], 99);
    expect(hrefs()).toEqual(["/scm/sales-orders", "/assr", "/"]);
    moveWorkspaceTab(ids[0], -5);
    expect(hrefs()).toEqual(["/", "/scm/sales-orders", "/assr"]);
    const before = getWorkspaceTabsSnapshot().tabs;
    moveWorkspaceTab(ids[1], 1); // already at 1
    moveWorkspaceTab("t999", 0); // unknown
    expect(getWorkspaceTabsSnapshot().tabs).toBe(before); // same reference — no emit
  });

  it("the new order survives a reload and drives close-neighbour semantics", () => {
    moveWorkspaceTab(ids[2], 0); // assr first: [assr, /, SO]
    resetWorkspaceTabsForTests();
    bindBrowserStorageIdentity(1);
    expect(hrefs()).toEqual(["/assr", "/", "/scm/sales-orders"]);
    // assr is still active; closing it now lands on its NEW right neighbour
    // (it sits first), which is Overview — the reordered layout, not the
    // creation order.
    const { navigateTo } = closeWorkspaceTab(ids[2]);
    expect(navigateTo).toBe("/");
  });
});

describe("closeWorkspaceTab", () => {
  let ids: string[];
  beforeEach(() => {
    bindBrowserStorageIdentity(1);
    openVia("/", "");
    openVia("/scm/sales-orders", "");
    openVia("/assr", "");
    ids = getWorkspaceTabsSnapshot().tabs.map((t) => t.id);
  });

  it("closing a background tab removes it, keeps the active pointer, navigates nowhere", () => {
    const { navigateTo } = closeWorkspaceTab(ids[1]);
    expect(navigateTo).toBeNull();
    expect(hrefs()).toEqual(["/", "/assr"]);
    expect(activeHref()).toBe("/assr");
  });

  it("closing the active tab hands back its left neighbour's remembered href", () => {
    activateWorkspaceTab(ids[1]);
    recordWorkspaceVisit("/scm/sales-orders/SO-1", "");
    activateWorkspaceTab(ids[2]);
    recordWorkspaceVisit("/assr", "");
    const { navigateTo } = closeWorkspaceTab(ids[2]);
    expect(navigateTo).toBe("/scm/sales-orders/SO-1");
    expect(activeHref()).toBe("/scm/sales-orders/SO-1");
  });

  it("closing the active FIRST tab hands back the right neighbour", () => {
    activateWorkspaceTab(ids[0]);
    const { navigateTo } = closeWorkspaceTab(ids[0]);
    expect(navigateTo).toBe("/scm/sales-orders");
  });

  it("closing the last remaining tab falls back to Overview", () => {
    closeWorkspaceTab(ids[0]);
    closeWorkspaceTab(ids[1]);
    const { navigateTo } = closeWorkspaceTab(ids[2]);
    expect(navigateTo).toBe("/");
    expect(hrefs()).toEqual([]);
  });
});

/* Owner 2026-09-27: a document opened from a relationship map gets its OWN tab
   in the strip — it must not overwrite another tab that happens to sit in the
   same section, and the page it came from keeps its tab. */
describe("document intent (relationship map)", () => {
  const openDoc = (pathname: string) => {
    markWorkspaceDocumentIntent();
    recordWorkspaceVisit(pathname, "");
  };

  it("opens the document in a new tab and leaves the SO tab where it was", () => {
    recordWorkspaceVisit("/scm/sales-orders/HC-SO-001", "");
    openDoc("/scm/delivery-orders/do-1");
    expect(hrefs()).toEqual(["/scm/sales-orders/HC-SO-001", "/scm/delivery-orders/do-1"]);
    expect(activeHref()).toBe("/scm/delivery-orders/do-1");
  });

  it("does not take over a tab already sitting in that section", () => {
    recordWorkspaceVisit("/scm/delivery-orders", "");
    openVia("/scm/sales-orders/HC-SO-001");
    openDoc("/scm/delivery-orders/do-1");
    expect(hrefs()).toEqual(["/scm/delivery-orders", "/scm/sales-orders/HC-SO-001", "/scm/delivery-orders/do-1"]);
  });

  it("the same document again activates its tab instead of opening a second one", () => {
    recordWorkspaceVisit("/scm/sales-orders/HC-SO-001", "");
    openDoc("/scm/delivery-orders/do-1");
    const soTab = getWorkspaceTabsSnapshot().tabs[0]!.id;
    const back = activateWorkspaceTab(soTab);
    recordWorkspaceVisit(back!, "");
    openDoc("/scm/delivery-orders/do-1");
    expect(hrefs()).toEqual(["/scm/sales-orders/HC-SO-001", "/scm/delivery-orders/do-1"]);
    expect(activeHref()).toBe("/scm/delivery-orders/do-1");
  });
});
