/* Quality Overview's figures (owner, 2026-10-17). Everything that measures
   performance follows the selected period, so the page shows how the team and
   the suppliers are doing NOW, not months ago:
   - opened / closed: cases opened / closed in the period;
   - average to close: cases OPENED in the period that are closed (a case
     opened months ago and closed today is the old backlog, not today's pace);
   - time per stage: stages that ENDED in the period;
   - suppliers: cases opened in the period against items received from that
     supplier in the same period — "1,000 ordered, 50 came back = 5%";
   - the open cases, their age and the overdue list are as of today.
   A stage is overdue the way the Stage Funnel counts it: its days so far have
   reached the stage's target days. Pure, so the arithmetic is tested apart. */

export interface QCase {
  id: number; stage: string; openedAt: string; closedAt: string | null; creditor: string | null;
  assrNo: string | null; customer: string | null;
}
export interface QStageRow { caseId: number; stage: string; enteredAt: string; exitedAt: string | null; targetDays: number | null }
export interface QReceived { creditor: string; name: string; qty: number; lines: number }

const DAY = 86400000;
const days = (a: string, b: string) => (Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / DAY;
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const isOpen = (c: QCase) => c.stage !== "completed" && c.stage !== "voided";

export const AGE_BUCKETS: Array<[string, number, number]> = [
  ["0–7 days", 0, 7], ["8–14 days", 8, 14], ["15–21 days", 15, 21], ["22–30 days", 22, 30], ["31–60 days", 31, 60], ["61–90 days", 61, 90], ["Over 90 days", 91, Infinity],
];

export function qualityOverview(cases: QCase[], itemsByCase: Map<number, number>, history: QStageRow[], received: QReceived[], from: string, to: string, today: string, names: Map<string, string>) {
  const live = cases.filter((c) => c.stage !== "voided");
  const inP = (d: string | null) => !!d && d.slice(0, 10) >= from && d.slice(0, 10) <= to;
  const opened = live.filter((c) => inP(c.openedAt));
  const closed = live.filter((c) => c.stage === "completed" && inP(c.closedAt));
  const cohortClosed = opened.filter((c) => c.stage === "completed" && !!c.closedAt);
  /* Open on day d: opened by then, and either still open now or closed after d.
     A completed case with no closing date (older imports) counts as closed. */
  const openAt = (d: string) => live.filter((c) => c.openedAt.slice(0, 10) <= d && (isOpen(c) || (!!c.closedAt && c.closedAt.slice(0, 10) > d)));
  const openNow = live.filter(isOpen);
  const resolution = (cs: QCase[]) => avg(cs.filter((c) => c.closedAt).map((c) => Math.max(0, days(c.openedAt, c.closedAt as string))));

  const ages = AGE_BUCKETS.map(([label, lo, hi]) => ({ label, count: openNow.filter((c) => { const a = days(c.openedAt, today); return a >= lo && a <= hi; }).length }));

  const y = Number(to.slice(0, 4)); const m = Number(to.slice(5, 7));
  const trend = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 12 + i, 1));
    const key = d.toISOString().slice(0, 7);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return {
      month: key,
      opened: live.filter((c) => c.openedAt.slice(0, 7) === key).length,
      closed: live.filter((c) => c.stage === "completed" && (c.closedAt ?? "").slice(0, 7) === key).length,
      backlog: openAt(end < today ? end : today).length,
    };
  });

  /* Time per stage: stages that ended in the period, for the given cases. */
  const stageDays = (ids: Set<number> | null) => {
    const by = new Map<string, number[]>();
    for (const h of history) {
      if (!h.exitedAt || !inP(h.exitedAt) || (ids && !ids.has(h.caseId))) continue;
      by.set(h.stage, [...(by.get(h.stage) ?? []), Math.max(0, days(h.enteredAt, h.exitedAt))]);
    }
    return Object.fromEntries([...by.entries()].map(([s, xs]) => [s, { avgDays: avg(xs), cases: xs.length }]));
  };

  /* Overdue now: the open stage row whose days so far reached its target. */
  const byId = new Map(live.map((c) => [c.id, c]));
  const overdue = history
    .filter((h) => !h.exitedAt && (h.targetDays ?? 0) > 0)
    .map((h) => ({ h, c: byId.get(h.caseId), inStage: days(h.enteredAt, today) }))
    .filter((x): x is { h: QStageRow; c: QCase; inStage: number } => !!x.c && isOpen(x.c) && x.inStage >= (x.h.targetDays as number))
    .map(({ h, c, inStage }) => ({
      id: c.id, assrNo: c.assrNo, customer: c.customer, supplier: c.creditor ? names.get(c.creditor) ?? c.creditor : null,
      stage: h.stage, enteredAt: h.enteredAt.slice(0, 10), targetDays: h.targetDays as number,
      daysInStage: Math.floor(inStage), daysOver: Math.floor(inStage - (h.targetDays as number)), caseAgeDays: Math.floor(days(c.openedAt, today)),
    }))
    .sort((a, b) => b.daysOver - a.daysOver);

  const recv = new Map(received.map((r) => [r.creditor, r]));
  const supplierKeys = [...new Set([...opened.map((c) => c.creditor), ...received.map((r) => r.creditor)].filter((x): x is string => !!x))];
  const suppliers = supplierKeys.map((code) => {
    const cs = opened.filter((c) => c.creditor === code);
    const items = cs.reduce((a, c) => a + Math.max(1, itemsByCase.get(c.id) ?? 1), 0);
    const r = recv.get(code);
    const done = cs.filter((c) => c.stage === "completed" && !!c.closedAt);
    return {
      creditor: code, name: names.get(code) ?? r?.name ?? code,
      receivedQty: r?.qty ?? 0, receivedLines: r?.lines ?? 0,
      cases: cs.length, items,
      ratePct: r?.qty ? Math.round((items / r.qty) * 1000) / 10 : null,
      open: cs.filter(isOpen).length,
      overdue: overdue.filter((o) => o.supplier === (names.get(code) ?? code)).length,
      closed: done.length,
      avgDaysToClose: resolution(done),
      stageDays: stageDays(new Set(live.filter((c) => c.creditor === code).map((c) => c.id))),
    };
  }).filter((s) => s.cases > 0).sort((a, b) => b.cases - a.cases);

  return {
    opened: opened.length,
    closed: closed.length,
    ongoingNow: openNow.length,
    openedStillOpen: opened.filter(isOpen).length,
    avgDaysToClose: resolution(cohortClosed),
    avgDaysToCloseCases: cohortClosed.length,
    stageDays: stageDays(null),
    ages,
    trend,
    overdue,
    suppliers,
    unattributed: opened.filter((c) => !c.creditor).length,
  };
}
