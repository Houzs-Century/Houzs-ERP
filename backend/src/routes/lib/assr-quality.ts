/* Quality Overview's figures (owner, 2026-10-17). Performance reads recent,
   so an improvement shows:
   - opened / closed: cases opened / closed in the period;
   - average to close and time per stage: the LAST 30 DAYS whatever the
     period (cases closed / stages finished in them), with the 30 days before
     for comparison; the 12-month trend carries each month's average;
   - suppliers: cases opened in the period against items received from that
     supplier in the same period — "1,000 ordered, 50 came back = 5%" — and
     the same month by month;
   - the open cases, their age and the overdue list are as of today.
   A stage is overdue the way the Stage Funnel counts it: its days so far have
   reached the stage's target days. Pure, so the arithmetic is tested apart. */

export interface QCase {
  id: number; stage: string; openedAt: string; closedAt: string | null; creditor: string | null;
  assrNo: string | null; customer: string | null;
  /** What the customer complained about, and its category. */
  complaint: string | null; issueCategory: string | null;
}
export interface QStageRow { caseId: number; stage: string; enteredAt: string; exitedAt: string | null; targetDays: number | null }
export interface QReceived { creditor: string; name: string; month: string; qty: number; lines: number }

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
  /* Average to close (owner 2026-10-17): the last 30 days, whatever the period —
     a year-old pace must not hide that the team now closes twice as fast. */
  const dayBefore = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);
  const closedBetween = (a: string, b: string) => live.filter((c) => c.stage === "completed" && !!c.closedAt && c.closedAt.slice(0, 10) >= a && c.closedAt.slice(0, 10) <= b);
  const last30 = closedBetween(dayBefore(29), today);
  const prev30 = closedBetween(dayBefore(59), dayBefore(30));
  /* The same over 90 days (owner: "one month or three?") — the page switches. */
  const last90 = closedBetween(dayBefore(89), today);
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
    const closedIn = live.filter((c) => c.stage === "completed" && (c.closedAt ?? "").slice(0, 7) === key);
    return {
      month: key,
      opened: live.filter((c) => c.openedAt.slice(0, 7) === key).length,
      closed: closedIn.length,
      /* The month's average to close: cases closed that month, opened to closed. */
      avgDaysToClose: resolution(closedIn),
      backlog: openAt(end < today ? end : today).length,
    };
  });

  /* Time per stage: stages that ended in [a, b], for the given cases. */
  const stageDays = (ids: Set<number> | null, a: string, b: string) => {
    const by = new Map<string, number[]>();
    for (const h of history) {
      if (!h.exitedAt || h.exitedAt.slice(0, 10) < a || h.exitedAt.slice(0, 10) > b || (ids && !ids.has(h.caseId))) continue;
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
      complaint: c.complaint, issueCategory: c.issueCategory, stage: h.stage, enteredAt: h.enteredAt.slice(0, 10), targetDays: h.targetDays as number,
      daysInStage: Math.floor(inStage), daysOver: Math.floor(inStage - (h.targetDays as number)), caseAgeDays: Math.floor(days(c.openedAt, today)),
    }))
    .sort((a, b) => b.daysOver - a.daysOver);

  const recv = new Map<string, { qty: number; lines: number; name: string }>();
  for (const r of received) { const g = recv.get(r.creditor) ?? { qty: 0, lines: 0, name: r.name }; g.qty += r.qty; g.lines += r.lines; recv.set(r.creditor, g); }
  /* Every month of the period, so a quarter or a year shows each month's goods in, cases and rate. */
  const months: string[] = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= to.slice(0, 7); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(d.toISOString().slice(0, 7));
  const itemsOf = (cs: QCase[]) => cs.reduce((a, c) => a + Math.max(1, itemsByCase.get(c.id) ?? 1), 0);
  const supplierKeys = [...new Set([...opened.map((c) => c.creditor), ...received.map((r) => r.creditor)].filter((x): x is string => !!x))];
  const suppliers = supplierKeys.map((code) => {
    const cs = opened.filter((c) => c.creditor === code);
    const items = itemsOf(cs);
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
      stageDays: stageDays(new Set(live.filter((c) => c.creditor === code).map((c) => c.id)), from, to),
      months: months.map((mo) => {
        const q = received.filter((x) => x.creditor === code && x.month === mo).reduce((a, x) => a + x.qty, 0);
        const it = itemsOf(cs.filter((c) => c.openedAt.slice(0, 7) === mo));
        return { month: mo, receivedQty: q, items: it, ratePct: q ? Math.round((it / q) * 1000) / 10 : null };
      }),
    };
  }).filter((s) => s.cases > 0).sort((a, b) => b.cases - a.cases);

  return {
    opened: opened.length,
    closed: closed.length,
    ongoingNow: openNow.length,
    openedStillOpen: opened.filter(isOpen).length,
    avgDaysToClose: resolution(last30),
    avgDaysToCloseCases: last30.length,
    avgDaysToClosePrev30: resolution(prev30),
    stageDays: stageDays(null, dayBefore(29), today),
    avgDaysToClose90: resolution(last90),
    avgDaysToClose90Cases: last90.length,
    stageDays90: stageDays(null, dayBefore(89), today),
    ages,
    trend,
    overdue,
    suppliers,
    unattributed: opened.filter((c) => !c.creditor).length,
    /* The cases behind the figures — opened in the period, open now, or closed
       in the last 30 days — for the page's drill-down (owner 2026-10-18). */
    caseList: live.filter((c) => inP(c.openedAt) || isOpen(c) || (c.stage === "completed" && !!c.closedAt && c.closedAt.slice(0, 10) >= dayBefore(29)))
      .map((c) => ({
        id: c.id, assrNo: c.assrNo, customer: c.customer, complaint: c.complaint, issueCategory: c.issueCategory, creditor: c.creditor, supplier: c.creditor ? names.get(c.creditor) ?? c.creditor : null,
        stage: c.stage, openedAt: c.openedAt.slice(0, 10), closedAt: c.closedAt ? c.closedAt.slice(0, 10) : null,
        open: isOpen(c), openedInPeriod: inP(c.openedAt), ageDays: Math.floor(days(c.openedAt, c.closedAt ?? today)),
      })),
  };
}
