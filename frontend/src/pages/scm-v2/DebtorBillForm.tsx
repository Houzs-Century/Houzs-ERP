// ----------------------------------------------------------------------------
// DebtorBillForm — the one form behind New, Edit and Copy of an Other Debtor
// bill (owner 2026-09-06: 刚刚说的功能这普通 payment 也要有,other debtor bill
// 那边也要有 — the AP invoice's round 3 carried to its sibling). A debtor bill
// posts the moment it exists, so New and Copy read "Post bill"; an Edit
// re-posts (the route writes the contra and the fresh entry). Lines in the
// owner's order — account, description, amount — Insert adds a line and lands
// on it, Enter on an amount moves down, amounts read 1,800.00. A line with a
// description and neither account nor amount is a TEXT line (owner 2026-09-21:
// 有一些我只想放 description 罢了): it prints on the invoice and books nothing.
// A money line may name its Event (owner 2026-10-01, payment-request item 6:
// other debtor 单也要，但不是一定要选) — optional; the posted credit leg carries
// it, so a rental billed back to an organiser lowers that event's Rental.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { AddLineButton } from '../../vendor/scm/components/AddLineButton';
import type { Account } from '../../vendor/scm/lib/accounting-queries';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { useSaveHotkey, SAVE_HOTKEY_HINT } from '../../vendor/scm/lib/use-save-hotkey';
import { DateField } from '../../vendor/scm/components/DateField';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { EventSelect } from '../../vendor/scm/components/EventSelect';
import { fmtSen } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';

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

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const th: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'left', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em',
  textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'middle' };
const right: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)' };
const iconBtn: React.CSSProperties = { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 2 };

export const DebtorBillForm = ({ mode, initial, accounts, receivedSen = 0, saving, onSubmit, onCancel }: {
  mode: BillFormMode;
  initial: BillFormValues;
  accounts: Account[];
  /** Money already received against the bill being edited: the total may not fall below it. */
  receivedSen?: number;
  saving: boolean;
  onSubmit: (values: BillFormSubmit) => void | Promise<void>;
  onCancel: () => void;
}) => {
  const [v, setV] = useState<BillFormValues>(initial);
  const patchLine = (rid: number, patch: Partial<BillFormLine>) =>
    setV((prev) => ({ ...prev, lines: prev.lines.map((l) => (l.rid === rid ? { ...l, ...patch } : l)) }));

  /* Insert adds a line and lands on it; Enter on an amount moves down. */
  const tableRef = useRef<HTMLTableElement>(null);
  const [landOn, setLandOn] = useState<number | null>(null);
  useEffect(() => {
    if (landOn == null) return;
    tableRef.current?.querySelector<HTMLInputElement>(`tr[data-line="${landOn}"] input[role="combobox"]`)?.focus();
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
  const belowReceived = mode === 'edit' && total < receivedSen;
  const ready = !!v.billDate && total > 0 && !belowReceived && v.lines.filter((l) => l.amountSen > 0).every((l) => !!l.creditAccountCode);
  const saveLabel = mode === 'edit' ? 'Save & re-post' : 'Post bill';
  /* F3 / Ctrl+S = the save button (owner 2026-09-08: 像 autocount 按 f3);
     a form that is not ready ignores it, as the button would. */
  useSaveHotkey(() => { if (ready) void onSubmit(toBillSubmit(v)); }, !saving);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
      {mode === 'edit' && (
        <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)' }}>
          This bill is on the books — saving re-posts it: the old journal gets a contra, a fresh one books what you save.
          {receivedSen > 0 ? ` ${fmtSen(receivedSen)} is already received against it, so the total cannot fall below that.` : ''}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) minmax(280px, 3fr)', gap: 'var(--space-3)' }}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Bill date *</span>
          <DateField fullWidth className={styles.fieldInput} value={v.billDate} onChange={(iso) => setV((p) => ({ ...p, billDate: iso }))} aria-label="Bill date" />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Description</span>
          <input className={styles.fieldInput} value={v.notes} onChange={(e) => setV((p) => ({ ...p, notes: e.target.value }))} aria-label="Bill description"
            placeholder="What this bill is for" />
        </label>
      </div>

      {/* The event this bill is for — optional: sets every line, and a line can
          still name its own in the table. */}
      <label className={styles.field} style={{ maxWidth: 640 }}>
        <span className={styles.fieldLabel}>Event (all lines, optional)</span>
        <EventSelect value={commonEvent} around={v.billDate || null} className={styles.fieldInput} aria-label="Event for all lines"
          onChange={(id) => setV((prev) => ({ ...prev, lines: prev.lines.map((l) => ({ ...l, projectId: id })) }))} />
      </label>

      <table ref={tableRef} style={{ width: '100%', borderCollapse: 'collapse' }}
        onKeyDown={(e) => { if (e.key === 'Insert') { e.preventDefault(); addLine(true); } }}>
        <thead>
          <tr>
            <th style={{ ...th, width: '34%' }}>Account (credit)</th>
            <th style={th}>Description</th>
            <th style={{ ...th, textAlign: 'right', width: 150 }}>Amount (RM)</th>
            <th style={{ ...th, width: '24%' }}>Event</th>
            <th style={{ ...th, width: 36 }} />
          </tr>
        </thead>
        <tbody>
          {v.lines.map((l) => (
            <tr key={l.rid} data-line={l.rid}>
              <td style={td}>
                <AccountSelect accounts={accounts} value={l.creditAccountCode} className={styles.fieldInput}
                  onChange={(code) => patchLine(l.rid, { creditAccountCode: code })} placeholder="— account this line credits —" />
              </td>
              <td style={td}>
                <input className={styles.fieldInput} style={{ width: '100%' }} placeholder="Description" value={l.description} aria-label={`line ${l.rid} description`}
                  onChange={(e) => patchLine(l.rid, { description: e.target.value })} />
              </td>
              <td style={td}>
                <MoneyInput bare valueSen={l.amountSen} inputClassName={styles.fieldInput} selectOnFocus aria-label={`line ${l.rid} amount`}
                  placeholder="0.00" style={{ width: '100%' }}
                  onCommit={(sen) => patchLine(l.rid, { amountSen: sen ?? 0 })}
                  onKeyDown={(e) => { if (e.key === 'Enter') hopFrom(l.rid); }} />
              </td>
              {/* The event last: the owner's typing order (account, description,
                  amount) stays unbroken; the picker above usually sets it. */}
              <td style={td}>
                <EventSelect value={l.projectId} around={v.billDate || null} className={styles.fieldInput} aria-label={`line ${l.rid} event`}
                  onChange={(id) => patchLine(l.rid, { projectId: id })} />
              </td>
              <td style={td}>
                {v.lines.length > 1 && (
                  <button type="button" aria-label={`remove line ${l.rid}`} onClick={() => removeLine(l.rid)} style={iconBtn}>
                    <X size={14} strokeWidth={1.75} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
            <td colSpan={2} style={td}>
              <AddLineButton variant="ghost" onClick={() => addLine(true)} />
              <span style={{ ...soft, marginLeft: 'var(--space-3)' }}>Insert adds a line · Enter on an amount moves down · a description alone is a text line: it prints, books nothing</span>
            </td>
            <td style={{ ...td, ...right, fontWeight: 700, color: belowReceived ? 'var(--c-festive-b, #B8331F)' : undefined }}>Total {fmtSen(total)}</td>
            <td />
            <td />
          </tr>
        </tfoot>
      </table>

      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', alignItems: 'center' }}>
        {belowReceived && <span style={{ fontSize: 'var(--fs-12)', color: 'var(--c-festive-b, #B8331F)' }}>The total cannot fall below the {fmtSen(receivedSen)} already received.</span>}
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{SAVE_HOTKEY_HINT}</span>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => void onSubmit(toBillSubmit(v))} disabled={saving || !ready}>
          {saving ? 'Saving…' : saveLabel}
        </Button>
      </div>
    </div>
  );
};
