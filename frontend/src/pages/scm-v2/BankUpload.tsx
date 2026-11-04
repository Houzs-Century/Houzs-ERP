// ----------------------------------------------------------------------------
// BankUpload — the Upload drawer of Bank statements (the owner's Claude Design,
// batch 3). What the Bank statement tab's upload box did, in a drawer opened
// from the account it is for: a CSV export, or the bank's monthly PDF read in
// the browser with pdf.js (docs/bugs/0869); the Year and month for a file whose
// dates carry no year or a quiet month's statement; the setup warnings; and the
// result said as the design's piles. Every rule is the server's; this reads the
// file and repeats what the server said, refusals verbatim (§2.14).
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { AlertTriangle, Check, FileText, Info, Upload, X } from 'lucide-react';
import { ResizableDetailDrawer } from '../../components/ResizableDetailDrawer';
import { useBankSetup, useUploadBankStatement } from './bank-queries';
import { fmt, refusalText } from './settlement-ui';
import { fmtDate } from '../../vendor/shared/format';
import drawer from './finance/FinanceTasks.module.css';
import styles from './UploadDrawer.module.css';

/** Where the page lands once the drawer closes after an upload: the account, and the month the file starts in. */
export type BankUploaded = { accountCode: string; statementId: number; month: string };

/** The file's bytes or its text, through FileReader — the one reader every
    browser (and the test runner's DOM) has. */
const readAs = (f: File, as: 'bytes' | 'text'): Promise<ArrayBuffer | string> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result as ArrayBuffer | string);
  r.onerror = () => reject(r.error ?? new Error('The file could not be read.'));
  if (as === 'bytes') r.readAsArrayBuffer(f); else r.readAsText(f);
});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Read = {
  name: string; text: string; notes: string[];
  piles: { matched: number; decide: number; already: number; reversed: number };
};

export function BankUploadDrawer({ account, onClose }: { account: string | null; onClose: (done: BankUploaded | null) => void }) {
  const setup = useBankSetup();
  const upload = useUploadBankStatement();
  const accounts = setup.data?.accounts ?? [];
  const [accountCode, setAccountCode] = useState(account ?? '');
  const chosen = accounts.find((a) => a.account_code === accountCode) ?? null;
  const bank = chosen?.bank_name ?? chosen?.bank_code ?? '';
  const [file, setFile] = useState<{ name: string; content: string; format: 'CSV' | 'PDF' } | null>(null);
  /* Which year and month, for a file whose dates carry no year or that has no
     transactions at all. It never moves a movement: each lands in the month of
     its own date. */
  const [statementMonth, setStatementMonth] = useState('');
  const [read, setRead] = useState<Read | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [done, setDone] = useState<BankUploaded | null>(null);
  const [dragging, setDragging] = useState(false);

  const take = (f: File | undefined) => {
    setRefused(null);
    if (!f) { setFile(null); return; }
    if (/\.pdf$/i.test(f.name)) {
      /* The bank's monthly statement PDF: the browser reads the text with where
         it was drawn; the server reads the bank's layout. pdf.js is loaded
         here, on the press, and never for a CSV. */
      void readAs(f, 'bytes')
        .then(async (data) => {
          const { extractPdfText } = await import('../../vendor/scm/lib/pdf-text');
          return extractPdfText(data as ArrayBuffer);
        })
        .then((pdf) => setFile({ name: f.name, content: JSON.stringify(pdf), format: 'PDF' }))
        .catch((err: unknown) => { setFile(null); setRefused(refusalText(err, 'The PDF could not be read.')); });
      return;
    }
    void readAs(f, 'text')
      .then((content) => setFile({ name: f.name, content: String(content), format: 'CSV' }))
      .catch((err: unknown) => { setFile(null); setRefused(refusalText(err, 'The file could not be read.')); });
  };

  const send = () => {
    if (!accountCode || !file) return;
    setRefused(null);
    upload.mutate({ accountCode, fileName: file.name, content: file.content, format: file.format, statementMonth: statementMonth || null }, {
      onSuccess: (r) => {
        const notes = [
          /* Said, because each is a place a reader could think the file was misread. */
          ...(r.joinedPairs > 0 ? [`${plural(r.joinedPairs, 'credit')} had their charge taken back separately and were joined`] : []),
          ...(r.skippedLines > 0 ? [`${plural(r.skippedLines, 'row')} carried no transaction`] : []),
        ];
        const decide = Math.max(0, r.lines - r.autoMatched - r.alreadyRecorded - 2 * r.contraPairs);
        setRead({
          name: file.name,
          /* A quiet month reads as what it is, not as "0 movements" (docs/bugs/0794). */
          text: r.lines === 0
            ? `No transactions in this statement — filed for ${r.periodFrom.slice(0, 7)} at ${fmt(r.openingBalanceSen ?? 0)} throughout.`
            : `${plural(r.lines, 'movement')} · ${fmtDate(r.periodFrom)} → ${fmtDate(r.periodTo)} · ${fmt(r.inSen)} in · ${fmt(r.outSen)} out`,
          notes,
          piles: { matched: r.autoMatched, decide, already: r.alreadyRecorded, reversed: r.contraPairs },
        });
        setDone({ accountCode, statementId: r.statementId, month: r.periodFrom.slice(0, 7) });
        setFile(null);
      },
      onError: (err) => setRefused(refusalText(err, 'The statement could not be read.')),
    });
  };

  const title = bank ? `Upload ${bank} statement` : 'Upload a bank statement';
  const sub = chosen
    ? `${chosen.account_name || bank} · ${chosen.account_code} · CSV or PDF from the bank's portal`
    : 'CSV or PDF from the bank\'s portal';
  const close = () => onClose(done);

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
            <span className={drawer.fieldLabel}>Bank account</span>
            {account && chosen ? <span className={styles.fixed}>{bank} · {chosen.account_code}{chosen.account_no ? ` · ${chosen.account_no}` : ''}</span> : (
              <select className={drawer.input} value={accountCode} aria-label="Bank account" onChange={(e) => { setAccountCode(e.target.value); setRefused(null); }}>
                <option value="">Which bank account?</option>
                {accounts.filter((a) => a.is_active).map((a) => (
                  <option key={a.account_code} value={a.account_code}>{a.bank_code} · {a.account_code}{a.account_no ? ` · ${a.account_no}` : ''}</option>
                ))}
              </select>
            )}
          </div>
          {/* A setup that cannot read anything says so BEFORE an upload, not as a refusal after one. */}
          {chosen && !chosen.ready && (
            <div className={styles.warn}><AlertTriangle size={14} /> {chosen.bank_code} has no statement columns set up, so nothing can be read from its file yet.</div>
          )}
          {setup.data && accounts.length === 0 && (
            <div className={styles.warn}><AlertTriangle size={14} /> No bank account is set up to take a statement in this company yet — add one under Recon setup → Bank statements.</div>
          )}

          <label className={drawer.field}>
            <span className={drawer.fieldLabel}>Year and month <span className={drawer.optional}>· optional</span></span>
            <input className={drawer.input} type="month" value={statementMonth} aria-label="Statement month" onChange={(e) => setStatementMonth(e.target.value)} />
            {/* Said plainly: the field never files a movement into a month — each belongs to the month of its own date. */}
            <span className={styles.hint}>
              For a file whose dates carry no year, or one with no transactions at all (a quiet month&apos;s statement is filed
              under the month chosen here). For a file that prints full dates, naming the month says it covers that whole
              month; each movement still belongs to the month of its own date. One source per month: the PDF or the CSV, never both.
            </span>
          </label>

          <label className={`${styles.drop} ${dragging ? styles.dropOn : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); take(e.dataTransfer.files[0]); }}>
            <Upload size={20} />
            <b>Drop the {bank || 'bank'} statement here</b>
            <span>CSV or PDF · overlapping days are skipped, never doubled</span>
            <span className={styles.browse}>or choose a file</span>
            <input type="file" className={styles.fileInput} accept=".csv,.txt,.pdf" aria-label="Bank statement file"
              onChange={(e) => take(e.target.files?.[0])} />
          </label>
          {file && <div className={styles.files}><span className={styles.file}><FileText size={12} /> {file.name}</span></div>}
          {setup.data && setup.data.recognises.length > 0 && (
            <span className={styles.hint}>Card money is recognised for {setup.data.recognises.join(', ')}. Anything else is listed for you to match.</span>
          )}

          {refused && (
            <div className={styles.refused}><AlertTriangle size={14} /><div>{refused}</div></div>
          )}
          {read && (
            <>
              <div className={styles.read}>
                <Check size={14} />
                <div>
                  <b>{read.name}</b> read
                  <div>{read.text}</div>
                  {read.notes.map((n) => <div key={n} className={styles.hint}>{n}</div>)}
                </div>
              </div>
              <div className={styles.piles}>
                {read.piles.matched > 0 && <Pile tone="ok" n={read.piles.matched} what="matched automatically" then="Same amount, one entry, names agree" />}
                {read.piles.decide > 0 && <Pile tone="warn" n={read.piles.decide} what="to decide" then={`Added to To do as “Decide ${plural(read.piles.decide, `${bank} line`)}”`} />}
                {read.piles.already > 0 && <Pile tone="calm" n={read.piles.already} what="already recorded" then="On an earlier upload of this account · left out, never doubled" />}
                {read.piles.reversed > 0 && <Pile tone="calm" n={read.piles.reversed} what={read.piles.reversed === 1 ? 'pair the bank reversed' : 'pairs the bank reversed'} then="Left out together · nothing to post" />}
              </div>
            </>
          )}
        </div>
        <div className={drawer.foot}>
          <div className={drawer.note}><Info size={15} /><span>A file the bank&apos;s layout cannot be read from is refused with the reason. It is never read as 0 movements.</span></div>
          <div className={drawer.footButtons}>
            {done && !file ? (
              <button type="button" className={drawer.btnPrimary} onClick={close}>Done</button>
            ) : (
              <>
                <button type="button" className={drawer.btnSecondary} onClick={close}>Cancel</button>
                <button type="button" className={styles.solid} disabled={!accountCode || !file || upload.isPending} onClick={send}>
                  <Upload size={14} /> {upload.isPending ? 'Reading…' : 'Upload & match'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </ResizableDetailDrawer>
  );
}

function Pile({ n, what, then, tone }: { n: number; what: string; then: string; tone: 'ok' | 'warn' | 'calm' }) {
  return (
    <div className={`${styles.pile} ${tone === 'ok' ? styles.pileOk : tone === 'warn' ? styles.pileWarn : styles.pileCalm}`}>
      <b>{n}</b>
      <div><span className={styles.pileWhat}>{what}</span><span className={styles.pileThen}>{then}</span></div>
    </div>
  );
}
