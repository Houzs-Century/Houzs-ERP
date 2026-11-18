/* The phone's three-layer Financial Snapshot (owner 2026-11-18): same figures
 * and tags as the desktop table; a tap sets or clears a line's Forecast. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const put = vi.fn(async () => ({}));
const del = vi.fn(async () => ({}));
vi.mock("../api/client", () => ({ api: { put: (...a: unknown[]) => put(...(a as [])), del: (...a: unknown[]) => del(...(a as [])), fetchBlobUrl: vi.fn() } }));

import { MobileForecastLines } from "./MobilePmsForecast";
import { LastEventExpoMapBlock } from "../pages/projects/LastEventExpoMap";
import type { DetailForecast, LineSource } from "../pages/projects/forecastLayers";

const line = (amount: number, source: LineSource, forecast: number | null = null) => ({ amount, source, forecast, last_event: null });
const LAYERS: DetailForecast = {
  uses_last_event: true,
  lines: {
    sales: line(90000, "forecast", 90000), cogs_matt_sofa: line(30000, "last_event"), cogs_bedframe: line(0, "actual"),
    cogs_accessories: line(0, "actual"), rental: line(15000, "actual"), setup: line(0, "actual"), transport_fee: line(0, "actual"),
    transport_setup_dismantle: line(0, "actual"), commission: line(0, "actual"), merchandise: line(0, "actual"), others: line(0, "actual"),
  },
  totals: {
    cogs_total: { amount: 30000, estimated: true }, gross_profit: { amount: 60000, estimated: true },
    total_cost: { amount: 45000, estimated: true }, net_profit: { amount: 45000, estimated: true },
  },
  split: { sales: { actual: 0, forecast: 90000, last_event: 0 }, cost: { actual: 15000, forecast: 0, last_event: 30000 }, net: { actual: -15000, forecast: 90000, last_event: -30000 } },
  estimated: true, last_event: null, last_event_error: null,
};

describe("MobileForecastLines", () => {
  it("tags each estimate and marks the totals that include one", () => {
    render(<MobileForecastLines projectId={9} layers={LAYERS} canWrite={false} reload={() => {}} />);
    expect(screen.getByText("Forecast")).toBeTruthy();
    expect(screen.getByText("Last event")).toBeTruthy();
    expect(screen.getAllByText("incl. estimates")).toHaveLength(4);
    expect((screen.getByRole("button", { name: /^Rental/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sets and clears a Forecast, then reloads", async () => {
    const reload = vi.fn();
    render(<MobileForecastLines projectId={9} layers={LAYERS} canWrite reload={reload} />);
    fireEvent.click(screen.getByRole("button", { name: /^Setup/ }));
    fireEvent.change(screen.getByLabelText("Forecast amount"), { target: { value: "2500" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/project-forecast/9/setup", { amount: 2500 }));
    expect(reload).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Total Sales/ }));
    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/project-forecast/9/sales"));
  });

  it("shows the failure when the save is refused", async () => {
    put.mockRejectedValueOnce(new Error("Not found"));
    render(<MobileForecastLines projectId={9} layers={LAYERS} canWrite reload={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Setup/ }));
    fireEvent.change(screen.getByLabelText("Forecast amount"), { target: { value: "1" } });
    fireEvent.click(screen.getByText("Save"));
    expect((await screen.findByRole("alert")).textContent).toBe("Not found");
  });
});

describe("LastEventExpoMapBlock", () => {
  it("names the last event and lists its Expo Map files", () => {
    render(<MemoryRouter><LastEventExpoMapBlock data={{ last_event: { id: 7, code: "EXPO-0626", name: "Expo June" }, files: [
      { id: 1, file_name: "blank.pdf", r2_key: "task-attach/5/blank.pdf", item_title: "Blank Floorplan" },
      { id: 2, file_name: "filled.jpg", r2_key: "task-attach/6/filled.jpg", item_title: "Filled Floorplan" },
    ] }} /></MemoryRouter>);
    expect(screen.getByText("EXPO-0626").getAttribute("href")).toBe("/projects/7");
    expect(screen.getByText("blank.pdf")).toBeTruthy();
    expect(screen.getByText("Filled Floorplan")).toBeTruthy();
  });
});
