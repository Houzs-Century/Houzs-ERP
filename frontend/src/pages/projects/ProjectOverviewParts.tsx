// Project Overview (owner, 2026-10-16): the headline P&L of every project in a
// period, and the Monthly / Quarterly / Yearly picker that sets the period.
import { StatCard } from "../../components/StatCard";
import { Toggle, SELECT_CLS, periodAnchors, periodRange, type Gran } from "../../components/scm-v2/OverviewKit";
import { formatCurrency } from "../../lib/utils";
import { todayMyt } from "../../vendor/scm/lib/dates";
import type { ProfitabilityResponse } from "./financeViewModel";

const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");

/** Sales, COGS, GP, rental, other cost and NP, each with its share of sales. */
export function ProjectOverviewHeadline({ totals }: { totals: ProfitabilityResponse["totals"] }) {
  const t = totals;
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatCard label="Sales" value={formatCurrency(t.income)} subtitle={`${t.projects.toLocaleString()} projects`} />
      <StatCard label="COGS" value={formatCurrency(t.cogs)} subtitle={`${pct(t.cogs, t.income)} of sales`} tone="error" />
      <StatCard label="Gross profit" value={formatCurrency(t.gp)} subtitle={`GP ${pct(t.gp, t.income)}`} tone={t.gp >= 0 ? "success" : "error"} />
      <StatCard label="Rental" value={formatCurrency(t.rental)} subtitle={`${pct(t.rental, t.income)} of sales`} tone="error" />
      <StatCard label="Other cost" value={formatCurrency(t.cost - t.rental)} subtitle="Setup, transport, commission…" tone="error" />
      <StatCard label="Net profit" value={formatCurrency(t.profit)} subtitle={`NP ${pct(t.profit, t.income)}`} tone={t.profit >= 0 ? "success" : "error"} />
    </div>
  );
}

/** The period the From / To range matches, or null for a custom range. */
function matchPeriod(from: string, to: string): { gran: Gran; anchor: string } | null {
  if (!from || !to) return null;
  for (const gran of ["M", "Q", "Y"] as const) {
    const r = periodRange(gran, from);
    if (r.from === from && r.to === to) return { gran, anchor: from };
  }
  return null;
}

export function ProjectPeriodBar({ dateFrom, dateTo, onRange }: { dateFrom: string; dateTo: string; onRange: (from: string, to: string) => void }) {
  const today = todayMyt();
  const match = matchPeriod(dateFrom, dateTo);
  const gran: Gran = match?.gran ?? "Y";
  const pick = (g: Gran, anchor: string) => { const r = periodRange(g, anchor); onRange(r.from, r.to); };
  const anchors = periodAnchors(gran, today);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Toggle value={match ? gran : ("" as Gran)} options={[["M", "Monthly"], ["Q", "Quarterly"], ["Y", "Yearly"]]} onChange={(g) => pick(g, periodAnchors(g, today)[0]!)} />
      <select className={SELECT_CLS} value={match && anchors.includes(match.anchor) ? match.anchor : ""} onChange={(e) => pick(gran, e.target.value)} aria-label="Period">
        {!(match && anchors.includes(match.anchor)) && <option value="">Custom range</option>}
        {anchors.map((a) => <option key={a} value={a}>{periodRange(gran, a).label}</option>)}
      </select>
    </div>
  );
}
