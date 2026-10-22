/* Project Overview's "Books not complete" list (owner 2026-10-22: 下面写
   missing，但是上面是有amount的): a rental below zero shows its figure — the
   P&L above shows it too — and says what is wrong; only none at all is
   "missing". */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const book = (id: number, name: string, rental: number, soSen: number) => ({
  id, code: `P${id}`, name, brand: "AKEMI", endDate: "2026-09-20", soSen, soDocs: [],
  hasReport: false, reportBills: 0, problemBills: [], rental,
});
const GAPS = {
  from: "2026-06-24", to: "2026-10-19", ended: 3,
  noSales: { count: 0, costBooked: 0, soSen: 0, rows: [] },
  noCogs: { count: 0, salesAffected: 0, rows: [] },
  noCommission: { count: 0, salesAffected: 0, rows: [] },
  byMonth: [],
  books: [
    book(343, "Putrajaya [AKEMI] MALL MGT @ IOI CITY MALL PUTRAJAYA", -22950, 33_580_900),
    book(2270, "JOHOR [ERGOTEX] SOLO @ SUNWAY KLUANG MALL", 0, 370_000),
    book(2227, "PULAU PINANG [ZANOTTI] BIGHOME @ SETIA SPICE CONVENTION CENTRE", 24000, 0),
  ],
  notDaily: [], soNoCogs: [], recentFrom: "2026-06-24",
};

vi.mock("../../hooks/useQuery", () => ({
  useQuery: () => ({ data: GAPS, loading: false, fetching: false, placeholder: false, error: null, reload: () => {} }),
}));

import { ProjectDataGapsPanel } from "./ProjectOverviewParts";

describe("Books not complete — Rental missing or no sales", () => {
  it("a rental below zero shows its figure and says so; none at all is missing; keyed with no sales says that", () => {
    render(<ProjectDataGapsPanel onOpen={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Rental missing or no sales/ }));
    const row = (name: string) => (screen.getByText(name).closest("tr") as HTMLTableRowElement).textContent;
    const negative = row("Putrajaya [AKEMI] MALL MGT @ IOI CITY MALL PUTRAJAYA");
    expect(negative).toContain("22,950.00");
    expect(negative).not.toContain("missing");
    expect(negative).toContain("Rental below zero");
    expect(row("JOHOR [ERGOTEX] SOLO @ SUNWAY KLUANG MALL")).toContain("missing");
    expect(row("JOHOR [ERGOTEX] SOLO @ SUNWAY KLUANG MALL")).toContain("No rental keyed");
    expect(row("PULAU PINANG [ZANOTTI] BIGHOME @ SETIA SPICE CONVENTION CENTRE")).toContain("Rental keyed, no sales");
  });
});
