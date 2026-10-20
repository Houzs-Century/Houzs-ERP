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
//                           Sales Attending (or PIC). A draft cannot be confirmed
//                           until PMS adds them (fair-binding.ts::
//                           fairConfirmProblems); a confirmed order that moved to
//                           another brand's booth is listed so PMS can add them.
//
// Both are read from the order and PMS as they are NOW. Nothing is stored, so
// re-linking, correcting the venue or PMS adding the person clears the row at
// once — there is no flag to forget to reset.
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll, type PageResult } from './paginate-all';
import {
  attendingNote,
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

/** Linked orders are checked from the day Houzs opened its books in the ERP —
 *  the same line the unlinked list draws. */
export const FAIR_CHECKS_FROM = NO_VERDICT_LISTED_FROM;

/** A CONFIRMED scan is checked for Sales Attending only from the day the scan
 *  rule went live (#4736); before it nobody had to be on the booth. A DRAFT is
 *  checked whatever its date — it cannot be confirmed without it. */
export const SCAN_RULE_FROM = '2026-10-19';

export type FairCheck = 'VENUE_DIFFERS' | 'NEEDS_ATTENDING';
export type FairCheckRow = FairPendingRow & { check: FairCheck; note: string };

type ScanJob = { so_doc_no: string; houzs_user_id: number | string | null; created_at: string | null };

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
    const linked = await paginateAll<FairPendingRow>((from, to) =>
      scope(
        sb.from('mfg_sales_orders').select(FAIR_PENDING_COLUMNS)
          .not('project_id', 'is', null)
          .neq('status', 'CANCELLED')
          .gte('so_date', FAIR_CHECKS_FROM)
          .order('so_date', { ascending: false }),
      ).range(from, to) as PromiseLike<PageResult<FairPendingRow>>,
    );
    if (linked.error) return { ok: false };
    const orders = (linked.data ?? []).filter((o) => o.project_id != null);
    const booths = await loadFairsByIds(db, companySql, orders.map((o) => Number(o.project_id)));
    const boothOf = (o: FairPendingRow): FairProjectRow | undefined => booths.get(Number(o.project_id));

    const differs = orders.filter((o) => {
      const b = boothOf(o);
      return !!(o.venue ?? '').trim() && !!b?.venue && !sameVenue(o.venue, b.venue);
    });
    const attendCandidates = orders.filter((o) => o.status === 'DRAFT' || String(o.so_date ?? '') >= SCAN_RULE_FROM);

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
          note: attendingNote(boothOf(o)!, names.get(scanner) ?? 'The person who scanned it', o.status === 'DRAFT'),
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
