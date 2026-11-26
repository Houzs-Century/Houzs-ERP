import type { PostPiResult } from '../routes/accounting';

export type PiLedgerOutcome =
  | { posted: true; status: 'posted' | 'already_posted'; jeNo: string }
  | { posted: false; status: 'migrated_source'; reason: null }
  | { posted: false; status: Exclude<PostPiResult['status'], 'posted' | 'already_posted' | 'migrated_source'>; reason: string | null };

export function piLedgerOutcome(r: PostPiResult): PiLedgerOutcome {
  if (r.ok) {
    if (r.status === 'migrated_source') return { posted: false, status: 'migrated_source', reason: null };
    return { posted: true, status: r.status, jeNo: r.jeNo };
  }
  return { posted: false, status: r.status, reason: r.reason ?? null };
}
