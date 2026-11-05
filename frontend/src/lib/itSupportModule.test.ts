import { describe, expect, it } from "vitest";
import { Box } from "lucide-react";
import type { NavTab } from "../components/Sidebar";
import { NAV_TABS } from "../components/Sidebar";
import { itModuleIndex } from "./itSupportModule";

const tab = (label: string, to?: string, children?: NavTab[]): NavTab => ({ label, to, icon: Box, children });

const TABS: NavTab[] = [
  tab("Overview", "/"),
  tab("Sales Orders", "/scm/sales-orders"),
  tab("Projects", "/projects?view=hub", [tab("Project List", "/projects?view=list"), tab("Calendar", "/projects?view=calendar")]),
  tab("Supply Chain", "/scm", [
    tab("Sales Order", "/scm/sales-order", [tab("Sales Orders", "/scm/sales-orders"), tab("Delivery Orders", "/scm/delivery-orders")]),
    tab("Procurement", "/scm/procurement", [tab("Purchase Orders", "/scm/purchase-orders")]),
  ]),
];

describe("IT request module from the sidebar", () => {
  const { moduleFor, options } = itModuleIndex(TABS);

  it("names a page by its top entry and group, never the page itself", () => {
    expect(moduleFor("/scm/delivery-orders")).toBe("Supply Chain · Sales Order");
    expect(moduleFor("/scm/purchase-orders/PO-001")).toBe("Supply Chain · Procurement");
    expect(moduleFor("/projects?view=calendar")).toBe("Projects");
    expect(moduleFor("/")).toBe("Overview");
  });

  it("reads a top-level shortcut as the group it belongs to", () => {
    expect(moduleFor("/scm/sales-orders")).toBe("Supply Chain · Sales Order");
    expect(options).not.toContain("Sales Orders");
  });

  it("leaves a page no entry covers unnamed, and does not let Overview cover everything", () => {
    expect(moduleFor("/it-support")).toBe("");
    expect(moduleFor("")).toBe("Overview");
  });

  it("lists every module once, in sidebar order", () => {
    expect(options).toEqual(["Overview", "Supply Chain · Sales Order", "Projects", "Supply Chain", "Supply Chain · Procurement"]);
  });

  it("covers the real sidebar's main pages", () => {
    const real = itModuleIndex(NAV_TABS);
    expect(real.moduleFor("/scm/delivery-orders")).toBe("Supply Chain · Sales Order");
    expect(real.moduleFor("/scm/grns")).toBe("Supply Chain · Procurement");
    expect(real.options.length).toBeGreaterThan(5);
  });
});
