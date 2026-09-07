// ----------------------------------------------------------------------------
// Receipts — /scm/receipts (owner 2026-09-03): 这个月收了什么钱, one page.
//
// Three kinds in one table: GENERAL (raised HERE — 就我只想开 receipt 罢了:
// payer typed free, money account, lines pick their own credit accounts,
// posts directly, 错就 void), DEBTOR (read-only mirror of the Other Debtors
// receipts, raised and four-layered over there), CUSTOMER (read-only mirror
// of the sales payments — 顾客的钱 keeps its own flow).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useAccounts, useReceipts, useCreateReceipt, useVoidReceipt,
  type Account, type ReceiptRow,
} from '../../vendor/scm/lib/accounting-queries';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { DateField } from '../../vendor/scm/components/DateField';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { todayMyt } from '../../vendor/scm/lib/dates';
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

const KIND_LABEL: Record<ReceiptRow['kind'], string> = {
  GENERAL: 'Receipt', DEBTOR: 'Other Debtor', CUSTOMER: 'Customer',
};

type Line = { rid: number; description: string; creditAccountCode: string; amountSen: number };

export const Receipts = () => {
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { can } = useHouzsAuth();
  const canCreate = can('scm.payment_voucher.create');
  const canCancel = can('scm.payment_voucher.cancel');

  const [month, setMonth] = useState<string>(() => new Date().toISOString().slice(0, 7));
  const listQ = useReceipts(month);
  const accountsQ = useAccounts();
  const accounts = useMemo<Account[]>(() => (accountsQ.data?.accounts ?? []).filter((a) => a.is_active), [accountsQ.data]);
  const moneyAccounts = useMemo(() => accounts.filter((a) => a.acc_money === true), [accounts]);

  const createReceipt = useCreateReceipt();
  const voidReceipt = useVoidReceipt();

  const [adding, setAdding] = useState(false);
  const [payer, setPayer] = useState('');
  const [bank, setBank] = useState('');
  /* The receipt's own date — the number's month follows it (docMonthTag on
     the server), so a receipt keyed today for last week's money lands in
     last week's series. Blank is refused by the button, never defaulted here
     and sent as nothing. */
  const [receiptDate, setReceiptDate] = useState<string>(() => todayMyt());
  const [lines, setLines] = useState<Line[]>([{ rid: 1, description: '', creditAccountCode: '', amountSen: 0 }]);
  const total = lines.reduce((s, l) => s + (l.amountSen > 0 ? l.amountSen : 0), 0);
  const patchLine = (rid: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));

  const save = async () => {
    try {
      const res = await createReceipt.mutateAsync({
        payerName: payer.trim(),
        receiptDate,
        bankAccountCode: bank,
        lines: lines
          .filter((l) => l.creditAccountCode && l.amountSen > 0)
          .map((l) => ({ ...(l.description.trim() ? { description: l.description.trim() } : {}), creditAccountCode: l.creditAccountCode, amountSen: l.amountSen })),
      });
      setAdding(false);
      setPayer(''); setBank(''); setReceiptDate(todayMyt());
      setLines([{ rid: 1, description: '', creditAccountCode: '', amountSen: 0 }]);
      void notify({ title: `${res.receipt.receiptNumber} posted`, body: `${fmtRm(res.receipt.totalSen)} booked into the ledger.`, tone: 'info' });
    } catch (e) {
      void notify({ title: 'Receipt failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const onVoid = async (r: ReceiptRow) => {
    const ok = await askConfirm({
      title: `Void ${r.number}?`,
      body: 'The RCT journal is reversed and the receipt turns CANCELLED — the ledger keeps both sides.',
      confirmLabel: 'Void', danger: true,
    });
    if (!ok) return;
    try {
      await voidReceipt.mutateAsync(r.id);
    } catch (e) {
      void notify({ title: 'Void failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const rows = listQ.data?.receipts ?? [];
  const monthTotal = rows.filter((r) => r.status !== 'CANCELLED').reduce((s, r) => s + r.totalSen, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="Receipts"
        actions={canCreate ? (
          <button type="button" onClick={() => setAdding(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)', background: 'none', border: 'none', padding: 0 }}>
            <Plus {...ICON} /> New receipt
          </button>
        ) : undefined}
      />

      {adding && (
        <section className={styles.card}>
          <div className={styles.cardHeader}><h2 className={styles.cardTitle}>New receipt — 录入即过账</h2></div>
          {/* Every control wears the same field dress (styles.fieldInput — the
              PV form's), on a grid: Date | Received from | Received into, then
              Description | Account | Amount per line. Owner 2026-09-07: 没办法
              输入日期, 格子等等不整齐, 有些有格子有些没有. */}
          <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', fontSize: 'var(--fs-13)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 180px) minmax(220px, 1fr) minmax(240px, 1fr)', gap: 'var(--space-3)', alignItems: 'end' }}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Date</span>
                <DateField fullWidth value={receiptDate} onChange={(iso) => setReceiptDate(iso)} className={styles.fieldInput} aria-label="Receipt date" />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Received from (打字就行)</span>
                <input value={payer} onChange={(e) => setPayer(e.target.value)} className={styles.fieldInput} />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Received into</span>
                <AccountSelect accounts={moneyAccounts} value={bank} onChange={setBank} placeholder="— bank / cash —" className={styles.fieldInput} />
              </label>
            </div>
            {lines.map((l) => (
              <div key={l.rid} style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) minmax(240px, 1fr) 160px', gap: 'var(--space-2)', alignItems: 'center' }}>
                <input placeholder="Description" value={l.description} className={styles.fieldInput}
                  onChange={(e) => patchLine(l.rid, { description: e.target.value })} />
                <AccountSelect accounts={accounts} value={l.creditAccountCode} className={styles.fieldInput}
                  onChange={(code) => patchLine(l.rid, { creditAccountCode: code })} />
                <MoneyInput bare valueSen={l.amountSen > 0 ? l.amountSen : null} allowBlank placeholder="Amount (RM)"
                  aria-label={`line ${l.rid} amount`} inputClassName={styles.fieldInput}
                  onCommit={(sen) => patchLine(l.rid, { amountSen: sen ?? 0 })} />
              </div>
            ))}
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <Button variant="ghost" size="sm" onClick={() => setLines((p) => [...p, { rid: Math.max(...p.map((x) => x.rid)) + 1, description: '', creditAccountCode: '', amountSen: 0 }])}>
                <Plus {...ICON} /> Line
              </Button>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>Total {fmtRm(total)}</span>
              <Button variant="primary" size="sm" onClick={() => void save()}
                disabled={createReceipt.isPending || total <= 0 || !payer.trim() || !bank || !receiptDate || lines.some((l) => l.amountSen > 0 && !l.creditAccountCode)}>
                {createReceipt.isPending ? 'Posting…' : 'Post receipt'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Close</Button>
            </div>
          </div>
        </section>
      )}

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Money in</h2>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', fontSize: 'var(--fs-13)' }}>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month"
              style={{ padding: '4px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6 }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmtRm(monthTotal)}</span>
          </div>
        </div>
        <div className={styles.cardBody} style={{ overflowX: 'auto' }}>
          {listQ.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}
          {!listQ.isLoading && rows.length === 0 && (
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>Nothing came in this month (searched general + other-debtor + customer receipts).</div>
          )}
          {rows.length > 0 && (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-weak, #e3e1da)' }}>
                  <th style={{ padding: '6px 8px' }}>Kind</th>
                  <th style={{ padding: '6px 8px' }}>No.</th>
                  <th style={{ padding: '6px 8px' }}>Date</th>
                  <th style={{ padding: '6px 8px' }}>From</th>
                  <th style={{ padding: '6px 8px' }}>Into</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Amount</th>
                  <th style={{ padding: '6px 8px' }}>Status</th>
                  <th style={{ padding: '6px 8px' }} aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`} style={{ borderBottom: '1px solid var(--border-weak, #f0eee8)', opacity: r.status === 'CANCELLED' ? 0.55 : 1 }}>
                    <td style={{ padding: '4px 8px', fontSize: 'var(--fs-11)', fontWeight: 600 }}>{KIND_LABEL[r.kind]}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>
                      {r.kind === 'DEBTOR'
                        ? <Link to="/scm/other-debtors" style={{ color: 'inherit' }}>{r.number}</Link>
                        : r.kind === 'CUSTOMER'
                          ? <Link to={`/scm/sales-orders/${r.number}`} style={{ color: 'inherit' }}>{r.number}</Link>
                          : r.number}
                    </td>
                    <td style={{ padding: '4px 8px' }}>{r.date}</td>
                    <td style={{ padding: '4px 8px' }}>{r.payer}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{r.moneyAccount}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtRm(r.totalSen)}</td>
                    <td style={{ padding: '4px 8px', fontSize: 'var(--fs-11)' }}>{r.status}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                      {r.kind === 'GENERAL' && r.status === 'POSTED' && canCancel && (
                        <button type="button" aria-label={`Void ${r.number}`} onClick={() => void onVoid(r)}
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
      </section>
    </div>
  );
};
