/* Procurement Overview · which supplier delays most (owner 2026-11-01: a
   scoring system; "不能都做吗？ ... 整合一下"). One table: the score is the
   headline, and the three ways of judging delay are its columns, any of which
   ranks the table:
     A. what is late now, in money × days;
     B. the score, 0–100;
     C. on time, the share of lines received by the date on the PO. */
import { useMemo } from "react";
import { fmtSen } from "../../vendor/shared/format";
import { cn } from "../../lib/utils";
import { SortTh, Td, useTableSort } from "../../components/scm-v2/OverviewKit";

export type ScoreGroup = {
  key: string;
  open: { sen: number; late: number; lateSen: number };
  supplierLead: { receipts: number; onTimePct: number | null; avgDaysLate: number | null };
};
export type LateLine = { supplier: string; openQty: number; openSen: number; daysLate: number | null };

/** Receipts in the period below this make the score a guess; it is shown greyed. */
export const MIN_SCORE_RECEIPTS = 10;
const WEIGHTS = { onTime: 40, lateness: 20, overdue: 30, quality: 10 } as const;
const clamp = (x: number) => Math.max(0, Math.min(100, x));

export type Score = {
  key: string; score: number | null; onTimePct: number | null; avgDaysLate: number | null;
  lateSen: number; lateLines: number; overdueSharePct: number | null; senDays: number; qualityPct: number | null; receipts: number;
};

/** The score: on time 40, how late when late 20 (10 days late scores 0), the
 *  share of what is still to come that is past its date 30, quality cases per
 *  100 received 10 (20 per 100 scores 0). A part with no data is left out and
 *  the rest re-weighted, so a supplier is not marked down for what nobody knows. */
export function scoreSupplier(g: ScoreGroup, lateLines: readonly LateLine[], qualityPct: number | null): Score {
  const mine = lateLines.filter((l) => l.supplier === g.key && l.openQty > 0 && (l.daysLate ?? 0) > 0);
  const senDays = mine.reduce((a, l) => a + l.openSen * (l.daysLate ?? 0), 0);
  const lead = g.supplierLead;
  const parts: Array<[number, number | null]> = [
    [WEIGHTS.onTime, lead.receipts > 0 ? lead.onTimePct : null],
    [WEIGHTS.lateness, lead.receipts > 0 ? (lead.avgDaysLate == null ? 100 : clamp(100 - lead.avgDaysLate * 10)) : null],
    [WEIGHTS.overdue, g.open.sen > 0 ? clamp(100 - (g.open.lateSen / g.open.sen) * 100) : null],
    [WEIGHTS.quality, qualityPct == null ? null : clamp(100 - qualityPct * 5)],
  ];
  const known = parts.filter((p): p is [number, number] => p[1] != null);
  const weight = known.reduce((a, [w]) => a + w, 0);
  return {
    key: g.key,
    score: weight ? Math.round(known.reduce((a, [w, v]) => a + w * v, 0) / weight) : null,
    onTimePct: lead.receipts > 0 ? lead.onTimePct : null,
    avgDaysLate: lead.avgDaysLate,
    lateSen: g.open.lateSen, lateLines: g.open.late,
    overdueSharePct: g.open.sen > 0 ? Math.round((g.open.lateSen / g.open.sen) * 100) : null,
    senDays, qualityPct, receipts: lead.receipts,
  };
}

/** Supplier names as both reports spell them, so the quality rate finds its row. */
export const supplierKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function SupplierScorecard({ groups, lines, quality, onPick }: {
  groups: readonly ScoreGroup[]; lines: readonly LateLine[];
  quality: ReadonlyMap<string, number> | null; onPick: (supplier: string) => void;
}) {
  const rows = useMemo(() => groups
    .filter((g) => g.supplierLead.receipts > 0 || g.open.sen > 0)
    .map((g) => scoreSupplier(g, lines, quality?.get(supplierKey(g.key)) ?? null)), [groups, lines, quality]);
  const { sorted, sort, toggle } = useTableSort(rows, (r, k) => (r as unknown as Record<string, number | string | null>)[k] ?? null);
  /* Worst first until a header is clicked. */
  const shown = sort ? sorted : [...rows].sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
  const tone = (s: number | null) => (s == null ? "text-ink-muted" : s < 60 ? "text-err" : s < 80 ? "text-warning-text" : "text-synced");

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead><tr>
          <SortTh left k="key" sort={sort} onSort={toggle}>Supplier</SortTh>
          <SortTh k="score" sort={sort} onSort={toggle}>Score</SortTh>
          <SortTh k="onTimePct" sort={sort} onSort={toggle}>On time</SortTh>
          <SortTh k="avgDaysLate" sort={sort} onSort={toggle}>Late by (avg)</SortTh>
          <SortTh k="lateSen" sort={sort} onSort={toggle}>Overdue now</SortTh>
          <SortTh k="overdueSharePct" sort={sort} onSort={toggle}>Overdue share</SortTh>
          <SortTh k="senDays" sort={sort} onSort={toggle}>Overdue RM × days</SortTh>
          <SortTh k="qualityPct" sort={sort} onSort={toggle}>Quality cases</SortTh>
          <SortTh k="receipts" sort={sort} onSort={toggle}>Lines received</SortTh>
        </tr></thead>
        <tbody>{shown.map((r) => {
          const few = r.receipts < MIN_SCORE_RECEIPTS;
          return (
            <tr key={r.key} onClick={() => onPick(r.key)} className="cursor-pointer hover:bg-surface-2/50">
              <Td left className="max-w-[240px] truncate">{r.key}</Td>
              <Td className={cn("font-semibold", few ? "text-ink-muted" : tone(r.score))}>{r.score ?? "—"}{few && <span className="block text-[10.5px] font-normal">few receipts</span>}</Td>
              <Td>{r.onTimePct == null ? "—" : `${r.onTimePct}%`}</Td>
              <Td>{r.avgDaysLate == null ? "—" : `${r.avgDaysLate} days`}</Td>
              <Td className={r.lateSen ? "text-err" : ""}>{fmtSen(r.lateSen)}{r.lateLines > 0 && <span className="block text-[10.5px] text-ink-muted">{r.lateLines} lines</span>}</Td>
              <Td>{r.overdueSharePct == null ? "—" : `${r.overdueSharePct}%`}</Td>
              <Td>{r.senDays ? fmtSen(r.senDays) : "—"}</Td>
              <Td>{r.qualityPct == null ? "—" : `${r.qualityPct}%`}</Td>
              <Td>{r.receipts}</Td>
            </tr>
          );
        })}</tbody>
      </table>
      <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-ink-muted">
        <li>Score 0–100, higher is better: on time 40% · how late when late 20% (10 days late scores 0) · overdue share 30% · quality cases 10% (20 cases per 100 received scores 0). A part with no data is left out and the others re-weighted. Under 60 red, under 80 amber; fewer than {MIN_SCORE_RECEIPTS} lines received in the period is greyed.</li>
        <li>On time and late by: lines received in the period, against the date first put on the PO. Overdue now, share and RM × days: every PO line not yet received, as of the period&apos;s end. RM × days = each late line&apos;s amount × its days late, added up: big and long-late weighs most.</li>
        <li>Quality cases: service cases per 100 items received, from Quality Overview for the same period. Click a supplier for its overdue PO lines.</li>
      </ul>
    </div>
  );
}
