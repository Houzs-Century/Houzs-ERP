/* The event's TWO P&Ls side by side (owner 2026-10-16): by the Total Sales he
 * keys, and by the Sales Orders opened at the fair. The figures are the
 * server's; the table lays them out, says where each came from, and lets the
 * typed rows be set in the Total Sales column only. */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventPnlTable } from "./EventPnlTable";
import type { EventPnl, PnlColumn } from "./types";
import type { DetailForecast, LineSource } from "./forecastLayers";

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
    render(<EventPnlTable pnl={PNL} editable={() => undefined} busyCategory={null} books={new Set()} layers={null} onForecast={null} />);
    expect(screen.getByRole("columnheader", { name: "By Total Sales" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "By Sales Orders (8)" })).toBeTruthy();
  });

  it("says where each figure came from", () => {
    render(<EventPnlTable pnl={PNL} editable={() => undefined} busyCategory={null} books={new Set()} layers={null} onForecast={null} />);
    expect(within(rowOf("Total Sales")).getByText("Total Sales box")).toBeTruthy();
    expect(within(rowOf("COGS Total")).getByText("est. at the orders' cost 38.4%")).toBeTruthy();
    expect(within(rowOf("COGS Total")).getByText("orders' cost")).toBeTruthy();
    expect(within(rowOf("Commission")).getAllByText("15% of sales · boost")).toHaveLength(2);
  });

  it("a typed row is set in the Total Sales column; the orders' column is never typed into", () => {
    const onSave = vi.fn(async () => undefined);
    render(<EventPnlTable pnl={PNL} editable={(category) => (category === "rental" ? { onSave } : undefined)} busyCategory={null} books={new Set()} layers={null} onForecast={null} />);
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
    render(<EventPnlTable pnl={{ ...PNL, by_so: null, so_count: 0 }} editable={() => undefined} busyCategory={null} books={new Set()} layers={null} onForecast={null} />);
    expect(screen.getByRole("columnheader", { name: "By Sales Orders" })).toBeTruthy();
    expect(within(rowOf("Total Sales")).getByText("no order opened")).toBeTruthy();
  });

  it("a row Finance filled is marked 入账", () => {
    render(<EventPnlTable pnl={PNL} editable={() => undefined} busyCategory={null} books={new Set(["rental"])} layers={null} onForecast={null} />);
    expect(within(rowOf("Rental")).getByText("Booked")).toBeTruthy();
  });
});

/* THREE LAYERS (owner 2026-11-18): the Total Sales column shows each line's
 * best figure so far, tagged; a line's Forecast is set or cleared from its label. */
const line = (amount: number, source: LineSource, forecast: number | null = null, last_event: number | null = null) => ({ amount, source, forecast, last_event });
const LAYERS: DetailForecast = {
  uses_last_event: true,
  lines: {
    sales: line(90000, "forecast", 90000, 100000),
    cogs_matt_sofa: line(30000, "last_event", null, 30000),
    cogs_bedframe: line(0, "actual"),
    cogs_accessories: line(0, "actual"),
    rental: line(15000, "actual", 11000, 12000),
    setup: line(3000, "last_event", null, 3000),
    transport_fee: line(0, "actual"),
    transport_setup_dismantle: line(0, "actual"),
    commission: line(0, "actual"),
    merchandise: line(0, "actual"),
    others: line(0, "actual"),
  },
  totals: {
    cogs_total: { amount: 30000, estimated: true },
    gross_profit: { amount: 60000, estimated: true },
    total_cost: { amount: 48000, estimated: true },
    net_profit: { amount: 42000, estimated: true },
  },
  split: { sales: { actual: 0, forecast: 90000, last_event: 0 }, cost: { actual: 15000, forecast: 0, last_event: 33000 }, net: { actual: -15000, forecast: 90000, last_event: -33000 } },
  estimated: true,
  last_event: { id: 7, code: "EXPO-2026-06", name: "Expo June", start_date: "2026-06-01" },
  last_event_error: null,
};
const FUTURE: EventPnl = {
  by_sales: col({ sales: 0, salesFrom: "none", cogs: { mattSofa: 0, bedframe: 0, accessories: 0, other: 0, total: 0, from: "none" }, rental: 15000 }),
  by_so: null,
  so_count: 0,
};

describe("EventPnlTable — three layers", () => {
  it("tags a Forecast and a Last event figure; an actual carries no tag", () => {
    render(<EventPnlTable pnl={FUTURE} editable={() => undefined} busyCategory={null} books={new Set()} layers={LAYERS} onForecast={null} />);
    const sales = within(rowOf("Total Sales")).getAllByRole("cell")[0]!;
    expect(sales.textContent).toContain("90,000");
    expect(within(sales).getByText("Forecast")).toBeTruthy();
    expect(within(within(rowOf("COGS — Matt/Sofa")).getAllByRole("cell")[0]!).getByText("Last event")).toBeTruthy();
    const rental = within(rowOf("Rental")).getAllByRole("cell")[0]!;
    expect(rental.textContent).toContain("15,000");
    expect(within(rental).queryByText("Forecast")).toBeNull();
    expect(within(rental).queryByText("Last event")).toBeNull();
  });

  it("totals come from the shown lines and say they include estimates", () => {
    render(<EventPnlTable pnl={FUTURE} editable={() => undefined} busyCategory={null} books={new Set()} layers={LAYERS} onForecast={null} />);
    const np = within(rowOf("Net Profit")).getAllByRole("cell")[0]!;
    expect(np.textContent).toContain("42,000");
    expect(np.textContent).toContain("incl. estimates");
    expect(within(rowOf("Total Cost")).getAllByRole("cell")[0]!.textContent).toContain("48,000");
  });

  it("no forecast control for a caller who may not set one", () => {
    render(<EventPnlTable pnl={FUTURE} editable={() => undefined} busyCategory={null} books={new Set()} layers={LAYERS} onForecast={null} />);
    expect(screen.queryByText("+ Forecast")).toBeNull();
  });

  it("sets a line's Forecast from its label", async () => {
    const onForecast = vi.fn(async () => undefined);
    render(<EventPnlTable pnl={FUTURE} editable={() => undefined} busyCategory={null} books={new Set()} layers={LAYERS} onForecast={onForecast} />);
    fireEvent.click(within(rowOf("Setup")).getByText("+ Forecast"));
    fireEvent.change(screen.getByLabelText("Forecast amount"), { target: { value: "4,500" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onForecast).toHaveBeenCalledWith("setup", 4500));
  });

  it("clears a line's Forecast", async () => {
    const onForecast = vi.fn(async () => undefined);
    render(<EventPnlTable pnl={FUTURE} editable={() => undefined} busyCategory={null} books={new Set()} layers={LAYERS} onForecast={onForecast} />);
    fireEvent.click(within(rowOf("Total Sales")).getByRole("button", { name: /^Forecast RM/ }));
    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => expect(onForecast).toHaveBeenCalledWith("sales", null));
  });

  it("shows the failure when the save is refused", async () => {
    const onForecast = vi.fn(async () => { throw new Error("You don't have permission to view financial information."); });
    render(<EventPnlTable pnl={FUTURE} editable={() => undefined} busyCategory={null} books={new Set()} layers={LAYERS} onForecast={onForecast} />);
    fireEvent.click(within(rowOf("Setup")).getByText("+ Forecast"));
    fireEvent.change(screen.getByLabelText("Forecast amount"), { target: { value: "100" } });
    fireEvent.click(screen.getByText("Save"));
    expect((await screen.findByRole("alert")).textContent).toContain("permission");
  });

  it("refuses a bad amount without calling the server", () => {
    const onForecast = vi.fn(async () => undefined);
    render(<EventPnlTable pnl={FUTURE} editable={() => undefined} busyCategory={null} books={new Set()} layers={LAYERS} onForecast={onForecast} />);
    fireEvent.click(within(rowOf("Setup")).getByText("+ Forecast"));
    fireEvent.change(screen.getByLabelText("Forecast amount"), { target: { value: "-5" } });
    fireEvent.click(screen.getByText("Save"));
    expect(screen.getByRole("alert").textContent).toContain("negative");
    expect(onForecast).not.toHaveBeenCalled();
  });
});
