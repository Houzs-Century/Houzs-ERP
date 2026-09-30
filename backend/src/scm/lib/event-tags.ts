// ----------------------------------------------------------------------------
// event-tags.ts — the event a voucher or AP invoice line's money is for
// (owner 2026-09-29/30: 我的 payment 可能需要绑定 event — 5a, an event per line,
// the header a default). An "event" is a public.projects row: one per brand per
// fair ("Pulau Pinang [AKEMI] MLE @ PENANG WATERFRONT CONVENTION CENTRE").
//
// The tag rides the line into its journal leg (acc/rules.ts, acc/engine.ts),
// so an event's cost is read from the ledger itself. This module is the
// public-schema half: the scm supabase client cannot reach public.projects, so
// every read here goes through `env.DB`, company-scoped by the caller's
// `activeCompanySql` fragment — the whole tenant boundary, as in
// fair-binding.ts.
// ----------------------------------------------------------------------------

import { activeCompanySql } from './companyScope';

/** The `DB` binding surface these reads need (structural, so tests can fake it). */
export type EventDb = {
  prepare(sql: string): {
    bind(...vals: unknown[]): { all<T>(): Promise<{ results?: T[] }> };
  };
};

export type EventRow = {
  id: number;
  code: string | null;
  name: string;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
  archived: boolean;
  venue: string | null;
  brand: string | null;
  organizer: string | null;
  boothNo: string | null;
};

/* Lower-case aliases, and every mapper dual-reads: the pg driver and the D1
   mirror disagree on result-column casing (fair-binding.ts). */
const EVENT_COLUMNS =
  'p.id AS id, p.code AS code, p.name AS name, p.start_date AS startdate, p.end_date AS enddate, ' +
  'p.status AS status, p.archived_at AS archivedat, p.venue AS venue, p.brand AS brand, ' +
  'p.organizer AS organizer, p.booth_no AS boothno';

function str(r: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = r[k];
    if (v != null && typeof v !== 'object' && String(v).trim() !== '') return String(v);
  }
  return null;
}

export function toEventRow(r: Record<string, unknown>): EventRow {
  return {
    id: Number(r.id),
    code: str(r, 'code'),
    name: str(r, 'name') ?? `Event #${String(r.id)}`,
    startDate: str(r, 'startdate', 'startDate', 'start_date'),
    endDate: str(r, 'enddate', 'endDate', 'end_date'),
    status: str(r, 'status'),
    archived: str(r, 'archivedat', 'archivedAt', 'archived_at') != null,
    venue: str(r, 'venue'),
    brand: str(r, 'brand'),
    organizer: str(r, 'organizer'),
    boothNo: str(r, 'boothno', 'boothNo', 'booth_no'),
  };
}

/** A line's event as the API sends it: absent, null or blank is "no event"; a
    positive integer is that event; anything else is a unit mistake, refused. */
export function parseEventId(raw: unknown): number | null | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return null;
  /* A number, or digits as text — never Number(true) === 1. */
  if (typeof raw !== 'number' && !(typeof raw === 'string' && /^\s*\d+\s*$/.test(raw))) return 'invalid';
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 'invalid';
}

/** The events of the active company among `ids` — archived and cancelled ones
    included: a tag already on a line stays readable and re-savable after the
    office archives or cancels the event (a cancelled fair can still owe a
    forfeited deposit). The picker is what leaves archived events out. */
export async function loadEventsByIds(db: EventDb, companySql: string, ids: number[]): Promise<Map<number, EventRow>> {
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map<number, EventRow>();
  if (clean.length === 0) return out;
  const res = await db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM projects p WHERE p.id IN (${clean.map(() => '?').join(', ')})${companySql}`)
    .bind(...clean)
    .all<Record<string, unknown>>();
  for (const r of (res.results ?? []) as Array<Record<string, unknown>>) {
    const e = toEventRow(r);
    if (Number.isFinite(e.id)) out.set(e.id, e);
  }
  return out;
}

/** The refusal for a write naming an event the company does not have — null
    when every named event is there (or none is named). A failed read refuses
    too: a tag nobody could check is not written. `c` is the route's context. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function unknownEventRefusal(c: any, ids: Array<number | null | undefined>): Promise<Response | null> {
  const wanted = [...new Set(ids.filter((n): n is number => n != null))];
  if (wanted.length === 0) return null;
  let found: Map<number, EventRow>;
  try {
    found = await loadEventsByIds(c.env.DB, activeCompanySql(c, 'p.company_id'), wanted);
  } catch (e) {
    return c.json({ error: 'event_read_failed', message: 'The events could not be read — try again.', reason: String((e as Error)?.message ?? e) }, 500);
  }
  const missing = wanted.find((id) => !found.has(id));
  if (missing != null) {
    return c.json({ error: 'event_not_found', message: `Event #${missing} is not in the company you are working in — pick the event again.` }, 400);
  }
  return null;
}

/** A voucher line carries an event only where the line IS the money spent: a
    supplier payment's one line is the AP control (the event belongs on the AP
    invoice it pays, where the expense was booked), and a customer refund's is
    the customer's AR. Then every named event must be the company's own. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pvLineEventRefusal(c: any, purpose: unknown, rows: ReadonlyArray<object>): Promise<Response | null> {
  const ids = rows.map((r) => (r as { project_id?: number | null }).project_id ?? null);
  if (ids.every((id) => id == null)) return null;
  const p = String(purpose ?? '').trim().toUpperCase();
  if (p === 'SUPPLIER_PAYMENT') {
    return c.json({ error: 'event_not_on_this_voucher', message: 'A supplier payment pays the AP account — tag the event on the AP invoice it pays.' }, 400);
  }
  if (p === 'CUSTOMER_REFUND') {
    return c.json({ error: 'event_not_on_this_voucher', message: 'A customer refund carries no event.' }, 400);
  }
  return unknownEventRefusal(c, ids);
}

/** The picker's window without a search: events that ended up to 60 days
    before the document date, through those starting 180 days after it — a
    booth is often paid months ahead of its fair, its last bill soon after. */
export const EVENT_WINDOW_BEFORE_DAYS = 60;
export const EVENT_WINDOW_AFTER_DAYS = 180;

const shiftDay = (ymd: string, days: number): string => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * What the event picker offers. With a search (two or more characters): any
 * live event of the company whose code, name, venue, organizer, brand or booth
 * holds it, newest first. Without one: the events inside the window around the
 * document date (EVENT_WINDOW_BEFORE_DAYS / _AFTER_DAYS), in date order.
 * Archived events are left out (owner
 * 2026-09-19: an archived project is one the office withdrew — the rule every
 * other reader of projects keeps); cancelled ones stay, marked, since a
 * cancelled fair can still carry a cost.
 */
export async function listEventOptions(
  db: EventDb,
  companySql: string,
  opts: { q: string | null; around: string },
): Promise<EventRow[]> {
  const q = (opts.q ?? '').trim().toLowerCase();
  if (q.length >= 2) {
    const like = `%${q}%`;
    const fields = ['p.code', 'p.name', 'p.venue', 'p.organizer', 'p.brand', 'p.booth_no'];
    const res = await db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM projects p
          WHERE p.archived_at IS NULL
            AND (${fields.map((f) => `lower(coalesce(${f}, '')) LIKE ?`).join(' OR ')})${companySql}
          ORDER BY coalesce(p.start_date, '') DESC, p.id DESC
          LIMIT 60`,
      )
      .bind(...fields.map(() => like))
      .all<Record<string, unknown>>();
    return ((res.results ?? []) as Array<Record<string, unknown>>).map(toEventRow).filter((e) => Number.isFinite(e.id));
  }
  const res = await db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM projects p
        WHERE p.archived_at IS NULL
          AND p.start_date IS NOT NULL
          AND p.start_date <= ?
          AND coalesce(p.end_date, p.start_date) >= ?${companySql}
        ORDER BY p.start_date, p.id
        LIMIT 400`,
    )
    .bind(shiftDay(opts.around, EVENT_WINDOW_AFTER_DAYS), shiftDay(opts.around, -EVENT_WINDOW_BEFORE_DAYS))
    .all<Record<string, unknown>>();
  return ((res.results ?? []) as Array<Record<string, unknown>>).map(toEventRow).filter((e) => Number.isFinite(e.id));
}
