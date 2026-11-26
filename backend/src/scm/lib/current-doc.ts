
export type CurrentEvent = {
  date: string;
  createdAt: string;
  rank: number;
  docNumber: string;
};

const normDay = (d: string): string => (d ?? '').slice(0, 10);

export function pickLatestDocNo(events: CurrentEvent[]): string | null {
  let best: CurrentEvent | null = null;
  for (const ev of events) {
    if (!best) { best = ev; continue; }
    const dc = normDay(ev.date).localeCompare(normDay(best.date));
    if (dc > 0) { best = ev; continue; }
    if (dc < 0) continue;
    const cc = ev.createdAt.localeCompare(best.createdAt);
    if (cc > 0) { best = ev; continue; }
    if (cc < 0) continue;
    if (ev.rank > best.rank) best = ev;
  }
  return best ? best.docNumber : null;
}

export function currentDocNoByKey(
  byKey: Map<string, CurrentEvent[]>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, evs] of byKey) {
    const docNo = pickLatestDocNo(evs);
    if (docNo) out.set(key, docNo);
  }
  return out;
}
