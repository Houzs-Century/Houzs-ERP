// ----------------------------------------------------------------------------
// ReceiptForm — a receipt's form in place of its list or its page (the owner's
// Claude Design, batch 5 §2.1, the design's receipt form): sundry income — who
// paid, into which money account, the lines and the account each credits — or
// an other debtor's money — the debtor, the money account, and what the debtor
// still owes, a tick for a bill in full or an amount for part of it. The right
// column says the total, what the books will say, why it cannot save yet, and
// the buttons. F3 / Ctrl+S saves, as the old pop-out did.
//
// The form only gathers. Its caller sends what it gathered through the same
// routes as before — POST /receipts (or PATCH on an edit, which re-posts) for
// sundry income, POST /other-debtors/:id/receipts for a debtor's money (post
// now from Receipts; a draft for the four layers from Debtor maintenance) — so
// nothing posts differently.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Info, X } from 'lucide-react';
import { AddLineButton } from '../../../vendor/scm/components/AddLineButton';
import {
  useAccountRoles, useDebtorDetail, useOtherDebtors, type Account, type DebtorBill, type ReceiptDetail,
} from '../../../vendor/scm/lib/accounting-queries';
import { AccountSelect } from '../../../vendor/scm/components/AccountSelect';
import { DateField } from '../../../vendor/scm/components/DateField';
import { MoneyInput } from '../../../vendor/scm/components/MoneyInput';
import { useSaveHotkey, SAVE_HOTKEY_HINT } from '../../../vendor/scm/lib/use-save-hotkey';
import { fmtDate, fmtSen } from '../../../vendor/shared/format';
import ui from '../MoneyIn.module.css';

export type SundryLine = { rid: number; description: string; creditAccountCode: string; amountSen: number };
/** What the form starts from. A sundry receipt uses the payer and lines, a
 *  debtor's the debtor and the amounts per bill. */
export type ReceiptValues = {
  receiptDate: string;
  payerName: string;
  bankAccountCode: string;
  lines: SundryLine[];
  debtorId: string;
  /** Bill id → sen received on it. */
  alloc: Record<string, number>;
};
export type SundrySubmit = {
  receiptDate: string; payerName: string; bankAccountCode: string;
  lines: Array<{ description?: string; creditAccountCode: string; amountSen: number }>;
};
export type DebtorSubmit = {
  debtorId: string; receiptDate: string; bankAccountCode: string;
  allocations: Array<{ billId: string; amountSen: number }>;
};
/** How a debtor receipt is saved: posted at once (Receipts), or kept for the
 *  four layers as a draft or prepared (Debtor maintenance). */
export type DebtorSave = 'post' | 'draft' | 'prepare';

export const blankLine = (rid: number): SundryLine => ({ rid, description: '', creditAccountCode: '', amountSen: 0 });
export const blankReceipt = (today: string, debtorId = ''): ReceiptValues =>
  ({ receiptDate: today, payerName: '', bankAccountCode: '', lines: [blankLine(1)], debtorId, alloc: {} });
const mytToday = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/** A sundry receipt's form values from the receipt: an edit keeps its date, a
 *  copy starts today (Copy as new, on the list or the receipt's page). */
export const receiptValuesOf = (d: ReceiptDetail, copy: boolean): ReceiptValues => ({
  receiptDate: copy ? mytToday() : String(d.receipt.receipt_date).slice(0, 10),
  payerName: d.receipt.payer_name,
  bankAccountCode: d.receipt.bank_account_code,
  lines: d.lines.map((l, i) => ({ rid: i + 1, description: l.description ?? '', creditAccountCode: l.credit_account_code, amountSen: Number(l.amount_sen) })),
  debtorId: '', alloc: {},
});

/** A bill a debtor receipt may take money for: posted, not cancelled, something
 *  still owed — or already on this receipt (an edit). */
const isOpenBill = (b: DebtorBill, alloc: Record<string, number>): boolean =>
  String(b.status).toUpperCase() !== 'CANCELLED' && (Number(b.total_sen) - Number(b.received_sen) > 0 || (alloc[b.id] ?? 0) > 0);

export function ReceiptForm({
  kind, mode, door, initial, accounts, moneyAccounts, accountName, saving, debtorLocked = false,
  onSundry, onDebtor, onCancel,
}: {
  kind: 'sundry' | 'debtor';
  mode: 'new' | 'copy' | 'edit';
  /** Where a debtor receipt is raised: on Receipts it posts now and knocks the
   *  bills off; on Debtor maintenance it waits for the four layers. */
  door: 'receipts' | 'debtors';
  initial: ReceiptValues;
  /** Postable leaves a sundry line may credit. */
  accounts: Account[];
  /** The bank and cash accounts the money may land on. */
  moneyAccounts: Account[];
  accountName: (code: string) => string | null;
  saving: boolean;
  /** The debtor cannot change (an edit). */
  debtorLocked?: boolean;
  onSundry: (v: SundrySubmit) => void;
  onDebtor: (v: DebtorSubmit, how: DebtorSave) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<ReceiptValues>(initial.lines.length > 0 ? initial : { ...initial, lines: [blankLine(1)] });
  const debtor = kind === 'debtor';
  const debtorsQ = useOtherDebtors();
  const detailQ = useDebtorDetail(debtor && v.debtorId ? v.debtorId : null);
  const rolesQ = useAccountRoles();
  const named = (code: string) => `${code}${accountName(code) ? ` ${accountName(code)}` : ''}`;

  const patchLine = (rid: number, patch: Partial<SundryLine>) =>
    setV((p) => ({ ...p, lines: p.lines.map((l) => (l.rid === rid ? { ...l, ...patch } : l)) }));
  const linesTotal = v.lines.reduce((sum, l) => sum + (l.amountSen > 0 ? l.amountSen : 0), 0);

  const debtorRow = (debtorsQ.data?.debtors ?? []).find((d) => d.id === v.debtorId) ?? detailQ.data?.debtor ?? null;
  const bills = useMemo(
    () => (detailQ.data?.bills ?? []).filter((b) => isOpenBill(b, initial.alloc)),
    [detailQ.data, initial.alloc],
  );
  /* What a bill still owes this receipt: on an edit, the draft's own amounts
     were never taken off the bill (a draft posts nothing), so the bill's
     outstanding is the limit either way. */
  const outOf = (b: DebtorBill): number => Math.max(0, Number(b.total_sen) - Number(b.received_sen));
  const allocTotal = bills.reduce((sum, b) => sum + (v.alloc[b.id] ?? 0), 0);
  const over = bills.find((b) => (v.alloc[b.id] ?? 0) > outOf(b));

  const total = debtor ? allocTotal : linesTotal;
  const blocking = !v.receiptDate ? 'Type the date as 2026/10/29.'
    : debtor
      ? (!v.debtorId ? 'Pick the debtor.'
        : !v.bankAccountCode ? 'Pick the account the money went into.'
          : over ? `${over.bill_number} only has ${fmtSen(outOf(over))} outstanding.`
            : allocTotal <= 0 ? 'Tick a bill or type an amount to receive.' : null)
      : (!v.payerName.trim() ? 'Type who paid.'
        : !v.bankAccountCode ? 'Pick the account the money went into.'
          : v.lines.some((l) => l.amountSen > 0 && !l.creditAccountCode) ? 'Pick an account for every line with an amount.'
            : linesTotal <= 0 ? 'Add a line with an amount.' : null);

  const submit = (how: DebtorSave) => {
    if (blocking || saving) return;
    if (debtor) {
      onDebtor({
        debtorId: v.debtorId, receiptDate: v.receiptDate, bankAccountCode: v.bankAccountCode,
        allocations: bills.filter((b) => (v.alloc[b.id] ?? 0) > 0).map((b) => ({ billId: b.id, amountSen: v.alloc[b.id]! })),
      }, how);
      return;
    }
    onSundry({
      receiptDate: v.receiptDate, payerName: v.payerName.trim(), bankAccountCode: v.bankAccountCode,
      lines: v.lines.filter((l) => l.creditAccountCode && l.amountSen > 0).map((l) => ({
        ...(l.description.trim() ? { description: l.description.trim() } : {}), creditAccountCode: l.creditAccountCode, amountSen: l.amountSen,
      })),
    });
  };
  /* The primary button: post on Receipts, prepare (or save an edit) on Debtor maintenance. */
  const primary: DebtorSave = debtor && door === 'debtors' && mode !== 'edit' ? 'prepare' : debtor && door === 'debtors' ? 'draft' : 'post';
  useSaveHotkey(() => submit(primary), !saving);

  const control = rolesQ.data?.roles.AR_OTHER ?? '305-0000';
  const into = v.bankAccountCode ? named(v.bankAccountCode) : '—';
  const credited = [...new Set(v.lines.filter((l) => l.creditAccountCode && l.amountSen > 0).map((l) => l.creditAccountCode))].map(named).join(', ');
  const books = debtor
    ? `Books: Dr ${into} · Cr ${named(control)}${debtorRow ? ` (${debtorRow.name})` : ''} · ${fmtSen(total)} · ${door === 'receipts' ? 'posts now and knocks the bills off' : 'posts at approval'}`
    : `Books: Dr ${into} · Cr ${credited || 'each line’s account'} · ${fmtSen(total)} · ${mode === 'edit' ? 're-posts' : 'posts now'}`;
  const primaryLabel = saving ? 'Saving…'
    : !debtor ? (mode === 'edit' ? 'Save & re-post' : 'Save & post')
      : door === 'receipts' ? 'Save & post'
        : mode === 'edit' ? 'Save changes' : 'Save & prepare';

  return (
    <div className={ui.formCol}>
      {!debtor && mode === 'edit' && (
        <div className={ui.formNote}><Info size={14} /><span>Saving changes re-posts it: the old journal gets a contra and a fresh one books what you save.</span></div>
      )}
      <div className={ui.formGrid}>
        <div className={ui.formCol}>
          <div className={`${ui.formCard} ${ui.formFields}`}>
            <div className={ui.formField}>
              <span className={ui.formLabel}>Date</span>
              <DateField fullWidth value={v.receiptDate} onChange={(iso) => setV((p) => ({ ...p, receiptDate: iso }))} className={ui.formInput}
                aria-label="Receipt date" placeholder="2026/10/29" />
            </div>
            {debtor ? (
              <label className={ui.formField}>
                <span className={ui.formLabel}>Debtor</span>
                <select aria-label="Debtor" value={v.debtorId} className={ui.formInput} disabled={debtorLocked}
                  onChange={(e) => { const id = e.target.value; setV((p) => ({ ...p, debtorId: id, alloc: {} })); }}>
                  <option value="">— Pick the debtor —</option>
                  {(debtorsQ.data?.debtors ?? []).filter((d) => d.is_active || d.id === v.debtorId).map((d) => (
                    <option key={d.id} value={d.id}>{d.name}{d.outstanding_sen > 0 ? ` · owes ${fmtSen(d.outstanding_sen)}` : ''}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label className={ui.formField}>
                <span className={ui.formLabel}>Received from</span>
                <input value={v.payerName} onChange={(e) => { const t = e.target.value; setV((p) => ({ ...p, payerName: t })); }}
                  className={ui.formInput} placeholder="Type the payer" aria-label="Received from" />
              </label>
            )}
            <label className={ui.formField}>
              <span className={ui.formLabel}>Received into</span>
              <AccountSelect accounts={moneyAccounts} value={v.bankAccountCode} placeholder="— bank / cash —" className={ui.formInput}
                onChange={(code) => setV((p) => ({ ...p, bankAccountCode: code }))} />
            </label>
          </div>

          {!debtor && (
            <section className={ui.formCard} aria-label="Lines">
              <div className={ui.formCardTitle}>Lines</div>
              <div className={ui.lineScroll}>
                <div className={ui.lineHead}><span>Account (credit)</span><span>Description</span><span className={ui.right}>Amount (RM)</span><span /></div>
                {v.lines.map((l) => (
                  <div key={l.rid} className={ui.lineRow}>
                    <AccountSelect accounts={accounts} value={l.creditAccountCode} placeholder="— Pick an account —" className={ui.formInput}
                      onChange={(code) => patchLine(l.rid, { creditAccountCode: code })} />
                    <input placeholder="What it is for" value={l.description} className={ui.formInput} aria-label={`line ${l.rid} description`}
                      onChange={(e) => patchLine(l.rid, { description: e.target.value })} />
                    <MoneyInput bare valueSen={l.amountSen > 0 ? l.amountSen : null} allowBlank placeholder="0.00"
                      aria-label={`line ${l.rid} amount`} inputClassName={ui.formInput}
                      onCommit={(sen) => patchLine(l.rid, { amountSen: sen ?? 0 })} />
                    <button type="button" className={ui.clear} aria-label={`Remove line ${l.rid}`} title="Remove line" disabled={v.lines.length === 1}
                      onClick={() => setV((p) => ({ ...p, lines: p.lines.filter((x) => x.rid !== l.rid) }))}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <div className={ui.lineFoot}>
                <AddLineButton variant="ghost"
                  onClick={() => setV((p) => ({ ...p, lines: [...p.lines, blankLine(Math.max(0, ...p.lines.map((x) => x.rid)) + 1)] }))} />
                <span className={ui.grow} />
                <span className={ui.hint}>{v.lines.length} line{v.lines.length === 1 ? '' : 's'} · {fmtSen(linesTotal)}</span>
              </div>
            </section>
          )}

          {debtor && (
            <section className={ui.formCard} aria-label="What the debtor still owes">
              <div className={ui.formCardTitle}>{debtorRow ? `What ${debtorRow.name} still owes` : 'Bills'}</div>
              {!v.debtorId ? <div className={ui.pickEmpty}>Pick the debtor to list what they still owe.</div>
                : detailQ.isLoading ? <div className={ui.pickEmpty}>Loading their bills…</div>
                  : detailQ.isError ? <div className={`${ui.pickEmpty} ${ui.formHintBad}`} role="alert">Their bills did not load — {detailQ.error instanceof Error ? detailQ.error.message : 'try again'}.</div>
                    : bills.length === 0 ? <div className={ui.pickEmpty}>This debtor has no open bill. Raise the bill first.</div>
                      : (
                        <div className={ui.lineScroll}>
                          <div className={ui.pickHead}><span /><span>Bill</span><span>Date</span><span>For</span><span className={ui.right}>Outstanding</span><span className={ui.right}>Receive</span></div>
                          {bills.map((b) => {
                            const out = outOf(b);
                            const got = v.alloc[b.id] ?? 0;
                            return (
                              <div key={b.id} className={ui.pickRow}>
                                <input type="checkbox" aria-label={`Collect ${b.bill_number} in full`} checked={got === out && out > 0}
                                  onChange={(e) => { const on = e.target.checked; setV((p) => ({ ...p, alloc: { ...p.alloc, [b.id]: on ? out : 0 } })); }}
                                  style={{ width: 16, height: 16, accentColor: '#16695f' }} />
                                <span className={ui.pickNo}>{b.bill_number}</span>
                                <span className={ui.muted}>{fmtDate(b.bill_date)}</span>
                                <span className={ui.pickFor} title={b.notes ?? undefined}>{b.notes ?? '—'}</span>
                                <span className={`${ui.right} ${ui.strong}`}>{fmtSen(out)}</span>
                                <MoneyInput bare valueSen={got > 0 ? got : null} allowBlank placeholder="0.00" selectOnFocus inputClassName={ui.formInput}
                                  aria-label={`amount for ${b.bill_number}`}
                                  onCommit={(sen) => setV((p) => ({ ...p, alloc: { ...p.alloc, [b.id]: Math.max(0, sen ?? 0) } }))} />
                              </div>
                            );
                          })}
                        </div>
                      )}
            </section>
          )}
        </div>

        <aside className={ui.side} aria-label="Save">
          <div className={ui.sideTotal}><span className={ui.sideTotalLabel}>Total</span><span className={ui.sideTotalValue}>{fmtSen(total)}</span></div>
          <div className={ui.sideBooks}>{books}</div>
          {blocking && <div className={ui.sideWhy}>{blocking}</div>}
          <div className={ui.sideButtons}>
            <button type="button" className={ui.btn} onClick={onCancel} disabled={saving}>Cancel</button>
            <span className={ui.grow} />
            {debtor && door === 'debtors' && mode !== 'edit' && (
              <button type="button" className={ui.btn} onClick={() => submit('draft')} disabled={saving || blocking != null}>Save draft</button>
            )}
            <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => submit(primary)} disabled={saving || blocking != null}>
              {primaryLabel}
            </button>
          </div>
          <span className={ui.hint}>{SAVE_HOTKEY_HINT}</span>
        </aside>
      </div>
    </div>
  );
}
