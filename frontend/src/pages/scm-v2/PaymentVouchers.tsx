// ----------------------------------------------------------------------------
// PaymentVouchers — list of standalone Payment Vouchers (PV), cloned from the
// Purchase Invoices list UX (DataGrid, status chips, double-click → detail,
// right-click context menu).
//
// A Payment Voucher is a "very plain" cash-out document: pay a vendor that is
// NOT a goods invoice (freight forwarder, one-off service). Created at
// /scm/payment-vouchers/new, posted to the GL from the detail page.
//
// The redesign (owner's Claude Design, batch 4): Money out opens here. Stage
// chips and the month, a line saying what the stage means, stage tags, the
// next step on every row (Prepare / Check / Approve & post, Print once done;
// Remind approver on a checked one for whoever cannot approve), ⋯ and
// right-click with the same menu, printing in place, and the batch bar in the
// design's words. Every voucher still walks through its own door: the same
// hooks, the same permissions, the same confirmations.
//
// HOUZS VENDOR — port of 2990's apps/backend/src/pages/PaymentVouchers.tsx.
// Import boundary only: react-router → react-router-dom; flow-queries PV hooks →
// vendored payment-voucher-queries; components/lib → ../../vendor/scm/*; nav
// repointed to the parallel /scm/* routes.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Camera, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { usePaymentVouchers, useCancelPaymentVoucher, useSubmitPaymentVoucher, useCheckPaymentVoucher, useApprovePaymentVoucher, useRemindApprover, fetchPvPrintDetail, fetchPvPrintBundle, type PaymentVoucherRow } from '../../vendor/scm/lib/payment-voucher-queries';
import { useAccounts } from '../../vendor/scm/lib/accounting-queries';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { deliverPdfBlob, type PdfAction } from '../../vendor/scm/lib/pdf-common';
import { DataGridCompat, type GridColumn, type GridContextMenuItem } from '../../components/DataGridCompat';
import type { TablePdfView } from '../../components/dataTableLineExport';
import { pvListTotal, pvListTotalNote, ringgitSenOfPv } from '../../vendor/scm/lib/pv-list-total';
import { cancelledDocNoClass, cancelledRowClass } from '../../lib/scm';
import { statusLabel } from '../../vendor/scm/lib/status-pill';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useToastOptional } from '../../hooks/useToast';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { fmtDateOrDash, fmtMoneySen, fmtTime, todayMY } from '@2990s/shared';
import { PageHeader } from '../../components/Layout';
import { BackToPile } from '../../vendor/scm/components/BackToPile';
import { FilterPills } from '../../components/FilterPills';
import { PaymentRequestsWaiting } from './PaymentRequestsWaiting';
import { AccountCell } from './JournalEntryCards';
import styles from './Suppliers.module.css';
import mo from './MoneyOut.module.css';
import pvx from './PaymentVouchers.module.css';
import { PDF_COMPRESS } from '../../vendor/scm/lib/pdf-options';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* The owner's four layers as chips (2026-09-02). The enum underneath stays
   DRAFT/POSTED/CANCELLED — Prepared and Checked are DRAFTs wearing marks, so
   the chip filter reads the marks, not just the status. */
const STATUS_CHIPS = ['all', 'DRAFT', 'PREPARED', 'CHECKED', 'POSTED', 'ADVANCE', 'CANCELLED'] as const;

/* An advance not yet knocked off (owner 2026-09-06: 如果这个 prepay 还没有
   knock off 单,在 listing 要特别显示 — AutoCount paints such rows blue). The
   row goes blue AND wears a tag, and its For line says how much is open:
   colour alone says neither how much nor, to a colour-blind clerk, anything. */
const advanceOpenSen = (r: PaymentVoucherRow): number => Number(r.advance_remaining_sen ?? 0);
const ADVANCE_BLUE = 'var(--c-blue, #1d4ed8)';

const chipMatches = (chip: string, r: PaymentVoucherRow): boolean => {
  switch (chip) {
    case 'DRAFT':    return r.status === 'DRAFT' && r.submitted_at == null;
    case 'PREPARED': return r.status === 'DRAFT' && r.submitted_at != null && r.checked_at == null;
    case 'CHECKED':  return r.status === 'DRAFT' && r.checked_at != null;
    case 'ADVANCE':  return advanceOpenSen(r) > 0;
    default:         return r.status === chip;
  }
};

const CHIP_LABELS: Record<string, string> = {
  all: 'All', DRAFT: 'Draft', PREPARED: 'Prepared', CHECKED: 'Checked',
  POSTED: 'Approved', ADVANCE: 'Advance open', CANCELLED: 'Cancelled',
};
/* What the stage means, said under the chips (the design's own words). */
const CHIP_HINTS: Record<string, string> = {
  all: 'Every voucher in any stage. Tick vouchers to prepare, check, approve or print them together.',
  DRAFT: 'Still being written, so everything can change. Prepare hands it on for the check.',
  PREPARED: 'Prepared and still editable. Checking locks it, gives it its formal number and reserves the money in Money today.',
  CHECKED: 'Locked and reserved; only its words can still change. Approving posts the journal in the same step. Reject is on the voucher page.',
  POSTED: 'Posted to the ledger. Cancel is on the voucher page: it reverses the journal and deletes nothing.',
  ADVANCE: 'Advances paid to a supplier that no bill has used yet. Applying one to a bill posts nothing new.',
  CANCELLED: 'Cancelled vouchers keep their number. Their journal was reversed by a contra entry.',
};

const fmtMoney = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

const PV_LIST_STORAGE_KEY = 'pv-list.layout.v1';
/* The server returns the newest 500 (listPaymentVouchersHandler). A count over
   a list that may be cut short is not the population, so counts show only
   while everything came back (FilterPills' own rule). */
const LIST_CAP = 500;

/** The Remark: what Finance typed beside the voucher (stored as notes). */
const notesOf = (r: PaymentVoucherRow): string => (r.notes ?? '').trim();
/** The Description: what is paid for, as the bills say it (the server's words, never the bill number). */
const descriptionOf = (r: PaymentVoucherRow): string => (r.description_text ?? '').trim();
/** The For line: what it pays for, and how much of an advance is still open. */
const forOf = (r: PaymentVoucherRow): string => {
  const open = advanceOpenSen(r);
  return [descriptionOf(r), open > 0 ? `${fmtMoney(open, r.currency)} not knocked off` : ''].filter(Boolean).join(' · ');
};

/* Batch eligibility — the same questions the detail page's buttons ask, so
   the tick can never offer what the door would refuse. Approvable includes
   the approved-but-still-DRAFT row: that is a post that died halfway, and
   re-approve resumes it (§0b). */
const isPreparable = (r: PaymentVoucherRow): boolean =>
  r.status === 'DRAFT' && r.submitted_at == null;
const isCheckable = (r: PaymentVoucherRow): boolean =>
  r.status === 'DRAFT' && r.submitted_at != null && r.checked_at == null;
const isApprovable = (r: PaymentVoucherRow): boolean =>
  r.status === 'DRAFT' && r.checked_at != null;

/* The stage a row stands at, off the same three questions. */
type Stage = 'DRAFT' | 'PREPARED' | 'CHECKED' | 'DONE';
const stageOf = (r: PaymentVoucherRow): Stage =>
  isPreparable(r) ? 'DRAFT' : isCheckable(r) ? 'PREPARED' : isApprovable(r) ? 'CHECKED' : 'DONE';
/* The tag's words and tone (the design: Draft calm · Prepared warn · Checked
   info · Approved calm · Cancelled late). */
const stageTag = (r: PaymentVoucherRow): { text: string; tone: string } => {
  switch (stageOf(r)) {
    case 'DRAFT': return { text: 'Draft', tone: mo.toneCalm };
    case 'PREPARED': return { text: 'Prepared', tone: mo.toneWarn };
    case 'CHECKED': return { text: 'Checked', tone: mo.toneInfo };
    default: return r.status === 'CANCELLED'
      ? { text: 'Cancelled', tone: mo.toneLate }
      : { text: statusLabel('pv', r.status), tone: mo.toneCalm };
  }
};

/* The searchable/groupable text mirrors what the cell SHOWS — a grouped list
   splits the layers the same way the eye does. */
function queueLabel(r: PaymentVoucherRow): string {
  return `${stageTag(r).text}${advanceOpenSen(r) > 0 ? ' · Advance open' : ''}`;
}

/* MYR-equivalent for the approve dialog and the Total — the same conversion Daily
   Bank and posting use: round(total_sen × exchange_rate) (lib/pv-list-total.ts). */
const myrSen = ringgitSenOfPv;

/** The last three months, newest first: the month chips (the design). */
const lastMonths = (today: string, n: number): string[] => {
  const out: string[] = [];
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  for (let i = 0; i < n; i += 1) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
};
const monthName = (ym: string): string =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const copyPath = (r: PaymentVoucherRow): string =>
  `/scm/payment-vouchers/new?copyFrom=${r.id}${r.purpose === 'SUPPLIER_PAYMENT' ? '&type=ap' : r.purpose === 'CUSTOMER_REFUND' ? '&type=refund' : ''}`;

export const PaymentVouchers = () => {
  const navigate = useNavigate();
  const openInTab = useOpenDocInTab();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const toast = useToastOptional();
  const { can } = useHouzsAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';
  const monthChip = searchParams.get('month') ?? 'all';
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete(key); else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = usePaymentVouchers({ counts: true });
  /* The design's one search box: any voucher, every stage and month, on the server. */
  const [qText, setQText] = useState('');
  const q = useDebouncedValue(qText.trim(), 300);
  const searching = q !== '';
  const search = usePaymentVouchers({ q, enabled: searching });
  const accounts = useAccounts();
  const cancelPv = useCancelPaymentVoucher();
  const preparePv = useSubmitPaymentVoucher();
  const checkPv = useCheckPaymentVoucher();
  const approvePv = useApprovePaymentVoucher();

  const canCreate = can('scm.payment_voucher.create');
  const canCancel = can('scm.payment_voucher.cancel');
  const canWrite = can('scm.payment_voucher.write');
  const canCheck = can('scm.payment_voucher.check');
  const canApprove = can('scm.payment_voucher.approve');
  /* Remind approver (the design's e8; owner 2026-11-03 主要是付款吧): whoever may
     see and prepare vouchers, while the approve right is someone else's. */
  const canRemind = !canApprove && (canCreate || canWrite || canCheck);
  const remindPv = useRemindApprover();

  const allRows = useMemo<PaymentVoucherRow[]>(() => (data?.paymentVouchers ?? []) as PaymentVoucherRow[], [data]);
  /* Everything came back: the counts are the population's, so they may show. */
  const whole = data != null && allRows.length < LIST_CAP;
  const found = useMemo<PaymentVoucherRow[]>(() => (search.data?.paymentVouchers ?? []) as PaymentVoucherRow[], [search.data]);
  const stageCounts = data?.counts;
  const months = useMemo(() => lastMonths(todayMY(), 3), []);
  const inMonth = (r: PaymentVoucherRow) => monthChip === 'all' || String(r.voucher_date ?? '').slice(0, 7) === monthChip;
  const rows = useMemo<PaymentVoucherRow[]>(
    /* A search shows what it found, whatever the stage and month. */
    () => (searching ? found : allRows.filter((r) => statusChip === 'all' || chipMatches(statusChip, r)).filter(inMonth)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inMonth reads monthChip, listed
    [allRows, found, searching, statusChip, monthChip],
  );
  const accountName = useMemo(() => new Map((accounts.data?.accounts ?? []).map((a) => [a.account_code, a.account_name])), [accounts.data]);
  const openDoc = (r: PaymentVoucherRow) => openInTab(`/scm/payment-vouchers/${r.id}`);

  /* ── 批量tick yes (the owner, 2026-09-02) — tick the rows whose yes is
     yours to give, one button stamps them one by one. Each voucher still
     walks through its OWN door (permission, gate, audit, and for approve
     the whole post) — a failure names itself and the rest carry on. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  /* A ticked voucher may have come from the search, older than the newest 500. */
  const byId = useMemo(() => new Map([...allRows, ...found].map((r) => [r.id, r])), [allRows, found]);
  const tickedRows = useMemo(
    () => [...selected].map((k) => byId.get(k)).filter((r): r is PaymentVoucherRow => Boolean(r)),
    [selected, byId],
  );
  const prepareTargets = canWrite ? tickedRows.filter(isPreparable) : [];
  const checkTargets = canCheck ? tickedRows.filter(isCheckable) : [];
  const approveTargets = canApprove ? tickedRows.filter(isApprovable) : [];
  const remindTargets = canRemind ? tickedRows.filter(isApprovable) : [];
  const printOnly = tickedRows.filter((r) => stageOf(r) === 'DONE').length;
  const sumMyr = (list: PaymentVoucherRow[]) => list.reduce((s, r) => s + myrSen(r), 0);

  const runBatch = async (kind: 'prepare' | 'check' | 'approve') => {
    /* Voucher-date order, then the Draft/creation order (docs/bugs/0653): the
       formal number is minted the moment a voucher is checked, so a batch that
       ran in TICK order once gave the 28/04 vouchers 001/002 and the 21/04 ones
       003–006. Tick order is the operator's mouse; the date is the paper's. */
    const targets = [...(kind === 'prepare' ? prepareTargets : kind === 'check' ? checkTargets : approveTargets)]
      .sort((a, b) => String(a.voucher_date ?? '').localeCompare(String(b.voucher_date ?? '')) || String(a.pv_number).localeCompare(String(b.pv_number)));
    if (targets.length === 0) return;
    /* Prepare is freely reversible (withdraw, and the voucher stays editable)
       so it runs without a dialog — same as the detail page's button. The two
       yeses move money standing, so they keep theirs. */
    if (kind !== 'prepare') {
      const verb = kind === 'check' ? 'Check' : 'Approve & post';
      const totalMyr = sumMyr(targets);
      const ok = await askConfirm({
        title: `${verb} ${targets.length} voucher(s)?`,
        body: kind === 'check'
          ? `The first yes on each: they lock, and ≈ ${fmtMoney(totalMyr)} reserves against Daily Bank's available money.`
          : `The second yes on each posts its journal entry to the GL — ≈ ${fmtMoney(totalMyr)} leaves the books now.`,
        confirmLabel: verb,
      });
      if (!ok) return;
    }
    setBatchRunning(true);
    const failures: string[] = [];
    let done = 0;
    const mut = kind === 'prepare' ? preparePv : kind === 'check' ? checkPv : approvePv;
    for (const r of targets) {
      try {
        await mut.mutateAsync(r.id);
        done += 1;
      } catch (e) {
        failures.push(`${r.pv_number}: ${e instanceof Error ? e.message : 'Something went wrong.'}`);
      }
    }
    setBatchRunning(false);
    setSelected(new Set());
    void notify({
      title: `${done} of ${targets.length} ${kind === 'prepare' ? 'prepared' : kind === 'check' ? 'checked' : 'approved & posted'}`,
      body: failures.length > 0 ? failures.join('\n') : 'Nothing refused.',
      tone: failures.length > 0 ? 'error' : 'info',
    });
  };

  /* ── One row's next step (the redesign): the same door as the batch and the
     voucher page — Prepare without a dialog, Check and Approve with theirs. */
  const [stepping, setStepping] = useState<string | null>(null);
  const runStep = async (r: PaymentVoucherRow) => {
    const s = stageOf(r);
    if (s === 'DONE') return;
    if (s !== 'DRAFT') {
      const ok = await askConfirm(s === 'PREPARED'
        ? { title: `Check ${r.pv_number}?`, body: `It locks, gets its formal number, and ≈ ${fmtMoney(myrSen(r))} reserves against Daily Bank's available money.`, confirmLabel: 'Check' }
        : { title: `Approve & post ${r.pv_number}?`, body: `Its journal entry posts to the GL — ≈ ${fmtMoney(myrSen(r))} leaves the books now.`, confirmLabel: 'Approve & post' });
      if (!ok) return;
    }
    setStepping(r.id);
    try {
      if (s === 'DRAFT') {
        await preparePv.mutateAsync(r.id);
        toast?.success(`${r.pv_number} prepared · checked next`);
      } else if (s === 'PREPARED') {
        await checkPv.mutateAsync(r.id);
        toast?.success(`Checked ${r.pv_number} · numbered and ${fmtMoney(myrSen(r))} reserved in Money today`);
      } else {
        await approvePv.mutateAsync(r.id);
        toast?.success(`Approved & posted ${r.pv_number} · ${fmtMoney(myrSen(r))}`);
      }
    } catch (e) {
      void notify({ title: `${r.pv_number} was not ${s === 'DRAFT' ? 'prepared' : s === 'PREPARED' ? 'checked' : 'approved'}`, body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    } finally {
      setStepping(null);
    }
  };

  /* ── Remind approver: a note in the approver's bell (the ERP's own, the system
     slice), never a name on the screen (A6). Posts nothing; the voucher does not
     change. One voucher from its row; the ticked ones from the batch bar make
     ONE note listing them. One reminder per voucher an hour, and the toast says
     when the next may go. */
  const [reminding, setReminding] = useState<string | null>(null);
  const runRemind = async (targets: PaymentVoucherRow[], key: string) => {
    if (targets.length === 0 || reminding != null) return;
    setReminding(key);
    try {
      const out = await remindPv.mutateAsync(targets.map((r) => r.id));
      const sent = targets.filter((r) => out.reminded.some((x) => x.id === r.id));
      const to = out.approvers === 1 ? 'the approver' : `${out.approvers} approvers`;
      const what = sent.length === 1
        ? `${sent[0]!.pv_number} · ${fmtMoney(Number(sent[0]!.total_sen ?? 0), sent[0]!.currency)}`
        : `${sent.length} vouchers · ${fmtMoney(sumMyr(sent))}`;
      toast?.success(`Reminder sent to ${to} · ${what}. One reminder per voucher an hour — the next after ${fmtTime(out.nextAt)}.`);
      if (out.refused.length > 0) {
        void notify({ title: `${out.refused.length} not reminded`, body: out.refused.map((x) => x.message).join('\n'), tone: 'info' });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Something went wrong.';
      if (key !== 'batch' && toast) toast.error(message);
      else void notify({ title: 'No reminder went', body: message, tone: 'error' });
    } finally {
      setReminding(null);
    }
  };

  /* ── Batch print (owner 2026-09-03: 可选多张 pv + document, 就 pv+document,
     pv+document…) — ONE merged PDF in LIST order. Each voucher loads fresh and
     renders as its OWN jsPDF (its own page numbering); the Worker appends each
     one's stored files where they live (print-bundle) and hands the finished
     PDF back. One voucher failing to load fails the WHOLE print with its
     number — a batch quietly missing a voucher is the dishonest branch. The
     row's own Print and Print + files go through the same door (the redesign
     prints in place). */
  const [printing, setPrinting] = useState(false);
  /* Files or not is the OPERATOR's call per batch too (owner 2026-09-04:
     批量那边也要有这个选) — default ON. Without files nothing needs the
     Worker: the vouchers render into ONE shared jsPDF client-side, the
     combined-PI pattern. */
  const [batchWithFiles, setBatchWithFiles] = useState(true);
  const printVouchers = async (targets: PaymentVoucherRow[], withFiles: boolean, action: PdfAction) => {
    if (targets.length === 0 || printing) return;
    setPrinting(true);
    try {
      const [{ jsPDF }, { default: autoTable }, { renderPaymentVoucherInto, pdfBytesToBase64 }, accountsRes] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
        import('../../vendor/scm/lib/payment-voucher-pdf'),
        authedFetch<{ accounts: Array<{ account_code: string; account_name: string }> }>('/accounting/accounts'),
      ]);
      const names = new Map(accountsRes.accounts.map((a) => [a.account_code, a.account_name]));
      const nameOf = (code: string) => names.get(code) ?? null;
      const name = targets.length === 1 ? `${targets[0]!.pv_number}.pdf` : 'payment-vouchers.pdf';

      if (!withFiles) {
        /* Vouchers only — one shared doc, each starting on a fresh page. */
        const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
        for (let i = 0; i < targets.length; i += 1) {
          if (i > 0) doc.addPage();
          const detail = await fetchPvPrintDetail(targets[i]!.id);
          type A = Parameters<typeof renderPaymentVoucherInto>;
          await renderPaymentVoucherInto(
            doc, autoTable,
            detail.paymentVoucher as unknown as A[2],
            detail.lines as unknown as A[3],
            detail.allocations as unknown as A[4],
            nameOf,
          );
        }
        deliverPdfBlob(doc.output('blob'), name, action);
        return;
      }

      const parts: Array<{ pvId: string; voucherBase64: string }> = [];
      for (const r of targets) {
        const detail = await fetchPvPrintDetail(r.id);
        const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
        type A = Parameters<typeof renderPaymentVoucherInto>;
        await renderPaymentVoucherInto(
          doc, autoTable,
          detail.paymentVoucher as unknown as A[2],
          detail.lines as unknown as A[3],
          detail.allocations as unknown as A[4],
          nameOf,
        );
        parts.push({ pvId: r.id, voucherBase64: pdfBytesToBase64(doc.output('arraybuffer') as ArrayBuffer) });
      }
      const blob = await fetchPvPrintBundle(parts);
      deliverPdfBlob(blob, name, action);
    } catch (e) {
      void notify({ title: 'Print failed — nothing was printed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    } finally {
      setPrinting(false);
    }
  };
  const printSelected = (action: PdfAction) => printVouchers(rows.filter((r) => selected.has(r.id)), batchWithFiles, action);
  /* The list itself on paper (owner 2026-11-09: 我filter 了，right click header print
     不行？): the header's Export to PDF prints the rows showing, the listing paper the
     Payment listing prints on, saying what the screen was cut to. */
  const printList = async (view: TablePdfView<PaymentVoucherRow>) => {
    try {
      const { generatePvListPdf, pvListCutTo } = await import('../../vendor/scm/lib/pv-list-pdf');
      const cutTo = pvListCutTo({ stage: CHIP_LABELS[statusChip] ?? statusChip, month: monthChip === 'all' ? '' : monthName(monthChip), search: searching ? q : '' });
      await generatePvListPdf(view, { cutTo, action: 'preview' });
    } catch (e) {
      void notify({ title: 'The list was not printed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const doCancelPv = async (r: PaymentVoucherRow) => {
    if (!(await askConfirm({ title: `Cancel ${r.pv_number}?`, body: 'It turns Cancelled; a posted journal is reversed with a contra entry. Nothing is deleted and the number stays.', confirmLabel: 'Cancel voucher', danger: true }))) return;
    cancelPv.mutate(r.id, {
      onError: (e) => notify({ title: 'Cancel failed', body: `${e instanceof Error ? e.message : 'Something went wrong.'}`, tone: 'error' }),
    });
  };

  /* ⋯ and right-click: one menu (the design's pvMenu). Edit only while the
     voucher can still change (Draft, Prepared) — a checked one is locked, its
     words apart (owner 2026-11-06). */
  const menuOf = (r: PaymentVoucherRow): GridContextMenuItem[] => {
    const menu: GridContextMenuItem[] = [{ label: 'Open', onClick: () => openDoc(r) }];
    if (canWrite && (isPreparable(r) || isCheckable(r))) {
      menu.push({ label: 'Edit', onClick: () => navigate(`/scm/payment-vouchers/${r.id}?edit=1`) });
    }
    if (canWrite && isApprovable(r) && r.approved_at == null) {
      menu.push({ label: 'Edit text & bank', onClick: () => navigate(`/scm/payment-vouchers/${r.id}?text=1`) });
    }
    menu.push({ divider: true });
    menu.push({ label: 'Print', onClick: () => void printVouchers([r], false, 'print') });
    menu.push({ label: 'Print + files', onClick: () => void printVouchers([r], true, 'print') });
    /* Copy as new (the owner, 2026-09-03: 我 right click 就能直接 copy) — any
       status, cancelled included: the CONTENT is the template, the identity
       is fresh. An AP Payment copies to an AP Payment. */
    if (canCreate) menu.push({ label: 'Copy as new', onClick: () => navigate(copyPath(r)) });
    if (r.status !== 'CANCELLED' && canCancel) {
      menu.push({ divider: true });
      menu.push({ label: 'Cancel…', danger: true, onClick: () => void doCancelPv(r) });
    }
    return menu;
  };
  const [openMenu, setOpenMenu] = useState<{ row: PaymentVoucherRow; x: number; y: number } | null>(null);

  const columns = useMemo<GridColumn<PaymentVoucherRow>[]>(() => [
    {
      key: 'pv_number', label: 'Voucher', width: 150, sortable: true,
      accessor: (r) => (
        <button type="button" className={`${mo.docLink} ${cancelledDocNoClass(r.status)}`}
          onClick={(e) => { e.stopPropagation(); openDoc(r); }}>{r.pv_number}</button>
      ),
      searchValue: (r) => r.pv_number,
      exportValue: (r) => r.pv_number,
      sortFn: (a, b) => a.pv_number.localeCompare(b.pv_number),
    },
    {
      key: 'voucher_date', label: 'Date', width: 110, sortable: true,
      accessor: (r) => fmtDateOrDash(r.voucher_date),
      searchValue: (r) => r.voucher_date ?? '',
      sortFn: (a, b) => String(a.voucher_date ?? '').localeCompare(String(b.voucher_date ?? '')),
      filterType: 'date', dateValue: (r) => r.voucher_date,
    },
    {
      key: 'payee_name', label: 'Payee', width: 220, sortable: true, groupable: true,
      accessor: (r) => r.payee_name || r.supplier?.name || '—',
      searchValue: (r) => `${r.payee_name ?? ''} ${r.supplier?.name ?? ''}`.trim(),
      groupValue: (r) => r.payee_name || r.supplier?.name || '(none)',
      sortFn: (a, b) => (a.payee_name ?? '').localeCompare(b.payee_name ?? ''),
    },
    {
      /* The Description (owner 2026-11-09: 对我来说 description 就是 purpose; 我只想
         显示单上的费用，不要像之前一样显示bill no. 等等): what is paid for, as the bills
         say it — the server's words, never the bill number. The key stays `notes`, the
         column's key since 2026-10-14, so every reader's saved widths and order hold.
         A long one is cut with … and reads whole on hover (the cell's title comes from
         filterValue) or with WRAP on; Export carries it. */
      key: 'notes', label: 'Description', width: 260, sortable: true, groupable: false,
      accessor: (r) => forOf(r) || '—',
      filterValue: (r) => forOf(r),
      searchValue: (r) => descriptionOf(r),
      exportValue: (r) => descriptionOf(r),
      sortFn: (a, b) => descriptionOf(a).localeCompare(descriptionOf(b)),
    },
    {
      /* The Remark: what Finance typed beside the voucher (Edit text & bank), off the list by default. */
      key: 'remark', label: 'Remark', width: 220, sortable: true, groupable: false, defaultHidden: true,
      accessor: (r) => notesOf(r) || '—',
      filterValue: (r) => notesOf(r),
      searchValue: (r) => notesOf(r),
      exportValue: (r) => notesOf(r),
      sortFn: (a, b) => notesOf(a).localeCompare(notesOf(b)),
    },
    {
      key: 'pay_bank', label: 'Bank', width: 130, sortable: true, groupable: true,
      accessor: (r) => r.pay_bank || '—',
      searchValue: (r) => r.pay_bank ?? '',
      groupValue: (r) => r.pay_bank || '(none)',
      exportValue: (r) => r.pay_bank ?? '',
      sortFn: (a, b) => (a.pay_bank ?? '').localeCompare(b.pay_bank ?? ''),
    },
    {
      key: 'pay_account_no', label: 'Account no.', width: 150, sortable: true, groupable: false,
      accessor: (r) => r.pay_account_no || '—',
      searchValue: (r) => r.pay_account_no ?? '',
      exportValue: (r) => r.pay_account_no ?? '',
    },
    {
      /* The money account it is paid from: code on one line, name below (owner 2026-09-15). */
      key: 'credit_account_code', label: 'Pay from', width: 150, sortable: true, groupable: true,
      accessor: (r) => (r.credit_account_code ? <AccountCell code={r.credit_account_code} name={accountName.get(r.credit_account_code)} /> : '—'),
      searchValue: (r) => `${r.credit_account_code ?? ''} ${accountName.get(r.credit_account_code ?? '') ?? ''}`.trim(),
      groupValue: (r) => r.credit_account_code ?? '(none)',
    },
    {
      key: 'total_sen', label: 'Amount', width: 130, sortable: true, align: 'right', groupable: false,
      accessor: (r) => <span className={mo.money}>{fmtMoney(Number(r.total_sen ?? 0), r.currency)}</span>,
      searchValue: (r) => fmtMoney(Number(r.total_sen ?? 0), r.currency),
      exportValue: (r) => Number(r.total_sen ?? 0) / 100,
      exportFormat: 'money',
      sortFn: (a, b) => Number(a.total_sen ?? 0) - Number(b.total_sen ?? 0),
      /* The Total (owner 2026-11-09: 表格最下面的总数（Total）- payment voucher 可以加):
         the ringgit of the rows showing, a cancelled voucher not counted. */
      total: (shown) => {
        const t = pvListTotal(shown);
        return <span className={mo.money} title={pvListTotalNote(t) || undefined}>{fmtMoney(t.sen)}</span>;
      },
    },
    {
      /* The four layers' marks ride as the tag, never inside the status enum
         (the 0324 lesson): a checked DRAFT reads Checked, a prepared one
         Prepared, and an advance still open says so beside it. */
      key: 'status', label: 'Stage', width: 170, sortable: true, groupable: true,
      accessor: (r) => {
        const t = stageTag(r);
        return (
          <span className={mo.tags}>
            <span className={`${mo.tag} ${t.tone}`}>{t.text}</span>
            {advanceOpenSen(r) > 0 && <span className={`${mo.tag} ${mo.toneAdvance}`}>Advance open</span>}
          </span>
        );
      },
      searchValue: (r) => queueLabel(r),
      groupValue: (r) => queueLabel(r),
      exportValue: (r) => queueLabel(r),
      sortFn: (a, b) => a.status.localeCompare(b.status),
      /* Beside the Total: what it left out, or converted. */
      total: (shown) => {
        const note = pvListTotalNote(pvListTotal(shown));
        return note ? <span style={{ fontWeight: 400, color: 'var(--fg-muted)' }}>{note}</span> : null;
      },
    },
    {
      /* The next step on the row (the design): the voucher's own door. */
      key: 'next_step', label: '', exportLabel: 'Next step', width: 170, align: 'right', groupable: false,
      accessor: (r) => {
        const s = stageOf(r);
        const step = s === 'DRAFT' && canWrite ? 'Prepare' : s === 'PREPARED' && canCheck ? 'Check' : s === 'CHECKED' && canApprove ? 'Approve & post' : null;
        return (
          <span className={mo.acts}>
            {step && (
              <button type="button" className={mo.act} disabled={stepping != null || batchRunning}
                onClick={(e) => { e.stopPropagation(); void runStep(r); }}>{stepping === r.id ? 'Working…' : step}</button>
            )}
            {s === 'CHECKED' && canRemind && (
              <button type="button" className={pvx.actSecondary} disabled={reminding != null || batchRunning}
                title="A note in the approver's bell. Posts nothing."
                onClick={(e) => { e.stopPropagation(); void runRemind([r], r.id); }}>{reminding === r.id ? 'Sending…' : 'Remind approver'}</button>
            )}
            {s === 'DONE' && (
              <button type="button" className={mo.actLink} disabled={printing}
                onClick={(e) => { e.stopPropagation(); void printVouchers([r], false, 'print'); }}>Print</button>
            )}
            <button type="button" className={mo.more} aria-label={`More for ${r.pv_number}`} title="Open, edit, print, copy as new, cancel"
              onClick={(e) => { e.stopPropagation(); setOpenMenu({ row: r, x: e.clientX, y: e.clientY }); }}>
              <MoreHorizontal size={14} />
            </button>
          </span>
        );
      },
      exportValue: (r) => {
        const s = stageOf(r);
        return s === 'DRAFT' ? 'Prepare' : s === 'PREPARED' ? 'Check' : s === 'CHECKED' ? 'Approve & post' : '';
      },
    },
    {
      /* DEV-75: not in Total; posts Dr 900-B001 / Cr the bank with the voucher. */
      key: 'bank_charge_sen', label: 'Bank charges', width: 120, sortable: true, align: 'right', groupable: false, defaultHidden: true,
      accessor: (r) => fmtMoney(Number(r.bank_charge_sen ?? 0), 'MYR'),
      exportValue: (r) => Number(r.bank_charge_sen ?? 0) / 100,
      exportFormat: 'money',
      sortFn: (a, b) => Number(a.bank_charge_sen ?? 0) - Number(b.bank_charge_sen ?? 0),
    },
    {
      /* The journal its approval posted (the redesign's hidden column). */
      key: 'je_no', label: 'Journal', width: 150, sortable: true, groupable: false, defaultHidden: true,
      accessor: (r) => r.je_no ?? '—',
      searchValue: (r) => r.je_no ?? '',
      exportValue: (r) => r.je_no ?? '',
    },
    {
      key: 'bill_ref', label: 'Bill no.', width: 130, sortable: true, groupable: false, defaultHidden: true,
      accessor: (r) => String(r.bill_ref ?? '') || '—',
      searchValue: (r) => String(r.bill_ref ?? ''),
      exportValue: (r) => String(r.bill_ref ?? ''),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the cells read the latest handlers through closures each render
  ], [accountName, canWrite, canCheck, canApprove, canRemind, stepping, reminding, batchRunning, printing]);

  /* All months: the server's count over the company. One month: counted here, while everything came back. */
  const chipCount = (chip: string) => (monthChip === 'all' && stageCounts
    ? stageCounts[chip]
    : whole ? allRows.filter((r) => (chip === 'all' || chipMatches(chip, r)) && inMonth(r)).length : undefined);
  const monthCount = (m: string) => (whole ? allRows.filter((r) => (statusChip === 'all' || chipMatches(statusChip, r)) && (m === 'all' || String(r.voucher_date ?? '').slice(0, 7) === m)).length : undefined);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance · Money out"
        title="Payment vouchers"
        actions={
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* The pile kept while this tab lives (owner 2026-10-06): the bills not yet opened. */}
            {canCreate && <BackToPile target="pv" />}
            {canCreate && (
              <>
                {/* The bill pile: drop many bills, they come back read and
                    grouped by supplier (owner's three cases, 2026-09-02). */}
                <Button variant="ghost" size="sm" onClick={() => navigate('/scm/payment-vouchers/scan')}>
                  <Camera {...ICON} />
                  <span>Scan bills</span>
                </Button>
                {/* The third kind (§14): money back to a customer, named by
                    the order or the cancelled invoice it refunds. */}
                <Button variant="secondary" size="sm" onClick={() => navigate('/scm/payment-vouchers/new?type=refund')}>
                  <Plus {...ICON} />
                  <span>New customer refund</span>
                </Button>
                {/* Two documents, AutoCount-style (owner 2026-08-30): the AP
                    Payment settles a supplier's invoices with an automatic AP
                    debit; the Payment Voucher pays expenses, lines by hand. */}
                <Button variant="secondary" size="sm" onClick={() => navigate('/scm/payment-vouchers/new')}>
                  <Plus {...ICON} />
                  <span>New payment voucher</span>
                </Button>
                <Button variant="primary" size="sm" onClick={() => navigate('/scm/payment-vouchers/new?type=ap')}>
                  <Plus {...ICON} />
                  <span>New AP payment</span>
                </Button>
              </>
            )}
          </div>
        }
      />

      {/* Requests waiting for Finance (owner 2026-10-08: 提醒我有几个payment request 还没proceed). */}
      <PaymentRequestsWaiting />

      {search.error && searching && (
        <div className={styles.bannerWarn}>
          <strong>The search did not run.</strong>{' '}
          {search.error instanceof Error ? search.error.message : 'Something went wrong.'}
        </div>
      )}

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load payment vouchers.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      <div className={mo.top}>
        <div className={mo.row}>
          <label className={mo.search}>
            <Search size={14} />
            <input value={qText} onChange={(e) => { setQText(e.target.value); setSelected(new Set()); }}
              placeholder="Find any voucher · number, payee, bill, amount" aria-label="Find any voucher" />
            {qText && <button type="button" className={mo.clear} aria-label="Clear the search" onClick={() => setQText('')}><X size={13} /></button>}
          </label>
        </div>
        {/* The SO strip's own FilterPills slab (owner 2026-07-26); the counts
            from the server, or counted here while the whole list came back. */}
        <FilterPills
          options={STATUS_CHIPS.map((s) => ({ value: s as string, label: CHIP_LABELS[s] ?? s, count: chipCount(s) }))}
          value={statusChip}
          onChange={(v) => setParam('status', v)}
        />
        <div className={mo.row} role="group" aria-label="Voucher month">
          {['all', ...months].map((m) => {
            const n = monthCount(m);
            return (
              <button key={m} type="button" aria-pressed={monthChip === m} className={`${mo.month} ${monthChip === m ? mo.monthOn : ''}`}
                onClick={() => setParam('month', m)}>
                {m === 'all' ? 'All months' : monthName(m)}
                {n != null && <span className={mo.monthCount}>{n}</span>}
              </button>
            );
          })}
        </div>
        <div className={mo.hint}>
          {searching
            ? (search.isLoading ? `Searching “${q}”…` : `Search “${q}” · ${found.length} voucher${found.length === 1 ? '' : 's'} across every stage and month${search.data?.capped ? ' · the newest 200 shown' : ''}`)
            : isLoading ? 'Loading vouchers…' : `${CHIP_HINTS[statusChip] ?? ''}${whole ? '' : ` The newest ${LIST_CAP} vouchers are listed.`}`}
        </div>
      </div>

      {/* The batch bar — appears once something is ticked. Each button says
          how many of the ticked rows ITS yes applies to. */}
      {selected.size > 0 && (
        <div className={mo.batch}>
          <div className={mo.row}>
            <span>{selected.size} ticked</span>
            {prepareTargets.length > 0 && (
              <Button variant="secondary" size="sm" onClick={() => void runBatch('prepare')} disabled={batchRunning}>
                Prepare {prepareTargets.length}
              </Button>
            )}
            {checkTargets.length > 0 && (
              <Button variant="secondary" size="sm" onClick={() => void runBatch('check')} disabled={batchRunning}>
                Check {checkTargets.length}
              </Button>
            )}
            {approveTargets.length > 0 && (
              <Button variant="primary" size="sm" onClick={() => void runBatch('approve')} disabled={batchRunning}>
                Approve & post {approveTargets.length}
              </Button>
            )}
            {remindTargets.length > 0 && (
              <Button variant="secondary" size="sm" onClick={() => void runRemind(remindTargets, 'batch')} disabled={batchRunning || reminding != null}>
                {reminding === 'batch' ? 'Sending…' : `Remind approver · ${remindTargets.length}`}
              </Button>
            )}
            {/* Print rides the SAME ticks (owner 2026-09-03): the ticked
                vouchers, list order, one PDF — with each voucher's files
                interleaved, or vouchers only (owner 2026-09-04: 批量那边也要
                有这个选). */}
            <Button variant="secondary" size="sm" onClick={() => void printSelected('print')} disabled={printing || batchRunning}>
              {printing ? 'Preparing…' : `Print ${selected.size}${batchWithFiles ? ' + files' : ''}`}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void printSelected('save')} disabled={printing || batchRunning}>
              Save as PDF
            </Button>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={batchWithFiles}
                aria-label="Include each voucher's attached files"
                onChange={(e) => setBatchWithFiles(e.target.checked)}
                style={{ width: 14, height: 14, accentColor: 'var(--c-orange)' }} />
              With files
            </label>
            {batchRunning && <span style={{ color: 'var(--fg-muted)' }}>stamping…</span>}
            <span className={mo.grow} />
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={batchRunning}>
              Clear
            </Button>
          </div>
          <div className={mo.batchNotes}>
            {(prepareTargets.length + checkTargets.length + approveTargets.length) > 0 && <span>Runs in voucher-date order.</span>}
            {checkTargets.length > 0 && <span>Checking locks them, numbers them and reserves {fmtMoney(sumMyr(checkTargets))} in Money today.</span>}
            {approveTargets.length > 0 && <span>Approving posts each journal now: {fmtMoney(sumMyr(approveTargets))} leaves the books.</span>}
            {!canApprove && tickedRows.some(isApprovable) && (
              <span>Approving needs the approve right.{remindTargets.length > 0 ? ' Remind approver sends one note for them all, once an hour per voucher.' : ''}</span>
            )}
            {printOnly > 0 && <span>{printOnly} ticked {printOnly === 1 ? 'voucher is' : 'vouchers are'} already approved or cancelled, so only printed.</span>}
          </div>
        </div>
      )}

      <DataGridCompat<PaymentVoucherRow>
        rows={rows}
        columns={columns}
        storageKey={PV_LIST_STORAGE_KEY}
        exportName="Payment Vouchers"
        onExportPdf={(view) => void printList(view)}
        rowKey={(r) => r.id}
        selectable={{
          selectedKeys: selected,
          onToggle: (k) => setSelected((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
          onToggleAll: (keys, allSel) => setSelected((p) => {
            const n = new Set(p);
            if (allSel) { for (const k of keys) n.delete(k); } else { for (const k of keys) n.add(k); }
            return n;
          }),
          /* EVERY row ticks — a tick means "include in the batch", and
             printing (owner 2026-09-03) applies to any voucher. The approval
             buttons still count only the rows THEIR yes applies to. And the
             tick lives in the CHECKBOX alone (owner: 我一点就直接 tick 了…做成
             一定要点那个tick 的格子) — a row click highlights, a double-click
             opens, right-click menus; nothing else ticks. */
          checkboxOnly: true,
        }}
        /* The page's own search box asks the server (every stage and month). */
        hideSearch
        groupBanner={false}
        onRowDoubleClick={(r) => openDoc(r)}
        getRowClassName={(r) => cancelledRowClass(r.status)}
        rowStyle={(r) => r.status === 'CANCELLED'
          ? { opacity: 0.6, filter: 'grayscale(0.4)' }
          : advanceOpenSen(r) > 0 ? { color: ADVANCE_BLUE } : undefined}
        contextMenu={(r) => menuOf(r)}
        isLoading={isLoading}
        emptyMessage={searching
          ? `No voucher matches “${q}”.`
          : allRows.length === 0
            ? 'No payment voucher yet — New payment voucher raises one.'
            : 'No voucher in this stage and month.'}
      />

      {openMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 79 }} onClick={() => setOpenMenu(null)} aria-hidden />
          <div className={mo.menu} role="menu" aria-label={`${openMenu.row.pv_number} menu`}
            style={{ top: Math.min(openMenu.y + 6, window.innerHeight - 280), left: Math.max(8, openMenu.x - 180) }}>
            {menuOf(openMenu.row).map((m, i) => (m.divider
              ? <div key={`d${i}`} className={mo.menuRule} />
              : (
                <button key={m.label} type="button" role="menuitem" className={`${mo.menuItem} ${m.danger ? mo.menuDanger : ''}`}
                  onClick={() => { setOpenMenu(null); m.onClick?.(); }}>{m.label}</button>
              )))}
          </div>
        </>
      )}
    </div>
  );
};
