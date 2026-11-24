// Own fleet tab: the pieces worth pinning (ownFleet.test.ts). Our own lorries
// priced like a 3PL — the trips and month figures come from
// GET /delivery-rate-cards/own-fleet; these only read and word them.
import type { OwnFleetMonth, OwnFleetRun } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { JOB_LABEL } from '../../../vendor/scm/lib/rate-rule-taxonomy';

/** The window the tab opens on: the 1st of the month two months back, to today. */
export function defaultOwnFleetRange(today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const back = new Date(Date.UTC(y, m - 1 - 2, 1));
  return { from: back.toISOString().slice(0, 10), to: today };
}

/** Sen per order, whole sen; null when there is nothing to divide. */
export const perDo = (sen: number, dos: number): number | null => (dos > 0 ? Math.round(sen / dos) : null);

/** The months added up, for the summary strip. */
export function ownFleetTotals(months: readonly OwnFleetMonth[]): OwnFleetMonth {
  const t: OwnFleetMonth = {
    month: 'total', trips: 0, dos: 0, sets: 0, pricedTrips: 0, pricedDos: 0, costSen: 0, deliveryCostSen: 0,
    threePlDos: 0, threePlSets: 0, threePlBilledSen: 0, threePlPricedDos: 0, threePlBilledPricedSen: 0, threePlCardSen: 0,
  };
  for (const m of months) {
    for (const k of Object.keys(t) as Array<keyof OwnFleetMonth>) {
      if (k !== 'month') (t[k] as number) += m[k] as number;
    }
  }
  return t;
}

/* The server names the job; one this copy of the list lacks shows by its own name. */
const jobLabel: Partial<Record<string, string>> = JOB_LABEL;

/** A trip's other jobs as Delivery Planning names them: "Supplier x2 · Transfer item". */
export function jobsText(jobs: OwnFleetRun['jobs']): string {
  return Object.entries(jobs)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([job, n]) => `${jobLabel[job] ?? job}${(n ?? 0) > 1 ? ` x${n}` : ''}`)
    .join(' · ');
}

/** Whose orders a trip carried: "HOUZS 4 · 2990 1", most first (one company: just the count). */
export function companySplit(dos: OwnFleetRun['dos']): string {
  const by = new Map<string, number>();
  for (const d of dos) by.set(d.companyCode ?? '?', (by.get(d.companyCode ?? '?') ?? 0) + 1);
  if (by.size <= 1) return String(dos.length);
  return [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, n]) => `${code} ${n}`).join(' · ');
}
