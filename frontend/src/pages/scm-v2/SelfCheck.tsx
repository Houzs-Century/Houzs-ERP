// ----------------------------------------------------------------------------
// SelfCheck — Books › Self-check in the owner's redesign (batch 6 §3,
// Finance-1a-Books-checks): the reconciliation the books carry about
// themselves, as one list of checks in three groups. Each row is a status
// tile, the check's name over its one-line state, its figure and a tag —
// Clean, or what needs looking at; a row with findings opens by default, a
// clean one stays one line, and whichever is open stays open while you are
// away. Run again re-reads every check.
//
//   Control accounts against their documents — Trade / Other debtors and
//   creditors (the control roles AR, AR_OTHER, AP, AP_OTHER): the ledger
//   balance; the documents whose journal disagrees with them; lines from
//   sources that do not belong on the account. Reads only.
//   Payments and their entries — payments that never reached the ledger
//   (Why? asks the gate in a dry run, nothing written; Book N payments only
//   after a dry run it refused none of, behind an inline confirm), and
//   payments that no longer agree with their entry (reads only; no button).
//   Money the books are not done with — cancelled orders still holding money
//   (Refund and Convert are on the order), and official receipts owed to
//   history (Create N receipts behind an inline confirm; nothing in the
//   ledger moves).
//
// Every call is today's: the control check, the dry run and the real backfill
// of customer payments, the cancelled-orders list, the receipts plan and its
// batched run. Nothing posts differently.
// ----------------------------------------------------------------------------

import { Children, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, HandCoins, Info, Loader2, Receipt, RefreshCw, Scale } from 'lucide-react';
import { DataTable, type Column } from '../../components/DataTable';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import { fmtDate, fmtDateTime, fmtSen } from '../../vendor/shared/format';
import { fmtLedger } from '../../vendor/scm/lib/ledger-queries';
import { useCancelledWithMoney, type ConvertSource } from '../../vendor/scm/lib/so-money-queries';
import {
  useBookUnbookedPayments, useControlCheck, usePaymentBookingDryRun,
  type ControlCheckRow, type ControlDrift, type PaymentDrift, type PaymentDriftRow, type PaymentDryRun, type UnbookedPayments,
} from './accounting-phase1-queries';
import {
  monthLabel, monthsWord, seriesLine, useReceiptBackfillPlan, useRunReceiptBackfill, type BackfillMonth, type BackfillPlan, type BackfillResult,
} from './receipt-backfill-queries';
import { AccountingHeader } from './books/AccountingHeader';
import { useBooksToast } from './books/BooksToast';
import tokens from './finance/finance-ui.module.css';
import b from './books/Books.module.css';
import s from './books/SelfCheck.module.css';

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-MY')} ${n === 1 ? one : many}`;
const rm = (sen: number): string => fmtSen(sen);

/* ── One row ──────────────────────────────────────────────────────────── */

type TagTone = 'late' | 'info' | 'calm' | 'warn';
const tagClass = (t: TagTone): string => (t === 'late' ? b.toneLate : t === 'info' ? b.toneInfo : t === 'warn' ? b.toneWarn : b.toneCalm);

/** What was opened or closed, kept while the page is away (the design keeps
    it across visits to the page; nothing is stored). */
const openMemory = new Map<string, boolean>();

type CheckRowProps = {
  id: string;
  title: string;
  sub: ReactNode;
  figure?: string | null;
  tag: { label: string; tone: TagTone; dot?: boolean };
  /** Findings: the red tile, and the row opens by default. */
  bad: boolean;
  /** Still reading, or not readable: the grey tile. */
  quiet?: boolean;
  children?: ReactNode;
};

function CheckRow({ id, title, sub, figure, tag, bad, quiet, children }: CheckRowProps) {
  const openable = Children.toArray(children).length > 0;
  const [choice, setChoice] = useState<boolean | null>(() => openMemory.get(id) ?? null);
  const open = openable && (choice ?? bad);
  const toggle = () => {
    if (!openable) return;
    openMemory.set(id, !open);
    setChoice(!open);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  return (
    <div className={s.check} data-check={id}>
      <div className={`${s.head} ${openable ? s.headOpenable : ''}`} onClick={toggle} onKeyDown={onKey}
        role={openable ? 'button' : undefined} tabIndex={openable ? 0 : undefined} aria-expanded={openable ? open : undefined}>
        <span className={`${s.tile} ${quiet ? s.tileCalm : bad ? s.tileLate : s.tileInfo}`} aria-hidden>
          {quiet ? <Loader2 size={16} /> : bad ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
        </span>
        <span className={s.titleBox}>
          <span className={s.title} style={{ display: 'block' }}>{title}</span>
          <span className={s.sub} style={{ display: 'block' }}>{sub}</span>
        </span>
        <span className={s.figure}>{figure ?? ''}</span>
        <span className={s.tagCell}><span className={`${b.tag} ${tagClass(tag.tone)}`}>{tag.dot && <span className={b.dot} />}{tag.label}</span></span>
        <span className={s.chev} aria-hidden>{openable && (open ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}</span>
      </div>
      {open && <div className={s.body}>{children}</div>}
    </div>
  );
}

const Result = ({ tone, children }: { tone: 'info' | 'calm' | 'late'; children: ReactNode }) => (
  <div className={`${s.result} ${tone === 'info' ? s.resultInfo : tone === 'late' ? s.resultLate : s.resultCalm}`} role="status">
    {tone === 'info' ? <CheckCircle2 size={14} aria-hidden /> : tone === 'late' ? <AlertTriangle size={14} aria-hidden /> : <Info size={14} aria-hidden />}
    <span>{children}</span>
  </div>
);

const Confirm = ({ question, body, label, busy, onCancel, onConfirm }: { question: string; body: string; label: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) => (
  <div className={s.confirm}>
    <Info size={15} aria-hidden />
    <span className={s.confirmText}><span className={s.confirmQ}>{question}</span> {body}</span>
    <button type="button" className={`${b.btn} ${s.small}`} onClick={onCancel} disabled={busy}>Cancel</button>
    <button type="button" className={`${b.btnSolid} ${s.small}`} onClick={onConfirm} disabled={busy}>{label}</button>
  </div>
);

const Act = ({ label, primary, busy, onClick }: { label: string; primary?: boolean; busy?: boolean; onClick: () => void }) => (
  <button type="button" className={`${s.act} ${primary ? s.actPrimary : s.actSecondary}`} onClick={onClick} disabled={busy}>
    {label}<ChevronRight size={13} aria-hidden />
  </button>
);

/* ── Control accounts against their documents ────────────────────────── */

/** The control roles by the names Finance uses for them. */
export function controlTitle(role: string): string {
  switch (role) {
    case 'AR': return 'Trade debtors';
    case 'AR_OTHER': return 'Other debtors';
    case 'AP_OTHER': return 'Other creditors';
    default: return 'Trade creditors';
  }
}
const debtorSide = (role: string): boolean => role === 'AR' || role === 'AR_OTHER';

/** A document of the drift list opens on its own page once the read names its id. */
export function driftDocHref(d: ControlDrift): string | null {
  if (!d.docId) return null;
  switch (d.docKind) {
    case 'SI': return `/scm/sales-invoices/${encodeURIComponent(d.docId)}`;
    case 'PI': return `/scm/purchase-invoices/${encodeURIComponent(d.docId)}`;
    case 'API': return `/scm/ap-invoices/${encodeURIComponent(d.docId)}`;
    default: return null;
  }
}

/** Findings on a control: its drift documents and foreign lines; an error counts as one to look at. */
export const controlFindings = (c: ControlCheckRow): number => ('error' in c ? 1 : c.driftDocs.length + c.foreignLines.length);

function ControlRow({ c, open }: { c: ControlCheckRow; open: (path: string) => void }) {
  const title = controlTitle(c.role);
  if ('error' in c) {
    return (
      <CheckRow id={`control-${c.accountCode}`} title={title} sub={`${c.accountCode} · balance in the ledger`} tag={{ label: 'Not checked', tone: 'late', dot: true }} bad>
        <div className={s.note}>The {title.toLowerCase()} check could not run: {c.error}</div>
      </CheckRow>
    );
  }
  const n = c.driftDocs.length + c.foreignLines.length;
  const figure = `${rm(Math.abs(c.glBalanceSen))}${c.glBalanceSen < 0 ? ' Cr' : ''}`;
  const party = debtorSide(c.role) ? 'Customer' : 'Supplier';
  const columns: Column<ControlDrift>[] = [
    {
      key: 'doc', label: 'Document', getValue: (d) => d.docNo,
      render: (d) => { const href = driftDocHref(d); return href ? <button type="button" className={s.docLink} onClick={() => open(href)}>{d.docNo}</button> : <span className={b.strong}>{d.docNo}</span>; },
    },
    { key: 'party', label: party, getValue: (d) => d.party ?? '', render: (d) => d.party ?? '—' },
    { key: 'date', label: 'Date', getValue: (d) => d.date ?? '', render: (d) => (d.date ? fmtDate(d.date) : '—') },
    { key: 'docTotal', label: 'Document total', align: 'right', getValue: (d) => d.docTotalSen / 100, render: (d) => fmtLedger(d.docTotalSen) },
    { key: 'jeTotal', label: 'Journal total', align: 'right', getValue: (d) => d.jeTotalSen / 100, render: (d) => fmtLedger(d.jeTotalSen) },
    { key: 'total_diff', label: 'Difference', align: 'right', getValue: (d) => d.diffSen / 100, render: (d) => <span className={b.strong}>{fmtLedger(d.diffSen)}</span> },
    { key: 'je_no', label: 'Entry', getValue: (d) => d.jeNo ?? '', render: (d) => d.jeNo ?? '—' },
    { key: 'wrong', label: 'What is wrong', getValue: (d) => d.note, render: (d) => <span className={b.muted}>{d.note}</span> },
  ];
  return (
    <CheckRow id={`control-${c.accountCode}`} title={title} sub={`${c.accountCode} · balance in the ledger`} figure={figure}
      tag={n > 0 ? { label: plural(n, 'finding', 'findings'), tone: 'late', dot: true } : { label: 'Clean', tone: 'info' }} bad={n > 0}>
      {n > 0 && (
        <>
          {c.driftDocs.length > 0 && (
            <DataTable<ControlDrift>
              tableId={`selfcheck-${c.accountCode}`} embedded freezeHeight="off" emptyLabel="Nothing here."
              columns={columns} rows={c.driftDocs} getRowKey={(d) => d.docNo}
              onRowDoubleClick={(d) => { const href = driftDocHref(d); if (href) open(href); }}
              contextMenu={(d) => { const href = driftDocHref(d); return href ? [{ label: `Open ${d.docNo}`, onClick: () => open(href) }] : []; }}
            />
          )}
          {c.foreignLines.length > 0 && (
            <div className={s.foreign}>
              Lines on this account from sources that do not belong here:{' '}
              {c.foreignLines.map((f) => `${f.jeNo} (${f.sourceType})`).join(', ')}
            </div>
          )}
        </>
      )}
    </CheckRow>
  );
}

/* ── Payments that reached the ledger ─────────────────────────────────── */

type UnbookedRow = UnbookedPayments['rows'][number];
type ShownPayment = { id: string; docNo: string; source?: string; customer: string | null; salesperson: string | null; paidOn: string; method: string; amountSen: number; status?: string; reason?: string };

const verdictWord = (status: string): string => (status === 'would_post' ? 'would post' : status);
const soHref = (docNo: string): string => `/scm/sales-orders/${encodeURIComponent(docNo)}`;

/** True when the payments check names something to look at. */
export const unbookedFindings = (p: UnbookedPayments): boolean =>
  Boolean(p.error) || p.rows.length > 0 || (p.since == null && (p.neverBooked?.count ?? 0) > 0);

export function UnbookedRowCheck({ p, onToast }: { p: UnbookedPayments; onToast: (text: string) => void }) {
  const dry = usePaymentBookingDryRun();
  const book = useBookUnbookedPayments();
  const qc = useQueryClient();
  const open = useOpenDocInTab();
  const [confirming, setConfirming] = useState(false);
  const never = p.since == null && (p.neverBooked?.count ?? 0) > 0;
  const findings = unbookedFindings(p);
  const count = never ? (p.neverBooked?.count ?? 0) : p.rows.length;
  const totalSen = never ? (p.neverBooked?.totalSen ?? 0) : p.totalSen;
  /* The real run is offered only after a dry run the gate refused nothing on
     (docs/bugs/0655) — the owner presses it himself; the write is his. */
  const bookable: PaymentDryRun | null = dry.data && dry.data.scanned > 0 && dry.data.failed.length === 0 ? dry.data : null;
  const bookableSen = bookable ? bookable.rows.reduce((t, r) => t + r.amountSen, 0) : 0;

  const sub = p.error
    ? 'The check could not run'
    : never
      ? `${plural(count, 'payment was', 'payments were')} recorded and none ever reached the books`
      : p.since == null
        ? 'No payment has been booked in this company yet'
        : p.rows.length > 0
          ? `${plural(p.rows.length, 'payment', 'payments')} since ${fmtDate(p.since)} did not`
          : `Every payment since ${fmtDate(p.since)} is in the books`;
  const tag = p.error
    ? { label: 'Not checked', tone: 'late' as const, dot: true }
    : never
      ? { label: 'none, ever', tone: 'late' as const, dot: true }
      : p.rows.length > 0
        ? { label: `${p.rows.length.toLocaleString('en-MY')} not in the books`, tone: 'late' as const, dot: true }
        : { label: 'Clean', tone: 'info' as const };

  const extra = new Map(p.rows.map((r: UnbookedRow) => [r.id, r]));
  const shown: ShownPayment[] = dry.data
    ? dry.data.rows.map((r) => ({ ...r, source: extra.get(r.id)?.source, customer: extra.get(r.id)?.customer ?? null, salesperson: extra.get(r.id)?.salesperson ?? null }))
    : p.rows.map((r) => ({ ...r, customer: r.customer ?? null, salesperson: r.salesperson ?? null }));
  const linkOf = (r: ShownPayment): string | null => (r.source !== 'SIPAY' && r.docNo ? soHref(r.docNo) : null);
  const columns: Column<ShownPayment>[] = [
    {
      key: 'doc', label: 'Document', getValue: (r) => r.docNo,
      render: (r) => { const href = linkOf(r); return href ? <button type="button" className={s.docLink} onClick={() => open(href)}>{r.docNo}</button> : r.docNo; },
    },
    { key: 'customer', label: 'Customer', getValue: (r) => r.customer ?? '', render: (r) => r.customer ?? '—' },
    { key: 'sales', label: 'Sales', getValue: (r) => r.salesperson ?? '', render: (r) => r.salesperson ?? '—' },
    { key: 'paidOn', label: 'Paid on', getValue: (r) => r.paidOn, render: (r) => fmtDate(r.paidOn) },
    { key: 'method', label: 'How', getValue: (r) => r.method, render: (r) => r.method },
    {
      key: 'amount', label: 'Amount', align: 'right', getValue: (r) => r.amountSen / 100, exportValue: (r) => r.amountSen / 100, exportFormat: 'money',
      render: (r) => fmtLedger(r.amountSen), total: (rows) => fmtLedger(rows.reduce((t, r) => t + r.amountSen, 0)),
    },
    ...(dry.data ? [
      {
        key: 'gate_status', label: 'Verdict', getValue: (r: ShownPayment) => verdictWord(r.status ?? ''),
        render: (r: ShownPayment) => <span className={`${s.pill} ${r.status === 'would_post' ? b.toneInfo : b.toneLate}`}>{verdictWord(r.status ?? '')}</span>,
      },
      { key: 'reason', label: 'Reason', getValue: (r: ShownPayment) => r.reason ?? '', render: (r: ShownPayment) => <span className={b.muted}>{r.reason ?? '—'}</span> },
    ] satisfies Column<ShownPayment>[] : []),
  ];

  const summary = (r: PaymentDryRun): string => {
    const byStatus = new Map<string, number>();
    for (const row of r.rows) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    return [...byStatus].map(([st, n]) => `${n} ${verdictWord(st)}`).join(', ');
  };

  const doBook = () => {
    book.mutate(undefined, {
      onSuccess: (r) => {
        setConfirming(false);
        void qc.invalidateQueries({ queryKey: ['finance-todo'] });
        onToast(`Booked ${plural(r.posted, 'payment', 'payments')} · ${rm(bookableSen)}`);
      },
    });
  };

  return (
    <CheckRow id="unbooked" title="Payments that reached the ledger" sub={sub} figure={findings && !p.error ? rm(totalSen) : null} tag={tag} bad={findings}>
      {/* The period this check speaks about, always — including when it speaks about nothing. */}
      {p.error && <div className={s.note}>The check could not run: {p.error}</div>}
      {!p.error && (
        <div className={s.note}>
          {p.since == null
            ? (never
              ? `No payment has ever been booked in this company, yet ${p.neverBooked?.count ?? 0} were recorded between ${p.neverBooked?.firstPaidOn ? fmtDate(p.neverBooked.firstPaidOn) : '?'} and ${p.neverBooked?.lastPaidOn ? fmtDate(p.neverBooked.lastPaidOn) : '?'} (imported and zero rows not counted). The booking hook is not reaching the books — press Why? for the gate's own reason on each.`
              : 'No payment has been booked in this company yet, and its SO/SI payment tables hold no bookable row (imported and zero rows are skipped by design).')
            : `Counting from ${fmtDate(p.since)}, the first day this company booked a payment. Earlier payments were left out of the books on purpose.`}
        </div>
      )}
      {shown.length > 0 && (
        <DataTable<ShownPayment>
          tableId={dry.data ? 'selfcheck-unbooked-dry' : 'selfcheck-unbooked'} embedded freezeHeight="off" emptyLabel="Nothing here."
          columns={columns} rows={shown} getRowKey={(r) => r.id}
          onRowDoubleClick={(r) => { const href = linkOf(r); if (href) open(href); }}
          contextMenu={(r) => { const href = linkOf(r); return href ? [{ label: `Open ${r.docNo}`, onClick: () => open(href) }] : []; }}
        />
      )}
      {dry.isError && <Result tone="late">The dry run could not run: {dry.error instanceof Error ? dry.error.message : String(dry.error)}</Result>}
      {dry.data && !book.data && (
        <Result tone="calm">
          Dry run: {plural(dry.data.scanned, 'unbooked payment', 'unbooked payments')} put through the gate, nothing written{dry.data.rows.length > 0 ? `: ${summary(dry.data)}.` : '.'}
          {dry.data.remaining > dry.data.rows.length ? ` Showing the first ${dry.data.rows.length}.` : ''}
        </Result>
      )}
      {book.isError && <Result tone="late">The booking could not run: {book.error instanceof Error ? book.error.message : String(book.error)}</Result>}
      {book.data && (
        <Result tone={book.data.failed.length > 0 || book.data.remaining > 0 ? 'late' : 'info'}>
          Booked {book.data.posted}, skipped {book.data.skipped}, refused {book.data.failed.length}
          {book.data.remaining > 0 ? ` — ${book.data.remaining} still waiting, press Why? and book again.` : book.data.failed.length > 0 ? '.' : '. Every payment is in the books now.'}
        </Result>
      )}
      {bookable && !book.data && confirming && (
        <Confirm
          question={`Book ${plural(bookable.scanned, 'payment', 'payments')} into the ledger?`}
          body={`Each posts on its own paid date, ${rm(bookableSen)} in total: Dr bank or cash, Cr Trade debtors.`}
          label={book.isPending ? 'Booking…' : 'Book them'} busy={book.isPending}
          onCancel={() => setConfirming(false)} onConfirm={doBook}
        />
      )}
      {findings && !p.error && !book.data && !confirming && (
        <div className={s.acts}>
          {bookable
            ? <Act primary label={`Book ${plural(bookable.scanned, 'payment', 'payments')}`} onClick={() => setConfirming(true)} />
            : <Act label={dry.isPending ? 'Asking the gate…' : 'Why? (dry run)'} busy={dry.isPending} onClick={() => dry.mutate()} />}
        </div>
      )}
    </CheckRow>
  );
}

/* ── Payments that still agree with their entry ──────────────────────── */

const driftWords: Record<PaymentDriftRow['fields'][number], string> = {
  amount: 'amount', date: 'date', method: 'how it was paid',
};

export const driftFindings = (d: PaymentDrift): boolean => Boolean(d.error) || d.rows.length > 0;

/* It reads. It writes nothing, and offers no button to: putting the entry
   right is the payment edit's own repost, and a fix offered here would be a
   second way to post. The table stays plain on purpose (a grid brings its
   own buttons). */
export function DriftRowCheck({ d }: { d: PaymentDrift }) {
  const clean = d.ok && d.rows.length === 0;
  /* Nothing booked here yet is not the same statement as everything agrees,
     and the row must not borrow the second one's words for the first. */
  const nothingToCompare = clean && d.scanned === 0;
  const sub = d.error
    ? 'The check could not run'
    : nothingToCompare
      ? 'No payment has reached the ledger yet, so there is no entry to compare a payment against'
      : `${plural(d.scanned, 'payment', 'payments')} compared with their journal entries`;
  const tag = d.error
    ? { label: 'Not checked', tone: 'late' as const, dot: true }
    : nothingToCompare
      ? { label: 'nothing to compare', tone: 'calm' as const }
      : d.rows.length > 0
        ? { label: `${d.rows.length} do not`, tone: 'late' as const, dot: true }
        : { label: `all ${d.scanned}`, tone: 'info' as const };
  return (
    <CheckRow id="agree" title="Payments that still agree with their entry" sub={sub} tag={tag} bad={driftFindings(d)}>
      {d.error && <div className={s.note}>The check could not run: {d.error}</div>}
      {d.rows.length > 0 && (
        <>
          <div className={s.plainWrap}>
            <table className={s.plain}>
              <thead>
                <tr><th>Document</th><th>Entry</th><th>What moved</th><th className={s.r}>Payment says</th><th className={s.r}>Entry says</th></tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={`${r.source}:${r.id}`}>
                    <td>{r.docNo}</td>
                    <td>{r.jeNo}</td>
                    <td>{r.fields.map((f) => driftWords[f]).join(', ')}</td>
                    <td className={s.r}>{rm(r.paymentAmountSen)}<br /><span className={s.under}>{r.paidOn ? fmtDate(r.paidOn) : 'no date'} · {r.paymentMethod}</span></td>
                    <td className={s.r}>{rm(r.entryAmountSen)}<br /><span className={s.under}>{fmtDate(r.entryDate)} · {r.entryMethod ?? 'not stated'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={s.note}>
            Nothing here is corrected automatically. The entry is put right by reversing it and booking it again — until that is built, reverse the entry by hand and re-key the payment.
          </div>
        </>
      )}
    </CheckRow>
  );
}

/* ── Cancelled orders still holding money ─────────────────────────────── */

type CancelledOrder = ConvertSource & { salesperson?: string | null };

export function CancelledRowCheck({ q }: { q: ReturnType<typeof useCancelledWithMoney> }) {
  const open = useOpenDocInTab();
  const rows = (q.data?.orders ?? []) as CancelledOrder[];
  const leftSen = q.data?.totalRemainingSen ?? 0;
  if (q.isError || (!q.data && !q.isLoading)) {
    return <CheckRow id="cancelled" title="Cancelled orders still holding money" sub="not checked — the read failed" tag={{ label: 'Not checked', tone: 'late', dot: true }} bad />;
  }
  if (!q.data) {
    return <CheckRow id="cancelled" title="Cancelled orders still holding money" sub="Checking…" tag={{ label: 'Checking', tone: 'calm' }} bad={false} quiet />;
  }
  const columns: Column<CancelledOrder>[] = [
    { key: 'doc_no', label: 'Order', getValue: (r) => r.docNo, render: (r) => <button type="button" className={s.docLink} onClick={() => open(soHref(r.docNo))}>{r.docNo}</button> },
    { key: 'customer', label: 'Customer', getValue: (r) => r.customer ?? '', render: (r) => r.customer ?? '—' },
    { key: 'sales', label: 'Sales', getValue: (r) => r.salesperson ?? '', render: (r) => r.salesperson ?? '—' },
    { key: 'cancelled_date', label: 'Cancelled on', getValue: (r) => r.cancelledOn ?? '', render: (r) => (r.cancelledOn ? fmtDate(r.cancelledOn) : '—') },
    { key: 'paid', label: 'Paid', align: 'right', getValue: (r) => r.bookedSen / 100, render: (r) => fmtLedger(r.bookedSen) },
    {
      key: 'balance', label: 'Left', align: 'right', getValue: (r) => r.remainingSen / 100, render: (r) => <span className={b.strong}>{fmtLedger(r.remainingSen)}</span>,
      total: (list) => fmtLedger(list.reduce((t, r) => t + r.remainingSen, 0)),
    },
  ];
  const sub = rows.length === 0
    ? 'No cancelled order is holding money'
    : rows.slice(0, 3).map((r) => `${r.docNo} · ${r.customer ?? '—'}`).join(', ') + (rows.length > 3 ? ` and ${rows.length - 3} more` : '');
  return (
    <CheckRow id="cancelled" title="Cancelled orders still holding money" sub={sub} figure={rows.length > 0 ? rm(leftSen) : null}
      tag={rows.length > 0 ? { label: plural(rows.length, 'order', 'orders'), tone: 'late', dot: true } : { label: 'Clean', tone: 'info' }} bad={rows.length > 0}>
      {rows.length > 0 && (
        <>
          <div className={s.note}>Refund and Convert are on the order’s money panel. Double-click a row to open the order.</div>
          <DataTable<CancelledOrder>
            tableId="selfcheck-cancelled" embedded freezeHeight="off" emptyLabel="Nothing here."
            columns={columns} rows={rows} getRowKey={(r) => r.docNo}
            onRowDoubleClick={(r) => open(soHref(r.docNo))}
            contextMenu={(r) => [{ label: `Open ${r.docNo}`, onClick: () => open(soHref(r.docNo)) }]}
          />
        </>
      )}
    </CheckRow>
  );
}

/* ── Official receipts ────────────────────────────────────────────────── */

export function ReceiptsRowCheck({ q, onToast }: { q: ReturnType<typeof useReceiptBackfillPlan>; onToast: (text: string) => void }) {
  const [progress, setProgress] = useState<BackfillResult | null>(null);
  const run = useRunReceiptBackfill(setProgress);
  const [confirming, setConfirming] = useState(false);
  const p: BackfillPlan | undefined = q.data;
  if (q.isError || (!p && !q.isLoading)) {
    return <CheckRow id="receipts" title="Official receipts" sub="not checked — the read failed" tag={{ label: 'Not checked', tone: 'late', dot: true }} bad />;
  }
  if (!p) return <CheckRow id="receipts" title="Official receipts" sub="Counting…" tag={{ label: 'Checking', tone: 'calm' }} bad={false} quiet />;
  const n = p.total;
  const anyUnlettered = p.months.some((m) => m.unlettered > 0);
  const columns: Column<BackfillMonth>[] = [
    { key: 'month', label: 'Month', getValue: (m) => m.ym, render: (m) => monthLabel(m.ym) },
    { key: 'payment_count', label: 'Payments', align: 'right', getValue: (m) => m.payments, render: (m) => m.payments },
    { key: 'cash_payment', label: 'Cash', align: 'right', getValue: (m) => m.cash, render: (m) => m.cash },
    { key: 'card', label: 'Card confirmed', align: 'right', getValue: (m) => m.confirmedCards, render: (m) => m.confirmedCards },
    {
      key: 'unlettered', label: 'No letter yet', align: 'right', defaultHidden: !anyUnlettered, getValue: (m) => m.unlettered, render: (m) => m.unlettered,
      description: 'Card payments confirmed, but the payout bank has no voucher letter yet',
    },
    { key: 'series', label: 'Numbers the run takes', getValue: (m) => m.series.map(seriesLine).join('; '), render: (m) => <span>{m.series.map((x) => <span key={x.series} style={{ display: 'block' }}>{seriesLine(x)}</span>)}</span> },
  ];
  const doRun = () => {
    run.mutate(undefined, {
      onSuccess: (r) => { setConfirming(false); onToast(`Created ${plural(r.created, 'official receipt', 'official receipts')} · ${r.formalised} formal`); },
      onError: () => setConfirming(false),
    });
  };
  const resultTone = run.data && (run.data.failed.length > 0 || run.data.remaining > 0) ? 'late' : 'info';
  return (
    <CheckRow id="receipts" title="Official receipts" sub={n === 0 ? 'Every payment has one' : `${plural(n, 'payment', 'payments')} from ${monthsWord(p.months)} have none`}
      tag={n > 0 ? { label: `${n.toLocaleString('en-MY')} without one`, tone: 'late', dot: true } : { label: 'Clean', tone: 'info' }} bad={n > 0}>
      {(n > 0 || run.data || run.isError) && (
        <>
          {n > 0 && (
            <DataTable<BackfillMonth>
              tableId="selfcheck-receipts" embedded freezeHeight="off" emptyLabel="Nothing here."
              columns={columns} rows={p.months} getRowKey={(m) => m.ym}
            />
          )}
          {run.isPending && progress && <Result tone="calm">Creating… {progress.created} of {n}, {progress.remaining} left</Result>}
          {run.isError && (
            <Result tone="late">
              The run stopped: {run.error instanceof Error ? run.error.message : String(run.error)}
              {progress && ` — ${progress.created} created so far; every receipt made is kept, press again for the rest.`}
            </Result>
          )}
          {run.data && (
            <Result tone={resultTone}>
              Created {run.data.created}, formal {run.data.formalised}, refused {run.data.failed.length}
              {run.data.remaining > 0 ? ` — ${run.data.remaining} still without one.` : run.data.failed.length > 0 ? '.' : '. Every payment has one now.'}
              {run.data.failed.length > 0 && (
                <ul className={s.refused}>
                  {run.data.failed.map((f) => <li key={`${f.paymentId}:${f.reason}`}>{f.docNo || f.paymentId}: {f.reason}</li>)}
                </ul>
              )}
            </Result>
          )}
          {n > 0 && !run.data && confirming && (
            <Confirm
              question={`Create ${plural(n, 'receipt', 'receipts')} now?`}
              body="Each payment gets its receipt on its own month’s series, in payment-date order. Cash and confirmed card payments are formal at once, the rest drafts. Nothing in the ledger moves."
              label={run.isPending ? 'Creating…' : 'Create them'} busy={run.isPending}
              onCancel={() => setConfirming(false)} onConfirm={doRun}
            />
          )}
          {n > 0 && !run.data && !confirming && (
            <div className={s.acts}><Act primary label={`Create ${plural(n, 'receipt', 'receipts')}`} onClick={() => setConfirming(true)} /></div>
          )}
        </>
      )}
    </CheckRow>
  );
}

/* ── The page ─────────────────────────────────────────────────────────── */

const GROUPS = [
  { key: 'controls', label: 'Control accounts against their documents', icon: Scale },
  { key: 'payments', label: 'Payments and their entries', icon: Receipt },
  { key: 'money', label: 'Money the books are not done with', icon: HandCoins },
] as const;

/** How many checks the page holds, and how many name something to look at. */
export function selfCheckCounts(p: {
  checks: ControlCheckRow[] | null;
  payments: UnbookedPayments | null;
  drift: PaymentDrift | null;
  cancelled: number | null;
  receipts: number | null;
}): { checks: number; toLook: number } {
  const controls = p.checks ?? [];
  const toLook = controls.filter((c) => controlFindings(c) > 0).length
    + (p.payments && unbookedFindings(p.payments) ? 1 : 0)
    + (p.drift && driftFindings(p.drift) ? 1 : 0)
    + (p.cancelled == null || p.cancelled > 0 ? 1 : 0)
    + (p.receipts == null || p.receipts > 0 ? 1 : 0);
  return { checks: Math.max(controls.length, 4) + 4, toLook };
}

export const SelfCheckTab = () => {
  const control = useControlCheck();
  const cancelled = useCancelledWithMoney(null);
  const receipts = useReceiptBackfillPlan();
  const open = useOpenDocInTab();
  const toast = useBooksToast();
  const [running, setRunning] = useState(false);

  const checks = control.data?.checks ?? null;
  const counts = selfCheckCounts({
    checks, payments: control.data?.payments ?? null, drift: control.data?.paymentDrift ?? null,
    cancelled: cancelled.isError ? null : cancelled.data ? cancelled.data.orders.length : 0,
    receipts: receipts.isError ? null : receipts.data ? receipts.data.total : 0,
  });
  const loaded = Boolean(control.data && cancelled.data && receipts.data);
  const checkedAt = Math.max(control.dataUpdatedAt, cancelled.dataUpdatedAt, receipts.dataUpdatedAt);
  const subtitle = control.isError
    ? 'The checks did not load — press Run again'
    : !loaded
      ? 'Checking…'
      : `Checked ${fmtDateTime(new Date(checkedAt))} · ${counts.checks} checks · ${counts.toLook > 0 ? `${counts.toLook} to look at` : 'all clean'}`;

  const runAgain = async () => {
    setRunning(true);
    try {
      const [c, x, r] = await Promise.all([control.refetch(), cancelled.refetch(), receipts.refetch()]);
      const after = selfCheckCounts({
        checks: c.data?.checks ?? null, payments: c.data?.payments ?? null, drift: c.data?.paymentDrift ?? null,
        cancelled: x.isError ? null : x.data?.orders.length ?? 0, receipts: r.isError ? null : r.data?.total ?? 0,
      });
      toast.say(`Self-check ran · ${after.toLook > 0 ? `${after.toLook} to look at` : 'all clean'}`);
    } finally {
      setRunning(false);
    }
  };

  const actions = (
    <div className={b.headActions}>
      <button type="button" className={b.btn} onClick={() => { void runAgain(); }} disabled={running}>
        <RefreshCw size={14} aria-hidden />{running ? 'Running…' : 'Run again'}
      </button>
    </div>
  );

  return (
    <div className={`${tokens.root} ${b.page}`}>
      <AccountingHeader tab="check" description={subtitle} actions={actions} />
      {control.isError && <div className={b.problem}>The control check did not load: {control.error instanceof Error ? control.error.message : 'please try again.'}</div>}
      <div className={s.list}>
        {GROUPS.map((g) => (
          <div key={g.key} className={s.group}>
            <div className={s.groupHead}><g.icon size={13} aria-hidden />{g.label}</div>
            {g.key === 'controls' && (checks
              ? checks.map((c) => <ControlRow key={c.role} c={c} open={open} />)
              : <CheckRow id="controls-loading" title="Control accounts" sub={control.isError ? 'not checked — the read failed' : 'Running checks…'}
                tag={control.isError ? { label: 'Not checked', tone: 'late', dot: true } : { label: 'Checking', tone: 'calm' }} bad={control.isError} quiet={!control.isError} />)}
            {g.key === 'payments' && control.data && (
              <>
                <UnbookedRowCheck p={control.data.payments} onToast={toast.say} />
                {control.data.paymentDrift && <DriftRowCheck d={control.data.paymentDrift} />}
              </>
            )}
            {g.key === 'payments' && !control.data && (
              <CheckRow id="payments-loading" title="Payments" sub={control.isError ? 'not checked — the read failed' : 'Running checks…'}
                tag={control.isError ? { label: 'Not checked', tone: 'late', dot: true } : { label: 'Checking', tone: 'calm' }} bad={control.isError} quiet={!control.isError} />
            )}
            {g.key === 'money' && (
              <>
                <CancelledRowCheck q={cancelled} />
                <ReceiptsRowCheck q={receipts} onToast={toast.say} />
              </>
            )}
          </div>
        ))}
      </div>
      {toast.node}
    </div>
  );
};
