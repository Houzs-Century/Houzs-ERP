// The Forecast figure a user types for a Financial Snapshot line
// (routes/projectForecast.ts): ringgit, zero or more, at most RM 100 million,
// stored as whole sen. PURE.
export const FORECAST_MAX_RM = 100_000_000;

export function parseForecastAmount(v: unknown): { ok: true; sen: number } | { ok: false; error: string } {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(/,/g, "")) : NaN;
  if (!Number.isFinite(n)) return { ok: false, error: "Enter an amount in RM." };
  if (n < 0) return { ok: false, error: "The amount cannot be negative." };
  if (n > FORECAST_MAX_RM) return { ok: false, error: "The amount is too large." };
  return { ok: true, sen: Math.round(n * 100) };
}
