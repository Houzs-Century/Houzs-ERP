// ----------------------------------------------------------------------------
// Receipts — /scm/receipts (owner 2026-09-03): 这个月收了什么钱, one page.
//
// Three kinds in one table: GENERAL (raised HERE — 就我只想开 receipt 罢了:
// payer typed free, money account, lines pick their own credit accounts,
// posts directly, 错就 void), DEBTOR (read-only mirror of the Other Debtors
// receipts, raised and four-layered over there), CUSTOMER (read-only mirror
// of the sales payments — 顾客的钱 keeps its own flow).
//
// The list is the voucher list's grid (owner 2026-09-08, pointing at that
// header: Filter 我要这样的 filter function): every column sorts, every funnel
// filters, the search box finds a number, a payer, a bank; the month picker,
// the count and the total ride in the grid's toolbar and the total follows
// whatever is filtered. New / Edit open in the pop-out over the list — the
// form used to be pushed in ABOVE the table, which sent the operator to the
// top of a long list (如果我在下面我要滑到很上面).
//
// The same New receipt takes an OTHER DEBTOR's money too (owner 2026-09-08:
// 不可能链接起来吗? 想 pv 也可以付 AP invoice, expense — receipt 页我也希望这样;
// then 用这个方式 for posting on Post): a kind switch, Sundry income or Other
// Debtor; the debtor's open bills list with an amount each, exactly the
// Other Debtors page's picker; Post raises the ODR through that module's own
// route with postNow, which books Dr bank / Cr 305 and knocks the bills off in
// the same call — no four layers on this door. The bill itself (记它欠多少) is
// still raised on the Other Debtors page.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, Pencil, Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useAccounts, useReceipts, useCreateReceipt, useVoidReceipt, useReceiptDetail, useUpdateReceipt,
  useOtherDebtors, useDebtorDetail, useCreateDebtorReceipt,
  postableAccounts,
  type Account, type ReceiptRow, type DebtorBill,
} from '../../vendor/scm/lib/accounting-queries';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { Modal } from '../../vendor/scm/components/Modal';
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

const RECEIPTS_STORAGE_KEY = 'receipts-list.layout.v1';
/* Newest first, the voucher list's order. Module-level on purpose: the grid
   re-derives its visible rows whenever a prop like this changes identity and
   reports them back — an inline comparator would report on every render. */
const NEWEST_FIRST = (a: ReceiptRow, b: ReceiptRow): number => b.date.localeCompare(a.date) || b.number.localeCompare(a.number);
const NO_ROWS: ReceiptRow[] = [];

const iconButton = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 2 } as const;

/* The grid's columns — the voucher list's shape: a cell, what search and the
   funnel see of it, how it sorts. Edit / Void live in a last column so the
   row tests (and the operator) find them by the receipt's number. */
const buildReceiptColumns = (h: {
  canEdit: boolean; canCancel: boolean;
  onEdit: (r: ReceiptRow) => void; onVoid: (r: ReceiptRow) => void;
}): DataGridColumn<ReceiptRow>[] => [
  {
    key: 'kind', label: 'Kind', width: 110, sortable: true, groupable: true,
    accessor: (r) => <span style={{ fontSize: 'var(--fs-11)', fontWeight: 600 }}>{KIND_LABEL[r.kind]}</span>,
    searchValue: (r) => KIND_LABEL[r.kind],
    filterValue: (r) => KIND_LABEL[r.kind],
    groupValue: (r) => KIND_LABEL[r.kind],
    sortFn: (a, b) => KIND_LABEL[a.kind].localeCompare(KIND_LABEL[b.kind]),
  },
  {
    key: 'number', label: 'No.', width: 180, sortable: true,
    accessor: (r) => (
      <span style={{ fontFamily: 'var(--font-mono)' }}>
        {r.kind === 'DEBTOR'
          ? <Link to="/scm/other-debtors" style={{ color: 'inherit' }}>{r.number}</Link>
          : r.kind === 'CUSTOMER'
            ? <Link to={`/scm/sales-orders/${r.number}`} style={{ color: 'inherit' }}>{r.number}</Link>
            : r.number}
      </span>
    ),
    searchValue: (r) => r.number,
    filterValue: (r) => r.number,
    filterType: 'numbering',
    sortFn: (a, b) => a.number.localeCompare(b.number),
  },
  {
    key: 'date', label: 'Date', width: 120, sortable: true,
    accessor: (r) => r.date,
    searchValue: (r) => r.date,
    filterType: 'date', dateValue: (r) => r.date,
    sortFn: (a, b) => a.date.localeCompare(b.date),
  },
  {
    key: 'payer', label: 'From', width: 260, sortable: true, groupable: true,
    accessor: (r) => r.payer,
    searchValue: (r) => r.payer,
    groupValue: (r) => r.payer || '(none)',
    sortFn: (a, b) => a.payer.localeCompare(b.payer),
  },
  {
    key: 'moneyAccount', label: 'Into', width: 200, sortable: true, groupable: true,
    accessor: (r) => <span style={{ fontFamily: 'var(--font-mono)' }}>{r.moneyAccount}</span>,
    searchValue: (r) => r.moneyAccount,
    groupValue: (r) => r.moneyAccount || '(none)',
    sortFn: (a, b) => a.moneyAccount.localeCompare(b.moneyAccount),
  },
  {
    key: 'totalSen', label: 'Amount', width: 140, sortable: true, align: 'right',
    accessor: (r) => <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(r.totalSen)}</span>,
    searchValue: (r) => fmtRm(r.totalSen),
    exportValue: (r) => r.totalSen / 100,
    filterType: 'number', numberValue: (r) => r.totalSen / 100,
    sortFn: (a, b) => a.totalSen - b.totalSen,
  },
  {
    key: 'status', label: 'Status', width: 120, sortable: true, groupable: true,
    accessor: (r) => <span style={{ fontSize: 'var(--fs-11)' }}>{r.status}</span>,
    searchValue: (r) => r.status,
    filterValue: (r) => r.status,
    groupValue: (r) => r.status,
    sortFn: (a, b) => a.status.localeCompare(b.status),
  },
  {
    key: 'actions', label: '', exportLabel: 'Actions', width: 80, align: 'right',
    accessor: (r) => (
      <span style={{ whiteSpace: 'nowrap' }}>
        {r.kind === 'GENERAL' && r.status === 'POSTED' && h.canEdit && (
          <button type="button" aria-label={`Edit ${r.number}`} style={{ ...iconButton, marginRight: 4 }}
            onClick={(e) => { e.stopPropagation(); h.onEdit(r); }}>
            <Pencil size={14} strokeWidth={1.75} />
          </button>
        )}
        {r.kind === 'GENERAL' && r.status === 'POSTED' && h.canCancel && (
          <button type="button" aria-label={`Void ${r.number}`} style={iconButton}
            onClick={(e) => { e.stopPropagation(); h.onVoid(r); }}>
            <Ban size={14} strokeWidth={1.75} />
          </button>
        )}
      </span>
    ),
    searchValue: () => '',
    exportValue: () => '',
  },
];

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
  /* Which money this New receipt takes: sundry income (lines pick their own
     credit accounts) or an Other Debtor's (bills ticked, control credited). */
  const [kind, setKind] = useState<'GENERAL' | 'DEBTOR'>('GENERAL');
  const [debtorId, setDebtorId] = useState('');
  const [debtorAllocs, setDebtorAllocs] = useState<Record<string, number>>({});
  const debtorsQ = useOtherDebtors();
  const debtorDetailQ = useDebtorDetail(adding && kind === 'DEBTOR' && debtorId ? debtorId : null);
  const createDebtorReceipt = useCreateDebtorReceipt();
  const openBills = useMemo<DebtorBill[]>(
    () => (debtorDetailQ.data?.bills ?? []).filter((b) => b.status !== 'CANCELLED' && b.total_sen - b.received_sen > 0),
    [debtorDetailQ.data],
  );
  const debtorTotal = Object.values(debtorAllocs).reduce((s, v) => s + (v > 0 ? v : 0), 0);
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
    setKind('GENERAL'); setDebtorId(''); setDebtorAllocs({});
  };
  const patchLine = (rid: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));

  const save = async () => {
    const sendLines = lines
      .filter((l) => l.creditAccountCode && l.amountSen > 0)
      .map((l) => ({ ...(l.description.trim() ? { description: l.description.trim() } : {}), creditAccountCode: l.creditAccountCode, amountSen: l.amountSen }));
    try {
      if (!editing && kind === 'DEBTOR') {
        const res = await createDebtorReceipt.mutateAsync({
          debtorId, receiptDate, bankAccountCode: bank, postNow: true,
          allocations: Object.entries(debtorAllocs).filter(([, v]) => v > 0).map(([billId, amountSen]) => ({ billId, amountSen })),
        });
        closeForm();
        void notify({ title: `${res.receipt.receiptNumber} posted`, body: `${fmtRm(res.receipt.totalSen ?? debtorTotal)} booked into the ledger — the ticked bills are knocked off.`, tone: 'info' });
        return;
      }
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
  /* The columns are built once; the void handler closes over dialogs and
     mutations that change identity every render, so it is reached by ref. */
  const voidRef = useRef(onVoid);
  voidRef.current = onVoid;
  const columns = useMemo(() => buildReceiptColumns({
    canEdit, canCancel,
    onEdit: (r) => setEditing(r),
    onVoid: (r) => { void voidRef.current(r); },
  }), [canEdit, canCancel]);

  /* The one "may post" for the button and the key alike. */
  const debtorMode = !editing && kind === 'DEBTOR';
  const canPost = debtorMode
    ? debtorTotal > 0 && !!debtorId && !!bank && !!receiptDate
    : total > 0 && !!payer.trim() && !!bank && !!receiptDate && !lines.some((l) => l.amountSen > 0 && !l.creditAccountCode);
  const saving = createReceipt.isPending || updateReceipt.isPending || createDebtorReceipt.isPending;
  /* F3 / Ctrl+S posts the open form (owner 2026-09-08: 像 autocount 按 f3). */
  useSaveHotkey(() => { if (canPost) void save(); }, adding && !saving);

  /* One identity per load: a fresh `[]` per render would have the grid
     re-derive and report its rows every render, and the report re-renders. */
  const rows = listQ.data?.receipts ?? NO_ROWS;
  /* What the grid currently shows after its search and funnels — the count
     and the total below follow it, so a filtered list totals itself. */
  const [visible, setVisible] = useState<ReceiptRow[] | null>(null);
  const shown = visible ?? rows;
  const listTotal = shown.filter((r) => r.status !== 'CANCELLED').reduce((s, r) => s + r.totalSen, 0);

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
        <Modal
          title={editing ? `Edit ${editing.number} — 改了会重新过账` : debtorMode ? 'New receipt — Other Debtor — 录入即过账' : 'New receipt — 录入即过账'}
          onClose={closeForm}
          width="min(980px, 100%)"
          ariaLabel={editing ? 'Edit receipt' : 'New receipt'}
        >
          {/* Every control wears the same field dress (styles.fieldInput — the
              PV form's), on a grid: Date | Received from | Received into, then
              Description | Account | Amount per line. Owner 2026-09-07: 没办法
              输入日期, 格子等等不整齐, 有些有格子有些没有. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', fontSize: 'var(--fs-13)' }}>
            {!editing && (
              <div role="radiogroup" aria-label="Receipt kind" style={{ display: 'flex', gap: 6 }}>
                {([['GENERAL', 'Sundry income'], ['DEBTOR', 'Other Debtor']] as const).map(([k, label]) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k}
                    onClick={() => { setKind(k); setDebtorAllocs({}); }}
                    style={{
                      padding: '4px 12px', borderRadius: 999, cursor: 'pointer', fontSize: 'var(--fs-13)',
                      border: `1px solid ${kind === k ? 'var(--c-orange)' : 'var(--border-weak, #d8d5cd)'}`,
                      background: kind === k ? 'var(--c-orange)' : 'none', color: kind === k ? '#fff' : 'inherit', fontWeight: kind === k ? 600 : 400,
                    }}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 180px) minmax(220px, 1fr) minmax(240px, 1fr)', gap: 'var(--space-3)', alignItems: 'end' }}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Date</span>
                <DateField fullWidth value={receiptDate} onChange={(iso) => setReceiptDate(iso)} className={styles.fieldInput} aria-label="Receipt date" />
              </label>
              {debtorMode ? (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Debtor</span>
                  <select aria-label="Debtor" value={debtorId} className={styles.fieldInput}
                    onChange={(e) => { setDebtorId(e.target.value); setDebtorAllocs({}); }}>
                    <option value="">— pick the debtor —</option>
                    {(debtorsQ.data?.debtors ?? []).filter((d) => d.is_active || d.id === debtorId).map((d) => (
                      <option key={d.id} value={d.id}>{d.name}{d.outstanding_sen > 0 ? ` — owes ${fmtRm(d.outstanding_sen)}` : ''}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Received from (打字就行)</span>
                  <input value={payer} onChange={(e) => setPayer(e.target.value)} className={styles.fieldInput} />
                </label>
              )}
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Received into</span>
                <AccountSelect accounts={moneyAccounts} value={bank} onChange={setBank} placeholder="— bank / cash —" className={styles.fieldInput} />
              </label>
            </div>
            {debtorMode && (
              /* The Other Debtors page's own picker: tick pays a bill in full,
                 type for a partial; nothing above the bill's outstanding. */
              !debtorId ? (
                <div style={{ color: 'var(--fg-muted)' }}>Pick the debtor to list what they still owe.</div>
              ) : debtorDetailQ.isLoading ? (
                <div style={{ color: 'var(--fg-muted)' }}>Loading their bills…</div>
              ) : openBills.length === 0 ? (
                <div style={{ color: 'var(--fg-muted)' }}>This debtor has no open bill — raise the bill on Other Debtors first.</div>
              ) : (
                <table style={{ borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      <th style={{ padding: '4px 8px' }} aria-label="collect in full" />
                      <th style={{ padding: '4px 8px' }}>Bill</th>
                      <th style={{ padding: '4px 8px' }}>Date</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Outstanding</th>
                      <th style={{ padding: '4px 8px' }}>Receive</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openBills.map((b) => {
                      const out = b.total_sen - b.received_sen;
                      const v = debtorAllocs[b.id] ?? 0;
                      return (
                        <tr key={b.id} style={{ borderBottom: '1px solid var(--border-weak, #f0eee8)' }}>
                          <td style={{ padding: '4px 8px' }}>
                            <input type="checkbox" aria-label={`Collect ${b.bill_number} in full`}
                              checked={v === out && out > 0}
                              onChange={(e) => setDebtorAllocs((prev) => ({ ...prev, [b.id]: e.target.checked ? out : 0 }))} />
                          </td>
                          <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{b.bill_number}</td>
                          <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{b.bill_date}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{fmtRm(out)}</td>
                          <td style={{ padding: '4px 8px', width: 160 }}>
                            <MoneyInput bare valueSen={v > 0 ? v : null} allowBlank inputClassName={styles.fieldInput} selectOnFocus aria-label={`amount for ${b.bill_number}`}
                              placeholder="0.00" style={{ width: '100%' }}
                              onCommit={(sen) => setDebtorAllocs((prev) => ({ ...prev, [b.id]: Math.min(out, Math.max(0, sen ?? 0)) }))} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )
            )}
            {!debtorMode && lines.map((l) => (
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
              {!debtorMode && (
                <Button variant="ghost" size="sm" onClick={() => setLines((p) => [...p, { rid: Math.max(...p.map((x) => x.rid)) + 1, description: '', creditAccountCode: '', amountSen: 0 }])}>
                  <Plus {...ICON} /> Line
                </Button>
              )}
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>Total {fmtRm(debtorMode ? debtorTotal : total)}</span>
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{SAVE_HOTKEY_HINT}</span>
              <Button variant="primary" size="sm" onClick={() => void save()}
                disabled={saving || !canPost}>
                {editing ? (updateReceipt.isPending ? 'Re-posting…' : 'Save & re-post') : saving ? 'Posting…' : 'Post receipt'}
              </Button>
              <Button variant="ghost" size="sm" onClick={closeForm}>Close</Button>
            </div>
          </div>
        </Modal>
      )}

      <DataGrid<ReceiptRow>
        rows={rows}
        columns={columns}
        storageKey={RECEIPTS_STORAGE_KEY}
        exportName="Receipts"
        rowKey={(r) => `${r.kind}-${r.id}`}
        searchPlaceholder="Search no., payer, bank…"
        isLoading={listQ.isLoading}
        emptyMessage={`Nothing came in ${month ? 'this month' : 'yet'} (searched general + other-debtor + customer receipts).`}
        onFilteredRowsChange={setVisible}
        defaultSort={NEWEST_FIRST}
        rowStyle={(r) => (r.status === 'CANCELLED' ? { opacity: 0.55 } : undefined)}
        groupBanner={false}
        toolbar={(
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', fontSize: 'var(--fs-13)' }}>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month"
              style={{ padding: '4px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6 }} />
            {month !== '' && (
              <button type="button" onClick={() => setMonth('')}
                style={{ padding: '4px 8px', border: '1px solid var(--border-weak, #d8d5cd)', borderRadius: 6, background: 'none', cursor: 'pointer', fontSize: 'var(--fs-13)' }}>
                All months
              </button>
            )}
            <span style={{ color: 'var(--fg-muted)' }}>{shown.length} receipt(s)</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmtRm(listTotal)}</span>
          </div>
        )}
      />
    </div>
  );
};
