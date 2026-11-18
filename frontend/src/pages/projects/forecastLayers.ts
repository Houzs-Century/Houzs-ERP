// The three-layer Financial Snapshot (owner 2026-11-18) — the shape the server
// sends (backend services/eventForecast.ts + eventForecastLoad.ts) and the one
// save both the desktop table and the phone use. Every figure is the server's;
// this only names the lines and tags, and sets / clears a Forecast.
import { api } from "../../api/client";

export const FORECAST_LINES = [
  "sales", "cogs_matt_sofa", "cogs_bedframe", "cogs_accessories", "rental", "setup",
  "transport_fee", "transport_setup_dismantle", "commission", "merchandise", "others",
] as const;
export type ForecastLine = (typeof FORECAST_LINES)[number];
export type LineSource = "actual" | "forecast" | "last_event";

export const FORECAST_LINE_LABELS: Record<ForecastLine, string> = {
  sales: "Total Sales",
  cogs_matt_sofa: "COGS — Matt/Sofa",
  cogs_bedframe: "COGS — Bedframe",
  cogs_accessories: "COGS — Accessories",
  rental: "Rental",
  setup: "Setup",
  transport_fee: "Transport Fee",
  transport_setup_dismantle: "Transport Setup & Dismantle",
  commission: "Commission",
  merchandise: "Merchandise",
  others: "Others Costing",
};

export interface LayeredLine { amount: number; source: LineSource; forecast: number | null; last_event: number | null }
export interface LayeredTotal { amount: number; estimated: boolean }
export interface LayerSplit { actual: number; forecast: number; last_event: number }

export interface DetailForecast {
  uses_last_event: boolean;
  lines: Record<ForecastLine, LayeredLine>;
  totals: { cogs_total: LayeredTotal; gross_profit: LayeredTotal; total_cost: LayeredTotal; net_profit: LayeredTotal };
  split: { sales: LayerSplit; cost: LayerSplit; net: LayerSplit };
  estimated: boolean;
  last_event: { id: number; code: string | null; name: string | null; start_date: string | null } | null;
  last_event_error: string | null;
}

export interface ExpoMapFile { id: number; file_name: string; r2_key: string; item_title: string }
export interface LastEventExpoMap { last_event: { id: number; code: string | null; name: string | null }; files: ExpoMapFile[] }

/** The tag a line carries; an actual carries none. */
export function sourceTag(source: LineSource): string | null {
  /* A last event's result IS the forecast until one is typed (owner 2026-11-19),
     so both read "Forecast"; the hover says where it came from. */
  return source === "forecast" || source === "last_event" ? "Forecast" : null;
}

/** The note under a total that holds an estimate. */
export const ESTIMATE_NOTE = "incl. estimates";

/** "12,000" / "12000.50" -> RM; "" -> null (clear); anything else -> an error. */
export function parseForecastInput(text: string): { ok: true; amount: number | null } | { ok: false; error: string } {
  const t = text.replace(/,/g, "").trim();
  if (t === "") return { ok: true, amount: null };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, error: "Enter an amount in RM." };
  if (n < 0) return { ok: false, error: "The amount cannot be negative." };
  return { ok: true, amount: Math.round(n * 100) / 100 };
}

/** Set a line's Forecast, or clear it with null. Throws the server's message. */
export async function saveForecast(projectId: number, line: ForecastLine, amount: number | null): Promise<void> {
  if (amount == null) await api.del(`/api/project-forecast/${projectId}/${line}`);
  else await api.put(`/api/project-forecast/${projectId}/${line}`, { amount });
}
