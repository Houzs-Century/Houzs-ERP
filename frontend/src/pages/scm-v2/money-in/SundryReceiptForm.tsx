// ----------------------------------------------------------------------------
// SundryReceiptForm — a sundry-income receipt's form, in place of its page
// (`?form=edit|copy`; the owner's Claude Design, batch 5 §2.1). Date, who paid,
// into which money account, then the lines — the account each credits, what
// it was for, the amount. The Books line says what saving does; the button
// stays grey with the reason until the receipt can be saved. F3 / Ctrl+S saves,
// as on the Receipts page's own form. The page sends it through the same
// routes as before: a copy posts new (POST /receipts), an edit re-posts
// (PATCH /receipts/:id — the old journal reversed, the number kept).
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { Account } from '../../../vendor/scm/lib/accounting-queries';
import { AccountSelect } from '../../../vendor/scm/components/AccountSelect';
import { DateField } from '../../../vendor/scm/components/DateField';
import { MoneyInput } from '../../../vendor/scm/components/MoneyInput';
import { useSaveHotkey, SAVE_HOTKEY_HINT } from '../../../vendor/scm/lib/use-save-hotkey';
import { fmtSen } from '../../../vendor/shared/format';
import fields from '../SalesOrderDetail.module.css';
import ui from '../MoneyIn.module.css';
import s from './MoneyInDoc.module.css';

export type SundryLine = { rid: number; description: string; creditAccountCode: string; amountSen: number };
export type SundryValues = { receiptDate: string; payerName: string; bankAccountCode: string; lines: SundryLine[] };
export type SundrySubmit = {
  receiptDate: string; payerName: string; bankAccountCode: string;
  lines: Array<{ description?: string; creditAccountCode: string; amountSen: number }>;
};

const blankLine = (rid: number): SundryLine => ({ rid, description: '', creditAccountCode: '', amountSen: 0 });

export const SundryReceiptForm = ({ mode, initial, accounts, moneyAccounts, accountName, saving, onSubmit, onCancel }: {
  mode: 'edit' | 'copy';
  initial: SundryValues;
  /** Postable leaves a line may credit. */
  accounts: Account[];
  /** The bank and cash accounts the money may land on. */
  moneyAccounts: Account[];
  accountName: (code: string) => string | null;
  saving: boolean;
  onSubmit: (v: SundrySubmit) => void;
  onCancel: () => void;
}) => {
  const [v, setV] = useState<SundryValues>(initial.lines.length > 0 ? initial : { ...initial, lines: [blankLine(1)] });
  const patchLine = (rid: number, patch: Partial<SundryLine>) =>
    setV((prev) => ({ ...prev, lines: prev.lines.map((l) => (l.rid === rid ? { ...l, ...patch } : l)) }));
  const total = v.lines.reduce((sum, l) => sum + (l.amountSen > 0 ? l.amountSen : 0), 0);
  const blocking = !v.receiptDate ? 'Type the date.'
    : !v.payerName.trim() ? 'Type who paid.'
      : !v.bankAccountCode ? 'Pick the account the money went into.'
        : v.lines.some((l) => l.amountSen > 0 && !l.creditAccountCode) ? 'Pick an account for every line with an amount.'
          : total <= 0 ? 'Add a line with an amount.' : null;
  const submit = () => {
    if (blocking || saving) return;
    onSubmit({
      receiptDate: v.receiptDate, payerName: v.payerName.trim(), bankAccountCode: v.bankAccountCode,
      lines: v.lines.filter((l) => l.creditAccountCode && l.amountSen > 0).map((l) => ({
        ...(l.description.trim() ? { description: l.description.trim() } : {}), creditAccountCode: l.creditAccountCode, amountSen: l.amountSen,
      })),
    });
  };
  useSaveHotkey(submit, !saving);
  const named = (code: string) => `${code}${accountName(code) ? ` ${accountName(code)}` : ''}`;
  const credited = [...new Set(v.lines.filter((l) => l.creditAccountCode && l.amountSen > 0).map((l) => l.creditAccountCode))].map(named).join(', ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
      {mode === 'edit' && (
        <div className={s.note}>Saving changes re-posts it: the old journal gets a contra and a fresh one books what you save.</div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, alignItems: 'end' }}>
        <label className={fields.field}>
          <span className={fields.fieldLabel}>Date</span>
          <DateField fullWidth value={v.receiptDate} onChange={(iso) => setV((p) => ({ ...p, receiptDate: iso }))} className={fields.fieldInput} aria-label="Receipt date" />
        </label>
        <label className={fields.field}>
          <span className={fields.fieldLabel}>Received from</span>
          <input value={v.payerName} onChange={(e) => setV((p) => ({ ...p, payerName: e.target.value }))} className={fields.fieldInput}
            placeholder="Type the payer" aria-label="Received from" />
        </label>
        <label className={fields.field}>
          <span className={fields.fieldLabel}>Received into</span>
          <AccountSelect accounts={moneyAccounts} value={v.bankAccountCode} onChange={(code) => setV((p) => ({ ...p, bankAccountCode: code }))}
            placeholder="— bank / cash —" className={fields.fieldInput} />
        </label>
      </div>
      {v.lines.map((l) => (
        <div key={l.rid} style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 1fr) minmax(200px, 1fr) 160px 28px', gap: 8, alignItems: 'center' }}>
          <AccountSelect accounts={accounts} value={l.creditAccountCode} className={fields.fieldInput}
            onChange={(code) => patchLine(l.rid, { creditAccountCode: code })} />
          <input placeholder="What it is for" value={l.description} className={fields.fieldInput} aria-label={`line ${l.rid} description`}
            onChange={(e) => patchLine(l.rid, { description: e.target.value })} />
          <MoneyInput bare valueSen={l.amountSen > 0 ? l.amountSen : null} allowBlank placeholder="0.00"
            aria-label={`line ${l.rid} amount`} inputClassName={fields.fieldInput}
            onCommit={(sen) => patchLine(l.rid, { amountSen: sen ?? 0 })} />
          <button type="button" className={ui.clear} aria-label={`Remove line ${l.rid}`} disabled={v.lines.length === 1}
            onClick={() => setV((p) => ({ ...p, lines: p.lines.filter((x) => x.rid !== l.rid) }))}>
            <X size={14} />
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <button type="button" className={`${ui.btn} ${ui.btnSmall}`}
          onClick={() => setV((p) => ({ ...p, lines: [...p.lines, blankLine(Math.max(0, ...p.lines.map((x) => x.rid)) + 1)] }))}>
          <Plus size={13} /> Add line
        </button>
        <span className={s.note}>{v.lines.length} line{v.lines.length === 1 ? '' : 's'} · {fmtSen(total)}</span>
      </div>
      <div className={s.note}>
        Books: Dr {v.bankAccountCode ? named(v.bankAccountCode) : '—'} · Cr {credited || '—'} · {fmtSen(total)} · {mode === 'edit' ? 're-posts' : 'posts now'}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        {blocking && <span className={`${s.note} ${s.toneLate}`}>{blocking}</span>}
        <span className={s.note}>{SAVE_HOTKEY_HINT}</span>
        <button type="button" className={ui.btn} onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={submit} disabled={saving || blocking != null}>
          {saving ? 'Saving…' : mode === 'edit' ? 'Save & re-post' : 'Save & post'}
        </button>
      </div>
    </div>
  );
};
