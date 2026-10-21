/* Project Overview's project table and what the page keeps (owner 2026-10-21):
   the choices live in the URL — Back keeps them, the menu link starts plain —
   and the table keeps every cost, readably. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { OvProject } from "./projectOverviewModel";

const keyed = (o: Partial<OvProject["keyed"]>): OvProject["keyed"] => ({
  income: 0, cogs: 0, rental: 0, commission: 0, setup: 0, transport: 0, merchandise: 0, other: 0,
  cogsMattSofa: 0, cogsBedframe: 0, cogsAccessories: 0, transportFee: 0, transportSetup: 0, ...o,
});
const project = (o: Partial<OvProject>): OvProject => ({
  id: 1, code: "P1", name: "Fair", brand: "AKEMI", organizer: "MYHOME", venue: "MV", state: "Selangor", stage: "confirmed",
  startDate: "2026-10-16", endDate: "2026-10-18", eventType: "Exhibition", keyed: keyed({}),
  salesOrders: { sen: 0, costSen: 0, count: 0, costSplit: { mattSofa: 0, bedframe: 0, accessories: 0 } },
  chatReport: null, pnl: null, collection: { totalSen: 0, paidSen: 0 }, ...o,
});

const PROJECTS: OvProject[] = [
  project({
    id: 361, name: "Selangor [AKEMI] MYHOME @ SUNWAY PYRAMID CONVENTION CENTRE", venue: "SUNWAY PYRAMID CONVENTION CENTRE",
    keyed: keyed({ income: 138358, cogs: 60608.18, rental: 38400, commission: 19370.12, transport: 5534.32, merchandise: 2767.16 }),
    collection: { totalSen: 13_835_800, paidSen: 9_074_900 },
  }),
  project({
    id: 2260, name: "KUALA LUMPUR [AKEMI] HOMELOVE @ MID VALLEY", organizer: "HOMELOVE", venue: "MID VALLEY", state: "Kuala Lumpur",
    startDate: "2026-10-15", endDate: "2026-10-18",
    keyed: keyed({ income: 196248, cogs: 83712.16, rental: 84000, commission: 27474.72, transport: 7849.92, merchandise: 3924.96 }),
    collection: { totalSen: 19_624_800, paidSen: 15_495_500 },
  }),
  project({
    id: 2267, name: "PUTRAJAYA [ZANOTTI] HOMELOVE @ IOIGECC", brand: "ZANOTTI", organizer: "HOMELOVE", venue: "IOIGECC", state: "Putrajaya",
    startDate: "2026-10-09", endDate: "2026-10-11",
    keyed: keyed({ income: 12930, cogs: 5580, rental: 18000, commission: 1680.9, transport: 646.5, merchandise: 258.6 }),
  }),
];

vi.mock("../../hooks/useQuery", () => ({
  useQuery: (key: string) => ({
    data: key === "/api/projects/overview" ? { projects: PROJECTS } : null,
    loading: false, fetching: false, placeholder: false, error: null, reload: () => {},
  }),
}));
vi.mock("../../components/scm-v2/Charts", async (orig) => ({
  ...(await orig<typeof import("../../components/scm-v2/Charts")>()),
  Columns: () => null,
}));
vi.mock("./ProjectOverviewParts", () => ({ ProjectStuckPanel: () => null, ProjectDataGapsPanel: () => null }));

import { ProjectOverviewPage } from "./ProjectOverviewPage";

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.search}</output>;
}
const show = (search: string) => render(
  <MemoryRouter initialEntries={[`/projects${search}`]}><ProjectOverviewPage /><Where /></MemoryRouter>,
);
const PERIOD = "?view=finances&af_from=2026-10-01&af_to=2026-10-31";
const projectsTable = () => screen.getByText("Sales Orders daily?").closest("table") as HTMLTableElement;
const titles = () => [...projectsTable().querySelectorAll("tbody tr td:first-child > div:first-child")].map((d) => d.firstChild?.textContent);

describe("Project Overview — the project table", () => {
  it("keeps every cost, groups the columns, names each project on two lines and shows a dash for nothing", () => {
    show(PERIOD);
    const table = projectsTable();
    for (const g of ["Sales", "Gross profit", "Event costs", "Result", "Collected"]) expect(within(table).getAllByText(g).length).toBeGreaterThan(0);
    for (const c of ["Rental", "Setup", "Transport", "Commission", "Merchandise", "Others"]) expect(within(table).getByText(c)).toBeTruthy();
    const row = within(table).getByText("[AKEMI] MYHOME").closest("tr") as HTMLTableRowElement;
    expect(row.textContent).toContain("SUNWAY PYRAMID CONVENTION CENTRE · Selangor · 10/16 - 10/18");
    expect(row.textContent).toContain("138,358.00");
    expect(row.textContent).not.toContain("RM ");
    /* Setup and Others: nothing — a dash. */
    expect([...row.querySelectorAll("td")].filter((td) => td.textContent === "–")).toHaveLength(3); // Service, Setup, Others
    const loss = within(table).getByText("-10,713.76");
    expect(loss.className).toContain("text-err");
  });

  it("the sort is read from the URL and written back to it — Back keeps it", () => {
    show(`${PERIOD}&ao_sort=sales`);
    expect(titles()).toEqual(["[AKEMI] HOMELOVE", "[AKEMI] MYHOME", "[ZANOTTI] HOMELOVE"]);
    expect(screen.getByRole("button", { name: "Sales" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Newest" }));
    expect(screen.getByTestId("where").textContent).toBe(PERIOD);
    expect(titles()).toEqual(["[AKEMI] MYHOME", "[AKEMI] HOMELOVE", "[ZANOTTI] HOMELOVE"]);
    fireEvent.click(screen.getByRole("button", { name: "Net profit" }));
    expect(screen.getByTestId("where").textContent).toBe(`${PERIOD}&ao_sort=np`);
  });

  it("a filter lives in the URL too; the plain menu link has none", () => {
    show(`${PERIOD}&ao_brand=ZANOTTI`);
    expect((screen.getByLabelText("Brand") as HTMLSelectElement).value).toBe("ZANOTTI");
    expect(titles()).toEqual(["[ZANOTTI] HOMELOVE"]);
    fireEvent.change(screen.getByLabelText("Brand"), { target: { value: "" } });
    expect(screen.getByTestId("where").textContent).toBe(PERIOD);
    expect(screen.getByText("[AKEMI] MYHOME")).toBeTruthy();
  });
});
