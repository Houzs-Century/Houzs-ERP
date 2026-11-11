// ----------------------------------------------------------------------------
// PaymentRequestsFinance — Payment requests as Finance reads them under Money
// out (the owner's Claude Design, batch 4 step 9). One table in three tabs —
// To do · Turned into vouchers · Sent back — with today's finer lists (Paid,
// Official invoice owed, All) beside them; the request's own buttons on its
// row; the whole request in a drawer on the right, opened from its number (the
// rows open nothing on a double-click, as in the design).
//
// Every answer goes through the door it went through before. Make voucher
// opens New payment voucher prefilled from the request (?fromRequest= — a
// voucher needs a debit account the request does not carry, so it cannot be
// drafted in one click); Make AP invoice opens the AP invoice form
// (?fromRequest=); Pay on <AP invoice> opens an AP payment on that bill; Send
// back POSTs /payment-requests/:id/return with the reason it requires. Nothing
// here posts to the ledger. A requester reads their own page instead
// (PaymentRequests.tsx), unchanged.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Info, MoreHorizontal, Plus, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  STAGE, answerText, awaitsFinance, billMatchText, hasInstalments, isRefundRequest, makeVoucherHref, mayAskBalance, requestKind, stageLabelEn,
  usePaymentRequest, useReturnPaymentRequest, useWithdrawPaymentRequest,
  type PaymentRequest, type StageTagTone,
} from '../../vendor/scm/lib/payment-request-queries';
import { OFFICIAL_LABEL, isOfficialState } from '../../vendor/scm/lib/official-doc-queries';
import { BillInstalments, BillMatchesNote, billFactsLine } from '../../vendor/scm/components/RequestBill';
import { useEventLabels, type EventOption } from '../../vendor/scm/lib/event-queries';
import { eventCellText } from '../../vendor/scm/components/EventSelect';
import { Modal } from '../../vendor/scm/components/Modal';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useToastOptional } from '../../hooks/useToast';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import { ResizableDetailDrawer } from '../../components/ResizableDetailDrawer';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { fmtDateOrDash, fmtSen, todayMY } from '../../vendor/shared/format';
import { BatchBar } from './money-in/MoneyInParts';
import { EVENTS_PATH, RequestForm } from './PaymentRequestForm';
import {
  BalanceForm, OfficialDocPanel, RequestFilesCard, apBalanceOn, inFilter, mayEditRequest, mayWithdrawRequest, payOnInvoiceHref,
  type RequestListQuery,
} from './PaymentRequestParts';
import look from './PaymentRequestsFinance.module.css';

/* ── Which list ─────────────────────────────────────────────────────────── */

type View = 'todo' | 'vouchers' | 'back' | 'paid' | 'official' | 'all';

/* The design's three tabs, then today's finer lists beside them, so nothing is lost. */
const TABS: ReadonlyArray<readonly [View, string]> = [['todo', 'To do'], ['vouchers', 'Turned into vouchers'], ['back', 'Sent back']];
const MORE: ReadonlyArray<readonly [View, string]> = [['paid', 'Paid'], ['official', 'Official invoice owed'], ['all', 'All']];

/* The server lists the newest 500 (listPaymentRequestsHandler). A count over a
   list that may be cut short is not the population, so the tabs count only
   while everything came back. */
const LIST_CAP = 500;

/** ?filter= keeps today's words: the Payment vouchers strip and To do link to ?filter=waiting. */
const viewOfFilter = (f: string | null): View => {
  switch (f) {
    case 'waiting': return 'todo';
    case 'processing': return 'vouchers';
    case 'returned': return 'back';
    case 'paid':
    case 'official':
    case 'all': return f;
    default: return 'todo';
  }
};

/** The tabs are made of the requester's own lists (one home for which list a request sits in). */
const inView = (r: PaymentRequest, v: View): boolean => {
  switch (v) {
    case 'todo': return inFilter(r, 'waiting');
    case 'vouchers': return inFilter(r, 'processing') || inFilter(r, 'paid');
    case 'back': return inFilter(r, 'returned');
    default: return inFilter(r, v);
  }
};

/** The column each tab adds (the design): how long it has waited, what answered it, or why it went back. */
const extraColumnOf = (v: View): 'waiting' | 'voucher' | 'reason' => (v === 'todo' ? 'waiting' : v === 'back' ? 'reason' : 'voucher');

/* What an empty list says — what it looked for, never a verdict (the empty-state rule). */
const emptyOf = (v: View): string => {
  switch (v) {
    case 'todo': return 'No requests waiting.';
    case 'vouchers': return 'No request turned into a voucher yet.';
    case 'back': return 'Nothing sent back.';
    case 'paid': return 'No paid request in this list.';
    case 'official': return 'No request in this list is marked official invoice owed.';
    default: return 'No payment request has been raised yet.';
  }
};

/* ── What a request shows ───────────────────────────────────────────────── */

const toneClass = (t: StageTagTone): string => {
  switch (t) {
    case 'warn': return look.toneWarn;
    case 'info': return look.toneInfo;
    case 'late': return look.toneLate;
    default: return look.toneCalm;
  }
};

/** The official invoice's state in English (OFFICIAL_LABEL's first half) — owed reads late, to check warn. */
const officialTag = (r: PaymentRequest): { text: string; tone: string } | null => {
  const s = r.officialDoc?.state;
  if (!isOfficialState(s)) return null;
  return { text: OFFICIAL_LABEL[s].label.split(' · ')[0], tone: s === 'OWED' ? look.toneLate : s === 'RECEIVED' ? look.toneWarn : look.toneCalm };
};

/** Whole days, on Malaysia's calendar, since the request was raised — the design's Waiting. */
const waitingDays = (createdAt: string, today: string): number => {
  const raised = Date.parse(createdAt);
  if (!Number.isFinite(raised)) return 0;
  const raisedDay = new Date(raised + 8 * 3600_000).toISOString().slice(0, 10);
  return Math.max(0, Math.round((Date.parse(today) - Date.parse(raisedDay)) / 86_400_000));
};
const waitingText = (days: number): string => (days === 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'}`);

/** Why: what it is for — and, for a refund, the order its money comes off. */
const whyOf = (r: PaymentRequest): string => (isRefundRequest(r) ? `${r.purpose} · ${r.refund_source_doc_no ?? ''}` : r.purpose);

/** Pay to, as the design shows it: the bank and the account's last four digits. The drawer holds it whole. */
const payToShort = (r: PaymentRequest): string => {
  const digits = (r.bank_account_no ?? '').replace(/\s+/g, '');
  const parts = [r.bank_name?.trim() ?? '', digits ? `···· ${digits.slice(-4)}` : ''].filter((s) => s !== '');
  return parts.length > 0 ? parts.join(' ') : '—';
};
const bankFull = (r: PaymentRequest): string => [r.bank_name, r.bank_account_no, r.bank_account_name].filter(Boolean).join(' · ') || '—';

/** The document that answered it — an AP invoice, else a voucher (answerText's order) — and where it opens. */
const answerDoc = (r: PaymentRequest): { kind: 'invoice' | 'voucher'; no: string; path: string; paid: string | null } | null => {
  if (r.invoice) {
    return {
      kind: 'invoice', no: r.invoice.invoiceNumber ?? 'AP invoice', path: `/scm/ap-invoices?open=${encodeURIComponent(r.invoice.id)}`,
      paid: r.invoice.paidSen > 0 ? `${fmtSen(r.invoice.paidSen)} of ${fmtSen(r.invoice.totalSen)} paid` : null,
    };
  }
  return r.voucher ? { kind: 'voucher', no: r.voucher.pvNumber ?? 'Draft voucher', path: `/scm/payment-vouchers/${r.voucher.id}`, paid: null } : null;
};

/** What may be done with a request now — one answer for its row, its ⋯ menu and its drawer. */
/* Several waiting requests answered by ONE voucher (owner 2026-11-04: combine
   payment request 做一张pv — 不同人也可以): a plain payment request only — a
   refund takes its own Customer Refund, a balance on an AP invoice is paid on
   that invoice. */
export const combinable = (r: PaymentRequest): boolean => awaitsFinance(r) && !isRefundRequest(r) && !apBalanceOn(r);
/** The tabs that tick: To do, and All (owner 2026-11-04) — a row that cannot combine shows its box disabled. */
export const TICK_VIEWS: ReadonlySet<View> = new Set<View>(['todo', 'all']);
export const oneVoucherHref = (ids: string[]): string => `/scm/payment-vouchers/new?fromRequests=${ids.map(encodeURIComponent).join(',')}`;

const movesOf = (r: PaymentRequest, me: number) => ({
  /* Finance answers what waits: a voucher, or back with a reason. */
  answer: awaitsFinance(r),
  /* Book the supplier's bill first (owner 2026-09-30, 6.1) — never for a refund. */
  apInvoice: awaitsFinance(r) && !isRefundRequest(r),
  /* A balance of a bill booked as an AP invoice is paid ON that invoice (item 2). */
  payOn: awaitsFinance(r) && apBalanceOn(r),
  /* 申请付余额 (item 2): the next instalment of the same bill. */
  balance: !isRefundRequest(r) && mayAskBalance(r),
  /* Finance's own request, while it is theirs to change. */
  edit: mayEditRequest(r, me),
  withdraw: mayWithdrawRequest(r, me),
});

/* The words and doors To do's request drawer shares (finance/RequestsDrawer.tsx). */
export const makeVoucherLabel = (r: PaymentRequest): string => (isRefundRequest(r) ? 'Make refund voucher' : 'Make voucher');
const makeVoucherTitle = (r: PaymentRequest): string => (isRefundRequest(r)
  ? `Approve — a Customer Refund on ${r.refund_source_doc_no ?? 'its order'}, the customer's bank in its notes`
  : 'Pay now — a payment voucher, the bill attached');
/* A refund Finance does not pay is rejected (owner 2026-10-14: 我可能还会拒绝). */
export const sendBackLabel = (r: PaymentRequest): string => (isRefundRequest(r) ? 'Reject' : 'Send back');
const payOnLabel = (r: PaymentRequest): string => `Pay on ${r.familyInvoice?.invoiceNumber ?? 'the AP invoice'}`;
export const AP_INVOICE_TITLE = "Book the supplier's bill first — an AP invoice, paid later by an AP Payment";
export const apInvoiceFromRequestHref = (r: PaymentRequest): string => `/scm/ap-invoices?fromRequest=${encodeURIComponent(r.id)}`;

/** Every way out of the page a request offers — the row, the ⋯ menu and the drawer press the same ones. */
type Doors = {
  makeVoucher: (r: PaymentRequest) => void;
  makeApInvoice: (r: PaymentRequest) => void;
  payOn: (r: PaymentRequest) => void;
  open: (path: string) => void;
  askBalance: (r: PaymentRequest) => void;
  edit: (r: PaymentRequest) => void;
  withdraw: (r: PaymentRequest) => void;
  sendBack: (r: PaymentRequest, note: string) => Promise<boolean>;
};

type MenuItem = { label: string; onClick: () => void; danger?: boolean; divider?: boolean };
const RULE: MenuItem = { label: '', onClick: () => undefined, divider: true };

function StageTags({ r }: { r: PaymentRequest }) {
  const official = officialTag(r);
  return (
    <span className={look.tags}>
      <span className={`${look.tag} ${toneClass(STAGE[r.stage].tag)}`}>{stageLabelEn(r)}</span>
      {official && <span className={`${look.tag} ${official.tone}`} title={r.officialDoc?.note ?? undefined}>{official.text}</span>}
    </span>
  );
}

/** A document number that opens in its own workspace tab — and still a link to copy or open elsewhere. */
function DocAnchor({ path, label, open }: { path: string; label: string; open: (path: string) => void }) {
  return (
    <a href={path} className={look.docLink} onClick={(e) => { e.preventDefault(); open(path); }}>{label}</a>
  );
}

/* ── The page ───────────────────────────────────────────────────────────── */

export function PaymentRequestsFinance({ listQ, mineOnly, onMineOnly }: { listQ: RequestListQuery; mineOnly: boolean; onMineOnly: (on: boolean) => void }) {
  const { user } = useHouzsAuth();
  const me = Number(user?.id);
  const navigate = useNavigate();
  const openInTab = useOpenDocInTab();
  const askConfirm = useConfirm();
  const toast = useToastOptional();
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<View>(() => viewOfFilter(searchParams.get('filter')));
  /* ?open=<id> opens one request in the drawer — a PMS row, an order's money
     panel and a voucher raised from the request all link back here. */
  const [openId, setOpenId] = useState<string | null>(() => searchParams.get('open'));
  /* Send back from a row: the reason box above the table (the design). */
  const [backOf, setBackOf] = useState<PaymentRequest | null>(null);
  const [form, setForm] = useState<{ mode: 'new' } | { mode: 'edit'; req: PaymentRequest } | null>(null);
  /* 申请付余额 (item 2): the request the next instalment is asked from. */
  const [balanceOf, setBalanceOf] = useState<PaymentRequest | null>(null);
  const [menu, setMenu] = useState<{ row: PaymentRequest; x: number; y: number } | null>(null);
  const withdraw = useWithdrawPaymentRequest();
  const sendBack = useReturnPaymentRequest();

  const rows = useMemo(() => listQ.data?.requests ?? [], [listQ.data]);
  const whole = listQ.data != null && rows.length < LIST_CAP;
  const visible = useMemo(() => rows.filter((r) => inView(r, view)), [rows, view]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  useEffect(() => { setTicked(new Set()); }, [view]);
  const tickedRows = visible.filter((r) => ticked.has(r.id) && combinable(r));
  const tickedPayees = new Set(tickedRows.map((r) => r.payee_name.trim().toUpperCase()));
  const labelsQ = useEventLabels(rows.map((r) => r.project_id), EVENTS_PATH);
  const today = todayMY();
  const mayRaise = listQ.data?.mayRaise ?? true;

  const onWithdraw = async (r: PaymentRequest) => {
    const ok = await askConfirm({ title: `Withdraw ${r.request_no}?`, body: 'Finance will not pay it. You can raise a new request later.', confirmLabel: 'Withdraw', danger: true });
    if (ok) withdraw.mutate(r.id); // a refusal reaches the user through the mutation's own onError
  };
  /* The reason is required; the requester reads it on the request (and a
     refund's on its order). */
  const onSendBack = async (r: PaymentRequest, note: string): Promise<boolean> => {
    try {
      await sendBack.mutateAsync({ id: r.id, note });
    } catch {
      return false; // the mutation's own onError told the user
    }
    const who = r.requested_by_name ?? 'the requester';
    toast?.success(isRefundRequest(r) ? `Rejected · ${who} sees why` : `Sent back to ${who} · they see your reason`);
    return true;
  };
  const doors: Doors = {
    makeVoucher: (r) => navigate(makeVoucherHref(r)),
    makeApInvoice: (r) => navigate(apInvoiceFromRequestHref(r)),
    payOn: (r) => navigate(payOnInvoiceHref(r)),
    open: openInTab,
    askBalance: setBalanceOf,
    edit: (r) => setForm({ mode: 'edit', req: r }),
    withdraw: (r) => { void onWithdraw(r); },
    sendBack: onSendBack,
  };

  /* ⋯ and right-click: one menu — every move the request has. */
  const menuOf = (r: PaymentRequest): MenuItem[] => {
    const m = movesOf(r, me);
    const doc = answerDoc(r);
    const items: MenuItem[] = [{ label: 'Open', onClick: () => setOpenId(r.id) }];
    if (m.answer) items.push({ label: makeVoucherLabel(r), onClick: () => doors.makeVoucher(r) });
    if (m.apInvoice) items.push({ label: 'Make AP invoice', onClick: () => doors.makeApInvoice(r) });
    if (m.payOn) items.push({ label: payOnLabel(r), onClick: () => doors.payOn(r) });
    if (doc) items.push({ label: `Open ${doc.no}`, onClick: () => doors.open(doc.path) });
    if (m.balance) items.push({ label: 'Request the balance', onClick: () => doors.askBalance(r) });
    if (m.edit) items.push({ label: r.status === 'REJECTED' ? 'Fix and send again' : 'Edit', onClick: () => doors.edit(r) });
    const closing: MenuItem[] = [];
    if (m.answer) closing.push({ label: `${sendBackLabel(r)}…`, onClick: () => setBackOf(r) });
    if (m.withdraw) closing.push({ label: 'Withdraw…', danger: true, onClick: () => doors.withdraw(r) });
    return closing.length > 0 ? [...items, RULE, ...closing] : items;
  };

  const columns = useMemo<Column<PaymentRequest>[]>(() => {
    const extra = extraColumnOf(view);
    const perTab: Column<PaymentRequest> = extra === 'waiting'
      ? {
        key: 'waiting', label: 'Waiting', width: '100px',
        render: (r) => {
          if (!awaitsFinance(r)) return <span className={look.muted}>—</span>;
          const days = waitingDays(r.created_at, today);
          return <span className={`${look.tag} ${days >= 3 ? look.toneWarn : look.toneCalm}`}>{waitingText(days)}</span>;
        },
        getValue: (r) => (awaitsFinance(r) ? waitingDays(r.created_at, today) : null),
        filterLabel: (v) => waitingText(Number(v)),
        exportValue: (r) => (awaitsFinance(r) ? waitingText(waitingDays(r.created_at, today)) : ''),
      }
      : extra === 'voucher'
        ? {
          key: 'voucher', label: 'Voucher', width: '230px',
          render: (r) => {
            const doc = answerDoc(r);
            if (!doc) return <span className={look.muted}>—</span>;
            return (
              <span className={look.tags}>
                <span className={`${look.tag} ${look.toneInfo}`}>{doc.no}</span>
                {doc.paid && <span className={look.aside}>{doc.paid}</span>}
              </span>
            );
          },
          getValue: (r) => answerText(r) ?? '',
        }
        : {
          key: 'reason', label: 'Reason', width: '260px',
          render: (r) => <span className={look.muted}>{r.finance_note || '—'}</span>,
          getValue: (r) => r.finance_note ?? '',
        };
    return [
      {
        key: 'no', label: 'Request', width: '200px',
        render: (r) => (
          <span className={look.tags}>
            <button type="button" className={look.docLink} onClick={(e) => { e.stopPropagation(); setOpenId(r.id); }}>{r.request_no}</button>
            {/* An instalment of a bill (item 2): which one. */}
            {(r.installment_no ?? 1) > 1 && <span className={look.aside}>#{r.installment_no} · balance</span>}
            {/* 同一张单: the same bill number and date on another live document. */}
            {(r.billMatches?.length ?? 0) > 0 && (
              <span className={`${look.tag} ${look.toneLate}`} aria-label="Same bill elsewhere"
                title={`Same bill: ${(r.billMatches ?? []).map(billMatchText).join(' | ')}`}>Same bill</span>
            )}
          </span>
        ),
        getValue: (r) => r.request_no,
      },
      {
        key: 'kind', label: 'Kind', width: '130px',
        render: (r) => <span className={`${look.tag} ${look.toneWarn}`}>{requestKind(r)}</span>,
        getValue: (r) => requestKind(r),
      },
      { key: 'payee', label: 'For', width: '200px', render: (r) => r.payee_name, getValue: (r) => r.payee_name },
      { key: 'purpose', label: 'Why', width: '240px', render: (r) => <span className={look.muted}>{whyOf(r)}</span>, getValue: (r) => whyOf(r) },
      {
        key: 'amount', label: 'Amount', align: 'right', width: '120px',
        render: (r) => <span className={look.money}>{fmtSen(r.amount_sen)}</span>,
        getValue: (r) => r.amount_sen, exportValue: (r) => r.amount_sen / 100, exportFormat: 'money',
        total: (list) => <span className={look.money}>{fmtSen(list.reduce((s, r) => s + r.amount_sen, 0))}</span>,
      },
      { key: 'bank', label: 'Pay to', width: '170px', render: (r) => <span className={look.muted}>{payToShort(r)}</span>, getValue: (r) => payToShort(r) },
      { key: 'by', label: 'Requested by', width: '140px', render: (r) => <span className={look.muted}>{r.requested_by_name ?? '—'}</span>, getValue: (r) => r.requested_by_name ?? '' },
      perTab,
      { key: 'stage', label: 'Stage', width: '210px', render: (r) => <StageTags r={r} />, getValue: (r) => stageLabelEn(r) },
      /* Today's columns the design leaves out — in the column chooser. */
      {
        key: 'event', label: 'Event', width: '240px', defaultHidden: true,
        render: (r) => <span className={r.project_id == null ? look.muted : undefined}>{eventCellText(labelsQ.data, r.project_id)}</span>,
        getValue: (r) => eventCellText(labelsQ.data, r.project_id),
      },
      { key: 'due', label: 'Pay by', defaultHidden: true, render: (r) => fmtDateOrDash(r.due_date), getValue: (r) => r.due_date, exportFormat: 'date' },
      { key: 'date', label: 'Date', defaultHidden: true, render: (r) => fmtDateOrDash(r.created_at), getValue: (r) => r.created_at, exportFormat: 'date' },
      {
        /* The request's own buttons (the design): what waits — Send back, Make
           voucher; what was answered — its voucher. ⋯ last. */
        key: 'actions', label: '', width: '260px', align: 'right', disableSort: true, disableFilter: true,
        render: (r) => {
          const m = movesOf(r, me);
          const doc = m.answer ? null : answerDoc(r);
          return (
            <span className={look.acts}>
              {m.answer && (
                <button type="button" className={look.actLink} onClick={(e) => { e.stopPropagation(); setBackOf(r); }}>{sendBackLabel(r)}</button>
              )}
              {m.answer && (
                <button type="button" className={look.act} title={makeVoucherTitle(r)}
                  onClick={(e) => { e.stopPropagation(); navigate(makeVoucherHref(r)); }}>{`${makeVoucherLabel(r)} ›`}</button>
              )}
              {doc && (
                <button type="button" className={look.actSecondary} title={doc.no}
                  onClick={(e) => { e.stopPropagation(); openInTab(doc.path); }}>{doc.kind === 'invoice' ? 'Open AP invoice ›' : 'Open voucher ›'}</button>
              )}
              <button type="button" className={look.more} aria-label={`More for ${r.request_no}`} title="Open, make a voucher or an AP invoice, send back"
                onClick={(e) => { e.stopPropagation(); setMenu({ row: r, x: e.clientX, y: e.clientY }); }}>
                <MoreHorizontal size={14} />
              </button>
            </span>
          );
        },
      },
    ];
  }, [view, today, me, labelsQ.data, navigate, openInTab]);

  const tab = (v: View, label: string) => {
    const n = whole ? rows.filter((r) => inView(r, v)).length : null;
    return (
      <button key={v} type="button" role="tab" aria-selected={view === v} className={`${look.tab} ${view === v ? look.tabOn : ''}`}
        onClick={() => { setView(v); setBackOf(null); }}>
        {label}
        {n != null && <span className={`${look.tabCount} ${v === 'todo' && n > 0 ? look.countInfo : n > 0 ? look.countSome : ''}`}>{n}</span>}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance · Money out"
        title="Payment requests"
        actions={mayRaise ? (
          <Button variant="primary" size="sm" onClick={() => setForm({ mode: 'new' })}>
            <Plus size={16} strokeWidth={1.75} /> New request
          </Button>
        ) : undefined}
      />

      <div className={look.top}>
        <div className={look.bar}>
          <div className={look.tabs} role="tablist" aria-label="Payment requests">
            {TABS.map(([v, label]) => tab(v, label))}
            <span className={look.tabSep} aria-hidden />
            {MORE.map(([v, label]) => tab(v, label))}
          </div>
          <span className={look.grow} />
          <label className={look.mine}>
            <input type="checkbox" checked={mineOnly} onChange={(e) => onMineOnly(e.target.checked)} aria-label="Only my requests" />
            Only my requests
          </label>
        </div>
        {listQ.data != null && !whole && (
          <div className={look.hint}>The newest {LIST_CAP} requests are listed; the tabs count once the list holds them all.</div>
        )}
        {backOf && (
          <SendBackBox key={backOf.id} request={backOf} busy={sendBack.isPending} onCancel={() => setBackOf(null)}
            onSend={(note) => { void onSendBack(backOf, note).then((ok) => { if (ok) setBackOf(null); }); }} />
        )}
      </div>

      <DataTable<PaymentRequest>
        tableId="payment-requests"
        exportName="payment-requests"
        columns={columns}
        rows={listQ.data ? visible : null}
        loading={listQ.isLoading}
        error={listQ.isError ? `The requests could not be loaded — ${listQ.error instanceof Error ? listQ.error.message : 'something went wrong.'}` : null}
        emptyLabel={emptyOf(view)}
        getRowKey={(r) => r.id}
        getRowStyle={(r) => {
          /* A withdrawn request fades; the one open in the drawer is marked. */
          const style = { ...(r.stage === 'WITHDRAWN' ? { opacity: 0.55 } : {}), ...(r.id === openId ? { background: 'var(--hz-dk-surface-2, #f3f8f7)' } : {}) };
          return Object.keys(style).length > 0 ? style : undefined;
        }}
        contextMenu={(r) => menuOf(r)}
        selection={TICK_VIEWS.has(view) ? {
          selectedIds: ticked,
          onToggle: (k) => setTicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
          onToggleAll: (keys, all) => setTicked((p) => { const n = new Set(p); for (const k of keys) { if (all) n.delete(k); else n.add(k); } return n; }),
          isDisabled: (k) => { const r = visible.find((x) => x.id === k); return !r || !combinable(r); },
          rowLabel: (r) => `Tick ${r.request_no}`,
        } : undefined}
      />

      {TICK_VIEWS.has(view) && tickedRows.length > 0 && (
        <BatchBar count={tickedRows.length} sum={fmtSen(tickedRows.reduce((s, r) => s + r.amount_sen, 0))} hidden={0}
          notes={tickedPayees.size > 1 ? ['Different payees — the voucher leaves the payee for you to type; each one\'s bank is in its notes.'] : []}
          onClear={() => setTicked(new Set())}>
          <button type="button" className={look.act} disabled={tickedRows.length < 2}
            title={tickedRows.length < 2 ? 'Tick two or more — one request uses its own Make voucher' : undefined}
            onClick={() => navigate(oneVoucherHref(tickedRows.map((r) => r.id)))}>
            {`Make ONE voucher · ${tickedRows.length} ›`}
          </button>
        </BatchBar>
      )}

      {menu && (
        <>
          <div className={look.menuCatcher} onClick={() => setMenu(null)} aria-hidden />
          <div className={look.menu} role="menu" aria-label={`${menu.row.request_no} menu`}
            style={{ top: Math.min(menu.y + 6, window.innerHeight - 320), left: Math.max(8, menu.x - 200) }}>
            {menuOf(menu.row).map((m, i) => (m.divider
              ? <div key={`rule-${i}`} className={look.menuRule} />
              : (
                <button key={m.label} type="button" role="menuitem" className={`${look.menuItem} ${m.danger ? look.menuDanger : ''}`}
                  onClick={() => { setMenu(null); m.onClick(); }}>{m.label}</button>
              )))}
          </div>
        </>
      )}

      {openId && (
        <RequestDrawer key={openId} id={openId} me={me} labels={labelsQ.data} doors={doors} sending={sendBack.isPending} onClose={() => setOpenId(null)} />
      )}

      {balanceOf && (
        <Modal title={`Request the balance — ${balanceOf.family?.rootNo ?? balanceOf.request_no}`} onClose={() => setBalanceOf(null)} width="min(640px, 100%)"
          ariaLabel="Request the balance">
          <BalanceForm request={balanceOf} onDone={(id) => { setBalanceOf(null); setOpenId(id); }} onCancel={() => setBalanceOf(null)} />
        </Modal>
      )}

      {form && (
        <Modal title={form.mode === 'new' ? 'New payment request' : `Edit ${form.req.request_no}`} onClose={() => setForm(null)} width="min(760px, 100%)"
          ariaLabel={form.mode === 'new' ? 'New payment request' : `Edit ${form.req.request_no}`}>
          <RequestForm
            initial={form.mode === 'edit' ? form.req : null}
            hasEvents={listQ.data?.hasEvents ?? true}
            onDone={(id) => { setForm(null); setOpenId(id); }}
            onCancel={() => setForm(null)}
          />
        </Modal>
      )}
    </div>
  );
}

/* ── Send back — the reason is required (the design's box) ───────────────── */
function SendBackBox({ request: r, busy, onCancel, onSend }: { request: PaymentRequest; busy: boolean; onCancel: () => void; onSend: (note: string) => void }) {
  const [note, setNote] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const refund = isRefundRequest(r);
  const requester = r.requested_by_name ?? 'the requester';
  const ready = note.trim() !== '' && !busy;
  const send = () => { if (ready) onSend(note.trim()); };
  return (
    <div className={look.back} role="group" aria-label={refund ? 'Reject the refund request' : 'Send the request back'}>
      <div className={look.backTitle}>{refund ? `Reject ${r.payee_name}’s refund request` : `Send ${r.payee_name}’s request back to ${requester}`}</div>
      <div className={look.backSub}>
        {refund
          ? `The money stays on ${r.refund_source_doc_no ?? 'its order'}; ${requester} reads your reason there and here.`
          : `${r.requested_by_name ?? 'The requester'} reads your reason, fixes the request and sends it again.`}
      </div>
      <div className={look.backRow}>
        <input data-upper ref={input} className={look.backInput} value={note} onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          aria-label={refund ? 'Why it is rejected' : 'Why it goes back'}
          placeholder={refund ? 'Why? e.g. the customer agreed to convert to a new order instead' : 'Why? e.g. attach the organiser invoice, not the quotation'} />
        <button type="button" className={look.backCancel} onClick={onCancel}>Cancel</button>
        <button type="button" className={look.backGo} disabled={!ready} onClick={send}>{refund ? 'Reject' : 'Send back'}</button>
      </div>
    </div>
  );
}

/* ── The request, whole, in a drawer on the right ────────────────────────── */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className={look.factKey}>{label}</dt>
      <dd className={look.factValue}>{children}</dd>
    </>
  );
}

function RequestDrawer({ id, me, labels, doors, sending, onClose }: {
  id: string;
  me: number;
  labels: Map<number, EventOption> | undefined;
  doors: Doors;
  sending: boolean;
  onClose: () => void;
}) {
  const q = usePaymentRequest(id);
  const r = q.data?.request ?? null;
  const [backOpen, setBackOpen] = useState(false);
  const m = r ? movesOf(r, me) : null;
  const refund = r ? isRefundRequest(r) : false;
  const doc = r ? answerDoc(r) : null;
  const hasButtons = !!m && (m.answer || m.balance || m.edit || m.withdraw);

  return (
    <ResizableDetailDrawer open onClose={onClose} ariaLabel={r ? `Payment request ${r.request_no}` : 'Payment request'}>
      <div className={look.drawer}>
        <div className={look.head}>
          <div>
            <div className={look.headTitle}>{r ? r.request_no : 'Payment request'}</div>
            {r && <div className={look.headSub}>Raised by {r.requested_by_name ?? '—'} on {fmtDateOrDash(r.created_at)}</div>}
          </div>
          <button type="button" className={look.close} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        {!r || !m ? (
          <div className={look.state}>
            {q.isError
              ? `The request could not be loaded — ${q.error instanceof Error ? q.error.message : 'something went wrong.'}`
              : q.isLoading ? 'Loading the request…' : 'This request could not be found.'}
          </div>
        ) : (
          <>
            <div className={look.body}>
              <div className={look.summary}>
                <div className={look.summaryTop}>
                  <span className={`${look.tag} ${look.toneWarn}`}>{requestKind(r)}</span>
                  <StageTags r={r} />
                  <span className={look.amount}>{fmtSen(r.amount_sen)}</span>
                </div>
                <div className={look.payee}>{r.payee_name}</div>
                <div className={look.why}>{r.purpose}</div>
              </div>

              {r.stage === 'RETURNED' && r.finance_note && (
                <div className={look.returned}>
                  {refund ? 'Rejected' : 'Returned'} by {r.decided_by ?? 'Finance'}{r.decided_at ? ` on ${fmtDateOrDash(r.decided_at)}` : ''}: {r.finance_note}
                </div>
              )}

              <dl className={look.facts}>
                {refund && (
                  <Fact label="Refund on">
                    <DocAnchor path={`/scm/sales-orders/${encodeURIComponent(r.refund_source_doc_no ?? '')}`} label={r.refund_source_doc_no ?? '—'} open={doors.open} />
                  </Fact>
                )}
                {!refund && <Fact label="Pay by">{fmtDateOrDash(r.due_date)}</Fact>}
                {!refund && <Fact label="Event">{eventCellText(labels, r.project_id)}</Fact>}
                {r.note && <Fact label="Note">{r.note}</Fact>}
                {!refund && (
                  <Fact label="The bill">
                    {r.bill_no || r.bill_date || r.bill_total_sen != null
                      ? billFactsLine({ billNo: r.bill_no, billDate: r.bill_date, totalSen: r.bill_total_sen })
                      : 'Not read'}
                  </Fact>
                )}
                {r.project_id == null && r.no_event_reason && <Fact label="No event — why">{r.no_event_reason}</Fact>}
                <Fact label={refund ? "Customer's bank" : "Payee's bank"}>{bankFull(r)}</Fact>
                <Fact label="Answered by">
                  {doc ? (
                    <>
                      <DocAnchor path={doc.path} label={doc.no} open={doors.open} />
                      {doc.paid && <span className={look.aside}> · {doc.paid}</span>}
                      {r.invoice && r.invoice.paidBy.length > 0 && <span className={look.aside}> · by {r.invoice.paidBy.join(', ')}</span>}
                      {!r.invoice && r.voucher?.postedAt && <span className={look.aside}> · paid {fmtDateOrDash(r.voucher.approvedAt ?? r.voucher.postedAt)}</span>}
                      {(r.invoice ? r.invoice.bankConfirmed : r.voucher?.bankConfirmed) && <span className={look.aside}> · bank ✓</span>}
                    </>
                  ) : '—'}
                </Fact>
              </dl>

              {hasInstalments(r.family) && <BillInstalments family={r.family} currentId={r.id} />}
              {/* 欠正式单 (item 3): Finance marks and checks the official invoice; a refund owes none. */}
              {!refund && (r.officialDoc || r.voucher || r.invoice) && <OfficialDocPanel request={r} finance mayUpload />}
              <BillMatchesNote matches={r.billMatches} />
              {r.parent_request_id && (
                <div className={look.hint}>The bill is on {r.family?.rootNo ?? 'the first request'} — it travels with the payment; nothing to upload again.</div>
              )}
              <RequestFilesCard request={r} canWrite />
            </div>

            {(backOpen || hasButtons) && (
              <div className={look.foot}>
                {backOpen ? (
                  <SendBackBox request={r} busy={sending} onCancel={() => setBackOpen(false)}
                    onSend={(note) => { void doors.sendBack(r, note).then((ok) => { if (ok) setBackOpen(false); }); }} />
                ) : (
                  <>
                    {m.answer && (
                      <div className={look.note}>
                        <Info size={15} />
                        <span>A voucher made from this request starts as a draft. It is checked, then approved, before any money moves.</span>
                      </div>
                    )}
                    <div className={look.footButtons}>
                      {m.withdraw && <button type="button" className={look.btnSecondary} onClick={() => doors.withdraw(r)}>Withdraw</button>}
                      {m.edit && <button type="button" className={look.btnSecondary} onClick={() => doors.edit(r)}>{r.status === 'REJECTED' ? 'Fix and send again' : 'Edit'}</button>}
                      {m.balance && <button type="button" className={look.btnSecondary} onClick={() => doors.askBalance(r)}>Request the balance</button>}
                      {m.answer && <button type="button" className={look.btnSecondary} onClick={() => setBackOpen(true)}>{sendBackLabel(r)}</button>}
                      {m.payOn && (
                        <button type="button" className={look.btnSecondary} title="Pay this instalment on the bill's AP invoice" onClick={() => doors.payOn(r)}>{payOnLabel(r)}</button>
                      )}
                      {m.apInvoice && <button type="button" className={look.btnSecondary} title={AP_INVOICE_TITLE} onClick={() => doors.makeApInvoice(r)}>Make AP invoice</button>}
                      {m.answer && (
                        <button type="button" className={look.btnPrimary} title={makeVoucherTitle(r)} onClick={() => doors.makeVoucher(r)}>{`${makeVoucherLabel(r)} ›`}</button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </ResizableDetailDrawer>
  );
}
