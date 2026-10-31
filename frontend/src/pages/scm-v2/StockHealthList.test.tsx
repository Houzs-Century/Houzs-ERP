/* Owner 2026-10-31: the dead / buffer table showed 40 of 717 rows, with no sort or export. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const rows = Array.from({ length: 120 }, (_, i) => ({ warehouse: i % 2 ? "KL WAREHOUSE" : "PG WAREHOUSE", category: "MATTRESS", itemCode: `ITEM-${String(i).padStart(3, "0")}`, variantKey: "", name: null, qty: i + 1, valueSen: (i + 1) * 100, idleDays: i }));
vi.mock("../../vendor/scm/lib/authed-fetch", () => ({ authedFetch: vi.fn(async () => ({ dead: rows, buffer: [] })) }));
const { StockHealthList, stockHealthSheet } = await import("./StockHealthList");

const mount = (warehouse: string | null = null) => render(<QueryClientProvider client={new QueryClient()}><StockHealthList kind="dead" query="x=1" catLabel={(k) => k} category={null} warehouse={warehouse} /></QueryClientProvider>);

describe("StockHealthList", () => {
  it("lists every row and sorts by a clicked header", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("120 rows · RM 7,260.00")).toBeTruthy());
    expect(document.querySelectorAll("tbody tr").length).toBe(120);
    fireEvent.click(screen.getByText(/Dead qty/));
    const first = () => (document.querySelector("tbody tr td") as HTMLElement).textContent;
    const a = first();
    fireEvent.click(screen.getByText(/Dead qty/));
    expect(first()).not.toBe(a);
  });
  it("search narrows the rows", async () => {
    mount();
    await waitFor(() => expect(document.querySelectorAll("tbody tr").length).toBe(120));
    fireEvent.change(screen.getByLabelText("Search these rows"), { target: { value: "ITEM-007" } });
    expect(document.querySelectorAll("tbody tr").length).toBe(1);
  });
  it("a location clicked above narrows the list to its rows (owner 2026-11-01)", async () => {
    mount("KL WAREHOUSE");
    await waitFor(() => expect(document.querySelectorAll("tbody tr").length).toBe(60));
    expect([...document.querySelectorAll("tbody tr")].every((tr) => tr.textContent?.includes("KL WAREHOUSE"))).toBe(true);
  });
  it("the Excel sheet carries ringgit, not sen", () => {
    const sheet = stockHealthSheet([rows[0]!], [{ k: "value", label: "Value", value: (r) => r.valueSen, show: () => "" }]);
    expect(sheet[0]).toEqual({ Value: 1 });
  });
});
