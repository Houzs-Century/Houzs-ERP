// ----------------------------------------------------------------------------
// fair-checks — the LINKED orders the "Fair Links to Settle" page also lists,
// in two groups of their own (owner 2026-10-19):
//
//   要查  VENUE_DIFFERS     the venue on the order is not where the order was
//                           placed: a scan its slip's place could not place (it
//                           fell back to the scanner's fair today / latest), or
//                           an older link the old cross-venue fallback made.
//                           Re-link it to the fair at its venue, or leave it.
//   等加人 NEEDS_ATTENDING  a SCANNED order whose scanner is not on its booth's
//                           Sales Attending (or PIC), listed so PMS can add them.
//                           It no longer stops Confirm (owner 2026-10-22: 「…不能
//                           开单的帮我remove 掉这个rule先。但扫描单还是能认」).
//
// The EVENING SALES REPORT (project chat) outranks the slip's place (owner
// 2026-10-20, routes/lib/sales-report-evidence.ts):
//
//   REPORT_ELSEWHERE  another fair's report lists the order (linked elsewhere
//                     or to nothing) — `target` is where to move it; two
//                     fairs' reports both listing it leave `target` empty.
//   An order the report of ITS OWN fair lists is right: never 要查
//   (「对的上就不要显示 venue differs」). An order in REPORT_ELSEWHERE is not
//   listed again under 要查 or 等加人 — its fair is the thing to fix first.
//
// A REPORT_ELSEWHERE row carries both booths on two lines — where the order
// is now (`current`) and where the report puts it (`target`) — so the page
// shows one row per order (owner 2026-10-21: 这个表很乱).
//
// An order a person PUT ASIDE (fair-put-aside.ts) is in none of them.
//
// All are read from the order, PMS and the chat as they are NOW. Nothing is
// stored, so re-linking, correcting the venue or PMS adding the person clears
// the row at once — there is no flag to forget to reset.
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll, type PageResult } from './paginate-all';
import {
  attendingNote,
  fairOptionLabel,
  labelOrganizer,
  linkedFairOf,
  sameVenue,
  venueDiffersNote,
  venueDiffersReason,
  type FairProjectRow,
} from './fair-options';
import { keyerProjectIdsAmong, loadFairsAtVenue, loadFairsByIds, type FairDb } from './fair-binding';
import {
  FAIR_PENDING_COLUMNS,
  NO_VERDICT_LISTED_FROM,
  type FairPendingRow,
  type FairPendingScope,
} from './fair-pending';
import { fmtDayMonth, fmtDayMonthRange } from '../shared/format';
import { loadReportEvidence, reportVerdict, type ReportVerdict } from '../../routes/lib/sales-report-evidence';

/** Linked orders are checked from the day Houzs opened its books in the ERP —
 *  the same line the unlinked list draws. */
export const FAIR_CHECKS_FROM = NO_VERDICT_LISTED_FROM;

/** A CONFIRMED scan is checked for Sales Attending only from the day the scan
 *  rule went live (#4736); before it nobody had to be on the booth. A DRAFT is
 *  checked whatever its date. */
export const SCAN_RULE_FROM = '2026-10-19';

/** Reports are read from fairs that started a month before the first checked
 *  order — a bill is never reported at a fair later than its order. */
export const REPORTS_FROM = '2026-08-01';

export type FairCheck = 'VENUE_DIFFERS' | 'NEEDS_ATTENDING' | 'REPORT_ELSEWHERE';
/** One booth on two lines, as Project Overview names a project (owner
 *  2026-10-21): "[AKEMI] HOMELOVE" over "IOIGECC · 10/09 - 10/11". */
export type FairCheckBooth = { projectId: number; title: string; detail: string };
/** Where an evening report puts an order: the booth to move it to. `label` is
 *  the one-line name the page showed before the two lines. */
export type FairCheckTarget = FairCheckBooth & { label: string; reportDate: string | null };
export type FairCheckRow = FairPendingRow & {
  check: FairCheck;
  note: string;
  target?: FairCheckTarget | null;
  /** REPORT_ELSEWHERE: the booth the order is under now; null with none. */
  current?: FairCheckBooth | null;
  /** REPORT_ELSEWHERE with no target: the booths whose reports both list it. */
  candidates?: FairCheckBooth[];
};

type ScanJob = { so_doc_no: string; houzs_user_id: number | string | null; created_at: string | null };
/** The order as read here; its Ref No. is what the evening reports list. */
type CheckedOrder = FairPendingRow;

/** "AKEMI — IOIGECC — HOMELOVE (10/09 - 10/11)": one booth, as Fair Links
 *  names a choice. */
export function boothText(id: number, row: FairProjectRow | undefined): string {
  const fair = row ? linkedFairOf(row) : null;
  if (!fair) return `event #${id}`;
  return `${(row?.brand ?? '').trim() || 'No brand'} — ${fairOptionLabel(fair)}`;
}

/** "[AKEMI] HOMELOVE" over "IOIGECC · 10/09 - 10/11". A booth with no brand
 *  is named by its event; one PMS no longer has is "event #id". */
export function boothLines(id: number, row: FairProjectRow | undefined): FairCheckBooth {
  const fair = row ? linkedFairOf(row) : null;
  if (!fair) return { projectId: id, title: `event #${id}`, detail: '' };
  const brand = (row?.brand ?? '').trim();
  const event = labelOrganizer(fair);
  return { projectId: id, title: brand ? `[${brand}] ${event}` : event, detail: `${fair.venue} · ${fmtDayMonthRange(fair.startDate, fair.endDate)}` };
}

/** The REPORT_ELSEWHERE row for one order, or null when the reports do not
 *  put it elsewhere. */
function reportRow(o: CheckedOrder, v: ReportVerdict, booths: ReadonlyMap<number, FairProjectRow>): FairCheckRow | null {
  const nowId = o.project_id != null ? Number(o.project_id) : null;
  const now = nowId != null ? `the order is under ${boothText(nowId, booths.get(nowId))}` : 'the order has no event';
  const current = nowId != null ? boothLines(nowId, booths.get(nowId)) : null;
  if (v.kind === 'elsewhere') {
    const id = v.sighting.projectId;
    const label = boothText(id, booths.get(id));
    const on = v.sighting.reportDate ? ` on ${fmtDayMonth(v.sighting.reportDate)}` : '';
    return {
      ...o, check: 'REPORT_ELSEWHERE', current,
      target: { ...boothLines(id, booths.get(id)), label, reportDate: v.sighting.reportDate },
      note: `The evening report of ${label} lists it${on}; ${now}.`,
    };
  }
  if (v.kind === 'conflict') {
    return {
      ...o, check: 'REPORT_ELSEWHERE', current, target: null,
      candidates: v.projectIds.map((id) => boothLines(id, booths.get(id))),
      note: `The evening reports of ${v.projectIds.map((id) => boothText(id, booths.get(id))).join(' and ')} both list it; ${now}. Pick the right one on the order.`,
    };
  }
  return null;
}

/**
 * Both groups, newest first. Any failed read is a failure — never an empty
 * list, which the page would show as "nothing to check".
 */
export async function loadFairChecks(args: {
  sb: any;
  db: FairDb;
  companySql: string;
  scope: FairPendingScope;
}): Promise<{ ok: true; rows: FairCheckRow[] } | { ok: false }> {
  const { sb, db, companySql, scope } = args;
  try {
    const read = (linkedOnes: boolean) => paginateAll<CheckedOrder>((from, to) => {
      const q = sb.from('mfg_sales_orders').select(FAIR_PENDING_COLUMNS);
      return scope(
        (linkedOnes ? q.not('project_id', 'is', null) : q.is('project_id', null))
          .neq('status', 'CANCELLED')
          .is('fair_put_aside_at', null)
          .gte('so_date', FAIR_CHECKS_FROM)
          .order('so_date', { ascending: false }),
      ).range(from, to) as PromiseLike<PageResult<CheckedOrder>>;
    });
    const [linked, unlinked] = await Promise.all([read(true), read(false)]);
    if (linked.error || unlinked.error) return { ok: false };
    const orders = (linked.data ?? []).filter((o) => o.project_id != null);
    const evidence = await loadReportEvidence(db, companySql, { since: REPORTS_FROM });

    /* What the evening reports say about each order, linked or not. */
    const verdicts = new Map<string, ReportVerdict>();
    for (const o of [...orders, ...(unlinked.data ?? [])]) verdicts.set(o.doc_no, reportVerdict(o, evidence));
    const elsewhere = [...orders, ...(unlinked.data ?? [])].filter((o) => {
      const k = verdicts.get(o.doc_no)?.kind;
      return k === 'elsewhere' || k === 'conflict';
    });
    const inReport = new Set(elsewhere.map((o) => o.doc_no));
    const reportedIds = [...verdicts.values()].flatMap((v) =>
      v.kind === 'elsewhere' ? [v.sighting.projectId] : v.kind === 'conflict' ? v.projectIds : []);
    const booths = await loadFairsByIds(db, companySql, [...orders.map((o) => Number(o.project_id)), ...reportedIds]);
    const boothOf = (o: FairPendingRow): FairProjectRow | undefined => booths.get(Number(o.project_id));

    const differs = orders.filter((o) => {
      const b = boothOf(o);
      return !!(o.venue ?? '').trim() && !!b?.venue && !sameVenue(o.venue, b.venue)
        && verdicts.get(o.doc_no)?.kind !== 'confirmed' && !inReport.has(o.doc_no);
    });
    const attendCandidates = orders.filter((o) => !inReport.has(o.doc_no)
      && (o.status === 'DRAFT' || String(o.so_date ?? '') >= SCAN_RULE_FROM));

    /* Who scanned which order — the latest job per order wins (a re-scan). */
    const docNos = [...new Set([...differs, ...attendCandidates].map((o) => o.doc_no))];
    const jobs = await chunkIn<ScanJob>(docNos, (batch, from, to) =>
      scope(sb.from('scan_jobs').select('so_doc_no, houzs_user_id, created_at').in('so_doc_no', batch)).range(from, to),
    );
    if (jobs.error) return { ok: false };
    const scannerOf = new Map<string, number>();
    const seenAt = new Map<string, string>();
    for (const j of jobs.data) {
      const id = Number(j.houzs_user_id);
      if (!Number.isFinite(id)) continue;
      const at = String(j.created_at ?? '');
      if ((seenAt.get(j.so_doc_no) ?? '') > at) continue;
      seenAt.set(j.so_doc_no, at);
      scannerOf.set(j.so_doc_no, id);
    }

    const rows: FairCheckRow[] = [];

    /* The evening report puts it at another fair. */
    for (const o of elsewhere) {
      const row = reportRow(o, verdicts.get(o.doc_no)!, booths);
      if (row) rows.push(row);
    }

    /* 要查 — one PMS read per (place, date), shared by every order on it. */
    const reasonFor = new Map<string, string>();
    for (const o of differs) {
      const day = String(o.so_date ?? '').slice(0, 10);
      const key = `${(o.venue ?? '').trim().toLowerCase()}|${day}`;
      if (!reasonFor.has(key)) {
        reasonFor.set(key, venueDiffersReason(o.venue as string, day, await loadFairsAtVenue(db, companySql, o.venue as string, day)));
      }
      rows.push({
        ...o, check: 'VENUE_DIFFERS',
        note: venueDiffersNote({ orderVenue: o.venue as string, scanned: scannerOf.has(o.doc_no), placed: boothOf(o)!, reason: reasonFor.get(key)! }),
      });
    }

    /* 等加人 — one Sales Attending read per scanner. */
    const byScanner = new Map<number, FairPendingRow[]>();
    for (const o of attendCandidates) {
      const s = scannerOf.get(o.doc_no);
      if (s == null || !boothOf(o)) continue;
      const list = byScanner.get(s);
      if (list) list.push(o); else byScanner.set(s, [o]);
    }
    const names = await scannerNames(db, [...byScanner.keys()]);
    for (const [scanner, list] of byScanner) {
      const standing = await keyerProjectIdsAmong(db, companySql, scanner, list.map((o) => ({ projectId: Number(o.project_id) })));
      for (const o of list) {
        if (standing.has(Number(o.project_id))) continue;
        rows.push({
          ...o, check: 'NEEDS_ATTENDING',
          note: attendingNote(boothOf(o)!, names.get(scanner) ?? 'The person who scanned it'),
        });
      }
    }

    rows.sort((a, b) => String(b.so_date ?? '').localeCompare(String(a.so_date ?? '')) || String(b.doc_no).localeCompare(String(a.doc_no)));
    return { ok: true, rows };
  } catch {
    return { ok: false };
  }
}

async function scannerNames(db: FairDb, ids: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const res = await db
    .prepare(`SELECT u.id AS id, u.name AS name FROM users u WHERE u.id IN (${ids.map(() => '?').join(', ')})`)
    .bind(...ids)
    .all<Record<string, unknown>>();
  for (const r of (res.results ?? []) as Array<Record<string, unknown>>) {
    if (typeof r.name === 'string' && r.name.trim()) out.set(Number(r.id), r.name.trim());
  }
  return out;
}
