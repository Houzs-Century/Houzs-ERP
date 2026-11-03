// ----------------------------------------------------------------------------
// BankRecordJournal — Bank statements › No entry found › Record journal (the
// owner's Claude Design, batch 3; owner 2026-11-03 on question d10: 「这样需要」 —
// the journal only, no receipt). A movement nothing in the books fits — a bank
// charge going out, interest coming in — is recorded as a manual journal from
// its own line: the manual-journal form (Books › Journal entries) opens in its
// drawer with the line's day and the bank's leg fixed (Dr the bank for money
// in, Cr it for money out, to the sen), the person picks the other account(s),
// and Save & post runs today's calls in order:
//   1. a fresh look at the month — a locked month, a line matched or set
//      aside meanwhile, or an entry that fits the line now (one posted from
//      here whose match did not go through, or one recorded elsewhere) refuses
//      before anything is written;
//   2. the draft and today's manual-journal post;
//   3. today's match call, the line to the entry — after a second fresh look,
//      so a line already matched to that entry is simply done, and a line
//      someone matched or set aside meanwhile is left as it is and said.
// Each step at most once: a second press finishes the first journal, never
// writes another. A match refused after the post is said plainly and the line
// is left to match by hand — the month is read again, so it waits under To
// match with the posted entry.
// ----------------------------------------------------------------------------

import { useQueryClient } from '@tanstack/react-query';
import { ResizableDetailDrawer } from '../../components/ResizableDetailDrawer';
import { NewJournalForm, type BankLineRecord } from './JournalEntryCards';
import { fetchBankMonth, invalidateAfterBankPosting, useMatchBankLine, type BankLine } from './bank-queries';
import { monthTitle } from './BankStatementsTop';
import tokens from './finance/finance-ui.module.css';

/** Whether a line may be recorded as a journal: an open line of money no entry fits and no card report is owed by. */
export const recordableLine = (l: BankLine): boolean =>
  l.state === 'OPEN' && l.kind === 'OTHER' && l.entryCandidates.length === 0 && l.candidates.length === 0 && l.amount_sen !== 0;

type LineRef = Pick<BankLine, 'id' | 'booked_on'>;

/* The month a line is listed (and locked) under is its own date's (the
   month's rule 1, and the server's lockMonthOf). */
const lookAgain = async (accountCode: string, line: LineRef) => {
  const fresh = await fetchBankMonth(accountCode, line.booked_on.slice(0, 7));
  return { locked: fresh.lock != null, now: fresh.lines.find((l) => l.id === line.id) ?? null };
};

/** The fresh look before anything is written: the sentence that refuses, or null. */
export async function recordRefusal(accountCode: string, line: LineRef): Promise<string | null> {
  const { locked, now } = await lookAgain(accountCode, line);
  if (locked) return `${monthTitle(line.booked_on.slice(0, 7))} is locked for ${accountCode}, so nothing was written. Unlock the month to record this line.`;
  if (!now || now.state !== 'OPEN') return 'This bank line is no longer open — it was matched or set aside meanwhile. Nothing was written.';
  /* An entry that fits the line now is matched, never recorded a second time. */
  const fits = now.entryCandidates.map((e) => e.jeNo);
  if (fits.length > 0) {
    return `${fits.length === 1 ? `${fits[0]} now fits` : `${fits.join(', ')} now fit`} this line, so nothing was written. Match it under ${fits.length === 1 ? 'To match' : 'To choose'}.`;
  }
  return null;
}

/** The line matched to the posted entry with today's match call — after a fresh
    look: already matched to that entry is done (null); matched or set aside
    otherwise meanwhile is left as it is, and the sentence says so. A refused
    match rejects. */
export async function settleLine(
  accountCode: string, line: LineRef, jeNo: string,
  match: (v: { lineId: number; jeNo: string }) => Promise<unknown>,
): Promise<string | null> {
  const { now } = await lookAgain(accountCode, line);
  if (now?.state === 'POSTED' && now.posted_je_no === jeNo) return null;
  if (!now || now.state !== 'OPEN') {
    return `the bank line was matched or set aside meanwhile, so it was left as it is. If it names another entry now, ${jeNo} is not needed — reverse it in Journal entries.`;
  }
  await match({ lineId: line.id, jeNo });
  return null;
}

export function BankRecordJournal({ line, accountCode, onClose, onToast }: {
  /** The line being recorded; the drawer is closed while null. */
  line: BankLine | null;
  /** The bank account the line moved on — its ledger code. */
  accountCode: string;
  onClose: () => void;
  onToast: (text: string) => void;
}) {
  const qc = useQueryClient();
  const match = useMatchBankLine();
  const record: BankLineRecord | null = line ? {
    lineNo: line.line_no,
    bookedOn: line.booked_on,
    amountSen: line.amount_sen,
    accountCode,
    description: line.description,
    reference: line.reference,
    check: () => recordRefusal(accountCode, line),
    settle: async (jeNo) => {
      try {
        return await settleLine(accountCode, line, jeNo, match.mutateAsync);
      } finally {
        /* The entry is posted whatever became of the match: the month is read again. */
        invalidateAfterBankPosting(qc);
      }
    },
  } : null;
  return (
    <ResizableDetailDrawer open={line != null} onClose={onClose} ariaLabel="Record journal">
      {line && record && (
        <div className={tokens.root} style={{ height: '100%' }}>
          <NewJournalForm key={line.id} record={record} onCancel={onClose} onToast={onToast} onSaved={() => onClose()} />
        </div>
      )}
    </ResizableDetailDrawer>
  );
}
