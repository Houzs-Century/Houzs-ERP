/* Payment corrections — what a holder of the correction right did to customer
   payments, why, who FIRST recorded each payment, and what it did to the books.

   Owner 2026-09-10, after the amend right shipped (docs/bugs/0780): 「可以有一个
   report 在我 finance 模块这里关于我更改的吗？要写 reason 错什么」. Two rules he
   then fixed: a reason is owed ONLY when the amend right is what opened the door
   (「靠权限改的来决定」— a same-day fix by whoever keyed it stays 任意更改), and
   the report lists only those corrections.

   Owner 2026-09-14 (docs/bugs/0888) widened the first rule and kept the second:
   「只要是有关 collection payment 的，我或有权限的用户做的动作都要记录写 reason」.
   A ROLE that holds `scm.so_payment.amend` LITERALLY — the `*` wildcard does
   not count (`hasPermissionLiterally`) — gives a reason for EVERY payment
   action on a sales order: recording one, changing one, removing one,
   attaching its proof; same day or not. Every such action is listed here,
   beside who first recorded the payment and on which day (「我就是要看原本是谁
   记录这一笔的」). A role without the key is as it was: a same-day fix by
   whoever keyed the payment owes nothing and is not listed; a correction the
   amend right opened (the Owner's wildcard, after the day) owes a reason as
   before and is listed as before.

   No new table. A payment action is already an `mfg_so_audit_log` row
   (ADD_PAYMENT / UPDATE_PAYMENT / DELETE_PAYMENT); the routes mark the ones
   made on the right with `source = 'amend'`, put the typed reason in `note`,
   tag the row with the payment it concerns (`payment_id`, migration
   20260914T1700), and on a correction add two field changes — `ledger`, the
   original entry → the one booked in its place, and `ledgerReversal`, the
   contra that voided the original — so the SO's own audit history shows the
   same facts the report does. The report is then a filtered read of that log.

   This file is pure. The route reads the rows; `paymentCorrectionsReport`
   decides what they mean. */

import type { FieldChange } from '../scm/lib/so-audit';
import type { LedgerTouch } from '../scm/lib/so-payment-row';

/** The `source` an audit row carries when the right made the change. */
export const AMEND_SOURCE = 'amend';

/** The field-change name that says what REPLACED what on the ledger: the
    original entry → the entry booked in its place (null on a delete). */
export const LEDGER_FIELD = 'ledger';
/** The contra that voided the original — its own change, because a reader
    who sees only "0099 → 0100" takes 0099 for the entry that was reversed,
    when 0099 IS the reversal (owner, 2026-09-10: 不明白; docs/bugs/0786). */
export const LEDGER_REVERSAL_FIELD = 'ledgerReversal';
/** The one field the proof route writes — what makes a row an attach, not an
    edit of the money. */
export const SLIP_FIELD = 'slipKey';

/** The refusal both correction routes answer when a correction on the amend
    right arrives with no reason. Plain sentence, no braces, no bare code — it
    is shown. */
export const REASON_REQUIRED = {
  error: 'reason_required',
  reason: 'Say why this payment is being corrected. Finance keeps a record of every '
    + 'correction made after the day it was keyed in.',
} as const;

/** The refusal for a caller whose ROLE holds the right: every payment action
    of theirs owes a reason, not only a late one (owner 2026-09-14). Under 200
    characters, like every refusal the client's sentence filter must keep. */
export const KEY_HOLDER_REASON_REQUIRED = {
  error: 'reason_required',
  reason: 'Say why. Your role holds the payment-correction right, so every payment you '
    + 'record, change, remove or attach proof to is listed on Accounting › Corrections with its reason.',
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


/** An `mfg_so_audit_log` row, as the route reads it. */
export type CorrectionAuditRow = {
  id: string;
  so_doc_no: string;
  action: string;
  actor_name_snapshot: string | null;
  field_changes: unknown;
  note: string | null;
  created_at: string;
  /** The payment the row concerns. Null on a row written before payments were
      tagged (docs/bugs/0888) — the report then reads the order's own
      ADD_PAYMENT rows for the recorder. */
  payment_id?: string | null;
  source?: string | null;
};

export type CorrectionChange = { field: string; from: unknown; to: unknown };

/** What the row did: recorded a payment, changed one, removed one, or attached
    (or replaced) its proof. */
export type CorrectionKind = 'added' | 'edited' | 'deleted' | 'proof';

export type CorrectionRow = {
  id: string;
  at: string;
  by: string;
  docNo: string;
  customer: string | null;
  kind: CorrectionKind;
  changes: CorrectionChange[];
  amountFromSen: number | null;
  amountToSen: number | null;
  reason: string;
  /** True when the row carries no reason because it predates the rule (owner
      2026-09-14: 规则之前) — the role holds the right today, the action was
      made when nothing asked it why. */
  beforeRule: boolean;
  recordedBy: string | null;
  recordedOn: string | null;
  originalJeNo: string | null;
  contraJeNo: string | null;
  jeNo: string | null;
};

export type CorrectionsSummary = {
  corrections: number;
  added: number;
  edited: number;
  deleted: number;
  proof: number;
  netMovedSen: number;
  addedSen: number;
  deletedSen: number;
};

export type CorrectionsReport = { rows: CorrectionRow[]; summary: CorrectionsSummary };

/** Who recorded a payment and when — as read off its ADD_PAYMENT audit row
    (`by` = the actor snapshot) or off the payment row itself (`by` = the
    collector's name). `by` is null when the row names nobody: an automation
    row with no actor, a payment with no collector. */
export type PaymentRecorder = { by: string | null; on: string };

/** The three reads that answer "who first recorded this payment", in the
    order the report tries them. All empty (`NO_RECORDERS`) is a valid answer
    — every row then reads as recorder unknown, never as a guess. */
export type RecorderLookup = {
  addsByPayment: ReadonlyMap<string, PaymentRecorder>;
  paymentsById: ReadonlyMap<string, PaymentRecorder>;
  addsByDoc: ReadonlyMap<string, ReadonlyArray<PaymentRecorder & { amountSen: number | null }>>;
};

export const NO_RECORDERS: RecorderLookup = {
  addsByPayment: new Map(), paymentsById: new Map(), addsByDoc: new Map(),
};

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

/** The amount an ADD_PAYMENT audit row recorded, off its own changes. */
export const addedAmountOf = (fieldChanges: unknown): number | null => {
  const amount = changesOf(fieldChanges).find((c) => c.field === 'amountSen');
  return amount ? senOf(amount.to) : null;
};

const kindOf = (action: string, changes: CorrectionChange[]): CorrectionKind => {
  if (action === 'ADD_PAYMENT') return 'added';
  if (action === 'DELETE_PAYMENT') return 'deleted';
  return changes.length > 0 && changes.every((c) => c.field === SLIP_FIELD) ? 'proof' : 'edited';
};

function recorderOf(
  a: CorrectionAuditRow, kind: CorrectionKind, amountFromSen: number | null, lookup: RecorderLookup,
): PaymentRecorder | null {
  if (kind === 'added') return { by: a.actor_name_snapshot ?? null, on: a.created_at };
  if (a.payment_id) {
    const add = lookup.addsByPayment.get(a.payment_id) ?? null;
    const pay = lookup.paymentsById.get(a.payment_id) ?? null;
    if (add && add.by) return add;
    if (pay) return { by: pay.by ?? add?.by ?? null, on: add?.on ?? pay.on };
    return add;
  }
  const before = (lookup.addsByDoc.get(a.so_doc_no) ?? []).filter((r) => r.on < a.created_at);
  if (amountFromSen != null) {
    const sameAmount = before.filter((r) => r.amountSen === amountFromSen);
    if (sameAmount.length === 1) return { by: sameAmount[0]!.by, on: sameAmount[0]!.on };
  }
  return before.length === 1 ? { by: before[0]!.by, on: before[0]!.on } : null;
}

/**
 * Shape the audit rows into the report. The route has already filtered to the
 * rows that belong here — `source = 'amend'`, plus the untagged rows a holder
 * of the right wrote before the rule — and the three payment actions; this
 * decides what each row says, names who first recorded its payment, and adds
 * the numbers the summary cards show.
 *
 * Newest first — the action made this morning is the one being asked about,
 * and the report is read from the top.
 */
export function paymentCorrectionsReport(
  audits: CorrectionAuditRow[],
  customerByDoc: ReadonlyMap<string, string | null>,
  recorders: RecorderLookup = NO_RECORDERS,
): CorrectionsReport {
  const rows: CorrectionRow[] = [];
  for (const a of audits) {
    const all = changesOf(a.field_changes);
    const ledger = all.find((c) => c.field === LEDGER_FIELD);
    const reversal = all.find((c) => c.field === LEDGER_REVERSAL_FIELD);
    const changes = all.filter((c) => c.field !== LEDGER_FIELD && c.field !== LEDGER_REVERSAL_FIELD);
    const kind = kindOf(a.action, changes);
    const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
    const legacy = reversal === undefined && ledger !== undefined && str(ledger.from) !== null;
    const amount = changes.find((c) => c.field === 'amountSen');
    const amountFromSen = amount ? senOf(amount.from) : null;
    const onRight = a.source === AMEND_SOURCE;
    const recorder = recorderOf(a, kind, amountFromSen, recorders);
    rows.push({
      id: a.id,
      at: a.created_at,
      by: a.actor_name_snapshot ?? '—',
      docNo: a.so_doc_no,
      customer: customerByDoc.get(a.so_doc_no) ?? null,
      kind,
      changes,
      amountFromSen,
      amountToSen: amount ? senOf(amount.to) : null,
      reason: onRight ? String(a.note ?? '').trim() : '',
      beforeRule: !onRight,
      recordedBy: recorder?.by ?? null,
      recordedOn: recorder?.on ?? null,
      originalJeNo: legacy ? null : (ledger ? str(ledger.from) : null),
      contraJeNo: legacy ? str(ledger.from) : (reversal ? str(reversal.to) : null),
      jeNo: ledger ? str(ledger.to) : null,
    });
  }
  rows.sort((x, y) => y.at.localeCompare(x.at) || y.id.localeCompare(x.id));

  const summary: CorrectionsSummary = {
    corrections: rows.length, added: 0, edited: 0, deleted: 0, proof: 0, netMovedSen: 0, addedSen: 0, deletedSen: 0,
  };
  for (const r of rows) {
    if (r.kind === 'added') {
      summary.added += 1;
      const got = r.amountToSen ?? 0;
      summary.addedSen += got;
      summary.netMovedSen += got;
    } else if (r.kind === 'deleted') {
      summary.deleted += 1;
      const gone = r.amountFromSen ?? 0;
      summary.deletedSen += gone;
      summary.netMovedSen -= gone;
    } else if (r.kind === 'proof') {
      summary.proof += 1;
    } else {
      summary.edited += 1;
      if (r.amountFromSen != null && r.amountToSen != null) summary.netMovedSen += r.amountToSen - r.amountFromSen;
    }
  }
  return { rows, summary };
}
