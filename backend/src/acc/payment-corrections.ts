/* Payment corrections — what Finance changed, why, and what it did to the books.

   Owner 2026-09-10, after the amend right shipped (docs/bugs/0780): 「可以有一个
   report 在我 finance 模块这里关于我更改的吗？要写 reason 错什么」. Two rules he
   then fixed: a reason is owed ONLY when the amend right is what opened the door
   (「靠权限改的来决定」— a same-day fix by whoever keyed it stays 任意更改), and
   the report lists only those corrections.

   No new table. A correction is already an `mfg_so_audit_log` row
   (UPDATE_PAYMENT / DELETE_PAYMENT); this module marks the ones made on the
   amend right with `source = 'amend'`, puts the typed reason in `note`, and
   adds two field changes — `ledger`, the original entry → the one booked in
   its place, and `ledgerReversal`, the contra that voided the original — so
   the SO's own audit history shows the same facts the report does. The report
   is then a filtered read of that log.

   This file is pure. The route reads the rows; `paymentCorrectionsReport`
   decides what they mean. */

import type { FieldChange } from '../scm/lib/so-audit';
import type { LedgerTouch } from '../scm/lib/so-payment-row';

/** The `source` an audit row carries when the amend right made the change. */
export const AMEND_SOURCE = 'amend';

/** The field-change name that says what REPLACED what on the ledger: the
    original entry → the entry booked in its place (null on a delete). */
export const LEDGER_FIELD = 'ledger';
/** The contra that voided the original — its own change, because a reader
    who sees only "0099 → 0100" takes 0099 for the entry that was reversed,
    when 0099 IS the reversal (owner, 2026-09-10: 不明白; docs/bugs/0786). */
export const LEDGER_REVERSAL_FIELD = 'ledgerReversal';

/** The refusal both routes answer when a correction on the amend right arrives
    with no reason. Plain sentence, no braces, no bare code — it is shown. */
export const REASON_REQUIRED = {
  error: 'reason_required',
  reason: 'Say why this payment is being corrected. Finance keeps a record of every '
    + 'correction made after the day it was keyed in.',
} as const;

/** The audit field changes describing what the correction did to the ledger:
    `ledger` original → new, and `ledgerReversal` naming the contra when one
    was written. Nothing when it touched nothing — a never-booked payment
    reverses no entry and an audit row must not claim otherwise. */
export function ledgerFieldChange(touch: LedgerTouch): FieldChange[] {
  if (touch.originalJeNo == null && touch.contraJeNo == null && touch.jeNo == null) return [];
  const out: FieldChange[] = [{ field: LEDGER_FIELD, from: touch.originalJeNo, to: touch.jeNo }];
  if (touch.contraJeNo != null) out.push({ field: LEDGER_REVERSAL_FIELD, from: null, to: touch.contraJeNo });
  return out;
}

/* ── The report ──────────────────────────────────────────────────────────── */

/** An `mfg_so_audit_log` row, as the route reads it. */
export type CorrectionAuditRow = {
  id: string;
  so_doc_no: string;
  action: string;
  actor_name_snapshot: string | null;
  field_changes: unknown;
  note: string | null;
  created_at: string;
};

export type CorrectionChange = { field: string; from: unknown; to: unknown };

export type CorrectionRow = {
  id: string;
  /** When the correction was made (ISO, as stored). */
  at: string;
  by: string;
  docNo: string;
  /** The order's customer, when the order could be read. */
  customer: string | null;
  kind: 'edited' | 'deleted';
  /** What moved, from → to, the ledger pair excluded — it has its own fields. */
  changes: CorrectionChange[];
  /** The money before and after. For a delete, `to` is null. Null on an edit
      that did not touch the amount. */
  amountFromSen: number | null;
  amountToSen: number | null;
  reason: string;
  /** The entry that was voided. Null on a first booking — and on the one row
      written before the contra had its own change, where `ledger.from` was
      the contra and the original was not recorded. */
  originalJeNo: string | null;
  /** The contra that voided it. */
  contraJeNo: string | null;
  /** The entry booked in its place. Null on a delete. */
  jeNo: string | null;
};

export type CorrectionsSummary = {
  corrections: number;
  edited: number;
  deleted: number;
  /** Σ (after − before) over edits that moved the amount, minus every deleted
      amount: what the corrections did to money received, net. */
  netMovedSen: number;
  deletedSen: number;
};

export type CorrectionsReport = { rows: CorrectionRow[]; summary: CorrectionsSummary };

const senOf = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

const changesOf = (raw: unknown): CorrectionChange[] => {
  if (!Array.isArray(raw)) return [];
  const out: CorrectionChange[] = [];
  for (const c of raw) {
    if (c && typeof c === 'object' && typeof (c as { field?: unknown }).field === 'string') {
      const r = c as { field: string; from?: unknown; to?: unknown };
      out.push({ field: r.field, from: r.from ?? null, to: r.to ?? null });
    }
  }
  return out;
};

/**
 * Shape the amend-sourced audit rows into the report. The route has already
 * filtered to `source = 'amend'` and the two payment actions; this decides
 * what each row says, and adds the numbers the summary cards show.
 *
 * Newest first — the correction made this morning is the one being asked
 * about, and the report is read from the top.
 */
export function paymentCorrectionsReport(
  audits: CorrectionAuditRow[],
  customerByDoc: ReadonlyMap<string, string | null>,
): CorrectionsReport {
  const rows: CorrectionRow[] = [];
  for (const a of audits) {
    const kind: CorrectionRow['kind'] = a.action === 'DELETE_PAYMENT' ? 'deleted' : 'edited';
    const all = changesOf(a.field_changes);
    const ledger = all.find((c) => c.field === LEDGER_FIELD);
    const reversal = all.find((c) => c.field === LEDGER_REVERSAL_FIELD);
    const changes = all.filter((c) => c.field !== LEDGER_FIELD && c.field !== LEDGER_REVERSAL_FIELD);
    const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
    /* LEGACY: the first row ever written (2026-09-10, 2990-SO-2606-043) carried
       the CONTRA in `ledger.from` and had no `ledgerReversal`. Read it as what
       it is — a reversal with the original unknown — never as an original. */
    const legacy = reversal === undefined && ledger !== undefined && str(ledger.from) !== null;
    const amount = changes.find((c) => c.field === 'amountSen');
    rows.push({
      id: a.id,
      at: a.created_at,
      by: a.actor_name_snapshot ?? '—',
      docNo: a.so_doc_no,
      customer: customerByDoc.get(a.so_doc_no) ?? null,
      kind,
      changes,
      amountFromSen: amount ? senOf(amount.from) : null,
      amountToSen: amount ? senOf(amount.to) : null,
      reason: String(a.note ?? '').trim(),
      originalJeNo: legacy ? null : (ledger ? str(ledger.from) : null),
      contraJeNo: legacy ? str(ledger.from) : (reversal ? str(reversal.to) : null),
      jeNo: ledger ? str(ledger.to) : null,
    });
  }
  rows.sort((x, y) => y.at.localeCompare(x.at) || y.id.localeCompare(x.id));

  const summary: CorrectionsSummary = { corrections: rows.length, edited: 0, deleted: 0, netMovedSen: 0, deletedSen: 0 };
  for (const r of rows) {
    if (r.kind === 'deleted') {
      summary.deleted += 1;
      const gone = r.amountFromSen ?? 0;
      summary.deletedSen += gone;
      summary.netMovedSen -= gone;
    } else {
      summary.edited += 1;
      if (r.amountFromSen != null && r.amountToSen != null) summary.netMovedSen += r.amountToSen - r.amountFromSen;
    }
  }
  return { rows, summary };
}
