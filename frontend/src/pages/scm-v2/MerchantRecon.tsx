// ----------------------------------------------------------------------------
// MERCHANT RECONCILIATION — the merchant (card machine) statement against what
// the ERP recorded. Accounting phase 2B, brief §3.5 layer 3.
//
// The owner named the two halves of this work himself: "就不能分成 merchant
// reconciliation, bank statement reconciliation 吗？" So:
//
//   here (/scm/merchant-recon)  — the MERCHANT statement vs the ERP's payments
//   /scm/bank-recon             — the BANK statement vs what the merchants owe
//
// This screen books FEES and nothing else (Dr merchant charges / Cr settlement-
// in-transit, the moment a line is confirmed) — the single thing 系统3 never did,
// so its card fees never reached the P&L. It never books the bank: the money
// arrives days later and that is the other screen's job.
//
// "对账 ＝ 把「在途结算款」这个科目清干净的过程" — between the two screens,
// 320-0000 empties.
//
// ONE THING AT A TIME. Working a statement replaces the list rather than piling
// under it; the version that piled drew this: "就感觉很多东西挤在一页".
//
// 系统3's skeleton is kept where it was right — four piles, bulk-confirm the
// auto-matched, candidates with clues — and given what it lacked: per-acquirer
// CONFIG instead of hardcoded quirks, no auto-confirm without a unique
// reference, and a loud refusal for a file it cannot read.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCheck, Download, Undo2, Upload } from 'lucide-react';
import {
  useAcquirerSetup, useSaveAcquirerSetup, useSettlementBatches, useSettlementBatch, useReadSettlementBatches,
  useConfirmSettlementRow, useConfirmSettlementGroup, useConfirmMatched, useIgnoreSettlementRow,
  useSettlementWatchlist, useUnconfirmSettlementRow, useReleaseSettlementRow, useFindPayments, usePayouts,
  confirmMatchedBatch, useInvalidateAfterPosting,
  type AcquirerSetup, type SettlementRow, type SettlementBatch, type BankAccount, type SettlementCandidate,
  type Watchlist, type Payout,
} from './settlement-queries';
import { DataTable, type Column } from '../../components/DataTable';
import { HeaderExportMenu } from '../../components/DataTableExportItems';
import { writeLineExportFile, type TablePdfView } from '../../components/dataTableLineExport';
import { customerRefOf } from '../../lib/customer-ref';
import { todayMY } from '../../vendor/shared/format';
import { LINE_STATUS_WORDS, QR_REF_WORDS, isOpenLine, isQrLine, lineStatus, openReportsOf, ordersOf, reportLinesMatrix, statusWordsOf } from './merchantReconExport';
import {
  ICON, fmt, btn, cell, num, table, headRow, rowLine, softText, danger, good, panel,
  BUCKET_LABEL, refusalText, payableOf,
} from './settlement-ui';
import { PayoutAdviceTab } from './PayoutAdviceTab';
import { MerchantUploadDrawer, type UploadLanding } from './MerchantUpload';
import { downloadCSV, toCSV } from '../../lib/csv';
import styles from './Suppliers.module.css';
import grid from './MerchantRecon.module.css';
import { PageHeader } from '../../components/Layout';
import { AcquirerCards, ReportHead, ReportStrip, ReportTabs, TAB_EMPTY, acquirerCards, lineTab, type ReportTab } from './MerchantReportsTop';
import top from './MerchantReports.module.css';
import { useFinanceTodo } from './finance/finance-todo-queries';
import { fmtDate } from '../../vendor/shared/format';
import { markWorkspaceOpenIntent } from '../../lib/workspaceTabs';
import { rememberReturnScroll, useReturnScroll } from '../../lib/returnScroll';

/* ── The order behind a line, one click away ──────────────────────────────────
   Owner 2026-10-21: 点开那个 HC-SO-013512 这些 sales order 直接打开整张 sales
   order. An order number opens the whole order in its OWN tab of the in-app
   strip — the convention of Fair Links and the project page's order list
   (lib/openDocInTab) — so the report stays one click away; Ctrl/Cmd-click opens
   a browser window. The order's Back closes that tab and returns here, to the
   same report at the same spot (owner 2026-10-21: 返回也要返回 merchant recon)
   — so the spot is noted as the link is clicked. An invoice payment's number
   stays text: the invoice page is reached by an id this screen does not
   carry. */
const DocLink = ({ source, docNo, bold }: { source: string | null | undefined; docNo: string; bold?: boolean }) => {
  if (source !== 'SOPAY' || !docNo) return bold ? <b>{docNo}</b> : <>{docNo}</>;
  return (
    <Link
      to={`/scm/sales-orders/${encodeURIComponent(docNo)}`}
      onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { rememberReturnScroll(); markWorkspaceOpenIntent(true); } }}
      style={{ fontWeight: bold ? 700 : undefined, whiteSpace: 'nowrap' }}
    >
      {docNo}
    </Link>
  );
};

/** The orders a matched line claimed, each one a door to its order. */
const LinkedDocs = ({ links }: { links: SettlementRow['linked'] }) => (
  <>
    {links.map((l, i) => (
      <span key={l.payment_id}>
        {i > 0 && ', '}
        {l.doc_no ? <DocLink source={l.payment_source} docNo={l.doc_no} bold /> : <b>{l.payment_id}</b>}
      </span>
    ))}
  </>
);

export const MerchantRecon = () => {
  /* The redesign (owner's Claude Design, batch 3): a card per acquirer on top;
     choosing one narrows the page to its reports and shows them by swipe day.
     With none chosen the page is today's work list of every acquirer. The
     acquirer, the open report and the advice view all live in the address. */
  const setup = useAcquirerSetup();
  const batches = useSettlementBatches();
  const todo = useFinanceTodo();
  const [params, setParams] = useSearchParams();
  const acq = params.get('acq');
  const advice = params.get('view') === 'advice';
  const batchParam = Number(params.get('batch'));
  const openId = Number.isInteger(batchParam) && batchParam > 0 ? batchParam : null;
  const all = batches.data?.batches ?? [];
  /* A report not in by the next morning, as To do raised it (card-missing): the swipe day before it began waiting. */
  const missingDay = useMemo(() => {
    const out: Record<string, string> = {};
    for (const j of todo.data?.mine ?? []) {
      if (j.rule !== 'card-missing' || !j.since) continue;
      const code = j.key.replace(/^card-missing:/, '');
      out[code] = new Date(Date.parse(`${j.since}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    }
    return out;
  }, [todo.data]);
  const cards = acquirerCards(setup.data?.acquirers ?? [], all, missingDay);
  /* The Upload drawer lives in the address (?upload=1, or ?upload=advice for
     Public Bank's advice), so To do can open it; what an upload made lands
     below once the drawer closes. */
  const uploading = params.get('upload');
  const [landing, setLanding] = useState<UploadLanding | null>(null);
  const openUpload = () => setParam({ upload: '1' });
  const uploadButton = <button type="button" className={top.upload} onClick={openUpload}><Upload {...ICON} /> Upload</button>;
  const setParam = (patch: Record<string, string | null>) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v == null) next.delete(k); else next.set(k, v); }
    return next;
  });

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance · Bank & cards" title="Merchant reports" />
      <div className={top.top}>
        <div className={top.headRow}>
          <span className={top.grow} />
          <Link to="/scm/settlement-setup" className={top.link}>Recon setup</Link>
          {/* Step two is its own screen; the link keeps the next job one click away. */}
          <Link to="/scm/bank-recon" className={top.link}>Bank statements <ArrowRight {...ICON} /></Link>
        </div>
        <AcquirerCards cards={cards} selected={acq}
          onSelect={(code) => setParam({ acq: acq === code ? null : code, batch: null, view: null })} />
        {acq && (
          <ReportStrip code={acq} batches={all.filter((x) => x.acquirer_code === acq)} openId={openId} missingDay={missingDay[acq] ?? null}
            onOpen={(id) => setParam({ batch: String(id), view: null })}
            extra={(
              <>
                {/* The advice is the acquirer's paperwork, so it lives with its reports (owner 2026-08-24). */}
                {acq === 'PBB' && (
                  <button type="button" className={`${top.chip} ${advice ? top.chipOn : ''}`} aria-pressed={advice}
                    onClick={() => setParam({ view: advice ? null : 'advice', batch: null })}>Advices</button>
                )}
                {uploadButton}
              </>
            )} />
        )}
        {!acq && (
          <div className={top.headRow}>
            <button type="button" className={`${top.chip} ${advice ? top.chipOn : ''}`} aria-pressed={advice}
              onClick={() => setParam({ view: advice ? null : 'advice', batch: null })}>Payment advices</button>
            <span className={top.grow} />
            {uploadButton}
          </div>
        )}
      </div>
      {uploading != null && (
        <MerchantUploadDrawer acq={acq} acquirers={setup.data?.acquirers ?? []} startWith={uploading === 'advice' ? 'advice' : null}
          onClose={(l) => {
            if (l?.kind === 'advice') { setParam({ upload: null, view: 'advice', batch: null }); return; }
            if (l) setLanding(l);
            setParam({ upload: null, ...(l ? { view: null, batch: null } : {}) });
          }} />
      )}
      {advice
        ? <PayoutAdviceTab onUpload={() => setParam({ upload: 'advice' })} />
        : <ReconcileTab acq={acq} landing={landing} onLandingDone={() => setLanding(null)} />}
    </div>
  );
};

/* ── The work queue: ONLY what is not matched yet ─────────────────────────────
   The owner, asked what this screen should open on: "应该就只会显示还没对上的
   transaction 吧". So it shows exactly that, from both sides at once:

     • statements with lines still to decide — the merchant says it, and either
       nobody in the ERP recorded it or a human has to choose which payment;
     • card money the sales team DID record that no statement has reported yet.

   A statement whose lines are all decided leaves this screen entirely. Where it
   goes is the bank statement reconciliation, and it can only go there once it
   is clean — his rule: 核对完了没有问题才会显示去 bank statement 的
   reconciliation. */

const ReconcileTab = ({ acq = null, landing = null, onLandingDone }: {
  acq?: string | null; landing?: UploadLanding | null; onLandingDone?: () => void;
}) => {
  const setup = useAcquirerSetup();
  const batches = useSettlementBatches();
  const watchlist = useSettlementWatchlist();
  const bulk = useConfirmAcross();
  /* The open report lives in the ADDRESS (?batch=), not in memory: a Sales
     Order opened from a report and closed again comes back to the same report
     (owner 2026-10-21: 我从 merchant recon 点开 SO，返回也要返回 merchant
     recon), and so does a reload. */
  const [params, setParams] = useSearchParams();
  const batchParam = Number(params.get('batch'));
  const batchId = Number.isInteger(batchParam) && batchParam > 0 ? batchParam : null;
  const setBatchId = (id: number | null) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id == null) next.delete('batch'); else next.set('batch', String(id));
    return next;
  });
  /* Back from an order lands where the list was scrolled. */
  useReturnScroll(batchId == null && batches.data != null);
  const [showDone, setShowDone] = useState(false);
  const readBatches = useReadSettlementBatches();
  const [exportNote, setExportNote] = useState<ExportNote | null>(null);

  /* ONE THING AT A TIME. Working a statement replaces everything else. */
  if (batchId != null) return <BatchView batchId={batchId} onBack={() => setBatchId(null)} />;
  /* What the last upload made — the summary it lands on (the drawer said the piles). */
  if (landing && landing.batchIds.length > 0) {
    return (
      <UploadSummary batchIds={landing.batchIds} refusals={landing.results.filter((r) => !r.ok)}
        leftOut={landing.results.flatMap((r) => (r.ok && r.leftOut ? [{ name: r.name, text: r.leftOut }] : []))}
        onOpen={setBatchId} onDone={() => onLandingDone?.()} />
    );
  }

  const every = batches.data?.batches ?? [];
  /* "Confirm all matched" covers every report; the list shows the chosen acquirer's. */
  const everyOpen = every.filter((b) => (b.open_count ?? 0) > 0);
  const all = acq ? every.filter((b) => b.acquirer_code === acq) : every;
  const open = all.filter((b) => (b.open_count ?? 0) > 0);
  const cleared = all.filter((b) => (b.open_count ?? 0) === 0);
  /* Two different jobs, and the button may only claim the first: a line that
     matched by reference is a press, a line without one is a decision. */
  const readyToConfirm = everyOpen.reduce((s, b) => s + (b.to_confirm_count ?? 0), 0);
  const toPost = everyOpen.filter(worthConfirming).length;
  const stillToDecide = everyOpen.reduce((s, b) => s + (b.to_choose_count ?? 0) + (b.no_record_count ?? 0), 0);
  /* Card money the sales team recorded that no statement has reported. Held
     back until the watchlist has answered, so an empty list never reads as
     "nothing outstanding" when it means "not loaded". */
  const waiting = (watchlist.data?.recordedNotArrived ?? []).filter((p) => !acq || p.acquirerCode === acq || p.acquirerCode == null);
  const waitingSen = waiting.reduce((s, p) => s + p.amountSen, 0);
  /* Keyed in without a bank: the server lists such a payment ONCE here
     (docs/bugs/0688 — it used to sit under every merchant), and the confirm
     that stamps its bank is what moves it onto that merchant's list. */
  const untagged = waiting.filter((p) => p.acquirerCode == null).length;

  /* Owner 2026-11-06: 我要能 export, right click, 支持 pdf. A file takes a moment to make, and one
     that cannot be made says why, beside the list it was asked of. */
  const runExport = (list: ExportNote['list'], what: string, work: () => Promise<void>) => {
    setExportNote({ list, text: `Making the ${what}…`, failed: false });
    work().then(
      () => setExportNote(null),
      (e: unknown) => setExportNote({ list, failed: true, text: e instanceof Error && e.message ? e.message : `The ${what} could not be made.` }),
    );
  };
  const exportReports = (how: 'excel' | 'pdf') => runExport('reports', how === 'pdf' ? 'PDF' : 'Excel', async () => {
    const reports = openReportsOf(open, await readBatches(open.map((b) => b.id)));
    if (how === 'excel') {
      await writeLineExportFile(reportLinesMatrix(reports), 'To reconcile', `merchant-reports-to-reconcile-${todayMY()}.xlsx`);
      return;
    }
    const { generateReportLinesPdf } = await import('../../vendor/scm/lib/merchant-recon-pdf');
    await generateReportLinesPdf(reports, { merchant: acq });
  });
  const exportCardsPdf = (view: TablePdfView<WaitingCard>) => runExport('cards', 'PDF', async () => {
    const { generateWaitingCardsPdf } = await import('../../vendor/scm/lib/merchant-recon-pdf');
    await generateWaitingCardsPdf(view, { merchant: acq });
  });

  return (
    <div className="space-y-4">
      {/* 1. The reports that still need decisions. */}
      <section className="space-y-2">
        <b>Merchant reports still to reconcile</b>
        {/* Two different empty states, and only one of them may claim anything:
            "every report is done" is spoken over reports that were READ and
            counted; zero reports read gets a sentence about what was looked
            for, because an absence is never evidence (owner 2026-08-17). A
            failed read renders neither. */}
        {batches.data && open.length === 0 && (
          all.length === 0 ? (
            <div style={softText}>
              No merchant report has been uploaded yet — upload one above and its lines are matched
              against what the ERP recorded.
            </div>
          ) : (
            <div style={{ fontSize: 'var(--fs-13)', color: good }}>
              Nothing to reconcile — every merchant report you have uploaded is done.
            </div>
          )
        )}
        {/* The same one press as the upload summary, because the list outlives
            that screen: reload the page, come back tomorrow, and the reports
            are still here wanting the identical decision. Only the lines that
            matched by reference — the ones needing a person are untouched and
            still counted below. */}
        {readyToConfirm > 0 && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" style={btn(true, bulk.busy)} disabled={bulk.busy}
              onClick={() => { void bulk.run(everyOpen); }}>
              {/* Says its scope too: one press here covers every report with
                  something to post, and the button inside a report covers only
                  that one. */}
              <CheckCheck {...ICON} /> {bulk.busy ? 'Posting…'
                : `Confirm all ${readyToConfirm} matched, across ${toPost} report${toPost === 1 ? '' : 's'}`}
            </button>
            <span style={softText}>
              Books each line&rsquo;s fee;
              {stillToDecide > 0 ? ` the ${stillToDecide} line(s) needing you are left alone.` : ' nothing else is touched.'}
            </span>
          </div>
        )}
        {bulk.posted && <PostedNote posted={bulk.posted} />}
        {/* Every line still to do, with the sale it matched — the same two
            columns as the upload summary, for the same reason: a file name is
            not a transaction (owner: 显示 transaction detail 和 sales order
            detail, 而不是 document 罢了). */}
        {exportNote?.list === 'reports' && <ExportStatus note={exportNote} />}
        {open.length > 0 && <LinesTable batches={open} openOnly onOpen={setBatchId} onExport={exportReports} />}
        {/* Done, and therefore not on this screen's list — but say so, and say
            where they went, so "it disappeared" never has to be a question. */}
        {cleared.length > 0 && (
          <div style={softText}>
            {cleared.length} report{cleared.length === 1 ? '' : 's'} fully reconciled —{' '}
            <Link to="/scm/bank-recon">bank statement reconciliation</Link> carries them now.{' '}
            <button type="button" style={{ ...btn(), padding: '2px 8px' }} onClick={() => setShowDone(!showDone)}>
              {showDone ? 'Hide' : 'Show'}
            </button>
          </div>
        )}
        {showDone && cleared.length > 0 && (
          <table style={table}>
            <tbody>
              {cleared.map((b) => (
                <tr key={b.id} style={rowLine}>
                  <td style={cell}><span className={styles.codeChip}>{b.acquirer_code}</span></td>
                  <td style={cell}>{b.file_name}</td>
                  <td style={cell}>{b.period_from} → {b.period_to}</td>
                  <td style={num}>{fmt(payableOf(b))}</td>
                  <td style={{ ...cell, color: good }}>{b.confirmed_count} line(s) done</td>
                  <td style={cell}>
                    <button type="button" style={btn()} onClick={() => setBatchId(b.id)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 2. The other side of "not matched yet": the ERP has it, no report does.
             His words: 我还没收到钱的是那几笔. */}
      <section className="space-y-2">
        <b>{`Card payments no merchant report has reported yet (${waiting.length})`}</b>
        <div style={softText}>
          Keyed in by the sales team; the merchant has not put them on a report. {fmt(waitingSen)} in total.
          {untagged > 0 && ` ${untagged} keyed in without a bank (未标): shown once here, offered to each merchant's report, and named by the one that confirms it.`}
        </div>
        {exportNote?.list === 'cards' && <ExportStatus note={exportNote} />}
        <DataTable<WaitingCard>
          tableId="merchant-recon-waiting"
          exportName="card-payments-not-reported"
          exportXlsx
          onExportPdf={exportCardsPdf}
          columns={WAITING_COLUMNS}
          rows={watchlist.data ? waiting : null}
          loading={watchlist.isLoading}
          error={watchlist.isError ? 'The watch list did not load.' : null}
          emptyLabel="Every card payment recorded is on a merchant report."
          getRowKey={(p) => `${p.source}:${p.id}`}
        />
      </section>
    </div>
  );
};

type ExportNote = { list: 'reports' | 'cards'; text: string; failed: boolean };
const ExportStatus = ({ note }: { note: ExportNote }) => (
  note.failed
    ? <div role="alert" style={{ ...softText, color: danger }}>{note.text}</div>
    : <div role="status" style={softText}>{note.text}</div>
);

type WaitingCard = Watchlist['recordedNotArrived'][number];
const WAITING_COLUMNS: Column<WaitingCard>[] = [
  { key: 'merchant', label: 'Merchant', render: (p) => <span className={styles.codeChip}>{p.acquirerCode ?? '未标'}</span>, getValue: (p) => p.acquirerCode ?? '未标' },
  { key: 'document', label: 'Document', render: (p) => <DocLink source={p.source} docNo={p.docNo} />, getValue: (p) => p.docNo },
  /* The order's Ref No. (owner 2026-11-06: 我要有那个 reference HC, ZNT 等等). */
  { key: 'refNo', label: 'Ref No.', render: (p) => customerRefOf(p) || '—', getValue: (p) => customerRefOf(p) },
  { key: 'salesperson', label: 'Salesperson', render: (p) => p.salespersonName ?? '—', getValue: (p) => p.salespersonName ?? '' },
  { key: 'paidOn', label: 'Customer paid on', render: (p) => fmtDate(p.paidOn), getValue: (p) => p.paidOn, exportFormat: 'date' },
  {
    key: 'days', label: 'Days', align: 'right',
    render: (p) => <span style={{ color: p.ageDays > 14 ? danger : undefined, fontWeight: p.ageDays > 14 ? 700 : undefined }}>{p.ageDays}</span>,
    getValue: (p) => p.ageDays, exportFormat: 'number',
  },
  {
    key: 'amount', label: 'Amount', align: 'right', render: (p) => fmt(p.amountSen),
    getValue: (p) => p.amountSen, exportValue: (p) => p.amountSen / 100, exportFormat: 'money',
  },
  /* Beside Approval, as on the report's own lines: staff key the booklet number under one and
     the swipe code under the other, in either order. */
  { key: 'accountSheet', label: 'Account sheet', render: (p) => p.accountSheet ?? '—', getValue: (p) => p.accountSheet ?? '' },
  { key: 'approval', label: 'Approval', render: (p) => p.approvalCode ?? '—', getValue: (p) => p.approvalCode ?? '' },
];

/* ── What the upload found ────────────────────────────────────────────────────
   The owner uploads a month of reports in one go, and asked for one answer for
   the lot rather than being dropped into the last file (2026-08-18): 当我上传完
   全部文件后…让我知道我 upload 的文件有哪里几笔是 match 的，有哪里几笔是我要
   manual check 或 verify 的，有哪里几笔会是 merchant 收到但完全 match 不上的.

   Those are exactly three numbers, and they are three different jobs:
     matched by reference — a button;
     to check by hand     — candidates found, a person must choose;
     no sale in the ERP   — the merchant reported money nobody recorded. */

/* ── Confirm a whole pile of reports with one press ───────────────────────────
   The owner, on a list of four reports each carrying its own Reconcile button:
   "但是当我upload 很多时我要一个一个按confirm?". No — a line matched by its
   approval code needs no judgement, and a month of statements is a lot of
   identical presses.

   Posted one report at a time, deliberately: the server confirms a batch at a
   time, so a refusal names ITS OWN file instead of failing the pile, and what
   went through stays through. Sequential, not parallel, for the same reason
   the upload is — each confirmation must see the payments the previous one
   already claimed.

   ONLY the reports with something to post, and ONE refresh at the end (owner
   2026-10-21, on "Posted 0. 52 could not be — Network error"). Every open
   report used to get a request — 79 of them for one matched line — and after
   EACH one the whole screen was read again, every open report's lines with it,
   so one press sent thousands of requests that the next refresh cut off. The
   connection choked and the screen called "failed" what the server had done. */

/** A report the press has work in: a line matched by reference, or a
    statement charge not yet booked — which the press books too. */
export const worthConfirming = (b: SettlementBatch): boolean =>
  (b.to_confirm_count ?? 0) > 0 || (Number(b.adjustment_sen) !== 0 && !b.adjustment_je_no);

type Posted = { lines: number; charges: number; failures: Array<{ file: string; reason: string }> };

const useConfirmAcross = () => {
  const refresh = useInvalidateAfterPosting();
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<Posted | null>(null);

  const run = async (batches: SettlementBatch[]) => {
    setBusy(true);
    setPosted(null);
    const out: Posted = { lines: 0, charges: 0, failures: [] };
    for (const b of batches.filter(worthConfirming)) {
      try {
        const r = await confirmMatchedBatch(b.id);
        out.lines += r.confirmed;
        if (r.statementCharge?.status === 'posted') out.charges += 1;
        for (const f of r.failed) out.failures.push({ file: b.file_name, reason: f.reason });
      } catch (e) {
        /* One report's failure is that report's line on the note; the rest go on. */
        out.failures.push({ file: b.file_name, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    refresh();
    setBusy(false);
    setPosted(out);
  };

  return { run, busy, posted };
};

/* ── The merchant side is finished ────────────────────────────────────────────
   Every line of every report decided, so step 1 of 2 is over and the only
   thing left is the money — 剩下要核对bank statement 罢了. It says what the
   merchants still owe, because that is the number the next screen is about,
   and it names the ones already paid rather than counting them silently. */

const UploadDone = ({ batches }: { batches: SettlementBatch[] }) => {
  const lines = batches.reduce((s, b) => s + (b.confirmed_count ?? 0), 0);
  const owed = batches.reduce((s, b) => s + (b.outstanding_sen ?? payableOf(b) - (b.received_sen ?? 0)), 0);
  const waitingOn = batches.filter((b) => (b.outstanding_sen ?? payableOf(b) - (b.received_sen ?? 0)) !== 0);

  return (
    <div style={{ ...panel(owed === 0 ? 'good' : 'plain'), display: 'grid', gap: 'var(--space-2)' }}>
      <b>
        {`Merchant reconciliation done — ${lines} line${lines === 1 ? '' : 's'} across `
          + `${batches.length} report${batches.length === 1 ? '' : 's'}, every one matched and booked.`}
      </b>
      {owed === 0 ? (
        <span style={softText}>The payouts are in the bank too. Nothing is outstanding.</span>
      ) : (
        <>
          {/* Says the amount and who owes it, once. The screen it goes to is
              named by the button below and nowhere else. */}
          <span style={softText}>
            {`Still to come: ${fmt(owed)} from `}
            {[...new Set(waitingOn.map((b) => b.acquirer_code))].join(', ')}
            {' — match it against the bank next.'}
          </span>
          <div>
            <Link to="/scm/bank-recon" style={{ ...btn(true), textDecoration: 'none' }}>
              Bank statement reconciliation <ArrowRight {...ICON} />
            </Link>
          </div>
        </>
      )}
    </div>
  );
};

/* Says what posted — lines AND the statement charges the press books with them
   — and, for what did not, which report and why, in the server's own words. */
const PostedNote = ({ posted }: { posted: Posted }) => {
  const what = [
    `${posted.lines} line${posted.lines === 1 ? '' : 's'}`,
    ...(posted.charges > 0 ? [`${posted.charges} statement charge${posted.charges === 1 ? '' : 's'}`] : []),
  ].join(' and ');
  const n = posted.failures.length;
  return (
    <div style={{ fontSize: 'var(--fs-13)', color: n ? danger : good, display: 'grid', gap: 2 }}>
      <span>Posted {what}.{n > 0 ? ` ${n} could not be:` : ''}</span>
      {posted.failures.slice(0, 5).map((f, i) => <span key={i}><b>{f.file}</b> — {f.reason}</span>)}
      {n > 5 && <span>…and {n - 5} more — open the report to see why.</span>}
    </div>
  );
};

const UploadSummary = ({ batchIds, refusals, leftOut, onOpen, onDone }: {
  batchIds: number[];
  refusals: Array<{ name: string; text: string }>;
  /** Files read whole but one or more lines short — already on another report (docs/bugs/0823). */
  leftOut: Array<{ name: string; text: string }>;
  onOpen: (id: number) => void;
  onDone: () => void;
}) => {
  const batches = useSettlementBatches();
  const bulk = useConfirmAcross();
  const [showPosted, setShowPosted] = useState(false);

  const mine = (batches.data?.batches ?? []).filter((b) => batchIds.includes(b.id));
  const sum = (pick: (b: SettlementBatch) => number) => mine.reduce((s, b) => s + pick(b), 0);
  const lines = sum((b) => b.row_count);
  const toConfirm = sum((b) => b.to_confirm_count ?? 0);
  const toCheck = sum((b) => b.to_choose_count ?? 0);
  const noRecord = sum((b) => b.no_record_count ?? 0);
  const done = sum((b) => b.confirmed_count ?? 0);
  const { busy, posted } = bulk;
  /* Read off the batches themselves, not off what this screen just posted:
     the same conclusion has to hold when he comes back to it tomorrow. Held
     back until the list has answered, so "loading" never reads as "done". */
  const allDone = mine.length > 0 && sum((b) => b.open_count ?? 0) === 0;

  return (
    <div className="space-y-4">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <button type="button" style={btn()} onClick={onDone}><ArrowLeft {...ICON} /> All reports</button>
        <b>{`${mine.length} report${mine.length === 1 ? '' : 's'} read · ${lines} line${lines === 1 ? '' : 's'}`}</b>
      </div>

      {/* Nothing left to decide = this job is OVER, and the screen has to say
          so instead of going on offering work. The owner, looking at four
          lines stamped done · JE-2608-0013 under a live "Confirm all 4
          matched": posted all 了就应该核对完了，剩下要核对bank statement 罢了.
          So the three piles and the button are what is STILL to do, and they
          leave when there is nothing. */}
      {!allDone && (
        <>
          {/* The three numbers, largest first — each one a different job. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 'var(--space-3)' }}>
            <Tally n={toConfirm} label="matched by reference" note="ready to confirm" tone="good" />
            <Tally n={toCheck} label="to check by hand" note="candidates found — you choose" tone="plain" />
            <Tally n={noRecord} label="no sale in the ERP" note="the merchant reported it, nobody recorded it" tone="danger" />
          </div>

          {toConfirm > 0 && (
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" style={btn(true, busy)} disabled={busy} onClick={() => { void bulk.run(mine); }}>
                <CheckCheck {...ICON} /> {busy ? 'Posting…' : `Confirm all ${toConfirm} matched`}
              </button>
              <span style={softText}>Books each line&rsquo;s fee. The money itself is the next screen.</span>
            </div>
          )}
          {posted && <PostedNote posted={posted} />}
          {done > 0 && !posted && <div style={softText}>{done} line(s) were already confirmed.</div>}
        </>
      )}
      {allDone && <UploadDone batches={mine} />}
      {/* Hidden, not thrown away: the lines are off the screen because they are
          off this job, but the journal numbers they posted are the first thing
          anybody asks for afterwards. */}
      {allDone && (
        <div>
          <button type="button" style={{ ...btn(), padding: '2px 8px' }} onClick={() => setShowPosted(!showPosted)}>
            {showPosted ? 'Hide' : 'Show'} what was posted
          </button>
        </div>
      )}
      {allDone && showPosted && <LinesTable batches={mine} onOpen={onOpen} />}

      {/* A file the server refused never became a report — it has no row below,
          so it says its own reason here or it says nothing anywhere. */}
      {refusals.map((r) => (
        <div key={r.name} style={{ fontSize: 'var(--fs-13)', color: danger, display: 'flex', gap: 6 }}>
          <AlertTriangle {...ICON} />
          <span><b>{r.name}</b> — {r.text}</span>
        </div>
      ))}
      {/* A file read whole but a line short: the line is on another report
          already, and the bank pays it once (docs/bugs/0823). Said here, or
          the operator sees a report missing a line and no reason. */}
      {leftOut.map((r) => (
        <div key={`left-${r.name}`} style={{ fontSize: 'var(--fs-13)', display: 'flex', gap: 6 }}>
          <AlertTriangle {...ICON} />
          <span><b>{r.name}</b> — {r.text}</span>
        </div>
      ))}

      {/* Every line STILL TO DO, not a count per file — the operator is
          reconciling transactions, and a file name is not one (owner: 我希望他是
          显示 transaction detail 和 sales order detail, 而不是 document 罢了).
          Each row is the merchant's line beside the sale it matched.

          Still to do, because a confirmed line has left this job: 他confirm 了
          下面就不应该显示了，就应该显示在 bank statement reconciliation 那个区域.
          Straight after an upload nothing is confirmed yet, so this is still
          every line the files contained; confirm them and they empty out of
          here and into the panel's next screen. */}
      {!allDone && <LinesTable batches={mine} onOpen={onOpen} openOnly />}
    </div>
  );
};

/* ── Every line, in ONE table ──────────────────────────────────────────────────
   The owner, looking at four reports each with its own repeated header: "这个可
   以做成一个table吗？就是有header的". One header, one table; each report is a
   tbody, and its name spans its own lines instead of being restated on each.

   `openOnly` is the difference between the two places this appears: the work
   list shows what is still to do, the upload summary shows everything that
   upload read. */

/* A DuitNow QR line's Reference cell (owner 2026-11-09: 0000PP 是 qr direct 去
   bank 的，不算卡机的): Hong Leong prints a placeholder there, so the line says
   what it is instead. */
const RefCell = ({ row }: { row: SettlementRow }) => (isQrLine(row)
  ? <span className={styles.codeChip}>{QR_REF_WORDS}</span>
  : row.ref ? <b>{row.ref}</b> : <span className={grid.sub}>—</span>);

/** A report's QR money, said beside its net and never in it: its sales put it in the bank. */
const qrMoneyWords = (sen: number): string => `QR ${fmt(sen)} · straight to the bank`;

const LinesTable = ({ batches, onOpen, openOnly, onExport }: {
  batches: SettlementBatch[]; onOpen: (id: number) => void; openOnly?: boolean;
  /** The work list exports from its header's right-click; the upload summary does not. */
  onExport?: (how: 'excel' | 'pdf') => void;
}) => {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  return (
  /* TWO BANDS, not one column of stacked text. The owner, on a Report cell
     holding a chip, a file name, a period, a total and a button: 可以分成多个
     column 吗？不然有一点点难看，太多信息 — 我理想中应该左手边都是 merchant
     report 的资料，然后紧挨着就是订单的资料.

     So the header says it in two tiers: everything the MERCHANT said on the
     left, everything the ERP said immediately beside it, and a rule down the
     seam. Each fact gets a column of its own, which is what makes a
     reconciliation readable down as well as across — the same gross under the
     same gross, the same fee under the same fee. */
  <>
  <table className={grid.grid}>
    <thead
      title={onExport ? 'Right-click to export to Excel or PDF' : undefined}
      onContextMenu={onExport ? (e) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); } : undefined}
    >
      <tr>
        <th rowSpan={2}>Report</th>
        <th colSpan={5} className={grid.band}>What the merchant reported</th>
        <th colSpan={7} className={`${grid.band} ${grid.seam}`}>The sale it paid for</th>
        <th rowSpan={2}>Status</th>
      </tr>
      <tr>
        <th>Date</th>
        <th>Reference</th>
        <th className={grid.num}>Gross</th>
        <th className={grid.num}>Fee</th>
        <th className={grid.num}>Net</th>
        <th className={grid.seam}>Document</th>
        <th>Customer</th>
        <th>Sales</th>
        <th>Account sheet</th>
        <th>Paid on</th>
        <th>Approval</th>
        <th className={grid.num}>Amount</th>
      </tr>
    </thead>
    {batches.map((b) => <BatchRows key={b.id} batch={b} onOpen={onOpen} openOnly={openOnly} />)}
  </table>
  {menuAt && onExport && (
    <HeaderExportMenu at={menuAt} onClose={() => setMenuAt(null)} onExcel={() => onExport('excel')} onPdf={() => onExport('pdf')} />
  )}
  </>
  );
};

const BatchRows = ({ batch, onOpen, openOnly }: {
  batch: SettlementBatch; onOpen: (id: number) => void; openOnly?: boolean;
}) => {
  const q = useSettlementBatch(batch.id);
  const all = q.data?.rows ?? [];
  /* On the work list, only what is still to do — a line already decided is not
     work. On the upload summary, everything the file contained. */
  const rows = openOnly ? all.filter(isOpenLine) : all;

  /* The report names itself once, down the side of its own lines. */
  const reportCell = (span: number) => (
    <td className={grid.report} rowSpan={span}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className={styles.codeChip}>{batch.acquirer_code}</span>
        <b style={{ wordBreak: 'break-all' }}>{batch.file_name}</b>
      </div>
      {/* The period is on every line below as its own date; only the report's
          TOTAL is worth repeating here, because no single line carries it. */}
      <div className={grid.sub}>net {fmt(payableOf(batch))}</div>
      {/* QR money is no part of that net: its sales put it in the bank (owner 2026-11-09). */}
      {(batch.qr_gross_sen ?? 0) !== 0 && <div className={grid.sub}>{qrMoneyWords(batch.qr_gross_sen ?? 0)}</div>}
      <button type="button" style={{ ...btn(openOnly === true), marginTop: 6 }} onClick={() => onOpen(batch.id)}>
        {openOnly ? 'Reconcile' : 'Open'}
      </button>
    </td>
  );

  if (rows.length === 0) {
    return (
      <tbody>
        <tr>
          {reportCell(1)}
          <td colSpan={13}>
            <span className={grid.sub}>{q.isLoading ? 'Reading its lines…' : 'Nothing left on this report.'}</span>
          </td>
        </tr>
      </tbody>
    );
  }

  return (
    <tbody>
      {rows.map((r, i) => {
        const status = lineStatus(r);
        const orders = ordersOf(r);
        /* One line settling several orders stacks INSIDE its cell — the rare
           case, and the only place stacking is still the honest shape. */
        const stack = (pick: (o: typeof orders[number]) => React.ReactNode) => (
          orders.length === 0
            ? <span className={grid.sub}>—</span>
            : orders.map((o) => <div key={o.key}>{pick(o) ?? '—'}</div>)
        );

        return (
          <tr key={r.id}>
            {i === 0 && reportCell(rows.length)}
            <td>
              <div>{r.txn_date}</div>
              <div className={grid.sub}>line {r.line_no}</div>
            </td>
            <td><RefCell row={r} /></td>
            <td className={grid.num}>{fmt(r.gross_sen)}</td>
            <td className={grid.num}>{fmt(r.fee_sen)}</td>
            <td className={grid.num}>{fmt(r.net_sen)}</td>

            <td className={grid.seam}>
              {orders.length === 0
                ? <span className={grid.sub}>{r.candidates.length > 0 ? `${r.candidates.length} possible` : '—'}</span>
                : stack((o) => <DocLink source={o.source} docNo={o.docNo} bold />)}
            </td>
            <td>{stack((o) => o.customer)}</td>
            <td>{stack((o) => o.sales)}</td>
            <td>{stack((o) => o.sheet)}</td>
            <td>{stack((o) => o.paidOn)}</td>
            <td>{stack((o) => o.code)}</td>
            <td className={grid.num}>{stack((o) => fmt(o.amountSen))}</td>

            <td>
              {status === 'done'
                ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                    <span className={grid.good}>{LINE_STATUS_WORDS.done}{r.posted_je_no ? ` · ${r.posted_je_no}` : ''}</span>
                    <UndoDone rowId={r.id} />
                  </span>
                )
                : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                    <span className={status === 'matched' ? grid.good : status === 'none' ? grid.bad : undefined}>{statusWordsOf(r)}</span>
                    {/* The sale shown is the machine's — by reference, or its guess — so it can be turned down here. */}
                    {status === 'matched' && <NotThis rowId={r.id} />}
                    {status === 'guess' && <NotThis rowId={r.id} guessed={(r.suggested ?? []).map(key)} />}
                  </span>
                )}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
};

/* The way back out of the ledger — the ignore refusal has always named it,
   and now a button performs it: reverse the fee entry, release the payments,
   put the line back among the ones to decide. Refused by the server while
   money is recorded received against the statement, and the server's sentence
   is shown verbatim. */
const UndoDone = ({ rowId }: { rowId: number }) => {
  const undo = useUnconfirmSettlementRow();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        style={{ ...btn(false, undo.isPending), marginLeft: 8 }}
        disabled={undo.isPending}
        title="Take this line back out of the ledger — its fee entry is reversed and the payment is claimable again"
        onClick={() => { setError(null); undo.mutate(rowId, { onError: (e) => setError(refusalText(e, 'The line could not be taken back.')) }); }}
      >
        <Undo2 {...ICON} /> Undo
      </button>
      {error && <div className={grid.bad} style={{ fontSize: 'var(--fs-12, 12px)' }}>{error}</div>}
    </>
  );
};

/** "Not this" on a line the machine matched and nobody confirmed (owner
    2026-11-03, batch 3 d2): the match is released, the line goes to To choose,
    and that payment is not offered to it again. Nothing posts.
    `guessed` — the system's GUESS the line shows, when it holds no link (owner
    2026-11-10: 这个 system guess 的，如果我确定了不是有没有按钮可以按不是了): the
    line remembers those payments and is not offered them again. */
const NotThis = ({ rowId, guessed = [] }: { rowId: number; guessed?: readonly string[] }) => {
  const release = useReleaseSettlementRow();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        style={{ ...btn(false, release.isPending), marginLeft: 8 }}
        disabled={release.isPending}
        title={guessed.length > 0
          ? 'This is not the sale — the system will not suggest it for this line again. Nothing is posted.'
          : 'This is not the sale — release the match and choose the right one. Nothing is posted.'}
        onClick={() => {
          setError(null);
          release.mutate({ rowId, payments: [...guessed] }, { onError: (e) => setError(refusalText(e, 'The match was not released.')) });
        }}
      >
        Not this
      </button>
      {error && <div className={grid.bad} style={{ fontSize: 'var(--fs-12, 12px)' }}>{error}</div>}
    </>
  );
};

const Tally = ({ n, label, note, tone }: {
  n: number; label: string; note: string; tone: 'good' | 'danger' | 'plain';
}) => (
  <div style={{ ...panel(n === 0 ? 'plain' : tone), display: 'flex', flexDirection: 'column', gap: 2 }}>
    <div style={{ fontSize: 'var(--fs-24, 22px)', fontWeight: 700 }}>{n}</div>
    <div style={{ fontWeight: 600 }}>{label}</div>
    <div style={softText}>{note}</div>
  </div>
);

/* ── One statement: the lines still to decide ─────────────────────────────────
   Lines already decided are OFF this screen by default — "只会显示还没对上的".
   The counts stay in view so nothing is hidden, and one checkbox brings the
   finished lines back for a look. */

/** Where a Public Bank report's money stands before it is paid: in an advice, or waiting for one. Null until the advices have loaded — an absence is never evidence. */
const pbbPayNote = (batchId: number, payouts: Payout[] | undefined): string | null => {
  if (!payouts) return null;
  const p = payouts.find((x) => x.status.days.some((d) => d.batchId === batchId));
  return p ? `In the advice of ${fmtDate(p.advice_date)} · books when the bank statement shows the credit` : "Waiting for Public Bank's payment advice (PDF)";
};

const BatchView = ({ batchId, onBack }: { batchId: number; onBack: () => void }) => {
  const q = useSettlementBatch(batchId);
  /* Public Bank pays through its advice: until one names this report, the report waits for it (the redesign). */
  const payouts = usePayouts();
  /* Back from an order opened on one of these lines lands on that line. */
  useReturnScroll(q.data != null);
  const confirmAll = useConfirmMatched();

  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const batch = q.data?.batch ?? null;
  /* A payment Finance corrected after the upload: the server read it back as
     this report opened and says which links moved (docs/bugs/0833). */
  const refreshed = q.data?.refreshedLinks ?? [];
  const openRows = rows.filter((r) => !r.confirmed_at && r.bucket !== 'IGNORED');
  const doneRows = rows.filter((r) => r.confirmed_at || r.bucket === 'IGNORED');
  const unconfirmedMatched = rows.filter((r) => r.bucket === 'MATCHED' && !r.confirmed_at).length;
  /* A line that already claimed its payment needs a button; one that has not
     needs a person. The screen must not call them the same thing. */
  const toConfirm = openRows.filter((r) => r.linked.length > 0).length;
  const toDecide = openRows.length - toConfirm;
  /* The redesign's five tabs (owner's Claude Design, batch 3): To confirm · To
     choose · No sale found ‖ Confirmed · Set aside — the tab lives in the
     address (?tab=), and a report opens on the first with lines to work. */
  const counts: Record<ReportTab, number> = { 'to-confirm': 0, 'to-choose': 0, 'no-sale': 0, done: 0, 'set-aside': 0 };
  for (const r of rows) counts[lineTab(r)] += 1;
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') as ReportTab | null;
  const tab: ReportTab = asked && asked in counts ? asked
    : (['to-confirm', 'to-choose', 'no-sale'] as const).find((t) => counts[t] > 0) ?? 'done';
  const setTab = (t: ReportTab) => setParams((prev) => { const next = new URLSearchParams(prev); next.set('tab', t); return next; }, { replace: true });
  /* A CARD IS A DECISION, a table row is information: lines to choose for, or
     with no sale, and lines set aside (Put back) are cards; matched and
     confirmed lines are table rows. */
  const inTab = rows.filter((r) => lineTab(r) === tab);
  const needChoice = tab === 'to-choose' || tab === 'no-sale' || tab === 'set-aside' ? inTab : [];
  const noChoice = needChoice.length > 0 ? [] : inTab;

  const exportCsv = () => {
    downloadCSV(`merchant-report-${batchId}.csv`, toCSV(rows, [
      { key: 'line', label: 'Line', getValue: (r) => r.line_no },
      { key: 'date', label: 'Date', getValue: (r) => r.txn_date },
      { key: 'ref', label: 'Reference', getValue: (r) => r.ref ?? '' },
      { key: 'gross', label: 'Gross', getValue: (r) => (r.gross_sen / 100).toFixed(2) },
      { key: 'fee', label: 'Fee', getValue: (r) => (r.fee_sen / 100).toFixed(2) },
      { key: 'net', label: 'Net', getValue: (r) => (r.net_sen / 100).toFixed(2) },
      { key: 'bucket', label: 'Bucket', getValue: (r) => BUCKET_LABEL[r.bucket] },
      { key: 'je', label: 'Journal', getValue: (r) => r.posted_je_no ?? '' },
      { key: 'note', label: 'Note', getValue: (r) => r.clue ?? r.notes ?? '' },
    ]));
  };

  return (
    <section className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <button type="button" style={btn()} onClick={onBack}><ArrowLeft {...ICON} /> All reports</button>
        <b>{batch ? `${batch.acquirer_code} · ${batch.file_name}` : 'Loading…'}</b>
        {batch && <span style={softText}>{batch.period_from} → {batch.period_to} · net {fmt(payableOf(batch))}</span>}
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 'var(--fs-13)' }}>
          {openRows.length === 0 ? 'Every line is decided.' : [
            /* Matched by reference is NOT a decision — it is one button. Saying
               "still to decide" about it is what made an auto-matched line read
               as a problem (owner: 出现的这个是什么？). */
            toConfirm > 0 ? `${toConfirm} matched, waiting for you to confirm` : null,
            toDecide > 0 ? `${toDecide} still to decide` : null,
          ].filter(Boolean).join(' · ')}
        </b>
        <span style={softText}>
          {`${rows.filter((r) => r.confirmed_at).length} done · ${rows.filter((r) => r.bucket === 'IGNORED').length} set aside`}
        </span>
        <span style={{ flex: 1 }} />
        {unconfirmedMatched > 0 && (
          <button type="button" style={btn(true, confirmAll.isPending)} disabled={confirmAll.isPending}
            onClick={() => confirmAll.mutate(batchId)}>
            {/* SAY THE SCOPE. The list screen has a button of its own that
                clears every report at once, and seeing two identically-worded
                buttons on two screens reads as two steps — the owner: 我不是很
                明白为什么会要按两个 confirm? Either one is enough; they differ
                only in how much they cover, so each says how much. */}
            <CheckCheck {...ICON} /> Confirm the {unconfirmedMatched} matched on this report
          </button>
        )}
        <button type="button" style={btn()} onClick={exportCsv}><Download {...ICON} /> Export</button>
      </div>

      {/* The charge the STATEMENT makes that no transaction on it explains —
          AEON's subvention fee. Shown whether or not it is booked yet, because
          an unbooked one means in-transit is holding money that is never coming. */}
      {batch && batch.adjustment_sen !== 0 && (
        <div style={panel(batch.adjustment_je_no ? 'good' : 'danger')}>
          <b>Merchant charge on no transaction: {fmt(Math.abs(batch.adjustment_sen))}</b>
          <div style={softText}>
            Lines come to {fmt(batch.net_sen)}; {batch.acquirer_code} says it is paying {fmt(batch.stated_net_sen ?? 0)}.
            {batch.adjustment_je_no ? ` Booked as ${batch.adjustment_je_no}.` : ' Confirm the report and it books.'}
          </div>
        </div>
      )}

      {confirmAll.data && (
        <div style={{ fontSize: 'var(--fs-13)', color: confirmAll.data.failed.length ? danger : good }}>
          Posted {confirmAll.data.confirmed} of {confirmAll.data.attempted}.
          {confirmAll.data.statementCharge?.jeNo && ` Statement charge booked as ${confirmAll.data.statementCharge.jeNo}.`}
          {confirmAll.data.failed.map((f) => <div key={f.rowId}>{f.rowId ? `Line ${f.rowId}: ` : ''}{f.reason}</div>)}
        </div>
      )}

      {refreshed.length > 0 && (
        <div style={panel('good')} data-testid="refreshed-links">
          <b>{refreshed.length} link{refreshed.length === 1 ? '' : 's'} refreshed to the payment's current amount</b>
          <div style={softText}>
            {refreshed.map((l) => `${l.docNo ?? l.paymentId}: ${fmt(l.fromSen)} → ${fmt(l.toSen)}`).join(' · ')}
          </div>
        </div>
      )}

      {batch && <HandOff batch={batch} toConfirm={toConfirm} toDecide={toDecide} />}

      {batch && <ReportHead batch={batch} counts={counts} payNote={batch.acquirer_code === 'PBB' ? pbbPayNote(batch.id, payouts.data?.payouts) : null} />}
      {batch && <ReportTabs tab={tab} counts={counts} onTab={setTab} />}
      {batch && inTab.length === 0 && <div style={softText}>{TAB_EMPTY[tab]}</div>}

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading the report…</div>}

      {/* A CARD IS A DECISION. A line already matched by its reference asks
          nothing — the button at the top books all of them at once — so giving
          it the same fat card as a line needing a choice buried the choices
          among them. The owner, on 27 identical cards under one button that
          would have cleared all 27: 这个是什么?

          So the ones that only need the button are a table, and the ones that
          need a person are cards. */}
      {noChoice.length > 0 && (
        <table className={grid.grid}>
          <thead>
            <tr>
              <th>Date</th><th>Reference</th>
              <th className={grid.num}>Gross</th><th className={grid.num}>Fee</th><th className={grid.num}>Net</th>
              <th className={grid.seam}>Matched to</th><th>Sales</th><th>Account sheet</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {noChoice.map((r) => (
              <tr key={r.id}>
                <td>{r.txn_date}<div className={grid.sub}>line {r.line_no}</div></td>
                <td><RefCell row={r} /></td>
                <td className={grid.num}>{fmt(r.gross_sen)}</td>
                <td className={grid.num}>{fmt(r.fee_sen)}</td>
                <td className={grid.num}>{fmt(r.net_sen)}</td>
                <td className={grid.seam}>
                  {r.matched_with && (
                    <div className={grid.sub}>
                      with line {r.matched_with.lines.filter((g) => g.rowId !== r.id).map((g) => g.lineNo).join(', ')} · together {fmt(r.matched_with.grossSen)}
                    </div>
                  )}
                  {r.linked.map((l) => (
                    <div key={l.payment_id}>
                      {l.doc_no ? <DocLink source={l.payment_source} docNo={l.doc_no} bold /> : <b>{l.payment_id}</b>}
                      {l.customer_name ? <span className={grid.sub}> · {l.customer_name}</span> : null}
                    </div>
                  ))}
                </td>
                <td>{r.linked.map((l) => <div key={l.payment_id}>{l.salesperson ?? '—'}</div>)}</td>
                <td>{r.linked.map((l) => <div key={l.payment_id}>{l.account_sheet ?? '—'}</div>)}</td>
                <td>
                  {r.confirmed_at
                    ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                        <span className={grid.good}>done{r.posted_je_no ? ` · ${r.posted_je_no}` : ''}</span>
                        <UndoDone rowId={r.id} />
                      </span>
                    )
                    : r.bucket === 'IGNORED'
                      ? <span style={softText}>set aside</span>
                      : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                          <span className={grid.good}>matched — the button above books it</span>
                          {r.linked.length > 0 && <NotThis rowId={r.id} />}
                        </span>
                      )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Said ONCE. It used to sit under every line — 27 copies of the same
          paragraph on this report alone. */}
      {needChoice.length > 0 && (
        <div style={softText}>
          &ldquo;Set aside&rdquo; just moves a line out of the working list — it books nothing and the
          money stays in settlement-in-transit. Use it for a line you have looked at and decided to
          deal with another way; you can put it back at any time.
        </div>
      )}
      {needChoice.map((r) => (
        <SettlementLine key={r.id} row={r}
          others={openRows.filter((o) => o.id !== r.id && o.linked.length === 0)} />
      ))}
    </section>
  );
};

/* ── Where this report goes next ──────────────────────────────────────────────
   The hand-off, and the owner's rule about it: 核对完了没有问题才会显示去 bank
   statement 的 reconciliation. Until every line is decided, this says what is
   left; after that, it says what the merchant owes and offers the next step. */

const HandOff = ({ batch, toConfirm, toDecide }: { batch: SettlementBatch; toConfirm: number; toDecide: number }) => {
  const payable = payableOf(batch);
  const outstanding = batch.outstanding_sen ?? payable - (batch.received_sen ?? 0);

  /* The counts are stated once, at the top. This line says only what happens
     next — repeating "1 to confirm" two inches below "1 to confirm" is the
     duplication the owner was looking at. */
  if (toConfirm > 0 || toDecide > 0) {
    return (
      <div style={softText}>
        Bank statement reconciliation opens for this report once every line is done.
      </div>
    );
  }
  /* A report of DuitNow QR money owes nothing through the clearing account: the
     bank's QR credit is matched to the linked sales instead (owner 2026-11-09). */
  if (payable === 0 && (batch.qr_gross_sen ?? 0) !== 0) {
    return (
      <div style={{ ...panel('plain'), display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <b>Every QR line is linked to its sale. The bank&rsquo;s QR credit is matched to those sales on the bank statement.</b>
        <Link to="/scm/bank-recon" style={{ ...btn(true), textDecoration: 'none' }}>
          Match the bank statement <ArrowRight {...ICON} />
        </Link>
      </div>
    );
  }
  return (
    <div style={{ ...panel(outstanding === 0 ? 'good' : 'plain'), display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
      <b>
        {outstanding === 0
          ? `Done, both sides: every line reconciled and ${fmt(payable)} is in the bank.`
          : `Every line is reconciled. ${batch.acquirer_code} owes ${fmt(outstanding)}.`}
      </b>
      {outstanding !== 0 && (
        <Link to="/scm/bank-recon" style={{ ...btn(true), textDecoration: 'none' }}>
          Match the bank statement <ArrowRight {...ICON} />
        </Link>
      )}
    </div>
  );
};

/* ── One statement line, with its candidates ──────────────────────────────── */

const key = (p: { source: string; id: string }) => `${p.source}:${p.id}`;

/* ── "Find the sale" ──────────────────────────────────────────────────────────
   The window offers what could plausibly be this line; a person may know which
   sale it IS — keyed twelve days after the swipe, no bank on it, so the matcher
   never loaded it (docs/bugs/0792; owner: 我要怎样选对应的 SO?). Here every
   card payment of the company can be searched whatever its date, the exact
   gross marked "possible" and ranked first, and any one of them ticked
   (owner: 可以注明 possible，但不能不让我选其他的). The confirm reads the chosen
   payments back, so the amount still has to add up before anything posts. */
const FindTheSale = ({ rowId, grossSen, picked, shown, onToggle, qr = false }: {
  rowId: number; grossSen: number; picked: Set<string>;
  /** Already offered above — not listed twice. */
  shown: Set<string>;
  onToggle: (p: SettlementCandidate) => void;
  /** A DuitNow QR line: the server searches Online payments, and the words say so. */
  qr?: boolean;
}) => {
  const [q, setQ] = useState('');
  const found = useFindPayments(rowId, q);
  const list = (found.data?.payments ?? []).filter((p) => !shown.has(key(p)));
  const kind = qr ? 'Online' : 'card';
  return (
    <div className="space-y-1" style={{ borderTop: '1px dashed var(--c-line, rgba(34,31,32,0.15))', paddingTop: 'var(--space-2)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find the sale"
          placeholder="SO number, customer, approval code or amount"
          style={{ padding: '4px 8px', border: '1px solid var(--c-line, rgba(34,31,32,0.25))', borderRadius: 'var(--radius-sm)', minWidth: 260 }} />
        <span style={softText}>
          {qr
            /* Owner 2026-11-09: 已经match 的就不应该出现 — a transfer already on the bank statement is not a QR's. */
            ? `Any Online payment of this company not yet on the bank statement, whatever its date — the exact ${fmt(grossSen)} is marked possible.`
            : `Any card payment of this company, whatever its date — the exact ${fmt(grossSen)} is marked possible.`}
        </span>
      </div>
      {found.isError && (
        <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{refusalText(found.error, 'The search did not run.')}</div>
      )}
      {found.isLoading && <div style={softText}>Searching…</div>}
      {found.data && list.length === 0 && (
        <div style={softText}>No {kind} payment of this company {q.trim() ? `matches "${q.trim()}"` : 'is waiting for a merchant report'}.</div>
      )}
      {list.length > 0 && (
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={cell} />
              <th style={cell}>Document</th><th style={cell}>Customer</th><th style={cell}>Paid</th>
              <th style={cell}>Approval</th><th style={num}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={key(p)} style={p.possible ? { background: 'rgba(47, 93, 79, 0.08)' } : undefined}>
                <td style={cell}>
                  <input type="checkbox" checked={picked.has(key(p))} onChange={() => onToggle(p)} aria-label={`Select ${p.docNo}`} />
                </td>
                <td style={cell}>
                  <DocLink source={p.source} docNo={p.docNo} />
                  {p.possible && <span className={styles.codeChip} style={{ marginLeft: 6 }}>possible</span>}
                  {/* A card payment keyed without its bank. An Online payment has no bank to key. */}
                  {!qr && p.merchantProvider === null && (
                    <span style={{ marginLeft: 6, fontSize: 'var(--fs-12)', color: 'var(--text-soft, #8a8578)' }}>未标 merchant</span>
                  )}
                </td>
                <td style={cell}>{p.customerName ?? '—'}</td>
                <td style={cell}>{p.paidOn}</td>
                <td style={cell}>{p.approvalCode ?? '—'}</td>
                <td style={num}>{fmt(p.amountSen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

const SettlementLine = ({ row, others = [] }: {
  row: SettlementRow;
  /** The report's other open lines with no payment of their own — what this
      line can be matched TOGETHER with (option B). */
  others?: SettlementRow[];
}) => {
  const confirm = useConfirmSettlementRow();
  const confirmGroup = useConfirmSettlementGroup();
  /* LINES MATCHED TOGETHER (owner 2026-11-03, option B): the customer swiped
     twice for two orders — RM 5,000 + RM 2,085 for RM 2,990 + RM 4,095 — so no
     line equals any payment; only the totals agree. Ticking other lines here
     makes the target their sum, and the confirm books every line's own fee. */
  const [joining, setJoining] = useState(false);
  const [together, setTogether] = useState<Set<number>>(() => new Set());
  const withLines = others.filter((o) => together.has(o.id));
  const targetSen = row.gross_sen + withLines.reduce((s, o) => s + o.gross_sen, 0);
  const ignore = useIgnoreSettlementRow();
  /* Start on the system's own answer when it has one — the operator confirms
     instead of repeating the search (owner: 尽量根据日期金额去尝试自动匹配后让我
     知道，我 final confirm). Seeded once, so a refetch never undoes his ticks. */
  const [picked, setPicked] = useState<Set<string>>(() => new Set((row.suggested ?? []).map(key)));
  /* The guess as the server sends it now — what "Not this" turns down (owner 2026-11-10). */
  const guessed = !row.confirmed_at && row.bucket !== 'IGNORED' && row.linked.length === 0 ? (row.suggested ?? []).map(key) : [];

  /* Payments a person found beyond the window, kept by key so a new search
     never drops a tick. */
  const [extra, setExtra] = useState<Map<string, SettlementCandidate>>(() => new Map());
  const [finding, setFinding] = useState(false);
  const offered = [...row.candidates, ...[...extra.values()].filter((p) => !row.candidates.some((c) => key(c) === key(p)))];
  const chosen = offered.filter((p) => picked.has(key(p)));
  const chosenSen = chosen.reduce((s, p) => s + p.amountSen, 0);
  const balanced = chosen.length > 0 && chosenSen === targetSen;
  const pending = confirm.isPending || confirmGroup.isPending;
  const failed = confirm.isError ? confirm.error : confirmGroup.isError ? confirmGroup.error : null;
  const hinted = new Set(row.comboHints.flat());

  const toggle = (p: { source: string; id: string }) => {
    setPicked((prev) => {
      const next = new Set(prev);
      const k = key(p);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const toggleFound = (p: SettlementCandidate) => {
    setExtra((prev) => {
      const next = new Map(prev);
      if (next.has(key(p))) next.delete(key(p)); else next.set(key(p), p);
      return next;
    });
    toggle(p);
  };
  const findButton = !row.confirmed_at && row.linked.length === 0 && (
    <button type="button" style={btn()} onClick={() => setFinding((v) => !v)} aria-expanded={finding}>
      {finding ? 'Hide the search' : 'Find the sale'}
    </button>
  );
  const joinButton = !row.confirmed_at && row.bucket !== 'IGNORED' && row.linked.length === 0 && others.length > 0 && (
    <button type="button" style={btn()} onClick={() => setJoining((v) => !v)} aria-expanded={joining}>
      {joining ? 'Match this line alone' : 'Match with other lines'}
    </button>
  );
  const toggleLine = (id: number) => setTogether((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const asGroup = joining && withLines.length > 0;
  /* A DuitNow QR line (owner 2026-11-09): its sale is keyed Online and already in
     the bank, so the press LINKS it — no fee, nothing posted. */
  const qr = isQrLine(row);
  const pressWords = asGroup
    ? (qr ? `Link the ${withLines.length + 1} lines` : `Confirm the ${withLines.length + 1} lines and post`)
    : (qr ? 'Link the sale' : 'Confirm and post');
  const press = () => {
    const payments = chosen.map((p) => ({ source: p.source, id: p.id, docNo: p.docNo, amountSen: p.amountSen }));
    if (asGroup) confirmGroup.mutate({ rowIds: [row.id, ...withLines.map((o) => o.id)], payments });
    else confirm.mutate({ rowId: row.id, matchReason: 'manual', payments });
  };

  return (
    /* A section, not a div: each line is its own piece of the report, and the
       element says so — to a screen reader and to a test scoping one line's
       buttons away from the next line's. */
    <section style={{
      padding: 'var(--space-3)', border: '1px solid var(--c-line, rgba(34,31,32,0.15))',
      borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-2)',
    }} className="space-y-2">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className={styles.codeChip}>Line {row.line_no}</span>
        <span>{row.txn_date}</span>
        {qr ? <span className={styles.codeChip}>{QR_REF_WORDS}</span> : row.ref && <span>ref <b>{row.ref}</b></span>}
        <span style={{ flex: 1 }} />
        <span><b>{fmt(row.gross_sen)}</b> gross</span>
        {qr
          ? <span style={softText}>no fee · straight to the bank with its sale</span>
          : <span style={softText}>− {fmt(row.fee_sen)} fee = {fmt(row.net_sen)} net</span>}
      </div>

      {/* A matched line says it ONCE. The clue ("Reference 969745 matches
          SO-2608-043") and the line below it ("Matched to SO-2608-043") were
          the same sentence twice — which is what still looked wrong after the
          contradiction was fixed. */}
      {row.clue && row.linked.length === 0 && <div style={softText}>{row.clue}</div>}

      {row.posted_je_no && (
        <div style={{ fontSize: 'var(--fs-13)', color: good }}>
          Posted as <span className={styles.codeChip}>{row.posted_je_no}</span>
          {row.linked.length > 0 && <> — <LinkedDocs links={row.linked} /></>}
        </div>
      )}

      {!row.confirmed_at && row.linked.length > 0 && (
        <div style={{ fontSize: 'var(--fs-13)' }}>
          Matched to <LinkedDocs links={row.linked} />
          {row.ref ? ' by its reference' : ''} — press <b>Confirm</b> to book its fee.
        </div>
      )}

      {!row.confirmed_at && joining && (
        <div className="space-y-1" data-testid="match-together">
          <div style={softText}>
            Tick the other lines of this report the same customer swiped — the payments you pick must add up to all of them together.
          </div>
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell} />
                <th style={cell}>Line</th><th style={cell}>Date</th><th style={cell}>Reference</th><th style={num}>Gross</th>
              </tr>
            </thead>
            <tbody>
              {others.map((o) => (
                <tr key={o.id}>
                  <td style={cell}>
                    <input type="checkbox" checked={together.has(o.id)} onChange={() => toggleLine(o.id)}
                      aria-label={`Match with line ${o.line_no}`} />
                  </td>
                  <td style={cell}>Line {o.line_no}</td>
                  <td style={cell}>{o.txn_date}</td>
                  <td style={cell}>{o.ref ?? '—'}</td>
                  <td style={num}>{fmt(o.gross_sen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!row.confirmed_at && row.candidates.length > 0 && (
        <div className="space-y-1">
          <table style={table}>
            <thead>
              <tr style={headRow}>
                <th style={cell} />
                <th style={cell}>Document</th><th style={cell}>Paid</th>
                <th style={cell}>Approval</th><th style={num}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {row.candidates.map((p) => (
                <tr key={key(p)} style={hinted.has(p.id) ? { background: 'rgba(47, 93, 79, 0.08)' } : undefined}>
                  <td style={cell}>
                    <input type="checkbox" checked={picked.has(key(p))} onChange={() => toggle(p)}
                      aria-label={`Select ${p.docNo}`} />
                  </td>
                  <td style={cell}>
                    <DocLink source={p.source} docNo={p.docNo} />
                    {/* A migration-era payment carries no merchant tag; say so
                        where it is being claimed. Confirming writes the tag.
                        Strictly null: a candidate WITHOUT the field (an older
                        cached response) is unknown, not untagged. A QR line's
                        sale is an Online payment, which has no bank to key. */}
                    {!qr && p.merchantProvider === null && (
                      <span style={{ marginLeft: 6, fontSize: 'var(--fs-12)', color: 'var(--text-soft, #8a8578)' }}>未标 merchant</span>
                    )}
                  </td>
                  <td style={cell}>{p.paidOn}</td>
                  <td style={cell}>{p.approvalCode ?? '—'}</td>
                  <td style={num}>{fmt(p.amountSen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!row.confirmed_at && finding && (
        <FindTheSale rowId={row.id} grossSen={row.gross_sen} picked={picked} qr={qr}
          shown={new Set(row.candidates.map(key))} onToggle={toggleFound} />
      )}

      {/* The choice is confirmed here whether it came from the window or the
          search — a found sale alone is a full selection. */}
      {!row.confirmed_at && (row.candidates.length > 0 || extra.size > 0) && (
        <div className="space-y-1">
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--fs-13)', color: balanced ? good : danger }}>
              Selected {fmt(chosenSen)} of {fmt(targetSen)}
              {asGroup ? ` (${withLines.length + 1} lines together)` : ''}
              {chosen.length > 0 && !balanced && ` — ${fmt(chosenSen - targetSen)} out`}
            </span>
            <button type="button" style={btn(true, !balanced || pending)}
              disabled={!balanced || pending}
              onClick={press}>
              {pressWords}
            </button>
            {findButton}
            {joinButton}
            {guessed.length > 0 && <NotThis rowId={row.id} guessed={guessed} />}
            <button type="button" style={btn()} onClick={() => ignore.mutate({ rowId: row.id, restore: row.bucket === 'IGNORED' })}>
              {row.bucket === 'IGNORED' ? 'Put back' : 'Set aside'}
            </button>
          </div>
        </div>
      )}

      {!row.confirmed_at && row.candidates.length === 0 && row.linked.length === 0 && extra.size === 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'var(--fs-13)', color: danger }}>
            {qr
              ? 'No Online payment explains this QR money. A DuitNow QR sale is keyed Online, with the QR’s code — key it, or find it below if it is in the ERP on another day.'
              : 'No payment within the matching window explains this money. If the sale IS in the ERP — keyed later, or without a bank — find it below; otherwise record it first, because it must not be cleared out of in-transit without one.'}
          </span>
          {findButton}
          {joinButton}
          <button type="button" style={btn()} onClick={() => ignore.mutate({ rowId: row.id, restore: row.bucket === 'IGNORED' })}>
            {row.bucket === 'IGNORED' ? 'Put back' : 'Set aside'}
          </button>
        </div>
      )}


      {failed && (
        <div style={{ fontSize: 'var(--fs-13)', color: danger }}>
          {(failed as { message?: string } | null)?.message ?? 'The line was not confirmed.'}
        </div>
      )}
    </section>
  );
};

export default MerchantRecon;
