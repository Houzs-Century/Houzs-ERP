// ----------------------------------------------------------------------------
// CreditNoteKnockOff — a supplier credit note knocks off the supplier's invoices
// on the AP Payment's own table (owner 2026-10-02: CN 的方式应该是类似 ap payment
// 这样 knock off；扣错了就我 untick 会 knock off 的 invoice 就行了), and an other
// debtor's credit note the debtor's bills on the same table (2026-10-28).
//
// Tick = knock the invoice off in full, as far as the credit reaches; untick =
// give it back; a typed figure = part of it. On a new or draft note the ticks
// are the plan the post carries out; on a posted note "Save knock-off" carries
// them out at once. The server half is acc/credit-note-allocations.ts
// (knockOffRows / setNoteKnockOff / carryOutPlan).
//
// A customer's credit note knocks off the customer's sales invoices on the same
// table (owner 2026-11-03: 「要」, his design "like AutoCount") — For is the
// invoice's order and total, Outstanding what it owes after its order's deposit
// and the other notes; it posts nothing (acc/credit-note-si.ts).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@2990s/design-system';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import {
  useCreditNoteKnockOff, usePartyKnockOff, useSetCreditNoteAllocations,
  type CreditAllocation, type CreditNote, type CreditNoteDetail, type KnockOffRow, type KnockOffTarget,
} from '../../vendor/scm/lib/credit-note-queries';
import { fmtDateOrDash, fmtSen } from '../../vendor/shared/format';
import { DataTable, type Column } from '../../components/DataTable';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { moneyInDocHref } from './money-in/moneyInDocs';

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

/** What the table says, by whose documents it holds: a supplier's invoices, an other debtor's bills. */
const WORDS = {
  supplier: {
    holder: 'supplier', doc: 'Invoice', table: "Knock off the supplier's invoices",
    pick: 'Pick the supplier to see their invoices.', loading: "Loading the supplier's invoices…", failed: 'The invoices did not load',
    none: 'No invoice of this supplier owes anything now — the credit stays with the supplier.',
    planned: 'tick the invoices this credit comes off — done when the note posts',
    posted: 'tick to knock an invoice off, untick to give it back — like an AP Payment',
  },
  debtor: {
    holder: 'debtor', doc: 'Bill', table: "Knock off the debtor's bills",
    pick: 'Pick the other debtor to see their bills.', loading: "Loading the debtor's bills…", failed: 'The bills did not load',
    none: 'No bill of this debtor owes anything now — the credit stays with the debtor.',
    planned: 'tick the bills this credit comes off — done when the note posts',
    posted: 'tick to knock a bill off, untick to give it back — like a receipt',
  },
  /* A customer's sales invoices (2026-11-03) — the design's words. */
  customer: {
    holder: 'customer', doc: 'Invoice', table: "Knock off against the customer's invoices",
    pick: 'Type the sales order or the customer to list their open invoices.', loading: "Loading the customer's invoices…", failed: 'The invoices did not load',
    none: 'No open invoice for this customer. The note stays as credit on the customer until it is knocked off.',
    planned: 'tick the invoices this credit knocks off — done when the note posts; it posts nothing more',
    posted: 'tick to knock an invoice off, untick to give it back — posts nothing',
  },
} as const;
export type KnockOffWho = keyof typeof WORDS;

/** The customer's table, its empty line and its title, by the customer's name when it is known (the design's words). */
export const customerWords = (name: string | null | undefined): { table: string; none: string } => {
  const who = String(name ?? '').trim();
  return who
    ? { table: `Knock off against ${who}’s invoices`, none: `No open invoice for ${who}. The note stays as credit on the customer until it is knocked off.` }
    : { table: WORDS.customer.table, none: WORDS.customer.none };
};

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const danger = 'var(--c-festive-b, #B8331F)';
const th: React.CSSProperties = { padding: '6px 8px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-muted)', textAlign: 'left', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '6px 8px', borderTop: '1px solid var(--line, #e3e1da)' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'That was not accepted.');

/** The AP Payment's Apply-to-PI table, for a credit note. A debtor's bill has no
    supplier reference, so the debtor's table leaves that column out; a
    customer's invoice says what it is For — its order and its total. */
export function KnockOffTable({ rows, creditSen, pick, onChange, disabled = false, who = 'supplier', title }: {
  rows: KnockOffRow[]; creditSen: number; pick: KnockOffPick; onChange: (next: KnockOffPick) => void; disabled?: boolean; who?: KnockOffWho;
  /** The table's name when the customer is known (customerWords). */
  title?: string;
}) {
  /* A typed figure the row cannot take is pulled back to what it can; the
     field is drawn again so it shows the figure kept, not the one typed. */
  const [redraw, setRedraw] = useState(0);
  const w = WORDS[who];
  const withRef = who === 'supplier';
  const customer = who === 'customer';
  const taken = pickSen(pick);
  const put = (r: KnockOffRow, sen: number): void => {
    const next = { ...pick };
    if (sen > 0) next[r.id] = { kind: r.kind, id: r.id, amountSen: sen };
    else delete next[r.id];
    onChange(next);
  };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table aria-label={title ?? w.table} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
        <thead>
          <tr>
            <th style={{ ...th, width: 34 }} aria-label="Knock off in full" />
            <th style={th}>{w.doc}</th>
            <th style={th}>Date</th>
            {withRef && <th style={th}>Supplier Ref</th>}
            {customer ? <th style={th}>For</th> : <th style={{ ...th, textAlign: 'right' }}>Amount</th>}
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
                <td style={{ ...td, ...(customer ? { fontWeight: 600 } : { fontFamily: 'var(--font-mono)' }) }}>
                  {r.number}
                  {r.kind === 'API' && <span style={{ ...soft, marginLeft: 6, fontFamily: 'inherit' }} title="AP invoice — a non-stock supplier bill">AP</span>}
                </td>
                <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--fg-muted)' }}>{fmtDateOrDash(r.invoiceDate)}</td>
                {withRef && <td style={{ ...td, color: r.invoiceRef ? undefined : 'var(--fg-muted)' }}>{r.invoiceRef || '—'}</td>}
                {customer
                  ? <td style={{ ...td, color: 'var(--fg-muted)' }}>{r.invoiceRef ?? '—'} · total {fmtSen(r.totalSen)}</td>
                  : <td style={{ ...td, ...num }}>{fmtSen(r.totalSen)}</td>}
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
export function KnockOffSum({ takenSen, totalSen, who = 'supplier' }: { takenSen: number; totalSen: number; who?: KnockOffWho }) {
  const over = takenSen > totalSen;
  return (
    <div style={{ ...soft, color: over ? danger : soft.color }} aria-label="Knock-off total">
      Knocking off <strong style={num}>{fmtSen(takenSen)}</strong>
      {over
        ? <> — more than the note's {fmtSen(totalSen)}; untick some first.</>
        : <> · credit left <strong style={num}>{fmtSen(totalSen - takenSen)}</strong> of {fmtSen(totalSen)} — it stays with the {WORDS[who].holder}.</>}
    </div>
  );
}

/** A saved note's knock-off (draft or posted): the ticks, and "Save knock-off" to
    keep them — a draft's as its plan, a posted note's carried out at once. */
export function NoteKnockOff({ noteId, posted, totalSen, who = 'supplier' }: { noteId: string; posted: boolean; totalSen: number; who?: KnockOffWho }) {
  const q = useCreditNoteKnockOff(noteId);
  const save = useSetCreditNoteAllocations();
  const server = useMemo(() => pickFromRows(q.data?.rows), [q.data]);
  const [edit, setEdit] = useState<KnockOffPick | null>(null);
  const pick = edit ?? server;
  const dirty = edit != null && !samePick(edit, server);
  const rows = q.data?.rows ?? [];
  const w = WORDS[who];
  return (
    <section aria-label="Knock off" style={{ display: 'grid', gap: 6, fontSize: 'var(--fs-13)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>Knock off · 扣发票</strong>
        <span style={soft}>{posted ? w.posted : 'carried out when the note posts'}</span>
      </div>
      {q.isLoading && <div style={soft}>{w.loading}</div>}
      {q.isError && <div style={{ color: danger }}>{w.failed} — {errText(q.error)}</div>}
      {q.data && rows.length === 0 && <div style={soft}>{w.none}</div>}
      {rows.length > 0 && <KnockOffTable rows={rows} creditSen={totalSen} pick={pick} onChange={setEdit} disabled={save.isPending} who={who} />}
      <KnockOffSum takenSen={pickSen(pick)} totalSen={totalSen} who={who} />
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

/** The New / Edit note form's knock-off — the ticks ride the draft as its plan.
    partyId: the supplier (or the other debtor) picked so far, '' for none yet;
    a customer's is the sales order typed (`by` 'so') or the name (`by` 'name'),
    read once the typing pauses. */
export function FormKnockOff({ who, partyId, by, partyName, noteId, totalSen, pick, onChange }: {
  who: KnockOffWho; partyId: string; by?: 'so' | 'name'; partyName?: string | null; noteId?: string; totalSen: number; pick: KnockOffPick; onChange: (next: KnockOffPick) => void;
}) {
  const typed = useSettled(partyId, who === 'customer' ? 450 : 0);
  const fresh = usePartyKnockOff(noteId || !typed ? null : { who, id: typed, by });
  const saved = useCreditNoteKnockOff(noteId ?? null);
  const q = noteId ? saved : fresh;
  const rows = q.data?.rows ?? [];
  const w = WORDS[who];
  const named = who === 'customer' ? customerWords(partyName) : { table: w.table, none: w.none };
  return (
    <section aria-label="Knock off" style={{ display: 'grid', gap: 6, fontSize: 'var(--fs-13)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>{who === 'customer' ? named.table : 'Knock off · 扣发票'}</strong>
        <span style={soft}>{w.planned}</span>
      </div>
      {!partyId && <div style={soft}>{w.pick}</div>}
      {partyId && q.isLoading && <div style={soft}>{w.loading}</div>}
      {q.isError && <div style={{ color: danger }}>{w.failed} — {errText(q.error)}</div>}
      {partyId && q.data && rows.length === 0 && <div style={soft}>{named.none}</div>}
      {rows.length > 0 && <KnockOffTable rows={rows} creditSen={totalSen} pick={pick} onChange={onChange} who={who} title={named.table} />}
      {partyId && <KnockOffSum takenSen={pickSen(pick)} totalSen={totalSen} who={who} />}
    </section>
  );
}

/** The value once it has stopped changing for `ms` — a sales order is read when
    its number is typed, not at every key. 0 passes it straight through. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (ms <= 0) return undefined;
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return ms <= 0 ? value : settled;
}

/** Why a customer note that answers a deposit invoice knocks nothing off (the server's rule, acc/credit-note-si.ts). */
export const depositPaperLine = (paper: CreditNoteDetail['depositPaper'], closedInvoice: CreditNoteDetail['closedInvoice']): string | null => {
  if (!paper) return null;
  if (paper.kind === 'refund') return 'It takes back a deposit for a refund — that money went back to the customer, so it knocks nothing off.';
  if (paper.kind === 'move') return 'It moved a deposit to another order — it knocks nothing off.';
  return `It closes deposit invoice ${paper.di ?? ''}${closedInvoice ? ` at the final invoice ${closedInvoice.number}` : ''} — the order's deposit lowers that invoice, so it knocks nothing off.`;
};

/** A customer note's knock-off on its page (the design's Knocks off): what it
    took off each sales invoice, read only — Knock off changes it on its own
    form. A draft shows its plan; a cancelled note knocks nothing off. */
export function CustomerKnockOffSection({ note, allocations, depositLine, onKnockOff }: {
  note: CreditNote; allocations: CreditAllocation[]; depositLine: string | null; onKnockOff: (() => void) | null;
}) {
  const posted = note.status === 'POSTED';
  const cancelled = note.status === 'CANCELLED';
  const takes = allocations.filter((a) => a.kind === 'SI' && (posted ? a.appliedSen : a.amountSen) > 0);
  const takenOf = (a: CreditAllocation): number => (posted ? a.appliedSen : a.amountSen);
  const taken = takes.reduce((s, a) => s + takenOf(a), 0);
  const left = cancelled || depositLine ? 0 : Math.max(0, Number(note.total_sen) - taken);
  const empty = cancelled ? 'Cancelled · nothing is knocked off.'
    : !posted ? 'No knock-off set. Edit the draft to knock it off against an invoice.'
      : `Not knocked off yet · ${fmtSen(left)} sits as credit on ${note.party_name ?? 'the customer'}.`;
  const columns: Column<CreditAllocation>[] = [
    {
      key: 'invoice_no', label: 'Invoice', getValue: (a) => a.number ?? '',
      render: (a) => <FinanceDocLink to={moneyInDocHref('salesInvoice', a.docId)}>{a.number ?? 'Invoice'}</FinanceDocLink>,
    },
    { key: 'date', label: 'Date', getValue: (a) => a.docDate ?? '', render: (a) => fmtDateOrDash(a.docDate ?? null), exportFormat: 'date' },
    {
      key: 'invoice_total', label: 'Invoice total', align: 'right', getValue: (a) => a.docTotalSen ?? 0,
      render: (a) => (a.docTotalSen == null ? '—' : fmtSen(a.docTotalSen)), exportValue: (a) => (a.docTotalSen ?? 0) / 100, exportFormat: 'money',
    },
    {
      key: 'knocked_off', label: posted ? 'Knocked off' : 'To knock off', align: 'right', getValue: takenOf,
      render: (a) => fmtSen(takenOf(a)), exportValue: (a) => takenOf(a) / 100, exportFormat: 'money',
      total: (rows) => fmtSen(rows.reduce((s, a) => s + takenOf(a), 0)),
    },
  ];
  return (
    <section aria-label="Knocks off" style={{ display: 'grid', gap: 6, fontSize: 'var(--fs-13)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>Knocks off</strong>
        {!depositLine && !cancelled && (
          <span style={soft}>Knocked off {fmtSen(taken)} · <span style={left > 0 && posted ? { color: 'var(--c-brass, #7a5a1e)' } : undefined}>Not knocked off {fmtSen(left)}</span></span>
        )}
        <span style={{ flex: 1 }} />
        {onKnockOff && <Button variant="ghost" size="sm" onClick={onKnockOff}>Knock off</Button>}
      </div>
      {depositLine ? <div style={soft}>{depositLine}</div>
        : takes.length === 0 || cancelled ? <div style={soft}>{empty}</div>
          : <DataTable<CreditAllocation> tableId="mi-note-knock-off" embedded columns={columns} rows={takes} getRowKey={(a) => a.id} />}
    </section>
  );
}
