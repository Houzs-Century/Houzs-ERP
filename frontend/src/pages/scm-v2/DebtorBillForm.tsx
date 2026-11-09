// ----------------------------------------------------------------------------
// DebtorBillForm — the one form behind New, Edit and Copy of an Other Debtor
// bill (owner 2026-09-06: 刚刚说的功能这普通 payment 也要有,other debtor bill
// 那边也要有 — the AP invoice's round 3 carried to its sibling), in the owner's
// Claude Design since batch 5 step 5: the debtor, the bill date and what it is
// for on the left with the lines under them; the total, what the books will
// say, why it cannot save yet and the buttons on the right.
//
// A debtor bill posts the moment it exists, so New and Copy read "Save &
// post"; an Edit re-posts (the route writes the contra and the fresh entry)
// and keeps its debtor — a bill belongs to its debtor. Lines in the owner's
// order — account, description, amount — Insert adds a line and lands on it,
// Enter on an amount moves down, amounts read 1,800.00. A line with a
// description and neither account nor amount is a TEXT line (owner 2026-09-21:
// 有一些我只想放 description 罢了): it prints on the invoice and books nothing.
// A money line may name its Event (owner 2026-10-01, payment-request item 6:
// other debtor 单也要，但不是一定要选) — optional; the posted credit leg carries
// it, so a rental billed back to an organiser lowers that event's Rental.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import { Info, X } from 'lucide-react';
import { AddLineButton } from '../../vendor/scm/components/AddLineButton';
import type { Account } from '../../vendor/scm/lib/accounting-queries';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { useSaveHotkey, SAVE_HOTKEY_HINT } from '../../vendor/scm/lib/use-save-hotkey';
import { DateField } from '../../vendor/scm/components/DateField';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { EventSelect } from '../../vendor/scm/components/EventSelect';
import { fmtSen } from '../../vendor/shared/format';
import ui from './MoneyIn.module.css';

/** projectId: the event a money line is for (item 6, optional) — null = none. */
export type BillFormLine = { rid: number; description: string; creditAccountCode: string; amountSen: number; projectId: number | null };
export type BillFormValues = { billDate: string; notes: string; lines: BillFormLine[] };
export type BillFormMode = 'new' | 'edit' | 'copy';
export type BillFormSubmit = { billDate: string; notes?: string; lines: Array<{ description?: string; creditAccountCode?: string; amountSen: number; projectId?: number }> };

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
export const emptyBillLine = (rid: number, projectId: number | null = null): BillFormLine => ({ rid, description: '', creditAccountCode: '', amountSen: 0, projectId });
export const emptyBillForm = (): BillFormValues => ({ billDate: myt(), notes: '', lines: [emptyBillLine(1)] });

/** A description with neither account nor amount: text on the paper, nothing in the books. */
export const isTextLine = (l: BillFormLine): boolean => !l.creditAccountCode && l.amountSen <= 0 && l.description.trim().length > 0;

export const toBillSubmit = (v: BillFormValues): BillFormSubmit => ({
  billDate: v.billDate,
  ...(v.notes.trim() ? { notes: v.notes.trim() } : {}),
  lines: v.lines
    .filter((l) => (l.creditAccountCode && l.amountSen > 0) || isTextLine(l))
    .map((l) => (isTextLine(l)
      ? { description: l.description.trim(), amountSen: 0 }
      : {
          ...(l.description.trim() ? { description: l.description.trim() } : {}),
          creditAccountCode: l.creditAccountCode, amountSen: l.amountSen,
          ...(l.projectId != null ? { projectId: l.projectId } : {}),
        })),
});

/** The one event every line names, or null when they differ (or none is named). */
const sharedEvent = (lines: BillFormLine[]): number | null =>
  lines.length > 0 && lines.every((l) => l.projectId === lines[0]!.projectId) ? lines[0]!.projectId : null;

export const DebtorBillForm = ({
  mode, initial, accounts, accountName, debtors, debtorId: initialDebtor = '', controlCode = '305-0000',
  receivedSen = 0, saving, onSubmit, onCancel,
}: {
  mode: BillFormMode;
  initial: BillFormValues;
  accounts: Account[];
  accountName: (code: string) => string | null;
  /** The registry's active debtors (and the bill's own on an edit). */
  debtors: Array<{ id: string; name: string; code?: string | null }>;
  debtorId?: string;
  /** The other debtors control the bill debits (the AR_OTHER role). */
  controlCode?: string;
  /** Money already received against the bill being edited: the total may not fall below it. */
  receivedSen?: number;
  saving: boolean;
  onSubmit: (values: BillFormSubmit, debtorId: string) => void | Promise<void>;
  onCancel: () => void;
}) => {
  const [v, setV] = useState<BillFormValues>(initial);
  const [debtorId, setDebtorId] = useState(initialDebtor);
  const patchLine = (rid: number, patch: Partial<BillFormLine>) =>
    setV((prev) => ({ ...prev, lines: prev.lines.map((l) => (l.rid === rid ? { ...l, ...patch } : l)) }));

  /* Insert adds a line and lands on it; Enter on an amount moves down. */
  const linesRef = useRef<HTMLDivElement>(null);
  const [landOn, setLandOn] = useState<number | null>(null);
  useEffect(() => {
    if (landOn == null) return;
    linesRef.current?.querySelector<HTMLInputElement>(`[data-line="${landOn}"] input[role="combobox"]`)?.focus();
    setLandOn(null);
  }, [landOn, v.lines]);
  const addLine = (land: boolean) => {
    setV((prev) => {
      const rid = Math.max(0, ...prev.lines.map((x) => x.rid)) + 1;
      if (land) setLandOn(rid);
      return { ...prev, lines: [...prev.lines, emptyBillLine(rid, sharedEvent(prev.lines))] };
    });
  };
  const removeLine = (rid: number) => setV((prev) => (prev.lines.length > 1 ? { ...prev, lines: prev.lines.filter((l) => l.rid !== rid) } : prev));
  const hopFrom = (rid: number) => {
    const next = v.lines.at(v.lines.findIndex((l) => l.rid === rid) + 1);
    if (next) setLandOn(next.rid); else addLine(true);
  };

  const commonEvent = sharedEvent(v.lines);
  const total = v.lines.reduce((s, l) => s + (l.amountSen > 0 ? l.amountSen : 0), 0);
  const blocking = !debtorId ? 'Pick the debtor.'
    : !v.billDate ? 'Type the date as 2026/10/29.'
      : v.lines.some((l) => l.amountSen > 0 && !l.creditAccountCode) ? 'Pick an account for every line with an amount.'
        : total <= 0 ? 'Add a line with an amount.'
          : mode === 'edit' && total < receivedSen ? `${fmtSen(receivedSen)} has been received on this bill, so the total can’t go below it.` : null;
  const submit = () => { if (!blocking && !saving) void onSubmit(toBillSubmit(v), debtorId); };
  /* F3 / Ctrl+S = the save button (owner 2026-09-08: 像 autocount 按 f3); a
     form that cannot save ignores it, as the button would. */
  useSaveHotkey(submit, !saving);

  const named = (code: string) => `${code}${accountName(code) ? ` ${accountName(code)}` : ''}`;
  const debtorName = debtors.find((d) => d.id === debtorId)?.name ?? null;
  const credited = [...new Set(v.lines.filter((l) => l.creditAccountCode && l.amountSen > 0).map((l) => l.creditAccountCode))].map(named).join(', ');
  const books = `Books: Dr ${named(controlCode)}${debtorName ? ` (${debtorName})` : ''} · Cr ${credited || 'each line’s account'} · ${fmtSen(total)} · ${mode === 'edit' ? 're-posts' : 'posts now'}`;

  return (
    <div className={ui.formCol}>
      {mode === 'edit' && (
        <div className={ui.formNote}><Info size={14} /><span>Saving re-posts the bill: the old journal gets a contra and a fresh one books what you save.</span></div>
      )}
      <div className={ui.formGrid}>
        <div className={ui.formCol}>
          <div className={`${ui.formCard} ${ui.formFields}`}>
            <label className={ui.formField}>
              <span className={ui.formLabel}>Debtor</span>
              {/* A bill keeps its debtor: the edit re-posts the same party. */}
              <select aria-label="Bill debtor" value={debtorId} className={ui.formInput} disabled={mode === 'edit'} onChange={(e) => setDebtorId(e.target.value)}>
                <option value="">— Pick the debtor —</option>
                {debtors.map((d) => <option key={d.id} value={d.id}>{d.name}{d.code ? ` · ${d.code}` : ''}</option>)}
              </select>
              {mode === 'edit' && (
                <span className={ui.formHint}>{receivedSen > 0 ? 'This bill has money received on it, so the debtor can’t change.' : 'A bill belongs to its debtor — copy it to bill someone else.'}</span>
              )}
            </label>
            <div className={ui.formField}>
              <span className={ui.formLabel}>Bill date</span>
              <DateField fullWidth className={ui.formInput} value={v.billDate} onChange={(iso) => setV((p) => ({ ...p, billDate: iso }))} aria-label="Bill date" placeholder="2026/10/29" />
            </div>
            <label className={`${ui.formField} ${ui.formFull}`}>
              <span className={ui.formLabel}>Description</span>
              <input data-upper className={ui.formInput} value={v.notes} onChange={(e) => { const t = e.target.value; setV((p) => ({ ...p, notes: t })); }} aria-label="Bill description"
                placeholder="What the bill is for · prints on the invoice" />
            </label>
            {/* The event this bill is for — optional: sets every line, and a line
                can still name its own below. */}
            <label className={`${ui.formField} ${ui.formFull}`}>
              <span className={ui.formLabel}>Event (all lines, optional)</span>
              <EventSelect value={commonEvent} around={v.billDate || null} className={ui.formInput} aria-label="Event for all lines"
                onChange={(id) => setV((prev) => ({ ...prev, lines: prev.lines.map((l) => ({ ...l, projectId: id })) }))} />
            </label>
          </div>

          <section className={ui.formCard} aria-label="Lines">
            <div className={ui.formCardTitle}>Lines</div>
            <div className={ui.lineScroll} ref={linesRef} onKeyDown={(e) => { if (e.key === 'Insert') { e.preventDefault(); addLine(true); } }}>
              <div className={`${ui.lineHead} ${ui.lineHeadEvent}`}><span>Account (credit)</span><span>Description</span><span className={ui.right}>Amount (RM)</span><span>Event</span><span /></div>
              {v.lines.map((l) => (
                <div key={l.rid} data-line={l.rid} className={`${ui.lineRow} ${ui.lineRowEvent}`}>
                  <AccountSelect accounts={accounts} value={l.creditAccountCode} className={ui.formInput}
                    onChange={(code) => patchLine(l.rid, { creditAccountCode: code })} placeholder="— Pick an account —" />
                  <input data-upper className={ui.formInput} placeholder="What it is for" value={l.description} aria-label={`line ${l.rid} description`}
                    onChange={(e) => patchLine(l.rid, { description: e.target.value })} />
                  <MoneyInput bare valueSen={l.amountSen} inputClassName={ui.formInput} selectOnFocus aria-label={`line ${l.rid} amount`}
                    placeholder="0.00" onCommit={(sen) => patchLine(l.rid, { amountSen: sen ?? 0 })}
                    onKeyDown={(e) => { if (e.key === 'Enter') hopFrom(l.rid); }} />
                  {/* The event last: the owner's typing order (account, description,
                      amount) stays unbroken; the picker above usually sets it. */}
                  <EventSelect value={l.projectId} around={v.billDate || null} className={ui.formInput} aria-label={`line ${l.rid} event`}
                    onChange={(id) => patchLine(l.rid, { projectId: id })} />
                  <button type="button" className={ui.clear} aria-label={`remove line ${l.rid}`} title="Remove line" disabled={v.lines.length === 1}
                    onClick={() => removeLine(l.rid)}>
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
            <div className={ui.lineFoot}>
              <AddLineButton variant="ghost" onClick={() => addLine(true)} />
              <span className={ui.hint}>Insert adds a line · Enter on an amount moves down · a description alone is a text line: it prints, books nothing</span>
              <span className={ui.grow} />
              <span className={ui.hint}>{v.lines.length} line{v.lines.length === 1 ? '' : 's'} · {fmtSen(total)}</span>
            </div>
          </section>
        </div>

        <aside className={ui.side} aria-label="Save">
          <div className={ui.sideTotal}><span className={ui.sideTotalLabel}>Total</span><span className={ui.sideTotalValue}>{fmtSen(total)}</span></div>
          <div className={ui.sideBooks}>{books}</div>
          {blocking && <div className={ui.sideWhy}>{blocking}</div>}
          <div className={ui.sideButtons}>
            <button type="button" className={ui.btn} onClick={onCancel} disabled={saving}>Cancel</button>
            <span className={ui.grow} />
            <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={submit} disabled={saving || blocking != null}>
              {saving ? 'Saving…' : mode === 'edit' ? 'Save & re-post' : 'Save & post'}
            </button>
          </div>
          <span className={ui.hint}>{SAVE_HOTKEY_HINT}</span>
        </aside>
      </div>
    </div>
  );
};
