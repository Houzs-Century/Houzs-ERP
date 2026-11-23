// ----------------------------------------------------------------------------
// DailyBankCashbook — Receipts & starts, the third view of the cash book's Daily
// Bank (owner 2026-11-23: 先做一个daily bank的一开始直接，但不需要列实际差额。然后我每天
// 会手动输入收到的金额; 付款就根据pv; 原版的daily bank还是要保留哦，我这算是新的daily
// bank). Two cards: the money received on the page's day, typed by hand per bank
// (add, change, delete, each on its history), and each money account's starting
// balance: the bank's balance at the start of a day. From its start a bank is on
// the cash book's Board as start + typed receipts − approved payment vouchers.
// Nothing here posts to the books, and the original Daily Bank never reads it.
// ----------------------------------------------------------------------------

import { useState, type FormEvent } from 'react';
import { History, Pencil, Plus, Trash2 } from 'lucide-react';
import { fmtDate, fmtDateTime, fmtSenPlain } from '../../vendor/shared/format';
import { DateField } from '../../vendor/scm/components/DateField';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import type { AuditLabelDictionary } from '../../components/audit/audit-labels';
import { EntityHistoryPanel } from './EntityHistoryPanel';
import styles from './DailyBank.module.css';
import {
  useAddCashbookReceipt, useDailyBankCashbook, useDeleteCashbookReceipt, useEditCashbookReceipt,
  useRemoveCashbookStart, useSaveCashbookStart, type CashbookAccount, type CashbookReceiptRow,
} from './daily-bank-cashbook-queries';

const money = (sen: number): string => fmtSenPlain(sen);
const asTyped = (sen: number): string => (sen / 100).toFixed(2);
const ICON = { size: 13, strokeWidth: 1.75 } as const;

/** RM as typed (commas and an RM prefix allowed) to sen; null unless it is a plain amount with at most two decimals. */
export function rmToSen(v: string, opts: { negative: boolean }): number | null {
  const t = v.replace(/[,\s]/g, '').replace(/^RM/i, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  if (t.startsWith('-') && !opts.negative) return null;
  const sen = Math.round(Number(t) * 100);
  return Number.isSafeInteger(sen) ? sen : null;
}

/** The accounts a receipt for `day` may go to: those whose cash book has started by then. */
export const openOn = (accounts: CashbookAccount[], day: string): CashbookAccount[] =>
  accounts.filter((a) => a.start != null && a.start.date <= day);

/** Who typed a receipt and when, and who changed it last. */
export function typedLine(r: CashbookReceiptRow): string {
  const at = (ts: string | null): string => (ts ? fmtDateTime(ts).slice(11) : '');
  const typed = [r.createdBy ?? 'Someone', at(r.createdAt)].filter(Boolean).join(' · ');
  return r.updatedBy ? `${typed} · changed by ${r.updatedBy}` : typed;
}

const AUDIT_LABELS: AuditLabelDictionary = {
  actions: { CREATE: 'Added', UPDATE: 'Changed', DELETE: 'Deleted' },
  fields: { account_code: 'Account', receipt_date: 'Day', amount_sen: 'Amount', note: 'Note', start_date: 'Starts on', balance_sen: 'Starting balance' },
  moneyFields: new Set(['amount_sen', 'balance_sen']),
};

type HistoryOf = { type: 'DAILY_BANK_RECEIPT' | 'DAILY_BANK_START'; id: string; label: string };

function AccountSelect({ accounts, value, onChange, label }: { accounts: CashbookAccount[]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <select className={styles.cbText} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {accounts.map((a) => <option key={a.accountCode} value={a.accountCode}>{a.accountCode} · {a.accountName}</option>)}
    </select>
  );
}

function RmBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <span className={styles.rmInput}>
      <span>RM</span>
      <input inputMode="decimal" placeholder="0.00" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
}

function ReceiptForm({ date, accounts, onSaid }: { date: string; accounts: CashbookAccount[]; onSaid: (s: string) => void }) {
  const add = useAddCashbookReceipt();
  const [picked, setPicked] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const account = accounts.some((a) => a.accountCode === picked) ? picked : (accounts[0]?.accountCode ?? '');
  const sen = rmToSen(amount, { negative: false });
  const ready = account !== '' && sen != null && sen > 0 && note.trim() !== '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    add.mutate({ accountCode: account, date, amountSen: sen, note: note.trim() }, {
      onSuccess: () => {
        onSaid(`Added RM ${money(sen)} into ${account} on ${fmtDate(date)}`);
        setAmount('');
        setNote('');
      },
    });
  };
  return (
    <form className={styles.cbForm} onSubmit={submit} aria-label="Type a receipt">
      <label className={styles.cbField}>Bank / cash account
        <AccountSelect accounts={accounts} value={account} onChange={setPicked} label="Account received into" />
      </label>
      <label className={styles.cbField}>Amount received
        <RmBox value={amount} onChange={setAmount} label="Amount received" />
      </label>
      <label className={`${styles.cbField} ${styles.cbGrow}`}>Who paid / what it is for
        <input className={styles.cbText} value={note} maxLength={300} placeholder="e.g. Hookka deposit SO-1234" aria-label="Who paid or what for" onChange={(e) => setNote(e.target.value)} />
      </label>
      <button type="submit" className={styles.solidButton} disabled={!ready || add.isPending}
        title={ready ? undefined : 'Pick the account, type the amount and say who paid'}>
        <Plus size={14} />{add.isPending ? 'Saving…' : 'Add receipt'}
      </button>
    </form>
  );
}

function ReceiptRowView({ r, accounts, canEdit, today, onHistory }: {
  r: CashbookReceiptRow; accounts: CashbookAccount[]; canEdit: boolean; today: string; onHistory: (h: HistoryOf) => void;
}) {
  const edit = useEditCashbookReceipt();
  const del = useDeleteCashbookReceipt();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [account, setAccount] = useState(r.accountCode);
  const [day, setDay] = useState(r.date);
  const [amount, setAmount] = useState(asTyped(r.amountSen));
  const [note, setNote] = useState(r.note);
  const open = () => { setAccount(r.accountCode); setDay(r.date); setAmount(asTyped(r.amountSen)); setNote(r.note); setEditing(true); };
  const sen = rmToSen(amount, { negative: false });
  const ready = sen != null && sen > 0 && note.trim() !== '' && day <= today;
  const choices = openOn(accounts, day);
  const remove = async () => {
    const ok = await confirm({
      title: `Delete RM ${money(r.amountSen)} into ${r.accountCode}?`,
      body: `${r.note} · ${fmtDate(r.date)}. It comes off the Board. The deletion is kept in its history with your name.`,
      confirmLabel: 'Delete receipt',
      danger: true,
    });
    if (ok) del.mutate({ id: r.id });
  };
  if (editing) {
    return (
      <tr>
        <td>{choices.length > 0
          ? <AccountSelect accounts={choices} value={choices.some((a) => a.accountCode === account) ? account : (choices[0]?.accountCode ?? '')} onChange={setAccount} label="Account" />
          : <span className={styles.cbFlag}>No account has started by this day</span>}</td>
        <td><DateField value={day} max={today} onChange={(iso) => { if (iso) setDay(iso); }} aria-label="Day received" /></td>
        <td className={styles.num}><RmBox value={amount} onChange={setAmount} label="Amount" /></td>
        <td><input className={styles.cbText} value={note} maxLength={300} aria-label="Note" onChange={(e) => setNote(e.target.value)} /></td>
        <td className={styles.cbActions}>
          <button type="button" className={styles.solidButton} disabled={!ready || choices.length === 0 || edit.isPending}
            onClick={() => {
              if (sen == null) return;
              const code = choices.some((a) => a.accountCode === account) ? account : (choices[0]?.accountCode ?? account);
              edit.mutate({ id: r.id, accountCode: code, date: day, amountSen: sen, note: note.trim() }, { onSuccess: () => setEditing(false) });
            }}>{edit.isPending ? 'Saving…' : 'Save'}</button>
          <button type="button" className={styles.iconButton} onClick={() => setEditing(false)}>Cancel</button>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td><span className={styles.docCell}>{r.accountCode}</span> <span className={styles.muted}>{r.accountName}</span></td>
      <td className={styles.muted}>{fmtDate(r.date)}</td>
      <td className={`${styles.num} ${styles.moneyIn}`}>{money(r.amountSen)}</td>
      <td>{r.note}{!r.counted && <span className={styles.cbFlag}>Not on the Board: before this account's start</span>}
        <div className={styles.muted}>{typedLine(r)}</div></td>
      <td className={styles.cbActions}>
        {canEdit && <button type="button" className={styles.iconButton} onClick={open} aria-label={`Change receipt ${r.note}`}><Pencil {...ICON} />Change</button>}
        {canEdit && <button type="button" className={`${styles.iconButton} ${styles.dangerText}`} disabled={del.isPending} onClick={() => { void remove(); }} aria-label={`Delete receipt ${r.note}`}><Trash2 {...ICON} />Delete</button>}
        <button type="button" className={styles.iconButton} onClick={() => onHistory({ type: 'DAILY_BANK_RECEIPT', id: r.id, label: `${r.accountCode} · ${fmtDate(r.date)} · RM ${money(r.amountSen)}` })} aria-label={`History of receipt ${r.note}`}><History {...ICON} /></button>
      </td>
    </tr>
  );
}

function StartRowView({ a, canEdit, defaultDay, onHistory, onSaid }: {
  a: CashbookAccount; canEdit: boolean; defaultDay: string; onHistory: (h: HistoryOf) => void; onSaid: (s: string) => void;
}) {
  const save = useSaveCashbookStart();
  const remove = useRemoveCashbookStart();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [day, setDay] = useState(defaultDay);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const open = () => {
    setDay(a.start?.date ?? defaultDay);
    setAmount(a.start ? asTyped(a.start.balanceSen) : '');
    setNote(a.start?.note ?? '');
    setEditing(true);
  };
  const sen = rmToSen(amount, { negative: true });
  const drop = async () => {
    const ok = await confirm({
      title: `Remove ${a.accountCode}'s starting balance?`,
      body: 'This bank leaves the cash book. Its typed receipts are kept, and count again once a start on or before them is set. The original Daily Bank is not affected.',
      confirmLabel: 'Remove start',
      danger: true,
    });
    if (ok) remove.mutate({ accountCode: a.accountCode }, { onSuccess: () => onSaid(`${a.accountCode} reads the ledger again`) });
  };
  const name = <><span className={styles.docCell}>{a.accountCode}</span> <span className={styles.muted}>{a.accountName}</span></>;
  if (editing) {
    return (
      <tr>
        <td>{name}</td>
        <td><DateField value={day} onChange={(iso) => { if (iso) setDay(iso); }} aria-label={`${a.accountCode} start day`} /></td>
        <td className={styles.num}><RmBox value={amount} onChange={setAmount} label={`${a.accountCode} balance at the start of the day`} /></td>
        <td><input className={styles.cbText} value={note} maxLength={300} placeholder="e.g. Maybank statement, closing 30/09" aria-label={`${a.accountCode} note`} onChange={(e) => setNote(e.target.value)} /></td>
        <td className={styles.cbActions}>
          <button type="button" className={styles.solidButton} disabled={sen == null || save.isPending}
            onClick={() => {
              if (sen == null) return;
              save.mutate({ accountCode: a.accountCode, startDate: day, balanceSen: sen, note: note.trim() || null }, {
                onSuccess: () => { setEditing(false); onSaid(`${a.accountCode} starts ${fmtDate(day)} at RM ${money(sen)}`); },
              });
            }}>{save.isPending ? 'Saving…' : 'Save start'}</button>
          <button type="button" className={styles.iconButton} onClick={() => setEditing(false)}>Cancel</button>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>{name}</td>
      <td>{a.start ? fmtDate(a.start.date) : <span className={styles.muted}>Not set</span>}</td>
      <td className={styles.num}>{a.start ? <span className={a.start.balanceSen < 0 ? styles.negative : undefined}>{money(a.start.balanceSen)}</span> : ''}</td>
      <td>
        {a.start
          ? <><span className={`${styles.srcTag} ${a.start.date <= defaultDay ? styles.srcCash : styles.srcLedger}`}>{a.start.date <= defaultDay ? 'On the cash book' : 'Starts later'}</span> <span className={styles.muted}>{a.start.note ? `${a.start.note} · ` : ''}{a.start.setBy ? `set by ${a.start.setBy}` : ''}</span></>
          : <><span className={`${styles.srcTag} ${styles.srcLedger}`}>Not started</span> <span className={styles.muted}>no starting balance yet</span></>}
      </td>
      <td className={styles.cbActions}>
        {canEdit && <button type="button" className={styles.iconButton} onClick={open}><Pencil {...ICON} />{a.start ? 'Change' : 'Set start'}</button>}
        {canEdit && a.start && <button type="button" className={`${styles.iconButton} ${styles.dangerText}`} disabled={remove.isPending} onClick={() => { void drop(); }}><Trash2 {...ICON} />Remove</button>}
        {a.start && <button type="button" className={styles.iconButton} onClick={() => onHistory({ type: 'DAILY_BANK_START', id: a.accountCode, label: `${a.accountCode} starting balance` })} aria-label={`History of ${a.accountCode}'s start`}><History {...ICON} /></button>}
      </td>
    </tr>
  );
}

export function DailyBankCashbook({ date, today }: { date: string; today: string }) {
  const q = useDailyBankCashbook(date);
  const [said, setSaid] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryOf | null>(null);
  const day = q.data;
  const accounts = day?.accounts ?? [];
  const open = openOn(accounts, date);
  const canEdit = day?.canWrite === true;
  const total = (day?.receipts ?? []).filter((r) => r.counted).reduce((n, r) => n + r.amountSen, 0);
  const future = date > today;

  return (
    <div className={styles.cashbook}>
      {q.isLoading && <div className={styles.muted}>Loading the cash book…</div>}
      {q.isError && <div role="alert" className={styles.problem}>The cash book could not be loaded — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</div>}

      {day && (
        <section className={styles.cbCard} aria-label="Money received">
          <div className={styles.closeHead}>
            <span className={styles.closeTitle}>Money received · {fmtDate(date)}</span>
            <span className={styles.closeSub}>{day.receipts.length} typed · RM {money(total)} on the Board</span>
          </div>
          <div className={styles.cbHelp}>Type what actually came into each bank this day, with who paid or what it is for. Payments come off by themselves: every approved payment voucher paying out of the account, on its voucher date. Nothing here posts to the books.</div>
          {future && <div className={styles.muted}>This day hasn’t happened yet. Money is typed once it is received.</div>}
          {!future && canEdit && open.length > 0 && <ReceiptForm date={date} accounts={open} onSaid={setSaid} />}
          {!future && open.length === 0 && <div className={styles.muted}>No account’s cash book has started by {fmtDate(date)}. Set a starting balance below first.</div>}
          {!canEdit && <div className={styles.muted}>You can read the cash book; changing it needs Finance’s posting permission.</div>}
          {said && <div className={styles.saidLine} role="status">{said}</div>}
          {day.receipts.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.acctTable}>
                <thead><tr><th>Account</th><th>Day</th><th className={styles.num}>Received (RM)</th><th>Who paid / what for</th><th /></tr></thead>
                <tbody>
                  {day.receipts.map((r) => (
                    <ReceiptRowView key={`${r.id}:${r.updatedAt ?? ''}`} r={r} accounts={accounts} canEdit={canEdit} today={today} onHistory={setHistory} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {day.deleted.length > 0 && (
            <details className={styles.cbDeletedList}>
              <summary>Deleted this day ({day.deleted.length})</summary>
              <table className={styles.acctTable}>
                <tbody>
                  {day.deleted.map((r) => (
                    <tr key={r.id}>
                      <td>{r.accountCode}</td>
                      <td className={styles.num}>{money(r.amountSen)}</td>
                      <td>{r.note}</td>
                      <td className={styles.muted}>Deleted by {r.deletedBy ?? 'someone'}{r.deletedAt ? ` · ${fmtDateTime(r.deletedAt)}` : ''}</td>
                      <td className={styles.cbActions}>
                        <button type="button" className={styles.iconButton} onClick={() => setHistory({ type: 'DAILY_BANK_RECEIPT', id: r.id, label: `${r.accountCode} · ${fmtDate(r.date)} · RM ${money(r.amountSen)}` })} aria-label={`History of deleted receipt ${r.note}`}><History {...ICON} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </section>
      )}

      {day && (
        <section className={styles.cbCard} aria-label="Starting balances">
          <div className={styles.closeHead}><span className={styles.closeTitle}>Starting balances</span>
            <span className={styles.closeSub}>{accounts.filter((a) => a.start).length} of {accounts.length} accounts use the cash book</span></div>
          <div className={styles.cbHelp}>The bank’s real balance at the start of a day, before any of that day’s money in or out: the closing balance of the day before. For example, a statement’s balance on 30/09 starts the cash book on 01/10. From that day this bank is on the cash book’s Board as start + money received − approved payment vouchers. A bank without a start is not on it yet. The original Daily Bank is not affected.</div>
          <div className={styles.tableWrap}>
            <table className={styles.acctTable}>
              <thead><tr><th>Account</th><th>Starts on</th><th className={styles.num}>Balance at the start (RM)</th><th>Cash book</th><th /></tr></thead>
              <tbody>
                {accounts.map((a) => (
                  <StartRowView key={`${a.accountCode}:${a.start?.setAt ?? ''}`} a={a} canEdit={canEdit} defaultDay={date} onHistory={setHistory} onSaid={setSaid} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {history && (
        <EntityHistoryPanel entityType={history.type} entityId={history.id} recordLabel={history.label}
          entityName={history.type === 'DAILY_BANK_START' ? 'Starting balance' : 'Typed receipt'}
          labels={AUDIT_LABELS} statusDocType="pv" onClose={() => setHistory(null)} />
      )}
    </div>
  );
}
