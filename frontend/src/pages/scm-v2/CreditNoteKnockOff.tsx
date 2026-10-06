// ----------------------------------------------------------------------------
// CreditNoteKnockOff — a supplier credit note knocks off the supplier's invoices
// on the AP Payment's own table (owner 2026-10-02: CN 的方式应该是类似 ap payment
// 这样 knock off；扣错了就我 untick 会 knock off 的 invoice 就行了).
//
// Tick = knock the invoice off in full, as far as the credit reaches; untick =
// give it back; a typed figure = part of it. On a new or draft note the ticks
// are the plan the post carries out; on a posted note "Save knock-off" carries
// them out at once. The server half is acc/credit-note-allocations.ts
// (knockOffRows / setNoteKnockOff / carryOutPlan).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Button } from '@2990s/design-system';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import {
  useCreditNoteKnockOff, useSetCreditNoteAllocations, useSupplierKnockOff,
  type KnockOffRow, type KnockOffTarget,
} from '../../vendor/scm/lib/credit-note-queries';
import { fmtDateOrDash, fmtSen } from '../../vendor/shared/format';

/** The ticks: what the note takes from each invoice, by invoice id. */
export type KnockOffPick = Record<string, KnockOffTarget | undefined>;

/** The ticks a table already holds — a posted note's knock-off, a draft's plan. */
export const pickFromRows = (rows: KnockOffRow[] | undefined): KnockOffPick => {
  const out: KnockOffPick = {};
  for (const r of rows ?? []) if (r.noteSen > 0) out[r.id] = { kind: r.kind, id: r.id, amountSen: r.noteSen };
  return out;
};
export const pickTargets = (pick: KnockOffPick): KnockOffTarget[] =>
  Object.values(pick).filter((t): t is KnockOffTarget => t != null && t.amountSen > 0);
export const pickSen = (pick: KnockOffPick): number => pickTargets(pick).reduce((s, t) => s + t.amountSen, 0);
const samePick = (a: KnockOffPick, b: KnockOffPick): boolean => {
  const x = pickTargets(a);
  return x.length === pickTargets(b).length && x.every((t) => b[t.id]?.amountSen === t.amountSen);
};

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const danger = 'var(--c-festive-b, #B8331F)';
const th: React.CSSProperties = { padding: '6px 8px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-muted)', textAlign: 'left', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '6px 8px', borderTop: '1px solid var(--line, #e3e1da)' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'That was not accepted.');

/** The AP Payment's Apply-to-PI table, for a credit note. */
export function KnockOffTable({ rows, creditSen, pick, onChange, disabled = false }: {
  rows: KnockOffRow[]; creditSen: number; pick: KnockOffPick; onChange: (next: KnockOffPick) => void; disabled?: boolean;
}) {
  /* A typed figure the row cannot take is pulled back to what it can; the
     field is drawn again so it shows the figure kept, not the one typed. */
  const [redraw, setRedraw] = useState(0);
  const taken = pickSen(pick);
  const put = (r: KnockOffRow, sen: number): void => {
    const next = { ...pick };
    if (sen > 0) next[r.id] = { kind: r.kind, id: r.id, amountSen: sen };
    else delete next[r.id];
    onChange(next);
  };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table aria-label="Knock off the supplier's invoices" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
        <thead>
          <tr>
            <th style={{ ...th, width: 34 }} aria-label="Knock off in full" />
            <th style={th}>Invoice</th>
            <th style={th}>Date</th>
            <th style={th}>Supplier Ref</th>
            <th style={{ ...th, textAlign: 'right' }}>Amount</th>
            <th style={{ ...th, textAlign: 'right' }}>Outstanding</th>
            <th style={{ ...th, textAlign: 'right' }}>Knock off</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const mine = pick[r.id]?.amountSen ?? 0;
            /* The most this row can take: what it owes before this note, and
               what the credit has left once the other rows are counted. */
            const max = Math.max(0, Math.min(r.owedSen, creditSen - (taken - mine)));
            return (
              <tr key={r.id}>
                <td style={td}>
                  <input type="checkbox" checked={mine > 0} disabled={disabled || (mine === 0 && max === 0)} aria-label={`Knock off ${r.number}`}
                    onChange={(e) => put(r, e.target.checked ? max : 0)} style={{ width: 16, height: 16, accentColor: 'var(--c-orange)' }} />
                </td>
                <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>
                  {r.number}
                  {r.kind === 'API' && <span style={{ ...soft, marginLeft: 6, fontFamily: 'inherit' }} title="AP invoice — a non-stock supplier bill">AP</span>}
                </td>
                <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--fg-muted)' }}>{fmtDateOrDash(r.invoiceDate)}</td>
                <td style={{ ...td, color: r.invoiceRef ? undefined : 'var(--fg-muted)' }}>{r.invoiceRef || '—'}</td>
                <td style={{ ...td, ...num }}>{fmtSen(r.totalSen)}</td>
                <td style={{ ...td, ...num, color: 'var(--fg-muted)' }}>{fmtSen(r.owedSen)}</td>
                <td style={{ ...td, ...num }}>
                  <MoneyInput key={`${r.id}:${redraw}`} bare valueSen={mine} selectOnFocus disabled={disabled} aria-label={`Amount off ${r.number}`} style={{ width: 120 }}
                    onCommit={(sen) => {
                      const kept = Math.max(0, Math.min(max, sen ?? 0));
                      if (kept !== (sen ?? 0)) setRedraw((n) => n + 1);
                      put(r, kept);
                    }} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "Knocking off RM X · credit left RM Y of RM Z" — red when the ticks outrun the note. */
export function KnockOffSum({ takenSen, totalSen }: { takenSen: number; totalSen: number }) {
  const over = takenSen > totalSen;
  return (
    <div style={{ ...soft, color: over ? danger : soft.color }} aria-label="Knock-off total">
      Knocking off <strong style={num}>{fmtSen(takenSen)}</strong>
      {over
        ? <> — more than the note's {fmtSen(totalSen)}; untick some first.</>
        : <> · credit left <strong style={num}>{fmtSen(totalSen - takenSen)}</strong> of {fmtSen(totalSen)} — it stays with the supplier.</>}
    </div>
  );
}

/** A saved note's knock-off (draft or posted): the ticks, and "Save knock-off" to
    keep them — a draft's as its plan, a posted note's carried out at once. */
export function NoteKnockOff({ noteId, posted, totalSen }: { noteId: string; posted: boolean; totalSen: number }) {
  const q = useCreditNoteKnockOff(noteId);
  const save = useSetCreditNoteAllocations();
  const server = useMemo(() => pickFromRows(q.data?.rows), [q.data]);
  const [edit, setEdit] = useState<KnockOffPick | null>(null);
  const pick = edit ?? server;
  const dirty = edit != null && !samePick(edit, server);
  const rows = q.data?.rows ?? [];
  return (
    <section aria-label="Knock off" style={{ display: 'grid', gap: 6, fontSize: 'var(--fs-13)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>Knock off · 扣发票</strong>
        <span style={soft}>{posted ? 'tick to knock an invoice off, untick to give it back — like an AP Payment' : 'carried out when the note posts'}</span>
      </div>
      {q.isLoading && <div style={soft}>Loading the supplier's invoices…</div>}
      {q.isError && <div style={{ color: danger }}>The invoices did not load — {errText(q.error)}</div>}
      {q.data && rows.length === 0 && <div style={soft}>No invoice of this supplier owes anything now — the credit stays with the supplier.</div>}
      {rows.length > 0 && <KnockOffTable rows={rows} creditSen={totalSen} pick={pick} onChange={setEdit} disabled={save.isPending} />}
      <KnockOffSum takenSen={pickSen(pick)} totalSen={totalSen} />
      {dirty && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <Button size="sm" disabled={save.isPending || pickSen(pick) > totalSen}
            onClick={() => save.mutate({ noteId, targets: pickTargets(pick) }, { onSuccess: () => setEdit(null) })}>
            {save.isPending ? 'Saving…' : 'Save knock-off · 保存'}
          </Button>
          <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => setEdit(null)}>Undo changes</Button>
        </div>
      )}
      {(save.data?.short ?? []).map((s) => (
        <div key={s.number} style={{ color: danger }}>{s.number} took only {fmtSen(s.appliedSen)} of {fmtSen(s.askedSen)} — it owes no more now.</div>
      ))}
      {save.isError && <div style={{ color: danger }}>{errText(save.error)}</div>}
    </section>
  );
}

/** The New / Edit note form's knock-off — the ticks ride the draft as its plan. */
export function FormKnockOff({ supplierId, noteId, totalSen, pick, onChange }: {
  supplierId: string; noteId?: string; totalSen: number; pick: KnockOffPick; onChange: (next: KnockOffPick) => void;
}) {
  const fresh = useSupplierKnockOff(noteId ? null : supplierId || null);
  const saved = useCreditNoteKnockOff(noteId ?? null);
  const q = noteId ? saved : fresh;
  const rows = q.data?.rows ?? [];
  return (
    <section aria-label="Knock off" style={{ display: 'grid', gap: 6, fontSize: 'var(--fs-13)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>Knock off · 扣发票</strong>
        <span style={soft}>tick the invoices this credit comes off — done when the note posts</span>
      </div>
      {!supplierId && <div style={soft}>Pick the supplier to see their invoices.</div>}
      {supplierId && q.isLoading && <div style={soft}>Loading the supplier's invoices…</div>}
      {q.isError && <div style={{ color: danger }}>The invoices did not load — {errText(q.error)}</div>}
      {supplierId && q.data && rows.length === 0 && <div style={soft}>No invoice of this supplier owes anything now — the credit stays with the supplier.</div>}
      {rows.length > 0 && <KnockOffTable rows={rows} creditSen={totalSen} pick={pick} onChange={onChange} />}
      {supplierId && <KnockOffSum takenSen={pickSen(pick)} totalSen={totalSen} />}
    </section>
  );
}
