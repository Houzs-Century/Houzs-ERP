// ----------------------------------------------------------------------------
// fair-audit — a History row for every change of an order's fair (owner
// 2026-10-16: re-assigns by Finance / PMS need an audit trail; 2026-10-19:
// salespeople see it in History too).
//
// Until now no fair change was recorded anywhere: the header edit's differ maps
// venue but not `project_id`, the settle screen wrote none, and the brand
// re-detect and the nightly reconcile moved links silently. Every writer now
// calls `recordFairChange` with the state before and after, and History reads
// "Fair: MID VALLEY — REX (10/15 - 10/18) · AKEMI → …" — the FAIR's name and
// the booth's brand, never a project id (owner: the order shows the fair name).
//
// Best-effort like every audit write here (so-audit.ts): it never blocks or
// fails the change it records.
// ----------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import { recordSoAudit } from './so-audit';
import { fairOptionLabel, linkedFairOf, type FairProjectRow } from './fair-options';
import { loadFairsByIds, type FairDb } from './fair-binding';

export type FairState = { projectId: number | null; fairMatch: string | null };

/** Who / what moved the fair — the History row's `source`. `transfer` is a
 *  person moving orders to the right project by hand (owner 2026-10-20). */
export type FairChangeHow = 'scan' | 'edit' | 'settle' | 'brand' | 'nightly' | 'transfer';

/** The order's fair columns as a state. */
export function fairStateOf(row: { project_id?: unknown; fair_match?: unknown }): FairState {
  const id = row.project_id == null ? null : Number(row.project_id);
  return {
    projectId: id != null && Number.isInteger(id) ? id : null,
    fairMatch: typeof row.fair_match === 'string' ? row.fair_match : null,
  };
}

const UNLINKED: Record<string, string> = {
  NO_FAIR: 'No fair',
  PENDING: 'Not linked (no fair found)',
  AMBIGUOUS: 'Not linked (two booths fit)',
  UNMATCHED: 'Not linked (no booth for the brand)',
};

/** One state as History shows it. */
export function fairStateLabel(state: FairState, booth: FairProjectRow | undefined): string {
  if (state.projectId != null) {
    const fair = booth ? linkedFairOf(booth) : null;
    if (!fair) return `Fair #${state.projectId}`;
    const brand = (booth?.brand ?? '').trim();
    return `${fairOptionLabel(fair)}${brand ? ` · ${brand}` : ''}`;
  }
  return UNLINKED[state.fairMatch ?? ''] ?? 'Not linked';
}

/**
 * Append the History row for one fair change. Nothing is written when the
 * state did not change.
 *
 * @param actorId   scm.staff id of the person (the bridge's `user.id`), or null
 *                  for the nightly reconcile.
 * @param actorName Their display name; null lets so-audit look it up.
 * @param note      Why, when a rule decided it (e.g. the scan's step).
 * @param also      Other fields the same move changed (a transfer's Venue and
 *                  Fair Day), in the same History row.
 */
export async function recordFairChange(args: {
  sb: SupabaseClient;
  db: FairDb;
  companySql: string;
  docNo: string;
  before: FairState;
  after: FairState;
  how: FairChangeHow;
  actorId: string | null;
  actorName: string | null;
  note?: string;
  also?: Array<{ field: string; from: string | null; to: string | null }>;
}): Promise<void> {
  const { before, after } = args;
  if (before.projectId === after.projectId && before.fairMatch === after.fairMatch) return;
  try {
    const ids = [before.projectId, after.projectId].filter((v): v is number => v != null);
    const booths = await loadFairsByIds(args.db, args.companySql, ids).catch(() => new Map<number, FairProjectRow>());
    await recordSoAudit(args.sb, {
      docNo: args.docNo,
      action: 'UPDATE_FAIR',
      actorId: args.actorId,
      actorName: args.actorName,
      fieldChanges: [{
        field: 'fair',
        from: fairStateLabel(before, before.projectId != null ? booths.get(before.projectId) : undefined),
        to: fairStateLabel(after, after.projectId != null ? booths.get(after.projectId) : undefined),
      }, ...(args.also ?? []).filter((c) => (c.from ?? '') !== (c.to ?? ''))],
      source: args.how,
      ...(args.note ? { note: args.note } : {}),
    });
  } catch {
    /* Audit never blocks the change it records (so-audit.ts). */
  }
}
