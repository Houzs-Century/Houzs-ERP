/* Project Overview's project table and what the page keeps (owner 2026-10-21):
   the choices live in the URL — Back keeps them, the menu link starts plain —
   and the table keeps every cost, readably. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OvProject } from "./projectOverviewModel";

const keyed = (o: Partial<OvProject["keyed"]>): OvProject["keyed"] => ({
  income: 0, cogs: 0, rental: 0, commission: 0, setup: 0, transport: 0, merchandise: 0, other: 0,
  cogsMattSofa: 0, cogsBedframe: 0, cogsAccessories: 0, transportFee: 0, transportSetup: 0, ...o,
});
const project = (o: Partial<OvProject>): OvProject => ({
  id: 1, code: "P1", name: "Fair", brand: "AKEMI", organizer: "MYHOME", venue: "MV", state: "Selangor", stage: "confirmed",
  startDate: "2026-10-16", endDate: "2026-10-18", eventType: "Exhibition", sizeSqm: null, keyed: keyed({}),
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
  /* A future event (owner 2026-11-18): its figures are a typed Forecast and the
     last same-venue event's actuals, already layered by the server. */
  project({
    id: 3001, name: "Selangor [AKEMI] MYHOME @ MITEC", venue: "MITEC", startDate: "2027-01-10", endDate: "2027-01-12",
    pnl: {
      fromOrders: false, sales: 90000, serviceRevenue: 0, cogs: { mattSofa: 30000, bedframe: 0, accessories: 0, other: 0 },
      rental: 12000, setup: 0, transportSetup: 0, others: 0, transportFee: 0, commission: 0, merchandise: 0,
      layers: { estimated: true, lastEvent: { id: 361, code: "P1" }, sources: { sales: "forecast", cogs_matt_sofa: "last_event", rental: "last_event" }, split: {
        sales: { actual: 0, forecast: 90000, last_event: 0 },
        cost: { actual: 0, forecast: 0, last_event: 42000 },
        net: { actual: 0, forecast: 90000, last_event: -42000 },
      } },
    },
  }),
];

vi.mock("../../hooks/useQuery", () => ({
  useQuery: (key: string) => ({
    data: key === "/api/projects/overview" ? { projects: PROJECTS } : null,
    loading: false, fetching: false, placeholder: false, error: null, reload: () => {},
  }),
  buildQueryKey: (key: string) => ["uq", key],
}));
vi.mock("../../components/scm-v2/Charts", async (orig) => ({
  ...(await orig<typeof import("../../components/scm-v2/Charts")>()),
  Columns: () => null,
}));
vi.mock("./ProjectOverviewParts", () => ({ ProjectStuckPanel: () => null, ProjectDataGapsPanel: () => null }));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectOverviewPage } from "./ProjectOverviewPage";
import { projectBackTo } from "./projectOverviewView";

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.search}</output>;
}
const show = (search: string) => render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter initialEntries={[`/projects${search}`]}><ProjectOverviewPage /><Where /></MemoryRouter>
  </QueryClientProvider>,
);
const PERIOD = "?view=finances&af_from=2026-10-01&af_to=2026-10-31";
const projectsTable = () => screen.getByText("Sales Orders Daily?").closest("table") as HTMLTableElement;
const titles = () => [...projectsTable().querySelectorAll("tbody tr span.text-primary")].map((d) => d.textContent);

/* Owner 2026-11-05 (这个我要做成 finance table): the shared Finance table — widths,
   moving a column, the right-click header menu and the column chooser are DataTable's
   own (its tests pin them); here, what this table puts in it. */
describe("Project Overview — the project table", () => {
  it("keeps every cost, gives Project / Event type / Venue / State / Start / End their own columns, and money as 1,234.56 / (1,234.56)", () => {
    show(PERIOD);
    const table = projectsTable();
    for (const c of ["Project", "Event Type", "Venue", "State", "Start", "End", "Rental", "Setup", "Transport", "Commission", "Merchandise", "Others", "Net Profit"]) {
      expect(within(table).getByText(c)).toBeTruthy();
    }
    const row = within(table).getByText("[AKEMI] MYHOME").closest("tr") as HTMLTableRowElement;
    const cells = [...row.querySelectorAll("td")].map((td) => td.textContent);
    expect(cells).toContain("SUNWAY PYRAMID CONVENTION CENTRE");
    expect(cells).toContain("Selangor");
    expect(cells).toContain("138,358.00");
    expect(row.textContent).not.toContain("RM ");
    expect(within(table).getByText("[AKEMI] MYHOME").className.split(" ")).toContain("whitespace-nowrap");
    const loss = within(table).getByText("(10,713.76)");
    expect(loss.className).toContain("text-err");
  });

  /* Owner 2026-10-25: 这个表需要有total, 然后把venue rent 和 project 倒反位置. */
  it("adds a Total row: each column summed, the % worked out from the sums, and comes before Venue rent", () => {
    show(PERIOD);
    const table = projectsTable();
    const total = within(table).getByText("Total · 3 projects");
    const foot = total.closest("tr") as HTMLTableRowElement;
    expect(foot.textContent).toContain("347,536.00");
    expect(foot.textContent).toContain("(12,271.54)");
    expect(foot.textContent).toContain("245,704.00");
    expect(foot.textContent).toContain("73.4%");
    const venueRent = screen.getByText("Venue rent");
    expect(table.compareDocumentPosition(venueRent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists the newest first", () => {
    show(PERIOD);
    expect(titles()).toEqual(["[AKEMI] MYHOME", "[AKEMI] HOMELOVE", "[ZANOTTI] HOMELOVE"]);
  });

  /* Owner 2026-11-12: 「这些其他不可以filter?」 — only Project, Event type, Venue and
     State had the header's filter and sort; Dates and the figures had neither. */
  it("Start / End and the figures filter and sort from their headers too: a range for the dates, a minimum and maximum for a figure", () => {
    show(PERIOD);
    const table = projectsTable();
    for (const c of [
      "Project", "Event type", "Venue", "State", "Start", "End", "Sales", "Service", "COGS", "GP", "GP %", "Rental", "Setup", "Transport",
      "Commission", "Merchandise", "Others", "Net profit", "NP %", "Collected", "Collected %",
    ]) {
      expect(within(table).getByRole("button", { name: `Filter & sort ${c}` })).toBeTruthy();
    }

    fireEvent.click(within(table).getByText("Sales"));
    expect(titles()).toEqual(["[ZANOTTI] HOMELOVE", "[AKEMI] MYHOME", "[AKEMI] HOMELOVE"]);

    fireEvent.click(within(table).getByRole("button", { name: "Filter & sort Sales" }));
    expect(screen.getAllByText("138,358.00").length).toBe(2);
    fireEvent.change(screen.getByLabelText("Minimum"), { target: { value: "100000" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(titles()).toEqual(["[AKEMI] MYHOME", "[AKEMI] HOMELOVE"]);
    expect(within(projectsTable()).getByText("Total · 2 projects")).toBeTruthy();

    fireEvent.click(within(projectsTable()).getByRole("button", { name: "Filter & sort Start" }));
    expect(screen.getByLabelText("From date")).toBeTruthy();
    expect(screen.getByRole("button", { name: "This Month" })).toBeTruthy();
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

/* Owner 2026-10-21: 我点9月的project，按 back 后又跳回10月，然后会跑回最上面 —
   the project page's Back went to the bare /projects, which opens on this month. */
describe("Project Overview — a project's Back comes back here", () => {
  it("opening a project notes this address, the period with it, for that project's Back", () => {
    show(PERIOD);
    fireEvent.click(within(projectsTable()).getByText("[AKEMI] MYHOME"));
    expect(projectBackTo(361)).toBe(`/projects${PERIOD}`);
    expect(projectBackTo(2260)).toBe("/projects");
  });
});

describe("Project Overview — future date ranges (owner 2026-11-18)", () => {
  it("a range past today lists the future event, tags its estimate and splits the totals by layer", () => {
    show("?view=finances&af_from=2027-01-01&af_to=2027-03-31");
    expect(titles()).toHaveLength(1);
    const row = within(projectsTable()).getByText("[AKEMI] MYHOME").closest("tr") as HTMLTableRowElement;
    /* No tag; its forecast figures are shaded (owner 2026-11-19). */
    expect(within(row).queryByText("Estimate")).toBeNull();
    expect(within(row).getByText("90,000.00").getAttribute("data-forecast")).toBe("typed");
    expect(within(row).getByText("12,000.00").getAttribute("data-forecast")).toBe("last");
    expect(within(projectsTable()).getAllByText("90,000.00").some((el) => el.getAttribute("title")?.startsWith("Typed forecast 90,000.00 · last event -"))).toBe(true);
    const split = screen.getByTestId("layer-split");
    expect(split.textContent).toContain("1 of 1 projects include a forecast");
    /* A last event's result is a forecast (owner 2026-11-19): two columns, not three. */
    for (const h of ["Actual", "Forecast"]) expect(within(split).getByText(h)).toBeTruthy();
    expect(within(split).queryByText("Last event")).toBeNull();
    const sales = within(split).getByText("Sales").closest("tr") as HTMLTableRowElement;
    expect(sales.textContent).toContain("90,000");
  });

  it("a past period has no layer split when nothing in it is an estimate", () => {
    show(PERIOD);
    expect(screen.queryByTestId("layer-split")).toBeNull();
  });
});

describe("Project Overview - the hero follows the part picked (owner 2026-11-19)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-19T04:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("Still to come narrows the big figures to the events after today", () => {
    show("?view=finances&af_from=2026-10-01&af_to=2027-01-31&af_part=coming");
    expect(screen.getByText(/still to come · 1 projects/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Still to come/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("Projected total shows every event in the period", () => {
    show("?view=finances&af_from=2026-10-01&af_to=2027-01-31");
    expect(screen.queryByText(/still to come · /)).toBeNull();
    expect(screen.getByRole("button", { name: /^Projected total/ }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Project Overview - fits a phone (owner 2026-11-19)", () => {
  it("the panel grid lets wide tables scroll inside their panel, and the layer split has no fixed width", () => {
    const { container } = show("?view=finances&af_from=2027-01-01&af_to=2027-03-31");
    const grid = [...container.querySelectorAll("div")].find((d) => d.className.includes("xl:grid-cols-"));
    expect(grid?.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(screen.getByTestId("layer-split").querySelector("table")?.className).not.toMatch(/min-w-/);
  });
});

describe("Project Overview - the ringgit table scrolls on a phone (owner 2026-11-19)", () => {
  it("sits in its own sideways-scrolling box", () => {
    show("?view=finances&af_from=2027-01-01&af_to=2027-03-31");
    expect(screen.getByTestId("ringgit-table").className).toContain("overflow-x-auto");
  });
});
