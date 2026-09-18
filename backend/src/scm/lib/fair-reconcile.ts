// ----------------------------------------------------------------------------
// fair-reconcile.ts — the nightly second pass at linking orders to their fair.
//
// WHY THIS EXISTS, in the owner's terms (2026-09-13): *"有时候 venue 是这个星期
// 六，但有时候他们星期三才会 confirm"* — the exhibition is often not in the system
// when the order is written. Measured the same day over Jun-Sep 2026, Houzs
// Century: of 114 fairs, 9 reached PMS 4-7 days before opening, 4 within 3 days,
// and 13 only AFTER they had already started. That is 23% of fairs where a
// salesperson standing on the floor cannot pick their own event.
//
// The order is never blocked for it. It records the PLACE (via Others, which is
// a pick from the venue master, never typing) and `fair_match = 'PENDING'`. This
// job runs once a day and tries again. When the fair finally exists, the link
// appears without anyone re-opening the order.
//
// It runs INSIDE the Worker rather than as a repair script on purpose: the rule
// that decides which booth an order belongs to lives in `fair-options.ts`, and a
// .mjs script would have to re-implement it. A second copy of a rule that
// decides exhibition P&L is the exact failure this repo keeps paying for.
//
// SAFE TO RE-RUN. It only ever reads rows whose `fair_match` is PENDING and only
// ever writes a row it could resolve — a settled order is never revisited, and a
// human decision (PICKED, or a cleared link) is never overwritten.
// ----------------------------------------------------------------------------

import { getSupabaseService } from '../../db/supabase';
import type { Env } from '../env';
import { resolveFairForSave, type FairDb } from './fair-binding';
import type { FairMatch } from './fair-options';

export type FairReconcileResult = {
  scanned: number;
  linked: number;
  /** Still waiting for the fair to be created. The normal outcome for an order
   *  written at an event PMS has not caught up with yet. */
  stillPending: number;
  /** Needs a person: two booths fit, or the order's brand has no booth there. */
  needsAPerson: number;
  skipped: number;
};

const EMPTY: FairReconcileResult = {
  scanned: 0, linked: 0, stillPending: 0, needsAPerson: 0, skipped: 0,
};

type PendingRow = {
  doc_no?: string; docNo?: string;
  so_date?: string | null; soDate?: string | null;
  venue?: string | null;
  branding?: string | null;
  company_id?: number | null; companyId?: number | null;
};

/**
 * One pass over the PENDING backlog.
 *
 * @param limit Bounded so a cron slot cannot run long on a bad day. The backlog
 *   is naturally small (orders written at not-yet-created fairs) and anything
 *   left over is picked up by the next run.
 */
export async function reconcilePendingFairs(
  env: Env,
  opts?: { limit?: number },
): Promise<FairReconcileResult> {
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
  let sb: ReturnType<typeof getSupabaseService>;
  try {
    sb = getSupabaseService(env);
  } catch {
    /* No SUPABASE_* secrets on this deployment — the job is simply dark, which
       is a legitimate state and must not throw inside a cron slot. */
    return EMPTY;
  }

  const { data, error } = await sb
    .from('mfg_sales_orders')
    .select('doc_no, so_date, venue, branding, company_id')
    .eq('fair_match', 'PENDING')
    .order('so_date', { ascending: false })
    .limit(limit);
  if (error) return EMPTY;

  const out: FairReconcileResult = { ...EMPTY, scanned: (data as PendingRow[]).length };

  for (const raw of data as PendingRow[]) {
    const docNo = raw.doc_no ?? raw.docNo ?? null;
    const venue = (raw.venue ?? '').trim();
    const soDate = String(raw.so_date ?? raw.soDate ?? '').slice(0, 10);
    const companyId = Number(raw.company_id ?? raw.companyId ?? NaN);
    /* A row with no document, no place, no date or no company cannot be
       resolved and must not be guessed at. Counted as skipped so a backlog that
       is going nowhere is visible in the log rather than silently "scanned". */
    if (!docNo || !venue || !/^\d{4}-\d{2}-\d{2}$/.test(soDate) || !Number.isInteger(companyId)) {
      out.skipped += 1;
      continue;
    }

    /* The ROW's own company is the tenant boundary here — a cron has no active
       company context, and `projects` would otherwise be read unscoped. */
    const fair = await resolveFairForSave({
      db: env.DB as unknown as FairDb,
      companySql: ` AND p.company_id = ${companyId}`,
      venue,
      /* No organizer: the order recorded a place, which is what the Others path
         captures. Venue + date + brand resolves uniquely except where two
         organizers share one venue on one day — 3 days in all of 2026 — and
         those come back AMBIGUOUS for a person rather than being guessed. */
      organizer: null,
      soDate,
      brand: raw.branding ?? null,
    });

    const match: FairMatch = fair.match;
    if (match === 'PENDING') { out.stillPending += 1; continue; }

    const patch =
      fair.projectId != null
        ? { project_id: fair.projectId, fair_match: 'PICKED' }
        : { fair_match: match };
    /* Scoped on the write as well as the read: nothing re-checks between two
       PostgREST round trips, and a scoped-read-then-open-update is exactly the
       shape that shipped across this system once already. */
    const { error: updErr } = await sb
      .from('mfg_sales_orders')
      .update(patch)
      .eq('doc_no', docNo)
      .eq('company_id', companyId);
    if (updErr) { out.skipped += 1; continue; }
    if (fair.projectId != null) out.linked += 1;
    else out.needsAPerson += 1;
  }

  return out;
}
