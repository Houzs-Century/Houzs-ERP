// ----------------------------------------------------------------------------
// MerchantUpload — the Upload drawer of Merchant reports (the owner's Claude
// Design, batch 3). What used to be the upload row, in a drawer, with every
// option it had: several files at once, Excel flattened in the browser, the
// fee total for a prorated-summary acquirer, the statement month for one whose
// dates carry no year, the no-reference warning, a refusal per file that keeps
// the file for Try again. Public Bank first asks which paper it is — its
// merchant report, or the IBG payment advice PDF that came with the payout.
// The result is said the design's way: each file read, then the piles its
// lines fell into. Every rule is the server's; this reads files and repeats
// what the server said, refusals verbatim (§2.14).
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { AlertTriangle, Check, FileText, Info, Upload, X } from 'lucide-react';
import { ResizableDetailDrawer } from '../../components/ResizableDetailDrawer';
import { useUploadPayoutAdvice, useUploadStatement, type AcquirerSetup, type PayoutDay } from './settlement-queries';
import { fmt, refusalText } from './settlement-ui';
import { fmtDate } from '../../vendor/shared/format';
import { parseMoneyToSen } from '../../lib/money';
import drawer from './finance/FinanceTasks.module.css';
import styles from './UploadDrawer.module.css';

export type UploadKind = 'report' | 'advice';
/** One file's answer: read (with what its lines fell into) or refused. */
export type FileResult = {
  name: string; ok: boolean; text: string;
  leftOut?: string;
  piles?: { matched: number; choose: number; none: number };
};
/** What the page lands on once the drawer closes after an upload. */
export type UploadLanding = { kind: UploadKind; batchIds: number[]; results: FileResult[] };

/** Each report read to CSV text. AEON sends .xlsx and the server reads CSV, so
    the sheet is flattened HERE — SheetJS, loaded on demand, first sheet only. */
export const readReportFiles = (picked: File[]): Promise<Array<{ name: string; content: string }>> =>
  Promise.all(picked.map(async (f) => {
    if (!/\.xlsx?$/i.test(f.name)) return { name: f.name, content: await f.text() };
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
    const first: string | undefined = wb.SheetNames[0];
    return { name: f.name, content: first ? XLSX.utils.sheet_to_csv(wb.Sheets[first]) : '' };
  }));

/** An advice goes up as base64 — a PDF read as text is mangled before the
    server ever sees it. The data-URL prefix is fine; the server strips it. */
export const readAdviceFiles = (picked: File[]): Promise<Array<{ name: string; contentBase64: string }>> =>
  Promise.all(picked.map((f) => new Promise<{ name: string; contentBase64: string }>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: f.name, contentBase64: String(reader.result ?? '') });
    reader.readAsDataURL(f);
  })));

const bucket = (buckets: Record<string, number>, key: string): number => Number(buckets[key] ?? 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An advice's days, in the design's three piles. */
const advicePiles = (days: PayoutDay[]) => ({
  agree: days.filter((d) => d.state === 'AGREES').length,
  short: days.filter((d) => d.state === 'DIFFERS'),
  wait: days.filter((d) => d.state === 'REPORT_MISSING' || d.state === 'REPORT_NOT_RECONCILED').length,
});

export function MerchantUploadDrawer({ acq, acquirers, startWith, onClose }: {
  acq: string | null; acquirers: AcquirerSetup[]; startWith: UploadKind | null;
  onClose: (landing: UploadLanding | null) => void;
}) {
  const upload = useUploadStatement();
  const uploadAdvice = useUploadPayoutAdvice();
  const [code, setCode] = useState(acq ?? (startWith === 'advice' ? 'PBB' : ''));
  const chosen = acquirers.find((a) => a.code === code) ?? null;
  /* Only Public Bank sends an advice this system reads, so only Public Bank is asked which paper it is. */
  const [picked, setPicked] = useState<UploadKind | null>(startWith);
  const kind: UploadKind | null = code === 'PBB' ? picked : code ? 'report' : null;
  const [reports, setReports] = useState<Array<{ name: string; content: string }>>([]);
  const [advices, setAdvices] = useState<Array<{ name: string; contentBase64: string }>>([]);
  const [summaryFee, setSummaryFee] = useState('');
  /* A file that dates "05-Jun" with no year: the operator answers which month;
     the system never guesses which year money belongs to. */
  const [statementMonth, setStatementMonth] = useState('');
  const [results, setResults] = useState<FileResult[]>([]);
  const [made, setMade] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const files = kind === 'advice' ? advices : reports;
  const take = (list: File[]) => {
    setResults([]);
    if (kind === 'advice') void readAdviceFiles(list).then(setAdvices).catch(() => setAdvices([]));
    else void readReportFiles(list).then(setReports);
  };
  const finished = results.length > 0 && files.length === 0;
  const retry = results.some((r) => !r.ok) && files.length > 0;
  const close = () => onClose(results.some((r) => r.ok) ? { kind: kind ?? 'report', batchIds: made, results } : null);

  const sendReports = async () => {
    const done: FileResult[] = [];
    /* A refused file stays selected: half the refusals end "…and upload it
       again", and throwing the file away made that impossible. */
    const rejected: typeof reports = [];
    const ids: number[] = [...made];
    /* One after another: each upload's matching must see the payments the
       previous one claimed, or two reports could take the same money. */
    const fee = parseMoneyToSen(summaryFee, 'The statement fee total');
    if (!fee.ok) {
      setResults(reports.map((f) => ({ name: f.name, ok: false, text: fee.message })));
      return;
    }
    for (const f of reports) {
      try {
        const r = await upload.mutateAsync({
          acquirerCode: code, fileName: f.name, content: f.content,
          summaryFeeSen: fee.empty ? null : fee.sen,
          statementMonth: statementMonth || null,
        });
        ids.push(r.batchId);
        const where = r.alreadyOnReport > 0 ? [...new Set(r.alreadyOnReportDetail.map((d) => d.fileName ?? `batch ${d.batchId}`))].join(', ') : '';
        done.push({
          name: f.name, ok: true,
          text: `${plural(r.rows, 'line')} · ${r.periodFrom === r.periodTo ? fmtDate(r.periodFrom) : `${fmtDate(r.periodFrom)} – ${fmtDate(r.periodTo)}`}`
            + ` · gross ${fmt(r.grossSen)} · fees ${fmt(r.feeSen)}`
            + (r.skippedLines > 0 ? ` · ${r.skippedLines} summary line(s) left out` : ''),
          /* A line the bank pays once, already on another report (docs/bugs/0823). */
          ...(r.alreadyOnReport > 0 ? { leftOut: `${r.alreadyOnReport} line(s) already on ${where} left out — the bank pays a card transaction once` } : {}),
          piles: { matched: bucket(r.buckets, 'MATCHED'), choose: bucket(r.buckets, 'NEEDS_CONFIRM'), none: bucket(r.buckets, 'UNMATCHED') },
        });
      } catch (err) {
        rejected.push(f);
        done.push({ name: f.name, ok: false, text: refusalText(err, 'The report could not be read.') });
      }
      setResults([...done]);
    }
    setReports(rejected);
    setMade(ids);
  };

  const sendAdvices = async () => {
    const done: FileResult[] = [];
    const rejected: typeof advices = [];
    for (const f of advices) {
      try {
        const r = await uploadAdvice.mutateAsync({ acquirerCode: 'PBB', fileName: f.name, contentBase64: f.contentBase64 });
        const p = advicePiles(r.status.days);
        done.push({
          name: f.name, ok: true,
          text: `${plural(r.status.days.length, 'settlement day')} · ${fmt(r.status.netSen)}`
            + (r.status.readyToReceive ? ' · every day agrees — the bank credit books against these reports' : ''),
          piles: { matched: p.agree, choose: p.short.length, none: p.wait },
        });
      } catch (err) {
        rejected.push(f);
        done.push({ name: f.name, ok: false, text: refusalText(err, 'The advice could not be read.') });
      }
      setResults([...done]);
    }
    setAdvices(rejected);
  };

  const send = async () => {
    if (!kind || files.length === 0 || busy) return;
    setBusy(true);
    setResults([]);
    try { await (kind === 'advice' ? sendAdvices() : sendReports()); } finally { setBusy(false); }
  };

  const title = kind === 'advice' ? 'Upload PBB payment advice' : `Upload ${code || 'a'} merchant report`;
  const sub = kind === 'advice'
    ? 'Public Bank · the IBG advice PDF that came with the payout'
    : chosen ? `${chosen.display_name} · CSV or Excel from the ${chosen.code} merchant portal` : 'CSV or Excel from the merchant portal';
  const ok = results.filter((r) => r.ok);
  const sum = (k: 'matched' | 'choose' | 'none') => ok.reduce((n, r) => n + (r.piles?.[k] ?? 0), 0);

  return (
    <ResizableDetailDrawer open onClose={close} ariaLabel={title}>
      <div className={drawer.drawer}>
        <div className={drawer.head}>
          <div>
            <div className={drawer.headTitle}>{title}</div>
            <div className={drawer.headSub}>{sub}</div>
          </div>
          <button type="button" className={drawer.close} onClick={close} aria-label="Close"><X size={16} /></button>
        </div>
        <div className={drawer.body}>
          <div className={drawer.field}>
            <span className={drawer.fieldLabel}>Acquirer</span>
            {acq ? <span className={styles.fixed}>{acq} · {chosen?.display_name ?? acq}</span> : (
              <select className={drawer.input} value={code} aria-label="Acquirer" onChange={(e) => { setCode(e.target.value); setResults([]); }}>
                <option value="">Which merchant?</option>
                {acquirers.filter((a) => a.is_active).map((a) => (
                  <option key={a.code} value={a.code} disabled={!a.ready}>{a.display_name}{a.ready ? '' : ' — not set up yet'}</option>
                ))}
              </select>
            )}
          </div>

          {code === 'PBB' && (
            <div className={drawer.field}>
              <span className={drawer.fieldLabel}>What are you uploading?</span>
              <div className={styles.kinds}>
                <button type="button" className={`${styles.kind} ${picked === 'report' ? styles.kindOn : ''}`} aria-pressed={picked === 'report'}
                  onClick={() => { setPicked('report'); setResults([]); }}>
                  <b>Merchant report</b><span>CSV or Excel · one per settlement day</span>
                </button>
                <button type="button" className={`${styles.kind} ${picked === 'advice' ? styles.kindOn : ''}`} aria-pressed={picked === 'advice'}
                  onClick={() => { setPicked('advice'); setResults([]); }}>
                  <b>Payment advice</b><span>PDF · HOUZSCENTURY_IBG_&lt;date&gt;.pdf</span>
                </button>
              </div>
            </div>
          )}

          {kind === 'report' && chosen?.fee_method === 'prorated-summary' && (
            <label className={drawer.field}>
              <span className={drawer.fieldLabel}>Statement fee total (RM)</span>
              <input className={drawer.input} value={summaryFee} onChange={(e) => setSummaryFee(e.target.value)} placeholder="0.00" aria-label="Statement fee total" />
            </label>
          )}
          {/* Asked ONLY of the acquirer whose file needs it: Hong Leong dates a line "16-Aug" with no year. */}
          {kind === 'report' && chosen?.dates_have_no_year === true && (
            <label className={drawer.field}>
              <span className={drawer.fieldLabel}>Statement month</span>
              <input className={drawer.input} type="month" value={statementMonth} aria-label="Statement month" onChange={(e) => setStatementMonth(e.target.value)} />
              <span className={styles.hint}>{chosen.display_name} dates its lines like &ldquo;16-Aug&rdquo;, with no year.</span>
            </label>
          )}
          {kind === 'report' && chosen && !chosen.autoMatchable && (
            <div className={styles.warn}><AlertTriangle size={14} /> {chosen.display_name} sends no unique reference — every line waits for you to confirm it.</div>
          )}

          {kind && (
            <label className={`${styles.drop} ${dragging ? styles.dropOn : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); take([...e.dataTransfer.files]); }}>
              {kind === 'advice' ? <FileText size={20} /> : <Upload size={20} />}
              <b>{kind === 'advice' ? 'Drop the advice PDF here' : `Drop the ${code} report here`}</b>
              <span>{kind === 'advice' ? 'PDF · HOUZSCENTURY_IBG_<date>.pdf · several at once is fine' : 'CSV or Excel · one day, or a whole month at once'}</span>
              <span className={styles.browse}>or choose files</span>
              <input type="file" multiple className={styles.fileInput}
                accept={kind === 'advice' ? '.pdf' : '.csv,.xls,.xlsx,text/csv'}
                aria-label={kind === 'advice' ? 'Payment advice PDF' : 'Statement files'}
                onChange={(e) => take([...(e.target.files ?? [])])} />
            </label>
          )}
          {files.length > 0 && (
            <div className={styles.files}>
              {files.map((f) => <span key={f.name} className={styles.file}><FileText size={12} /> {f.name}</span>)}
            </div>
          )}

          {results.map((r) => (
            <div key={r.name} className={r.ok ? styles.read : styles.refused}>
              {r.ok ? <Check size={14} /> : <AlertTriangle size={14} />}
              <div>
                <b>{r.name}</b> {r.ok ? 'read' : '— refused'}
                <div>{r.text}</div>
                {r.leftOut && <div className={styles.hint}>{r.leftOut}</div>}
              </div>
            </div>
          ))}
          {ok.length > 0 && kind === 'report' && (
            <div className={styles.piles}>
              {sum('matched') > 0 && <Pile tone="ok" n={sum('matched')} what="matched by reference" then={`Added to To do as “Confirm ${plural(sum('matched'), 'merchant line')}”`} />}
              {sum('choose') > 0 && <Pile tone="warn" n={sum('choose')} what="fit more than one order" then="Added to “Choose payments”" />}
              {sum('none') > 0 && <Pile tone="late" n={sum('none')} what="has no payment recorded" then="Added to “Choose payments” · sales may not have keyed it" />}
            </div>
          )}
          {ok.length > 0 && kind === 'advice' && (
            <div className={styles.piles}>
              {sum('matched') > 0 && <Pile tone="ok" n={sum('matched')} what={sum('matched') === 1 ? 'day agrees with its report' : 'days agree with their reports'} then="Nothing to do" />}
              {sum('choose') > 0 && <Pile tone="warn" n={sum('choose')} what={sum('choose') === 1 ? 'day differs from its report' : 'days differ from their reports'} then="The bank kept a charge, or the report is off · Book charge under Payment advices" />}
              {sum('none') > 0 && <Pile tone="warn" n={sum('none')} what={sum('none') === 1 ? 'day waits for its report' : 'days wait for their reports'} then="Upload the merchant report, or finish its lines" />}
            </div>
          )}
        </div>
        <div className={drawer.foot}>
          <div className={drawer.note}><Info size={15} /><span>A file in the wrong format is refused with the reason. It is never read as 0 lines.</span></div>
          <div className={drawer.footButtons}>
            {finished ? (
              <button type="button" className={drawer.btnPrimary} onClick={close}>Done</button>
            ) : (
              <>
                <button type="button" className={drawer.btnSecondary} onClick={close}>Cancel</button>
                <button type="button" className={styles.solid} disabled={!kind || files.length === 0 || busy} onClick={() => { void send(); }}>
                  <Upload size={14} /> {busy ? 'Reading…' : retry ? `Try again (${files.length})` : kind === 'advice' ? 'Upload advice' : 'Upload & match'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </ResizableDetailDrawer>
  );
}

function Pile({ n, what, then, tone }: { n: number; what: string; then: string; tone: 'ok' | 'warn' | 'late' }) {
  return (
    <div className={`${styles.pile} ${tone === 'ok' ? styles.pileOk : tone === 'warn' ? styles.pileWarn : styles.pileLate}`}>
      <b>{n}</b>
      <div><span className={styles.pileWhat}>{what}</span><span className={styles.pileThen}>{then}</span></div>
    </div>
  );
}
