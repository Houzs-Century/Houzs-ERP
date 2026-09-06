// ----------------------------------------------------------------------------
// OtherDebtors — /scm/other-debtors (owner 2026-09-03, confirmed line by line).
//
// other debtor 主要就是我会开 bill 其他和生意性质没有关系的人或公司收回钱:
// a REGISTRY (资料 lives here — 照理 chart of account 只能维护其他的, the GL
// keeps one 305-0000 control and never per-party sub-accounts), DEBTOR BILLS
// that post directly (明细行自由选户口 — 我开 bill 时决定 account 就行了),
// and RECEIPTS that walk the PV's four layers and knock bills off like an
// AP Payment — tick pays in full, type for partial (确定到时也可以 partial).
//
// 2026-09-06 (owner: 刚刚说的功能 … other debtor bill 那边也要有): the bill
// opens in a pop-out form (DebtorBillForm — Insert adds a line, amounts read
// 1,800.00), every bill can be EDITED (the route re-posts) or COPIED, and the
// receipt's amounts wear the same money dress.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Ban, CheckCircle2, Copy, Pencil, Plus, RotateCcw, Send, XCircle } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useAccounts, useOtherDebtors, useDebtorDetail, useCreateDebtor, useUpdateDebtor,
  useCreateDebtorBill, useUpdateDebtorBill, useCancelDebtorBill, useCreateDebtorReceipt, useDebtorReceiptAction,
  type Account, type DebtorBill, type DebtorReceipt,
} from '../../vendor/scm/lib/accounting-queries';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { Modal } from '../../vendor/scm/components/Modal';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { DebtorBillForm, emptyBillForm, type BillFormMode, type BillFormSubmit, type BillFormValues } from './DebtorBillForm';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

const fmtRm = (sen: number | null | undefined): string => {
  const v = Number(sen ?? 0);
  return `MYR ${(v / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/* The receipt's place in the four layers, chip-style (the PV vocabulary:
   POSTED shows as Approved — document-status-vocabulary.md's exception). */
const receiptStage = (r: DebtorReceipt): string => {
  if (r.status === 'CANCELLED') return 'Cancelled';
  if (r.status === 'POSTED') return 'Approved';
  if (r.checked_at) return 'Checked';
  if (r.submitted_at) return 'Prepared';
  return 'Draft';
};

/** The form's values from a bill: an EDIT keeps everything, a COPY keeps the
    description and lines and starts the paper afresh — today's date, a new
    number on post. */
const fromBill = (b: DebtorBill, copy: boolean): BillFormValues => ({
  billDate: copy ? myt() : b.bill_date,
  notes: b.notes ?? '',
  lines: (b.lines ?? []).map((l, i) => ({ rid: i + 1, description: l.description ?? '', creditAccountCode: l.credit_account_code, amountSen: l.amount_sen })),
});
type BillFormState = { mode: BillFormMode; initial: BillFormValues; billId?: string; billNumber?: string; receivedSen?: number };

export const OtherDebtors = () => {
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { can } = useHouzsAuth();
  const canCreate = can('scm.payment_voucher.create');
  const canWrite = can('scm.payment_voucher.write');
  const canCheck = can('scm.payment_voucher.check');
  const canApprove = can('scm.payment_voucher.approve');
  const canCancel = can('scm.payment_voucher.cancel');

  const listQ = useOtherDebtors();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailQ = useDebtorDetail(selectedId);
  const accountsQ = useAccounts();
  const accounts = useMemo<Account[]>(() => (accountsQ.data?.accounts ?? []).filter((a) => a.is_active), [accountsQ.data]);
  const moneyAccounts = useMemo(() => accounts.filter((a) => a.acc_money === true), [accounts]);

  const createDebtor = useCreateDebtor();
  const updateDebtor = useUpdateDebtor();
  const createBill = useCreateDebtorBill();
  const updateBill = useUpdateDebtorBill();
  const cancelBill = useCancelDebtorBill();
  const createReceipt = useCreateDebtorReceipt();
  const receiptAction = useDebtorReceiptAction();

  /* New-debtor card. */
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const saveDebtor = async () => {
    try {
      const res = await createDebtor.mutateAsync({
        name: newName.trim(),
        ...(newPhone.trim() ? { phone: newPhone.trim() } : {}),
        ...(newNotes.trim() ? { notes: newNotes.trim() } : {}),
      });
      setAdding(false); setNewName(''); setNewPhone(''); setNewNotes('');
      setSelectedId(res.debtor.id);
    } catch (e) {
      void notify({ title: 'Save failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* The bill form — New, Edit, Copy — in its own pop-out (owner: 开 bill 时决定
     account 就行了; and, 2026-09-06, everything editable, copyable). */
  const [billForm, setBillForm] = useState<BillFormState | null>(null);
  const openNewBill = () => setBillForm({ mode: 'new', initial: emptyBillForm() });
  const openEditBill = (b: DebtorBill) => setBillForm({ mode: 'edit', initial: fromBill(b, false), billId: b.id, billNumber: b.bill_number, receivedSen: Number(b.received_sen) });
  const openCopyBill = (b: DebtorBill) => setBillForm({ mode: 'copy', initial: fromBill(b, true), billNumber: b.bill_number });
  const submitBill = async (values: BillFormSubmit) => {
    if (!selectedId || !billForm) return;
    try {
      if (billForm.mode === 'edit' && billForm.billId) {
        const res = await updateBill.mutateAsync({ billId: billForm.billId, body: values });
        setBillForm(null);
        void notify({ title: `${res.bill.billNumber} saved`, body: `Re-posted — the old journal got its contra and ${res.jeNo ?? 'a fresh entry'} books it as saved; ${fmtRm(res.bill.totalSen)} now on 305-0000.`, tone: 'info' });
        return;
      }
      const res = await createBill.mutateAsync({ debtorId: selectedId, ...values });
      setBillForm(null);
      void notify({
        title: `${res.bill.billNumber} posted`,
        body: `${fmtRm(res.bill.totalSen)} now owing — the GL carries it on 305-0000.${billForm.mode === 'copy' && billForm.billNumber ? ` Copied from ${billForm.billNumber}.` : ''}`,
        tone: 'info',
      });
    } catch (e) {
      void notify({ title: 'Bill failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* New-receipt card — AP-Payment shape: tick = full, type = partial. */
  const [receipting, setReceipting] = useState(false);
  const [receiptBank, setReceiptBank] = useState('');
  const [allocs, setAllocs] = useState<Record<string, number>>({});
  const openBills = (detailQ.data?.bills ?? []).filter((b) => b.status === 'POSTED');
  const receiptTotal = Object.values(allocs).reduce((s, v) => s + v, 0);
  const saveReceipt = async () => {
    if (!selectedId) return;
    try {
      const res = await createReceipt.mutateAsync({
        debtorId: selectedId,
        bankAccountCode: receiptBank,
        allocations: Object.entries(allocs).filter(([, v]) => v > 0).map(([billId, amountSen]) => ({ billId, amountSen })),
      });
      setReceipting(false); setAllocs({}); setReceiptBank('');
      void notify({ title: `${res.receipt.receiptNumber} raised`, body: 'It starts at Draft — prepare, check and approve to post the money in.', tone: 'info' });
    } catch (e) {
      void notify({ title: 'Receipt failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const runReceipt = async (r: DebtorReceipt, action: 'submit' | 'withdraw' | 'check' | 'reject' | 'approve') => {
    if (action === 'reject') {
      const ok = await askConfirm({ title: `Reject ${r.receipt_number}?`, body: '一律退回 Draft — every mark clears and it starts again.', confirmLabel: 'Reject', danger: true });
      if (!ok) return;
    }
    if (action === 'approve') {
      const ok = await askConfirm({ title: `Approve ${r.receipt_number}?`, body: `${fmtRm(r.total_sen)} books into ${r.bank_account_code} and the ticked bills are knocked off.`, confirmLabel: 'Approve & post' });
      if (!ok) return;
    }
    try {
      await receiptAction.mutateAsync({ receiptId: r.id, action });
    } catch (e) {
      void notify({ title: `${action} failed`, body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const onCancelBill = async (b: DebtorBill) => {
    const ok = await askConfirm({ title: `Cancel ${b.bill_number}?`, body: 'The ODB journal is reversed; a bill with money received refuses.', confirmLabel: 'Cancel bill', danger: true });
    if (!ok) return;
    try {
      await cancelBill.mutateAsync(b.id);
    } catch (e) {
      void notify({ title: 'Cancel failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const debtors = listQ.data?.debtors ?? [];
  const detail = detailQ.data;
  const billFormTitle = billForm?.mode === 'edit'
    ? `Edit ${billForm.billNumber ?? 'bill'} — ${detail?.debtor.name ?? ''}`
    : billForm?.mode === 'copy' ? `New bill — copied from ${billForm.billNumber ?? 'a bill'}` : `New bill — ${detail?.debtor.name ?? ''} · 明细行自由选户口`;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="Other Debtors"
        actions={canCreate ? (
          <button type="button" onClick={() => setAdding(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)', background: 'none', border: 'none', padding: 0 }}>
            <Plus {...ICON} /> New debtor
          </button>
        ) : undefined}
      />

      {adding && (
        <section className={styles.card}>
          <div className={styles.cardHeader}><h2 className={styles.cardTitle}>New debtor</h2></div>
          <div className={styles.cardBody} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end', fontSize: 'var(--fs-13)' }}>
            <label className={styles.field} style={{ flex: '1 1 220px' }}>
              <span className={styles.fieldLabel}>Name</span>
              <input className={styles.fieldInput} value={newName} onChange={(e) => setNewName(e.target.value)} />
            </label>
            <label className={styles.field} style={{ width: 170 }}>
              <span className={styles.fieldLabel}>Phone</span>
              <input className={styles.fieldInput} value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
            </label>
            <label className={styles.field} style={{ flex: '1 1 220px' }}>
              <span className={styles.fieldLabel}>Notes</span>
              <input className={styles.fieldInput} value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
            </label>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button variant="primary" size="sm" onClick={() => void saveDebtor()} disabled={createDebtor.isPending || !newName.trim()}>
                {createDebtor.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)} disabled={createDebtor.isPending}>Cancel</Button>
            </div>
          </div>
        </section>
      )}

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Debtors</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            资料在这里维护 — the chart keeps only the 305-0000 control
          </span>
        </div>
        <div className={styles.cardBody} style={{ overflowX: 'auto' }}>
          {listQ.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}
          {!listQ.isLoading && debtors.length === 0 && (
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>No debtors yet — add the first with "New debtor".</div>
          )}
          {debtors.length > 0 && (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-weak, #e3e1da)' }}>
                  <th style={{ padding: '6px 8px' }}>Name</th>
                  <th style={{ padding: '6px 8px' }}>Phone</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Outstanding</th>
                  <th style={{ padding: '6px 8px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {debtors.map((d) => (
                  <tr key={d.id}
                    onClick={() => setSelectedId(d.id)}
                    style={{ borderBottom: '1px solid var(--border-weak, #f0eee8)', cursor: 'pointer', background: selectedId === d.id ? 'var(--c-cream, #faf7f0)' : undefined }}>
                    <td style={{ padding: '6px 8px', fontWeight: 600 }}>{d.name}</td>
                    <td style={{ padding: '6px 8px' }}>{d.phone ?? '—'}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtRm(d.outstanding_sen)}</td>
                    <td style={{ padding: '6px 8px', fontSize: 'var(--fs-11)', color: d.is_active ? 'var(--c-secondary-a, #2F5D4F)' : 'var(--fg-muted)' }}>
                      {d.is_active ? 'ACTIVE' : 'INACTIVE'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {selectedId && detail && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>{detail.debtor.name}</h2>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              {canWrite && (
                <Button variant="ghost" size="sm"
                  onClick={() => void updateDebtor.mutateAsync({ id: selectedId, isActive: !detail.debtor.is_active }).catch((e: unknown) => {
                    void notify({ title: 'Update failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
                  })}>
                  <Pencil {...ICON} /> {detail.debtor.is_active ? 'Deactivate' : 'Reactivate'}
                </Button>
              )}
              {canCreate && (
                <Button variant="ghost" size="sm" onClick={() => { openNewBill(); setReceipting(false); }}>
                  <Plus {...ICON} /> New bill
                </Button>
              )}
              {canCreate && openBills.length > 0 && (
                <Button variant="primary" size="sm" onClick={() => { setReceipting(true); setBillForm(null); }}>
                  <Send {...ICON} /> New receipt
                </Button>
              )}
            </div>
          </div>
          <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>

            {receipting && (
              <div style={{ border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', fontSize: 'var(--fs-13)' }}>
                <b>New receipt — tick pays in full, type for partial</b>
                <label className={styles.field} style={{ maxWidth: 340 }}>
                  <span className={styles.fieldLabel}>Received into</span>
                  <AccountSelect accounts={moneyAccounts} value={receiptBank} onChange={setReceiptBank} className={styles.fieldInput} placeholder="— bank / cash —" />
                </label>
                <table style={{ borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
                  <tbody>
                    {openBills.map((b) => {
                      const out = b.total_sen - b.received_sen;
                      const v = allocs[b.id] ?? 0;
                      return (
                        <tr key={b.id} style={{ borderBottom: '1px solid var(--border-weak, #f0eee8)' }}>
                          <td style={{ padding: '4px 8px' }}>
                            <input type="checkbox" aria-label={`Collect ${b.bill_number} in full`}
                              checked={v === out && out > 0}
                              onChange={(e) => setAllocs((prev) => ({ ...prev, [b.id]: e.target.checked ? out : 0 }))} />
                          </td>
                          <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{b.bill_number}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{fmtRm(out)}</td>
                          <td style={{ padding: '4px 8px', width: 150 }}>
                            <MoneyInput bare valueSen={v} inputClassName={styles.fieldInput} selectOnFocus aria-label={`amount for ${b.bill_number}`}
                              placeholder="0.00" style={{ width: '100%' }}
                              onCommit={(sen) => setAllocs((prev) => ({ ...prev, [b.id]: Math.min(out, Math.max(0, sen ?? 0)) }))} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>Receiving {fmtRm(receiptTotal)}</span>
                  <Button variant="primary" size="sm" onClick={() => void saveReceipt()}
                    disabled={createReceipt.isPending || receiptTotal <= 0 || !receiptBank}>
                    {createReceipt.isPending ? 'Raising…' : 'Raise receipt'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setReceipting(false)}>Close</Button>
                </div>
              </div>
            )}

            <div>
              <b style={{ fontSize: 'var(--fs-13)' }}>Bills</b>
              {detail.bills.length === 0
                ? <div style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>None yet.</div>
                : (
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
                    <tbody>
                      {detail.bills.map((b) => (
                        <tr key={b.id} style={{ borderBottom: '1px solid var(--border-weak, #f0eee8)', opacity: b.status === 'CANCELLED' ? 0.55 : 1 }}>
                          <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{b.bill_number}</td>
                          <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{b.bill_date}</td>
                          <td style={{ padding: '4px 8px', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.notes ?? undefined}>{b.notes ?? '—'}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtRm(b.total_sen)}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>
                            received {fmtRm(b.received_sen)}
                          </td>
                          <td style={{ padding: '4px 8px', fontSize: 'var(--fs-11)' }}>{b.status}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {canCreate && b.status !== 'CANCELLED' && (
                              <button type="button" aria-label={`Edit ${b.bill_number}`} title="Edit" onClick={() => openEditBill(b)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 2 }}>
                                <Pencil size={14} strokeWidth={1.75} />
                              </button>
                            )}
                            {canCreate && (
                              <button type="button" aria-label={`Copy ${b.bill_number}`} title="Copy as new" onClick={() => openCopyBill(b)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 2 }}>
                                <Copy size={14} strokeWidth={1.75} />
                              </button>
                            )}
                            {canCancel && b.status !== 'CANCELLED' && b.received_sen === 0 && (
                              <button type="button" aria-label={`Cancel ${b.bill_number}`} title="Cancel bill" onClick={() => void onCancelBill(b)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 2 }}>
                                <Ban size={14} strokeWidth={1.75} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>

            <div>
              <b style={{ fontSize: 'var(--fs-13)' }}>Receipts</b>
              {detail.receipts.length === 0
                ? <div style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>None yet.</div>
                : (
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
                    <tbody>
                      {detail.receipts.map((r) => {
                        const stage = receiptStage(r);
                        const draft = r.status === 'DRAFT';
                        return (
                          <tr key={r.id} style={{ borderBottom: '1px solid var(--border-weak, #f0eee8)' }}>
                            <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{r.receipt_number}</td>
                            <td style={{ padding: '4px 8px' }}>{r.receipt_date}</td>
                            <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{r.bank_account_code}</td>
                            <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtRm(r.total_sen)}</td>
                            <td style={{ padding: '4px 8px', fontSize: 'var(--fs-11)', fontWeight: 600 }}>{stage}</td>
                            <td style={{ padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                              {draft && !r.submitted_at && canWrite && (
                                <Button variant="ghost" size="sm" onClick={() => void runReceipt(r, 'submit')}><Send {...ICON} /> Prepare</Button>
                              )}
                              {draft && r.submitted_at && !r.checked_at && canWrite && (
                                <Button variant="ghost" size="sm" onClick={() => void runReceipt(r, 'withdraw')}><RotateCcw {...ICON} /> Withdraw</Button>
                              )}
                              {draft && r.submitted_at && !r.checked_at && canCheck && (
                                <Button variant="primary" size="sm" onClick={() => void runReceipt(r, 'check')}><CheckCircle2 {...ICON} /> Check</Button>
                              )}
                              {draft && r.checked_at && canApprove && (
                                <Button variant="primary" size="sm" onClick={() => void runReceipt(r, 'approve')}><CheckCircle2 {...ICON} /> Approve & post</Button>
                              )}
                              {draft && r.submitted_at && (canCheck || canApprove) && (
                                <Button variant="ghost" size="sm" onClick={() => void runReceipt(r, 'reject')}><XCircle {...ICON} /> Reject</Button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
            </div>
          </div>
        </section>
      )}

      {billForm && selectedId && (
        <Modal title={billFormTitle} onClose={() => setBillForm(null)} ariaLabel={billFormTitle}>
          <DebtorBillForm
            key={`${billForm.mode}-${billForm.billId ?? 'new'}`}
            mode={billForm.mode}
            initial={billForm.initial}
            accounts={accounts}
            receivedSen={billForm.receivedSen}
            saving={createBill.isPending || updateBill.isPending}
            onSubmit={submitBill}
            onCancel={() => setBillForm(null)}
          />
        </Modal>
      )}
    </div>
  );
};
