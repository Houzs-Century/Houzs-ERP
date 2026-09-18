/** The daily pending-task reminder's arithmetic, kept out of the component so
 *  it can be unit-tested without a router, a query client or a login.
 *
 *  WHY THIS READS THE LIST ENDPOINT AND NOT A NEW ONE (owner 2026-09-09):
 *  which work is "mine" is decided by THIRTEEN role lanes in
 *  `services/projects.ts` (`pendingOr`), selected per caller in
 *  `routes/projects.ts`. That block routes every staff member's day, so the
 *  reminder deliberately does NOT re-implement it — it calls
 *  `/api/projects?my_pending=1`, the exact request the My Pending list makes.
 *  The popup therefore cannot disagree with the screen it sends you to, and a
 *  future lane change updates both for free.
 */

/** One row of the My Pending list, narrowed to what the digest needs. */
export type PendingRow = {
  id: number;
  name: string;
  start_date?: string | null;
  end_date?: string | null;
  /** '|'-joined open task titles for THIS caller; absent on some lanes. */
  my_pending_titles?: string | null;
};

/** Worst first — the order the popup lists them in. */
export type DigestTier = "past_event" | "this_week" | "later";

export type DigestGroup = {
  tier: DigestTier;
  events: PendingRow[];
  /** Task titles owed across this group, deduped, for the popup's detail line. */
  titles: string[];
};

export type PendingDigest = {
  total: number;
  groups: DigestGroup[];
  /** The worst tier present, or null when there is nothing to nag about. */
  worst: DigestTier | null;
  /** past_event / this_week may not be postponed — see the popup. */
  mustAcknowledge: boolean;
};

/** Local calendar date (Malaysia for this deployment), never UTC: an event that
 *  ended today must not read as "past" just because the UTC clock rolled. */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const day = (v: string | null | undefined): string => (v ?? "").slice(0, 10);

/** Which bucket an event falls in. The event's OWN dates decide it — exact data,
 *  no guessing at how late an individual task is (the list's task rows carry no
 *  due date, and inventing one would put a wrong number in front of the owner). */
export function tierFor(row: PendingRow, today: string): DigestTier {
  const ends = day(row.end_date) || day(row.start_date);
  const starts = day(row.start_date) || ends;
  if (ends && ends < today) return "past_event";
  if (starts && starts <= addDays(today, 7)) return "this_week";
  return "later";
}

const TIER_ORDER: DigestTier[] = ["past_event", "this_week", "later"];

export function buildDigest(rows: PendingRow[], today = localToday()): PendingDigest {
  const byTier = new Map<DigestTier, PendingRow[]>();
  for (const row of rows) {
    const t = tierFor(row, today);
    const list = byTier.get(t);
    if (list) list.push(row);
    else byTier.set(t, [row]);
  }
  const groups: DigestGroup[] = [];
  for (const tier of TIER_ORDER) {
    const events = byTier.get(tier);
    if (!events?.length) continue;
    const titles = [
      ...new Set(
        events.flatMap((e) =>
          (e.my_pending_titles ?? "")
            .split("|")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ),
    ];
    groups.push({ tier, events, titles });
  }
  const worst = groups[0]?.tier ?? null;
  return {
    total: rows.length,
    groups,
    worst,
    // An event that has already finished, or one running within the week, is
    // not something to postpone — the popup drops "Remind later" for those,
    // reusing the announcement modal's own mandatory-acknowledgement rule.
    mustAcknowledge: worst === "past_event" || worst === "this_week",
  };
}

/** Storage key for "I have seen today's reminder". Per user AND per day, so it
 *  reappears tomorrow on its own with no cron and nothing to reset. */
export function seenKey(base: string | null, today = localToday()): string | null {
  return base ? `${base}:${today}` : null;
}
