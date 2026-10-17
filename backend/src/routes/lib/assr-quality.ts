/* Quality Overview's figures (owner, 2026-10-17): cases opened, closed and
   still ongoing in the period; how old the open cases are; the 12-month trend
   with the backlog; and per supplier how often their goods come back (per item
   and per order received) and how long their cases take, in total and stage by
   stage. Pure, so the arithmetic is tested apart from the reads. */

export interface QCase { id: number; stage: string; openedAt: string; closedAt: string | null; creditor: string | null }
export interface QStageRow { caseId: number; stage: string; enteredAt: string; exitedAt: string | null }
export interface QReceived { creditor: string; name: string; qty: number; lines: number }

const DAY = 86400000;
const days = (a: string, b: string) => (Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / DAY;
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const isOpen = (c: QCase) => c.stage !== "completed" && c.stage !== "voided";

export const AGE_BUCKETS: Array<[string, number, number]> = [
  ["0–7 days", 0, 7], ["8–14 days", 8, 14], ["15–21 days", 15, 21], ["22–30 days", 22, 30], ["31–60 days", 31, 60], ["61–90 days", 61, 90], ["Over 90 days", 91, Infinity],
];

/** `received`: goods in from each supplier over the supplier window
 *  [supFrom, to] — a trailing year, because a defect shows up months after the
 *  goods arrive, so a month's cases over a month's receipts says nothing. */
export function qualityOverview(cases: QCase[], itemsByCase: Map<number, number>, history: QStageRow[], received: QReceived[], from: string, to: string, today: string, supFrom: string, names: Map<string, string>) {
  const asOf = to < today ? to : today;
  const live = cases.filter((c) => c.stage !== "voided");
  const inP = (d: string | null) => !!d && d.slice(0, 10) >= from && d.slice(0, 10) <= to;
  const opened = live.filter((c) => inP(c.openedAt));
  const closed = live.filter((c) => c.stage === "completed" && inP(c.closedAt));
  /* Open on day d: opened by then, and either still open now or closed after d.
     A completed case with no closing date (older imports) counts as closed. */
  const openAt = (d: string) => live.filter((c) => c.openedAt.slice(0, 10) <= d && (isOpen(c) || (!!c.closedAt && c.closedAt.slice(0, 10) > d)));
  const openNow = live.filter(isOpen);

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

  /* Stage durations, per stage, over the cases closed in the period. */
  const closedIds = new Set(closed.map((c) => c.id));
  const stageDays = (ids: Set<number>) => {
    const by = new Map<string, number[]>();
    for (const h of history) {
      if (!ids.has(h.caseId) || !h.exitedAt) continue;
      by.set(h.stage, [...(by.get(h.stage) ?? []), Math.max(0, days(h.enteredAt, h.exitedAt))]);
    }
    return Object.fromEntries([...by.entries()].map(([s, xs]) => [s, avg(xs)]));
  };
  const resolution = (cs: QCase[]) => avg(cs.filter((c) => c.closedAt).map((c) => Math.max(0, days(c.openedAt, c.closedAt as string))));

  const recv = new Map(received.map((r) => [r.creditor, r]));
  const inSup = (d: string | null) => !!d && d.slice(0, 10) >= supFrom && d.slice(0, 10) <= to;
  const supOpened = live.filter((c) => inSup(c.openedAt));
  const supplierKeys = [...new Set(supOpened.map((c) => c.creditor).filter((x): x is string => !!x))];
  const suppliers = supplierKeys.map((code) => {
    const cs = supOpened.filter((c) => c.creditor === code);
    const closedCs = live.filter((c) => c.creditor === code && c.stage === "completed" && inSup(c.closedAt));
    const items = cs.reduce((a, c) => a + Math.max(1, itemsByCase.get(c.id) ?? 1), 0);
    const r = recv.get(code);
    return {
      creditor: code, name: names.get(code) ?? r?.name ?? code,
      cases: cs.length, items, receivedQty: r?.qty ?? 0, receivedLines: r?.lines ?? 0,
      perItemPct: r?.qty ? Math.round((items / r.qty) * 1000) / 10 : null,
      perOrderPct: r?.lines ? Math.round((cs.length / r.lines) * 1000) / 10 : null,
      open: cs.filter(isOpen).length,
      closed: closedCs.length,
      avgResolutionDays: resolution(closedCs),
      stageDays: stageDays(new Set(closedCs.map((c) => c.id))),
    };
  }).sort((a, b) => b.cases - a.cases);

  return {
    asOf,
    opened: opened.length,
    closed: closed.length,
    ongoingNow: openNow.length,
    ongoingAtEnd: openAt(asOf).length,
    openedStillOpen: opened.filter(isOpen).length,
    unattributed: opened.filter((c) => !c.creditor).length,
    supplierWindow: { from: supFrom, to, cases: supOpened.length, unattributed: supOpened.filter((c) => !c.creditor).length },
    avgResolutionDays: resolution(closed),
    stageDays: stageDays(closedIds),
    ages,
    trend,
    suppliers,
  };
}
