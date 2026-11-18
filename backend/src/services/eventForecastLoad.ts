// ----------------------------------------------------------------------------
// eventForecastLoad.ts — the reads behind the three-layer Financial Snapshot
// (services/eventForecast.ts holds the rules; owner 2026-11-18).
//
//   readForecasts      the typed figures (project_forecast), by event.
//   findLastEvents     the earlier same-organiser-venue-and-brand event, by event.
//   loadDetailLayers   the event page: layers + the last event's Expo Map.
//
// These run on env.DB (the D1-compatible connection over the same Postgres),
// because the event page and Project Overview read everything else that way and
// their suites run on the D1 test mirror. The WRITES are Drizzle
// (routes/projectForecast.ts).
//
// Company scope: every read carries the company of the event being read (a
// forecast row is reached through its project's company_id, not its own copy).
// ----------------------------------------------------------------------------

import type { Env } from '../types';
import type { EventPnl } from './eventPnl';
import { pnlAndLinesForProjects } from './eventPnlBatch';
import {
  isForecastLine, lastEventValues, layerPnl, pickLastEvent, usesLastEvent,
  type BaselineCandidate, type ForecastLayers, type ForecastLine,
} from './eventForecast';
import { todayMyt } from '../scm/lib/my-time';

type Db = Env['DB'];
export type ForecastMap = Map<number, Partial<Record<ForecastLine, number>>>;

/** The typed forecast per event and line, in RM. Throws on a failed read. */
export async function readForecasts(db: Db, projectIds: readonly number[], companyId: number | null): Promise<ForecastMap> {
  const out: ForecastMap = new Map();
  const ids = [...new Set(projectIds)].filter(Number.isInteger);
  if (ids.length === 0 || companyId == null) return out;
  const res = await db.prepare(
    `SELECT f.project_id, f.line_key, f.amount_sen
       FROM project_forecast f JOIN projects p ON p.id = f.project_id
      WHERE p.company_id = ? AND f.project_id IN (${ids.map(() => '?').join(', ')})`,
  ).bind(companyId, ...ids).all<{ project_id: number | string; line_key: string; amount_sen: number | string }>();
  for (const r of res.results) {
    if (!isForecastLine(r.line_key)) continue;
    const id = Number(r.project_id);
    const m = out.get(id) ?? {};
    m[r.line_key] = Number(r.amount_sen) / 100;
    out.set(id, m);
  }
  return out;
}

export type LastEventRow = BaselineCandidate & { code: string | null; name: string | null; total_sales: number | null };

/** The last event of ONE event (pickLastEvent's rule, narrowed in SQL to the same
 *  company, organiser, venue and brand first). Throws on a failed read. */
export async function findLastEvent(db: Db, current: BaselineCandidate): Promise<LastEventRow | null> {
  if (current.company_id == null || !current.organizer?.trim() || !current.venue?.trim() || !current.brand?.trim() || !current.start_date) return null;
  const res = await db.prepare(
    `SELECT p.id, p.company_id, p.organizer, p.venue, p.start_date, p.code, p.name, p.brand,
            (SELECT f.total_sales FROM project_finance f WHERE f.project_id = p.id LIMIT 1) AS total_sales
       FROM projects p
      WHERE p.company_id = ? AND p.id <> ? AND p.archived_at IS NULL AND COALESCE(p.status, '') <> 'cancelled'
        AND lower(trim(p.organizer)) = lower(trim(?)) AND lower(trim(p.venue)) = lower(trim(?)) AND lower(trim(p.brand)) = lower(trim(?))
        AND substr(p.start_date, 1, 10) < substr(?, 1, 10)
      ORDER BY p.start_date DESC, p.id DESC LIMIT 5`,
  ).bind(current.company_id, current.id, current.organizer, current.venue, current.brand, current.start_date).all<LastEventRow>();
  return pickLastEvent(current, res.results.map((r) => ({ ...r, id: Number(r.id), company_id: Number(r.company_id) })));
}

/* ── The Expo Map reference ──────────────────────────────────────────────── */

export type ExpoMapFile = { id: number; file_name: string; r2_key: string; item_title: string };
const isExpoItem = (title: string | null, section: string | null): boolean =>
  /^(blank|filled) floorplan/i.test((title ?? '').trim()) || /^expo map/i.test((section ?? '').trim());

/** True when the event's own Expo Map items carry a file. */
export function hasExpoMapFiles(
  checklist: ReadonlyArray<{ id: number; title?: string | null; section_id?: number | null }>,
  sections: ReadonlyArray<{ id: number; name: string }>,
  attachments: ReadonlyArray<{ item_id: number }>,
): boolean {
  const sectionName = new Map(sections.map((s) => [Number(s.id), s.name]));
  const expoIds = new Set(checklist.filter((c) => isExpoItem(c.title ?? null, sectionName.get(Number(c.section_id)) ?? null)).map((c) => Number(c.id)));
  return attachments.some((a) => expoIds.has(Number(a.item_id)));
}

/** The files on an event's Expo Map items. Throws on a failed read. */
export async function readExpoMapFiles(db: Db, projectId: number): Promise<ExpoMapFile[]> {
  const res = await db.prepare(
    `SELECT a.id, a.file_name, a.r2_key, c.title AS item_title, s.name AS section_name
       FROM project_checklist_attachments a
       JOIN project_checklist c ON c.id = a.item_id
       LEFT JOIN project_checklist_sections s ON s.id = c.section_id
      WHERE c.project_id = ? AND a.archived_at IS NULL
      ORDER BY c.seq, c.id, a.id`,
  ).bind(projectId).all<ExpoMapFile & { section_name: string | null }>();
  return res.results
    .filter((r) => isExpoItem(r.item_title, r.section_name))
    .map((r) => ({ id: Number(r.id), file_name: r.file_name, r2_key: r.r2_key, item_title: r.item_title }));
}

/* ── The event page ──────────────────────────────────────────────────────── */

export type DetailForecast = ForecastLayers & {
  last_event: { id: number; code: string | null; name: string | null; start_date: string | null } | null;
  /** Why the last event's figures could not be read; null when they were. */
  last_event_error: string | null;
};
/** The last event's Expo Map files, shown while this event has none of its own.
 *  Apart from the money, so it is not stripped with it. */
export type LastEventExpoMap = { last_event: { id: number; code: string | null; name: string | null }; files: ExpoMapFile[] };

/**
 * The event page's layers over its By Total Sales column (null when the page
 * has no P&L — its orders or rate card could not be read), and the last event's
 * Expo Map. A failed read of the forecasts, the last event or its Expo Map
 * throws, like the rest of the page; a failed read of the last event's P&L is
 * reported in `last_event_error`.
 */
export async function loadDetailLayers(
  env: Env,
  project: BaselineCandidate & { end_date: string | null },
  pnl: EventPnl | null,
  booksRows: readonly string[],
  /** The event's own checklist rows, sections and task attachments, as the page read them. */
  own: { checklist: readonly unknown[]; sections: readonly unknown[]; attachments: readonly unknown[] },
  costCategories: readonly string[],
): Promise<{ forecast: DetailForecast | null; expoMap: LastEventExpoMap | null }> {
  const [forecasts, last] = await Promise.all([
    readForecasts(env.DB, [project.id], project.company_id),
    findLastEvent(env.DB, project),
  ]);
  let lastValues: Partial<Record<ForecastLine, number>> | null = null;
  let lastError: string | null = null;
  let expoMap: LastEventExpoMap | null = null;
  if (last) {
    const [read, files] = await Promise.all([
      pnl ? pnlAndLinesForProjects(env, [{ id: last.id, brand: last.brand, total_sales: last.total_sales }], last.company_id, costCategories) : null,
      hasExpoMapFiles(
        own.checklist as ReadonlyArray<{ id: number; title?: string | null; section_id?: number | null }>,
        own.sections as ReadonlyArray<{ id: number; name: string }>,
        own.attachments as ReadonlyArray<{ item_id: number }>,
      ) ? Promise.resolve([]) : readExpoMapFiles(env.DB, last.id),
    ]);
    const got = read?.ok ? read.byId.get(last.id) : undefined;
    if (got) lastValues = lastEventValues(got.pnl.by_sales, new Set(got.booksRows));
    else if (read) lastError = read.ok ? 'no figures' : read.reason;
    if (files.length > 0) expoMap = { last_event: { id: last.id, code: last.code, name: last.name }, files };
  }
  if (!pnl) return { forecast: null, expoMap };
  const layers = layerPnl({
    col: pnl.by_sales,
    booksRows: new Set(booksRows),
    forecast: forecasts.get(project.id) ?? {},
    lastEvent: lastValues,
    useLastEvent: usesLastEvent(project, todayMyt()),
  });
  return {
    forecast: {
      ...layers,
      last_event: last ? { id: last.id, code: last.code, name: last.name, start_date: last.start_date } : null,
      last_event_error: lastError,
    },
    expoMap,
  };
}
