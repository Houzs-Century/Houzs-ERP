/* The event's TWO P&Ls side by side (owner 2026-10-16): by the Total Sales he
 * keys, and by the Sales Orders opened at the fair. The figures are the
 * server's; the table lays them out, says where each came from, and lets the
 * typed rows be set in the Total Sales column only. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventPnlTable } from "./EventPnlTable";
import type { EventPnl, PnlColumn } from "./types";

const col = (over: Partial<PnlColumn> = {}): PnlColumn => ({
  sales: 114240, salesFrom: "box",
  cogs: { mattSofa: 36969.3, bedframe: 0, accessories: 6851.6, other: 0, total: 43820.9, from: "so_ratio" },
  rental: 9800, setup: 0, transportSetupDismantle: 0, others: 0, serviceRevenue: 0,
  transportFee: { amount: 5712, from: "rate", pct: 5, serviceCost: 0 },
  commission: { amount: 17136, from: "rate", pct: 15, boost: true },
  merchandise: { amount: 2284.8, from: "rate", pct: 2 },
  totalCost: 78753.7, grossProfit: 70419.1, netProfit: 35486.3,
  ...over,
});
const PNL: EventPnl = {
  by_sales: col(),
  by_so: col({
    sales: 46352, salesFrom: "so",
    cogs: { mattSofa: 15000, bedframe: 0, accessories: 2780, other: 0, total: 17780, from: "so" },
    transportFee: { amount: 2317.6, from: "rate", pct: 5, serviceCost: 0 },
  }),
  so_count: 8,
};

const rowOf = (label: string) => screen.getByRole("rowheader", { name: new RegExp(`^${label}`) }).closest("tr") as HTMLElement;

describe("EventPnlTable — two P&Ls", () => {
  it("heads the columns By Total Sales and By Sales Orders (n)", () => {
    render(<EventPnlTable pnl={PNL} editable={() => undefined} busyCategory={null} books={new Set()} />);
    expect(screen.getByRole("columnheader", { name: "By Total Sales" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "By Sales Orders (8)" })).toBeTruthy();
  });

  it("says where each figure came from", () => {
    render(<EventPnlTable pnl={PNL} editable={() => undefined} busyCategory={null} books={new Set()} />);
    expect(within(rowOf("Total Sales")).getByText("Total Sales box")).toBeTruthy();
    expect(within(rowOf("COGS Total")).getByText("est. at the orders' cost 38.4%")).toBeTruthy();
    expect(within(rowOf("COGS Total")).getByText("orders' cost")).toBeTruthy();
    expect(within(rowOf("Commission")).getAllByText("15% of sales · boost")).toHaveLength(2);
  });

  it("a typed row is set in the Total Sales column; the orders' column is never typed into", () => {
    const onSave = vi.fn(async () => undefined);
    render(<EventPnlTable pnl={PNL} editable={(category) => (category === "rental" ? { onSave } : undefined)} busyCategory={null} books={new Set()} />);
    const cells = within(rowOf("Rental")).getAllByRole("cell");
    fireEvent.click(cells[1]!);
    expect(within(cells[1]!).queryByRole("spinbutton")).toBeNull();
    fireEvent.click(cells[0]!);
    const input = within(cells[0]!).getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "12000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith(12000);
  });

  it("no order opened: the orders' column shows nothing to read", () => {
    render(<EventPnlTable pnl={{ ...PNL, by_so: null, so_count: 0 }} editable={() => undefined} busyCategory={null} books={new Set()} />);
    expect(screen.getByRole("columnheader", { name: "By Sales Orders" })).toBeTruthy();
    expect(within(rowOf("Total Sales")).getByText("no order opened")).toBeTruthy();
  });

  it("a row Finance filled is marked 入账", () => {
    render(<EventPnlTable pnl={PNL} editable={() => undefined} busyCategory={null} books={new Set(["rental"])} />);
    expect(within(rowOf("Rental")).getByText("入账")).toBeTruthy();
  });
});
