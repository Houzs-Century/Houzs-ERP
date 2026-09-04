// ----------------------------------------------------------------------------
// OtherDebtors — /scm/other-debtors (owner 2026-09-03, confirmed line by line).
//
// other debtor 主要就是我会开 bill 其他和生意性质没有关系的人或公司收回钱:
// a REGISTRY (资料 lives here — 照理 chart of account 只能维护其他的, the GL
// keeps one 305-0000 control and never per-party sub-accounts), DEBTOR BILLS
// that post directly (明细行自由选户口 — 我开 bill 时决定 account 就行了),
// and RECEIPTS that walk the PV's four layers and knock bills off like an
// AP Payment — tick pays in full, type for partial (确定到时也可以 partial).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Ban, CheckCircle2, Pencil, Plus, RotateCcw, Send, XCircle } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useAccounts, useOtherDebtors, useDebtorDetail, useCreateDebtor, useUpdateDebtor,
  useCreateDebtorBill, useCancelDebtorBill, useCreateDebtorReceipt, useDebtorReceiptAction,
  type Account, type DebtorBill, type DebtorReceipt,
} from '../../vendor/scm/lib/accounting-queries';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

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

type BillLine = { rid: number; description: string; creditAccountCode: string; amountSen: number };

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

  /* New-bill card (owner: 开 bill 时决定 account 就行了). */
  const [billing, setBilling] = useState(false);
  const [billLines, setBillLines] = useState<BillLine[]>([{ rid: 1, description: '', creditAccountCode: '', amountSen: 0 }]);
  const billTotal = billLines.reduce((s, l) => s + (l.amountSen > 0 ? l.amountSen : 0), 0);
  const patchLine = (rid: number, patch: Partial<BillLine>) =>
    setBillLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const saveBill = async () => {
    if (!selectedId) return;
    try {
      const res = await createBill.mutateAsync({
        debtorId: selectedId,
        lines: billLines
          .filter((l) => l.creditAccountCode && l.amountSen > 0)
          .map((l) => ({ ...(l.description.trim() ? { description: l.description.trim() } : {}), creditAccountCode: l.creditAccountCode, amountSen: l.amountSen })),
      });
      setBilling(false);
      setBillLines([{ rid: 1, description: '', creditAccountCode: '', amountSen: 0 }]);
      void notify({ title: `${res.bill.billNumber} posted`, body: `${fmtRm(res.bill.totalSen)} now owing — the GL carries it on 305-0000.`, tone: 'info' });
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
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 220px' }}>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Name</span>
              <input value={newName} onChange={(e) => setNewName(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Phone</span>
              <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6, width: 150 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 220px' }}>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Notes</span>
              <input value={newNotes} onChange={(e) => setNewNotes(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6 }} />
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
                <Button variant="ghost" size="sm" onClick={() => { setBilling(true); setReceipting(false); }}>
                  <Plus {...ICON} /> New bill
                </Button>
              )}
              {canCreate && openBills.length > 0 && (
                <Button variant="primary" size="sm" onClick={() => { setReceipting(true); setBilling(false); }}>
                  <Send {...ICON} /> New receipt
                </Button>
              )}
            </div>
          </div>
          <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>

            {billing && (
              <div style={{ border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', fontSize: 'var(--fs-13)' }}>
                <b>New bill — 明细行自由选户口</b>
                {billLines.map((l) => (
                  <div key={l.rid} style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                    <input placeholder="Description" value={l.description}
                      onChange={(e) => patchLine(l.rid, { description: e.target.value })}
                      style={{ flex: '1 1 200px', padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6 }} />
                    <div style={{ flex: '1 1 220px' }}>
                      <AccountSelect accounts={accounts} value={l.creditAccountCode}
                        onChange={(code) => patchLine(l.rid, { creditAccountCode: code })} />
                    </div>
                    <input type="number" min={0} step="0.01" placeholder="Amount (RM)" aria-label={`line ${l.rid} amount`}
                      value={l.amountSen > 0 ? String(l.amountSen / 100) : ''}
                      onChange={(e) => patchLine(l.rid, { amountSen: Math.round(Number(e.target.value || 0) * 100) })}
                      style={{ width: 130, padding: '6px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6, textAlign: 'right' }} />
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                  <Button variant="ghost" size="sm" onClick={() => setBillLines((p) => [...p, { rid: Math.max(...p.map((x) => x.rid)) + 1, description: '', creditAccountCode: '', amountSen: 0 }])}>
                    <Plus {...ICON} /> Line
                  </Button>
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>Total {fmtRm(billTotal)}</span>
                  <Button variant="primary" size="sm" onClick={() => void saveBill()}
                    disabled={createBill.isPending || billTotal <= 0 || billLines.some((l) => l.amountSen > 0 && !l.creditAccountCode)}>
                    {createBill.isPending ? 'Posting…' : 'Post bill'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setBilling(false)}>Close</Button>
                </div>
              </div>
            )}

            {receipting && (
              <div style={{ border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', fontSize: 'var(--fs-13)' }}>
                <b>New receipt — tick pays in full, type for partial</b>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 340 }}>
                  <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>Received into</span>
                  <AccountSelect accounts={moneyAccounts} value={receiptBank} onChange={setReceiptBank} placeholder="— bank / cash —" />
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
                          <td style={{ padding: '4px 8px' }}>
                            <input type="number" min={0} step="0.01" aria-label={`amount for ${b.bill_number}`}
                              value={v > 0 ? String(v / 100) : ''}
                              onChange={(e) => {
                                const sen = Math.min(out, Math.max(0, Math.round(Number(e.target.value || 0) * 100)));
                                setAllocs((prev) => ({ ...prev, [b.id]: sen }));
                              }}
                              style={{ width: 120, padding: '4px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6, textAlign: 'right' }} />
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
                          <td style={{ padding: '4px 8px' }}>{b.bill_date}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtRm(b.total_sen)}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>
                            received {fmtRm(b.received_sen)}
                          </td>
                          <td style={{ padding: '4px 8px', fontSize: 'var(--fs-11)' }}>{b.status}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                            {canCancel && b.status !== 'CANCELLED' && b.received_sen === 0 && (
                              <button type="button" aria-label={`Cancel ${b.bill_number}`} onClick={() => void onCancelBill(b)}
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
    </div>
  );
};
