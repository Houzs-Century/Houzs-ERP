// ----------------------------------------------------------------------------
// Receipts — /scm/receipts (owner 2026-09-03): 这个月收了什么钱, one page.
//
// Three kinds in one table: GENERAL (raised HERE — 就我只想开 receipt 罢了:
// payer typed free, money account, lines pick their own credit accounts,
// posts directly, 错就 void), DEBTOR (read-only mirror of the Other Debtors
// receipts, raised and four-layered over there), CUSTOMER (read-only mirror
// of the sales payments — 顾客的钱 keeps its own flow).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, Pencil, Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useAccounts, useReceipts, useCreateReceipt, useVoidReceipt, useReceiptDetail, useUpdateReceipt,
  postableAccounts,
  type Account, type ReceiptRow,
} from '../../vendor/scm/lib/accounting-queries';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { useSaveHotkey, SAVE_HOTKEY_HINT } from '../../vendor/scm/lib/use-save-hotkey';
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
  const canEdit = can('scm.payment_voucher.write') || canCreate;

  /* Every month by default; the month is a FILTER (owner 2026-09-08: 月份只是
     筛选 — the page used to open on this month alone). '' = all. */
  const [month, setMonth] = useState<string>('');
  const listQ = useReceipts(month || undefined);
  const accountsQ = useAccounts();
  /* The whole chart goes in: a header whose children are all retired is still
     a header (docs/bugs/0693). */
  const accounts = useMemo<Account[]>(() => postableAccounts(accountsQ.data?.accounts ?? []), [accountsQ.data]);
  const moneyAccounts = useMemo(() => accounts.filter((a) => a.acc_money === true), [accounts]);

  const createReceipt = useCreateReceipt();
  const voidReceipt = useVoidReceipt();
  const updateReceipt = useUpdateReceipt();

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
  /* Editing a POSTED general receipt (owner 2026-09-07: 收钱的日期错了 → 做 b):
     the same form, seeded from the receipt, saved through PATCH — the server
     reverses the old RCT entry as it was dated and books a fresh one on the
     new date; the number stays. */
  const [editing, setEditing] = useState<ReceiptRow | null>(null);
  const detailQ = useReceiptDetail(editing?.id ?? null);
  /* Seed ONCE per receipt opened — the operator's edits must not be overwritten
     by a refetch, and a hook that hands back a fresh object must not loop. */
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!editing || !detailQ.data || seededFor.current === editing.id) return;
    seededFor.current = editing.id;
    const { receipt, lines: rows } = detailQ.data;
    setPayer(receipt.payer_name);
    setBank(receipt.bank_account_code);
    setReceiptDate(String(receipt.receipt_date).slice(0, 10));
    setLines(rows.length > 0
      ? rows.map((l, i) => ({ rid: i + 1, description: l.description ?? '', creditAccountCode: l.credit_account_code, amountSen: Number(l.amount_sen) }))
      : [{ rid: 1, description: '', creditAccountCode: '', amountSen: 0 }]);
    setAdding(true);
  }, [editing, detailQ.data]);
  const closeForm = () => {
    setAdding(false); setEditing(null); seededFor.current = null;
    setPayer(''); setBank(''); setReceiptDate(todayMyt());
    setLines([{ rid: 1, description: '', creditAccountCode: '', amountSen: 0 }]);
  };
  const patchLine = (rid: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));

  const save = async () => {
    const sendLines = lines
      .filter((l) => l.creditAccountCode && l.amountSen > 0)
      .map((l) => ({ ...(l.description.trim() ? { description: l.description.trim() } : {}), creditAccountCode: l.creditAccountCode, amountSen: l.amountSen }));
    try {
      if (editing) {
        const res = await updateReceipt.mutateAsync({ id: editing.id, payerName: payer.trim(), receiptDate, bankAccountCode: bank, lines: sendLines });
        closeForm();
        void notify({ title: `${res.receipt.receiptNumber} re-posted`, body: `${fmtRm(res.receipt.totalSen)} now booked on ${res.receipt.receiptDate} — the old entry is reversed, the number stays.`, tone: 'info' });
        return;
      }
      const res = await createReceipt.mutateAsync({
        payerName: payer.trim(),
        receiptDate,
        bankAccountCode: bank,
        lines: sendLines,
      });
      closeForm();
      void notify({ title: `${res.receipt.receiptNumber} posted`, body: `${fmtRm(res.receipt.totalSen)} booked into the ledger.`, tone: 'info' });
    } catch (e) {
      void notify({ title: editing ? 'Re-post failed' : 'Receipt failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
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

  /* The one "may post" for the button and the key alike. */
  const canPost = total > 0 && !!payer.trim() && !!bank && !!receiptDate && !lines.some((l) => l.amountSen > 0 && !l.creditAccountCode);
  /* F3 / Ctrl+S posts the open form (owner 2026-09-08: 像 autocount 按 f3). */
  useSaveHotkey(() => { if (canPost) void save(); }, adding && !createReceipt.isPending && !updateReceipt.isPending);

  const rows = listQ.data?.receipts ?? [];
  const listTotal = rows.filter((r) => r.status !== 'CANCELLED').reduce((s, r) => s + r.totalSen, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="Receipts"
        actions={canCreate ? (
          <button type="button" onClick={() => { closeForm(); setAdding(true); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)', background: 'none', border: 'none', padding: 0 }}>
            <Plus {...ICON} /> New receipt
          </button>
        ) : undefined}
      />

      {adding && (
        <section className={styles.card}>
          <div className={styles.cardHeader}><h2 className={styles.cardTitle}>{editing ? `Edit ${editing.number} — 改了会重新过账` : 'New receipt — 录入即过账'}</h2></div>
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
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{SAVE_HOTKEY_HINT}</span>
              <Button variant="primary" size="sm" onClick={() => void save()}
                disabled={createReceipt.isPending || updateReceipt.isPending || !canPost}>
                {editing ? (updateReceipt.isPending ? 'Re-posting…' : 'Save & re-post') : createReceipt.isPending ? 'Posting…' : 'Post receipt'}
              </Button>
              <Button variant="ghost" size="sm" onClick={closeForm}>Close</Button>
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
            {month !== '' && (
              <button type="button" onClick={() => setMonth('')}
                style={{ padding: '4px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6, background: 'none', cursor: 'pointer', fontSize: 'var(--fs-13)' }}>
                All months
              </button>
            )}
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmtRm(listTotal)}</span>
          </div>
        </div>
        <div className={styles.cardBody} style={{ overflowX: 'auto' }}>
          {listQ.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}
          {!listQ.isLoading && rows.length === 0 && (
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>Nothing came in {month ? 'this month' : 'yet'} (searched general + other-debtor + customer receipts).</div>
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
                    <td style={{ padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {r.kind === 'GENERAL' && r.status === 'POSTED' && canEdit && (
                        <button type="button" aria-label={`Edit ${r.number}`} onClick={() => setEditing(r)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 2, marginRight: 4 }}>
                          <Pencil size={14} strokeWidth={1.75} />
                        </button>
                      )}
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
