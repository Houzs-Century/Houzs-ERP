/* Venue rent (owner 2026-10-23): rent per square foot and per day by venue,
   and - click a venue - by the operator charging it. */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OvProject } from "./projectOverviewModel";
import { VenueRentPanel } from "./VenueRentPanel";

const project = (o: Partial<OvProject>): OvProject => ({
  id: 1, code: "P1", name: "Fair", brand: "AKEMI", organizer: "MYHOME", venue: "MID VALLEY", state: "KL", stage: "completed",
  startDate: "2026-10-01", endDate: "2026-10-03", eventType: "Exhibition", sizeSqm: 100,
  keyed: { income: 0, cogs: 0, rental: 0, commission: 0, setup: 0, transport: 0, merchandise: 0, other: 0, cogsMattSofa: 0, cogsBedframe: 0, cogsAccessories: 0, transportFee: 0, transportSetup: 0 },
  salesOrders: { sen: 0, costSen: 0, count: 0, costSplit: { mattSofa: 0, bedframe: 0, accessories: 0 } },
  chatReport: null, collection: { totalSen: 0, paidSen: 0 },
  pnl: { fromOrders: false, sales: 0, serviceRevenue: 0, cogs: { mattSofa: 0, bedframe: 0, accessories: 0, other: 0 }, rental: 21528, setup: 0, transportSetup: 0, others: 0, transportFee: 0, commission: 0, merchandise: 0 },
  ...o,
});

describe("VenueRentPanel", () => {
  it("rent per m2 and per day are the venue's totals over its booth area and days; a venue opens to its operators", () => {
    const pnl = (rental: number) => ({ ...project({}).pnl!, rental });
    render(<VenueRentPanel periodLabel="Oct" projects={[
      /* 100 m2, 3 days, RM 21,528 -> RM 215.28 / m2, RM 71.76 / m2 / day, RM 7,176 / day */
      project({ id: 1, organizer: "MYHOME", pnl: pnl(21528) }),
      project({ id: 2, organizer: "BIGHOME", pnl: pnl(10764) }),
      project({ id: 3, venue: "SETIA SPICE", sizeSqm: null }),
    ]} />);
    const row = screen.getByText(/MID VALLEY/).closest("tr") as HTMLElement;
    /* 32,292 over 200 m2 = RM 161.46 per m2 */
    expect(row.textContent).toContain("RM 161.46");
    expect(screen.queryByText(/SETIA SPICE/)).toBeNull();
    expect(screen.getByText(/with a rental but no booth size are left out/)).toBeTruthy();
    fireEvent.click(row);
    expect((screen.getByText("MYHOME").closest("tr") as HTMLElement).textContent).toContain("RM 215.28");
    expect((screen.getByText("BIGHOME").closest("tr") as HTMLElement).textContent).toContain("RM 107.64");
  });
});
