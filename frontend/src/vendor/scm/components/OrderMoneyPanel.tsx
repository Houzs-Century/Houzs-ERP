/* OrderMoneyPanel — the money on a Sales Order and its two exits, side by
   side (owner 2026-09-15: 他应该是 convert or refund，所以功能要做一起 … 这个按钮
   我觉得挨着一起; docs/bugs/0927 the backend, docs/bugs/0931 this). Since
   2026-09-16 the order need not be cancelled: a LIVE order keeps its deposit
   fraction of the total (Houzs 30% / 2990 50%) and may move the rest; it may
   refund any part (Finance approves the voucher).

   Under the payments table of a saved order, once it collected something:
   paid · refunded (the vouchers, with their status) · refund requested (the
   requests still waiting) · moved (to which orders) · REMAINING, and for a
   live order what it keeps. Two buttons when something is left:

     [Refund]   an amount (part or all), the reason and the customer's bank —
                all required → a PAYMENT REQUEST for Finance (owner 2026-10-14:
                可以让他跑去 payment request … 因为我可能还会拒绝), the
                requester's own. It counts against what is left while it
                waits; Finance answers it with the refund voucher or returns it,
                and the panel lists each request with its answer.
     [Convert]  this order and the customer's other orders with money, each
                with a tick and an amount (part or all of what may move) → the
                New SO page opens with the customer and lines copied and one
                converted row per tick (owner: 这个是可以选多张一起 convert? — 可以).

   Renders nothing for an order that collected nothing, and nothing on a
   failed read: the payments above are the money truth. */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MoneyInput } from './MoneyInput';
import { fmtDate } from '../../shared/format';
import { useNotify } from './NotifyDialog';
import {
  EMPTY_BANK, convertParamOf, newOrderWithMoneyHref, refundAskGaps, useAddedConvertSources, useOrderMoney, useRequestRefund, useRequestRefunds,
  type ConvertPick, type ConvertSource, type MoneyRefundRequest, type OrderMoney, type RefundAskBank,
} from '../lib/so-money-queries';

const fmtRm = (sen: number): string =>
  `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const panel: React.CSSProperties = {
  marginTop: 8, padding: '10px 12px', borderRadius: 8,
  border: '1px solid var(--c-line, rgba(34,31,32,0.12))', background: 'var(--c-cream, #faf7f0)',
  fontSize: 'var(--fs-12)', display: 'flex', flexDirection: 'column', gap: 8,
};
const btn: React.CSSProperties = {
  padding: '4px 12px', borderRadius: 6, border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  background: 'var(--c-paper, #fff)', cursor: 'pointer', fontSize: 'var(--fs-12)', fontWeight: 600,
};
const primary: React.CSSProperties = { ...btn, background: 'var(--c-ink, #221f20)', color: 'var(--c-paper, #fff)', borderColor: 'var(--c-ink, #221f20)' };
const muted: React.CSSProperties = { color: 'var(--fg-muted)' };
const field: React.CSSProperties = { padding: '4px 8px', border: '1px solid var(--c-line, rgba(34,31,32,0.2))', borderRadius: 6 };
const danger: React.CSSProperties = { color: 'var(--c-danger, #a33)' };

/** The figures line — pure, so a test reads it without the buttons. */
export function moneySummary(m: OrderMoney): string {
  const fromAutoCount = m.importedSen ?? 0;
  const parts = [`Paid ${fmtRm(m.bookedSen)}${fromAutoCount > 0 ? ` (incl. ${fmtRm(fromAutoCount)} from AutoCount)` : ''}`];
  if (m.refundedSen > 0) parts.push(`Refunded ${fmtRm(m.refundedSen)}`);
  if ((m.requestedSen ?? 0) > 0) parts.push(`Refund requested ${fmtRm(m.requestedSen ?? 0)}`);
  if (m.convertedSen > 0) parts.push(`Moved ${fmtRm(m.convertedSen)}`);
  parts.push(`Remaining ${fmtRm(m.remainingSen)}`);
  return parts.join(' · ');
}

/** A refund request as the panel lists it: its number, amount and answer. */
export function refundRequestText(r: MoneyRefundRequest): string {
  const answer = r.state === 'WAITING' ? 'waiting for Finance'
    : r.state === 'ANSWERED' ? `answered by ${r.pvNumber ?? 'a refund voucher'}`
      : r.state === 'RETURNED' ? `rejected${r.financeNote ? `: ${r.financeNote}` : ''}`
        : 'withdrawn';
  return `${r.requestNo} · ${fmtRm(r.amountSen)} (${answer})`;
}

/** The customer's bank — the bank, the account number, the name on the
    account; `of` names the order when several sit side by side. */
function BankFields({ value, onChange, of }: { value: RefundAskBank; onChange: (v: RefundAskBank) => void; of?: string }) {
  const at = of ? ` for ${of}` : '';
  return (
    <>
      <input value={value.bankName} onChange={(e) => onChange({ ...value, bankName: e.target.value })} placeholder="Customer's bank *"
        aria-label={`Customer's bank${at}`} style={{ ...field, width: 150 }} />
      <input value={value.bankAccountNo} onChange={(e) => onChange({ ...value, bankAccountNo: e.target.value })} placeholder="Account number *"
        aria-label={`Account number${at}`} inputMode="numeric" style={{ ...field, width: 160 }} />
      <input value={value.bankAccountName} onChange={(e) => onChange({ ...value, bankAccountName: e.target.value })} placeholder="Name on the account *"
        aria-label={`Name on the account${at}`} style={{ ...field, width: 190 }} />
    </>
  );
}

/** What a live order must keep, and what may move — nothing for a cancelled one. */
export function keepLine(m: OrderMoney): string | null {
  if (m.cancelled || m.keepSen <= 0) return null;
  return `Keeps ${fmtRm(m.keepSen)} (${Math.round(m.keepFraction * 100)}% of ${fmtRm(m.totalSen)}) · ${m.movableSen > 0 ? `${fmtRm(m.movableSen)} can move` : 'nothing can move'}`;
}

function RefundForm({ docNo, remainingSen, onDone }: { docNo: string; remainingSen: number; onDone: () => void }) {
  const [amountSen, setAmountSen] = useState(remainingSen);
  const [reason, setReason] = useState('');
  const [bank, setBank] = useState<RefundAskBank>(EMPTY_BANK);
  const request = useRequestRefund(docNo);
  const notify = useNotify();
  const over = amountSen > remainingSen;
  const gaps = refundAskGaps({ reason, ...bank });
  const submit = async () => {
    try {
      const r = await request.mutateAsync({ amountSen, reason, ...bank });
      void notify({ title: `Refund request ${r.requestNo} sent to Finance`, body: `${fmtRm(amountSen)} on ${docNo}. Finance approves it or sends it back with the reason — you see the answer here and on Payment Requests.` });
      onDone();
    } catch (e) {
      void notify({ title: 'The refund request was not sent', body: e instanceof Error ? e.message : String(e), tone: 'error' });
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="refund-form">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>Refund</span>
        <MoneyInput valueSen={amountSen} onCommit={(sen) => setAmountSen(sen ?? 0)} aria-label="Refund amount" />
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason *" aria-label="Refund reason"
          style={{ ...field, flex: 1, minWidth: 200 }} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <BankFields value={bank} onChange={setBank} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={primary} disabled={amountSen <= 0 || over || gaps.length > 0 || request.isPending} onClick={() => void submit()}>Send refund request</button>
        <button type="button" style={btn} onClick={onDone}>Cancel</button>
        {over && <span style={danger}>Only {fmtRm(remainingSen)} is left.</span>}
        {!over && gaps.length > 0 && <span style={muted}>Still needed: {gaps.join(', ')}.</span>}
        <span style={muted}>Finance approves it or sends it back.</span>
      </div>
    </div>
  );
}

/** `onOpen` — the phone's screen router (docs/bugs/0933) opens the New SO
    screen itself; the desktop navigates to the page. */
type OpenNewOrder = (copyFrom: string, picks: ConvertPick[]) => void;

export type ConvertRow = ConvertSource & { self?: boolean };

/** Pick which orders to take money from, and how much of each (a live order
    gives what is above its floor); the New SO page then opens on `copyFrom`
    with one converted row per tick. Another order — any customer's — can be
    added by number. */
export function ConvertPicker({ rows: given, copyFrom, ticked: tickedAtFirst, onDone, onOpen }: {
  rows: ConvertRow[]; copyFrom: string; ticked: string[]; onDone: () => void; onOpen?: OpenNewOrder;
}) {
  const navigate = useNavigate();
  const picker = useAddedConvertSources(given);
  const rows = picker.sources as ConvertRow[];
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(tickedAtFirst));
  const [amounts, setAmounts] = useState<Record<string, number>>(() => Object.fromEntries(given.map((r) => [r.docNo, r.movableSen])));
  const addAnother = async () => {
    const src = await picker.add();
    if (!src) return;
    setAmounts((a) => ({ ...a, [src.docNo]: src.movableSen }));
    setTicked((t) => new Set([...t, src.docNo]));
  };
  const picks: ConvertPick[] = rows.filter((r) => ticked.has(r.docNo)).map((r) => ({ docNo: r.docNo, amountSen: amounts[r.docNo] ?? 0 }));
  const bad = rows.find((r) => ticked.has(r.docNo) && ((amounts[r.docNo] ?? 0) <= 0 || (amounts[r.docNo] ?? 0) > r.movableSen));
  const total = picks.reduce((s, p) => s + p.amountSen, 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="convert-form">
      <span>Move to a new order — tick the orders to take money from, and how much of each:</span>
      {rows.map((r) => (
        <label key={r.docNo} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="checkbox" checked={ticked.has(r.docNo)} aria-label={`Take from ${r.docNo}`}
            onChange={(e) => setTicked((s) => { const n = new Set(s); if (e.target.checked) n.add(r.docNo); else n.delete(r.docNo); return n; })} />
          <span style={{ fontFamily: 'var(--font-mono)' }}>{r.docNo}</span>
          {!r.self && r.customer && <span style={muted}>{r.customer}</span>}
          <span style={muted}>{r.keepSen > 0 ? `${fmtRm(r.movableSen)} can move (keeps ${fmtRm(r.keepSen)})` : `${fmtRm(r.remainingSen)} left`}</span>
          <MoneyInput valueSen={amounts[r.docNo] ?? 0} onCommit={(sen) => setAmounts((a) => ({ ...a, [r.docNo]: sen ?? 0 }))} aria-label={`Amount from ${r.docNo}`} />
        </label>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={primary} disabled={picks.length === 0 || Boolean(bad)}
          onClick={() => (onOpen ? onOpen(copyFrom, picks) : navigate(newOrderWithMoneyHref(copyFrom, picks)))}>
          Open a new order with {fmtRm(total)}
        </button>
        <button type="button" style={btn} onClick={onDone}>Cancel</button>
        {bad && <span style={{ color: 'var(--c-danger, #a33)' }}>{bad.docNo}: between RM 0.01 and {fmtRm(bad.movableSen)}.</span>}
        <span style={muted}>The new order opens with {copyFrom}'s customer and lines; one payment row per ticked order, dated the day the money was first paid.</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={picker.more} onChange={(e) => picker.setMore(e.target.value)} placeholder="Another order, e.g. 2990-SO-2607-024" aria-label="Another cancelled order"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addAnother(); } }}
          style={{ minWidth: 260, padding: '4px 8px', border: '1px solid var(--c-line, rgba(34,31,32,0.2))', borderRadius: 6 }} />
        <button type="button" style={btn} disabled={picker.busy} onClick={() => void addAnother()}>Add</button>
        {picker.note && <span style={{ color: 'var(--c-danger, #a33)' }}>{picker.note}</span>}
      </div>
      <span hidden data-testid="convert-param">{convertParamOf(picks)}</span>
    </div>
  );
}

/** The panel's convert: this order first, ticked, for what may move; the
    customer's other orders beneath, unticked. */
function ConvertForm({ money, others, onDone, onOpen }: { money: OrderMoney; others: ConvertSource[]; onDone: () => void; onOpen?: OpenNewOrder }) {
  const rows = useMemo<ConvertRow[]>(() => [
    { docNo: money.docNo, customer: money.customer.name, status: money.status, cancelledOn: null, remainingSen: money.remainingSen, bookedSen: money.bookedSen, movableSen: money.movableSen, keepSen: money.keepSen, self: true },
    ...others.map((o) => ({ ...o, self: false })),
  ], [money, others]);
  return <ConvertPicker rows={rows} copyFrom={money.docNo} ticked={[money.docNo]} onDone={onDone} onOpen={onOpen} />;
}

/** One refund request per order — the SO list's bar, several orders at once,
    any customers: each order its own amount and customer's bank, one reason. */
export function RefundPicker({ rows, onDone }: { rows: Array<{ docNo: string; customer: string | null; remainingSen: number }>; onDone: () => void }) {
  const [amounts, setAmounts] = useState<Record<string, number>>(() => Object.fromEntries(rows.map((r) => [r.docNo, r.remainingSen])));
  const [banks, setBanks] = useState<Record<string, RefundAskBank>>(() => Object.fromEntries(rows.map((r) => [r.docNo, EMPTY_BANK])));
  const [reason, setReason] = useState('');
  const request = useRequestRefunds();
  const notify = useNotify();
  const bankOf = (docNo: string): RefundAskBank => banks[docNo] ?? EMPTY_BANK;
  const bad = rows.find((r) => (amounts[r.docNo] ?? 0) <= 0 || (amounts[r.docNo] ?? 0) > r.remainingSen);
  const gappy = rows.find((r) => refundAskGaps({ reason, ...bankOf(r.docNo) }).length > 0);
  const submit = async () => {
    const out = await request.mutateAsync(rows.map((r) => ({ docNo: r.docNo, amountSen: amounts[r.docNo] ?? 0, reason, ...bankOf(r.docNo) })));
    const raised = out.filter((o) => o.requestNo);
    const failed = out.filter((o) => o.error);
    void notify({
      title: failed.length === 0 ? `${raised.length} refund request${raised.length === 1 ? '' : 's'} sent to Finance` : `${raised.length} sent, ${failed.length} not`,
      body: [...raised.map((o) => `${o.docNo}: ${o.requestNo}`), ...failed.map((o) => `${o.docNo}: ${o.error}`)].join('\n'),
      tone: failed.length === 0 ? undefined : 'error',
    });
    if (failed.length === 0) onDone();
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="refund-form">
      {rows.map((r) => (
        <div key={r.docNo} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{r.docNo}</span>
          {r.customer && <span style={muted}>{r.customer}</span>}
          <span style={muted}>{fmtRm(r.remainingSen)} left</span>
          <MoneyInput valueSen={amounts[r.docNo] ?? 0} onCommit={(sen) => setAmounts((a) => ({ ...a, [r.docNo]: sen ?? 0 }))} aria-label={`Refund from ${r.docNo}`} />
          <BankFields value={bankOf(r.docNo)} onChange={(v) => setBanks((b) => ({ ...b, [r.docNo]: v }))} of={r.docNo} />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason *" aria-label="Refund reason"
          style={{ ...field, flex: 1, minWidth: 200 }} />
        <button type="button" style={primary} disabled={Boolean(bad) || Boolean(gappy) || request.isPending} onClick={() => void submit()}>Send {rows.length} refund request{rows.length === 1 ? '' : 's'}</button>
        <button type="button" style={btn} onClick={onDone}>Cancel</button>
        {bad && <span style={danger}>{bad.docNo}: between RM 0.01 and {fmtRm(bad.remainingSen)}.</span>}
        {!bad && gappy && <span style={muted}>Still needed on {gappy.docNo}: {refundAskGaps({ reason, ...bankOf(gappy.docNo) }).join(', ')}.</span>}
      </div>
    </div>
  );
}

export function OrderMoneyPanel({ docNo, onOpenNewOrder }: { docNo: string; onOpenNewOrder?: OpenNewOrder }) {
  const q = useOrderMoney(docNo);
  const [mode, setMode] = useState<'idle' | 'refund' | 'convert'>('idle');
  const m = q.data?.money;
  if (q.isError || !m || m.bookedSen === 0) return null;
  const others = q.data?.others ?? [];
  const title = m.cancelled ? 'Money on this cancelled order' : 'Money on this order';
  const keeps = keepLine(m);
  /* The refund requests (owner 2026-10-14) — a withdrawn one says nothing. */
  const asked = (m.refundRequests ?? []).filter((r) => r.state !== 'WITHDRAWN');
  return (
    <div style={panel} data-testid="order-money-panel" aria-label={title}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700 }}>{title}</span>
        <span>{moneySummary(m)}</span>
        {keeps && <span style={muted}>{keeps}</span>}
      </div>
      {asked.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }} aria-label="Refund requests">
          {asked.map((r) => (
            <a key={r.id} href={`/scm/payment-requests?open=${encodeURIComponent(r.id)}`}
              style={{ color: r.state === 'RETURNED' ? 'var(--c-danger, #a33)' : 'var(--c-orange)', fontFamily: 'var(--font-mono)' }}>
              {refundRequestText(r)}
            </a>
          ))}
        </div>
      )}
      {(m.refunds.length > 0 || m.conversions.length > 0) && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', ...muted }}>
          {m.refunds.map((r) => (
            <a key={r.id} href={`/scm/payment-vouchers/${r.id}`} style={{ color: 'var(--c-orange)', fontFamily: 'var(--font-mono)' }}>
              {r.pvNumber} · {fmtRm(r.totalSen)}{r.status === 'POSTED' ? '' : ` (${r.status.toLowerCase()})`}
            </a>
          ))}
          {m.conversions.map((c) => (
            <a key={c.paymentId} href={`/scm/sales-orders/${encodeURIComponent(c.toDocNo)}`} style={{ color: 'var(--c-orange)', fontFamily: 'var(--font-mono)' }}>
              → {c.toDocNo} · {fmtRm(c.amountSen)}{c.convertedOn ? ` (${fmtDate(c.convertedOn)})` : ''}
            </a>
          ))}
        </div>
      )}
      {m.open && mode === 'idle' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" style={btn} onClick={() => setMode('refund')}>Refund</button>
          <button type="button" style={btn} disabled={m.movableSen <= 0} onClick={() => setMode('convert')}>Convert</button>
          {m.movableSen <= 0 && <span style={muted}>Nothing above the floor to move.</span>}
        </div>
      )}
      {!m.open && m.reason && <span style={muted}>{m.reason}</span>}
      {mode === 'refund' && <RefundForm docNo={docNo} remainingSen={m.remainingSen} onDone={() => setMode('idle')} />}
      {mode === 'convert' && <ConvertForm money={m} others={others} onDone={() => setMode('idle')} onOpen={onOpenNewOrder} />}
    </div>
  );
}
