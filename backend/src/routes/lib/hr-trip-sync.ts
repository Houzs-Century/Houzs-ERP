/* Trip Pay reads Delivery Planning (and the Projects module's Setup / Dismantle)
 * into hr_trip_rows without destroying anything HR did:
 *   - a stop not yet in the month becomes a row;
 *   - a row whose stop changed is brought up to date, unless HR edited it;
 *   - a row whose stop was cancelled or deleted is flagged for HR, never removed;
 *   - a row HR removed stays removed (it is kept, paid nothing, so no read adds it back);
 *   - a month whose payroll is approved is never touched.
 * Every night at 00:05 MYT (index.ts, "5 16 * * *") the read adds YESTERDAY and
 * re-reads only older days of the open trip months whose source changed since the
 * company's last run (updated_at on trips / dp_orders / delivery_order_crew /
 * projects, created_at on trip_stops) or whose set of stops differs from the
 * rows. "Read Delivery Planning" runs the same rules over the whole month at once.
 * A month filled by pasting the Trip Report is left alone by the nightly read.
 * Money is never stored: it is worked out on read from the rows and the rates. */
import { and, eq, inArray } from "drizzle-orm";
import type { Env } from "../../types";
import { getDb } from "../../db/client";
import { companies, hr_employees, hr_trip_rows, hr_trip_sync_state } from "../../db/schema";
import { tripMonthBounds, tripMonthOf } from "../../scm/shared/hr-trip-pay";
import { changedSourceDays, planningRows, rowHrEdited, tripMonthLocked, type Person, type SourceRow } from "./hr-trip-store";

type Db = ReturnType<typeof getDb>;
type RowRecord = typeof hr_trip_rows.$inferSelect;

const CONTENT: ReadonlyArray<keyof SourceRow> = [
  "trip_date",
  "doc_no",
  "transfer_to",
  "ref_no",
  "kind",
  "job_type",
  "event_type",
  "local_total_sen",
  "state",
  "postcode",
  "lorry_plate",
  "trip_ref",
  "venue_key",
  "driver_1_name",
  "driver_2_name",
  "helper_1_name",
  "helper_2_name",
  "driver_1_employee_id",
  "driver_2_employee_id",
  "helper_1_employee_id",
  "helper_2_employee_id",
];

export type StoredRow = Pick<RowRecord, "id" | "source" | "source_ref" | "hr_edited" | "created_at" | "updated_at" | "source_missing_at" | "removed_at"> &
  Record<(typeof CONTENT)[number], unknown>;

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The days of a trip month the nightly read touches: yesterday, the older days
 *  whose source changed (`changed`, or every day when there is no watermark yet),
 *  and the days whose stops differ from the stored Planning rows. Never today or
 *  later. Pure. */
export function selectSyncDays(input: {
  first: string;
  last: string;
  yesterday: string;
  changed: ReadonlySet<string> | "all";
  stored: ReadonlyArray<{ source_ref: string | null; trip_date: string }>;
  source: ReadonlyArray<{ source_ref: string; trip_date: string }>;
}): Set<string> {
  const cap = input.last < input.yesterday ? input.last : input.yesterday;
  const days = new Set<string>();
  if (cap < input.first) return days;
  if (input.yesterday >= input.first && input.yesterday <= input.last) days.add(input.yesterday);
  for (let d = input.first; d <= cap; d = addDays(d, 1)) if (input.changed === "all" || input.changed.has(d)) days.add(d);
  const refs = (list: ReadonlyArray<{ source_ref: string | null; trip_date: string }>) => {
    const m = new Map<string, string[]>();
    for (const r of list) if (r.source_ref) m.set(r.trip_date, [...(m.get(r.trip_date) ?? []), r.source_ref]);
    return m;
  };
  const a = refs(input.stored);
  const b = refs(input.source);
  for (const d of new Set([...a.keys(), ...b.keys()])) {
    if (d < input.first || d > cap) continue;
    if ((a.get(d) ?? []).sort().join(",") !== (b.get(d) ?? []).sort().join(",")) days.add(d);
  }
  return days;
}

export type SyncPlan = {
  inserts: SourceRow[];
  updates: { id: number; row: SourceRow }[];
  /** Rows whose source is gone: flag for HR. */
  flag: number[];
  /** Flagged rows whose source is back. */
  unflag: number[];
};

/** What to write so the stored Planning rows match the source on `days` (null =
 *  every day). A stored row and a source row pair up by source_ref, whichever
 *  side's date is in `days`. HR-edited and HR-removed rows are never rewritten. Pure. */
export function planSync(stored: ReadonlyArray<StoredRow>, source: ReadonlyArray<SourceRow>, days: ReadonlySet<string> | null): SyncPlan {
  const inDays = (d: unknown) => days == null || days.has(String(d));
  const plan: SyncPlan = { inserts: [], updates: [], flag: [], unflag: [] };
  const storedBy = new Map<string, StoredRow>();
  for (const r of stored) if (r.source === "PLANNING" && r.source_ref && !storedBy.has(r.source_ref)) storedBy.set(r.source_ref, r);
  const sourceRefs = new Set(source.map((s) => s.source_ref));
  for (const s of source) {
    const cur = storedBy.get(s.source_ref);
    if (!cur) {
      if (inDays(s.trip_date)) plan.inserts.push(s);
      continue;
    }
    if (!inDays(s.trip_date) && !inDays(cur.trip_date)) continue;
    const locked = cur.removed_at != null || rowHrEdited({ ...cur, job_type: cur.job_type as string | null });
    const differs = CONTENT.some((k) => String(cur[k] ?? "") !== String(s[k] ?? ""));
    if (!locked && differs) plan.updates.push({ id: cur.id, row: s });
    else if (cur.source_missing_at != null) plan.unflag.push(cur.id);
  }
  for (const [ref, cur] of storedBy) {
    if (sourceRefs.has(ref) || cur.source_missing_at != null || cur.removed_at != null || !inDays(cur.trip_date)) continue;
    plan.flag.push(cur.id);
  }
  return plan;
}

export type SyncResult = { month: string; skipped: "locked" | "pasted" | null; days: number; added: number; updated: number; flagged: number };

async function companyPeople(db: Db, companyId: number): Promise<Person[]> {
  return db
    .select({
      id: hr_employees.id,
      empNo: hr_employees.emp_no,
      name: hr_employees.name,
      tripNames: hr_employees.trip_names,
      userId: hr_employees.user_id,
      joinDate: hr_employees.join_date,
      resignedOn: hr_employees.resigned_on,
    })
    .from(hr_employees)
    .where(eq(hr_employees.company_id, companyId));
}

/** Read the month's source and apply the non-destructive rules. `mode: "all"`
 *  (the button) covers every day of the month; "nightly" only selectSyncDays,
 *  with `since` the company's watermark (null = never run). */
export async function syncTripMonth(
  db: Db,
  companyId: number,
  month: string,
  opts: { mode: "all" | "nightly"; yesterday: string; since: string | null; by: number | null },
): Promise<SyncResult> {
  const none = (skipped: SyncResult["skipped"]): SyncResult => ({ month, skipped, days: 0, added: 0, updated: 0, flagged: 0 });
  if (await tripMonthLocked(db, companyId, month)) return none("locked");
  const stored = await db.select().from(hr_trip_rows).where(and(eq(hr_trip_rows.company_id, companyId), eq(hr_trip_rows.trip_month, month)));
  if (opts.mode === "nightly" && stored.some((r) => r.source === "SHEET")) return none("pasted");
  const source = await planningRows(db, companyId, month, await companyPeople(db, companyId));
  const { first, last } = tripMonthBounds(month);
  let days: Set<string> | null = null;
  if (opts.mode === "nightly") {
    const changed = opts.since ? await changedSourceDays(db, companyId, first, last, opts.since) : "all";
    days = selectSyncDays({ first, last, yesterday: opts.yesterday, changed, stored: stored.filter((r) => r.source === "PLANNING"), source });
  }
  const plan = planSync(stored, source, days);
  const now = new Date().toISOString();
  for (let i = 0; i < plan.inserts.length; i += 200) {
    await db.insert(hr_trip_rows).values(plan.inserts.slice(i, i + 200).map((r) => ({ ...r, company_id: companyId, trip_month: month, created_by: opts.by })));
  }
  for (const u of plan.updates) {
    const { source: _s, source_ref: _r, ...set } = u.row;
    await db
      .update(hr_trip_rows)
      .set({ ...set, source_missing_at: null, updated_at: now })
      .where(and(eq(hr_trip_rows.company_id, companyId), eq(hr_trip_rows.id, u.id)));
  }
  if (plan.flag.length) await db.update(hr_trip_rows).set({ source_missing_at: now }).where(and(eq(hr_trip_rows.company_id, companyId), inArray(hr_trip_rows.id, plan.flag)));
  if (plan.unflag.length) await db.update(hr_trip_rows).set({ source_missing_at: null }).where(and(eq(hr_trip_rows.company_id, companyId), inArray(hr_trip_rows.id, plan.unflag)));
  return { month, skipped: null, days: days ? days.size : -1, added: plan.inserts.length, updated: plan.updates.length, flagged: plan.flag.length };
}

/** The open trip months the nightly read looks at: yesterday's and the one before. */
export function nightlyMonths(yesterday: string): string[] {
  const m = tripMonthOf(yesterday);
  const [y, mm] = m.split("-").map(Number);
  const prev = mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, "0")}`;
  return [prev, m];
}

/** The 00:05 MYT run, every company. One company's failure does not stop the rest. */
export async function runNightlyTripSync(env: Env, scheduledTime: number): Promise<{ companies: number; results: string[] }> {
  const db = getDb(env);
  const startedAt = new Date().toISOString();
  const yesterday = new Date(scheduledTime + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
  const ids = (await db.select({ id: companies.id }).from(companies)).map((c) => Number(c.id));
  const results: string[] = [];
  for (const companyId of ids) {
    try {
      const state = (await db.select().from(hr_trip_sync_state).where(eq(hr_trip_sync_state.company_id, companyId)).limit(1)).at(0);
      const out: SyncResult[] = [];
      for (const month of nightlyMonths(yesterday)) out.push(await syncTripMonth(db, companyId, month, { mode: "nightly", yesterday, since: state?.watermark ?? null, by: null }));
      const summary = out.map((r) => (r.skipped ? `${r.month} ${r.skipped}` : `${r.month} ${r.days}d +${r.added} ~${r.updated} !${r.flagged}`)).join("; ");
      const set = { watermark: startedAt, last_run_at: startedAt, last_summary: summary, updated_at: startedAt };
      await db.insert(hr_trip_sync_state).values({ company_id: companyId, ...set }).onConflictDoUpdate({ target: hr_trip_sync_state.company_id, set });
      results.push(`${companyId}: ${summary}`);
    } catch (e) {
      results.push(`${companyId}: failed ${String((e as Error).message).slice(0, 160)}`);
    }
  }
  return { companies: ids.length, results };
}
