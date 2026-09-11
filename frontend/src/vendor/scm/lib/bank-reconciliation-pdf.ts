// ----------------------------------------------------------------------------
// bank-reconciliation-pdf — the BANK RECONCILIATION STATEMENT, on paper.
//
// Owner, 2026-09-08, having asked for the month first: 然后就是match 完了我要
// report.
//
// This is the report an accountant and an auditor both mean by that phrase: it
// starts at the balance the BANK says, walks to the balance the BOOKS say, and
// every step of the walk is an item somebody can go and look at. Nothing else
// on this screen is a report — a difference on a screen is a reading, and a
// reading cannot be filed.
//
// The walk is the identity acc/bank-reconcile checks, written out as lines:
//
//     balance per bank statement
//   − on the bank, not in the books
//   + in the books, not on the bank
//   − difference brought forward
//   = balance per the books
//
// It TIES BY CONSTRUCTION, because the last line is computed by doing that
// arithmetic and then checked against the ledger balance the server sent. If
// the two disagree the report says so on its face and prints no statement:
// a reconciliation that publishes a walk which does not arrive is worse than
// none, because it looks filed.
//
// Two more refusals, for the same reason:
//   • no closing balance on the file (plenty of daily exports print none) —
//     there is nothing to walk FROM, and the report says that rather than
//     starting from a zero;
//   • a month with a day missing — the walk is arithmetically fine and about
//     the wrong month, so the gap is printed above the statement, not after it.
//
// The building is pure and the drawing is not, deliberately: every figure and
// every line of this report is decided in `reconciliationStatement` and read
// back by its test without rendering a PDF.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont,
  fmtDocDate, fmtDocStamp, fmtRm, safeName, type PdfAction,
} from './pdf-common';

/* ── What the month endpoint hands over, structurally ──────────────────────
   Named here rather than imported from the page's query module: this file is
   the report, and a report that cannot be built without a React screen cannot
   be tested without one either. */

export type ReconInput = {
  periodFrom: string;
  periodTo: string;
  openingStatementSen: number | null;
  openingLedgerSen: number;
  broughtForwardSen: number | null;
  closingStatementSen: number | null;
  closingLedgerSen: number;
  differenceSen: number | null;
  bankNotInBooks: { count: number; sen: number };
  booksNotOnBank: { count: number; sen: number };
  /** Earlier periods' entries still not on any statement, and what cleared
      from before the period on this statement (docs/bugs/0802). Optional so a
      server that predates them still prints. */
  carried?: { count: number; sen: number };
  clearedFromBeforeSen?: number;
  consistent: boolean;
  inconsistency: string | null;
  reconciled: boolean;
};

export type AssemblyInput = {
  month: string;
  periodFrom: string;
  periodTo: string;
  statementOpeningSen: number | null;
  openingFrom: { fileName: string; on: string } | null;
  statementClosingSen: number | null;
  closingFrom: { fileName: string; on: string } | null;
  gaps: string[];
  complete: boolean;
};

export type ReconLine = {
  id: number;
  booked_on: string;
  description: string;
  reference: string | null;
  amount_sen: number;
  kind: string;
  state: string;
  posted_je_no: string | null;
  note: string | null;
  file_name?: string | null;
};

export type ReconLedgerEntry = {
  jeNo: string;
  entryDate: string;
  sourceType: string | null;
  sourceDocNo: string | null;
  debitSen: number;
  creditSen: number;
  partyName?: string | null;
  notes?: string | null;
  carried?: boolean;
};

export type ReconReportInput = {
  accountCode: string;
  month: string;
  assembly: AssemblyInput;
  reconciliation: ReconInput;
  lines: ReconLine[];
  unmatchedEntries: ReconLedgerEntry[];
};

/* ── The report ───────────────────────────────────────────────────────────── */

/** One step of the walk from the bank's balance to the books'. */
export type StatementStep = {
  label: string;
  /** Signed as it acts on the running figure, so the column adds up as read. */
  sen: number;
  /** A sub-total or the final figure rather than a movement. */
  rule?: 'total' | 'grand';
  /** How many items are behind it, where it stands for a list below. */
  count?: number;
};

export type ReconSection = {
  title: string;
  /** Said under the title when the section is empty, or when it needs a
      sentence of its own. Never a bare empty table. */
  note?: string;
  head: string[];
  body: string[][];
};

export type ReconReport = {
  accountCode: string;
  month: string;
  periodFrom: string;
  periodTo: string;
  /** Sentences that must be read BEFORE the figures. Empty means the month is
      whole and the numbers account for themselves. */
  warnings: string[];
  /** The walk. Empty when it cannot honestly be drawn — `warnings` then says
      why, and there is no statement to file. */
  steps: StatementStep[];
  /** Where each end of the walk came from, for a reader who wants to check. */
  provenance: string[];
  /** True only when the walk arrives at the ledger balance AND the month is
      whole AND the server's own consistency check held. */
  filable: boolean;
  sections: ReconSection[];
};

const money = (sen: number): string => fmtRm(sen);
/** A deduction reads as a bracket, the way every other statement in this
    system prints one. */
const signed = (sen: number): string => (sen < 0 ? `(${fmtRm(-sen)})` : fmtRm(sen));

const sourceOf = (e: ReconLedgerEntry): string =>
  [e.sourceType, e.sourceDocNo].filter(Boolean).join(' · ') || '—';

export function reconciliationStatement(input: ReconReportInput): ReconReport {
  const { accountCode, month, assembly, reconciliation: r, lines, unmatchedEntries } = input;

  const warnings: string[] = [];
  /* ORDER MATTERS. The month being incomplete comes first: it makes every
     figure below about a different month, which no arithmetic check can
     detect. The server's own inconsistency comes second, because it means the
     figures disagree with each other. */
  if (!assembly.complete) {
    warnings.push(
      'This month is not covered end to end by the statements uploaded, so the figures below'
      + ' describe only the days that are.',
    );
    for (const g of assembly.gaps) warnings.push(g);
  }
  if (!r.consistent && r.inconsistency) warnings.push(r.inconsistency);

  const provenance: string[] = [];
  if (assembly.openingFrom) {
    provenance.push(
      `Opening ${money(assembly.statementOpeningSen ?? 0)} per ${assembly.openingFrom.fileName}`
      + ` (${fmtDocDate(assembly.openingFrom.on)}).`,
    );
  }
  if (assembly.closingFrom) {
    provenance.push(
      `Closing ${money(assembly.statementClosingSen ?? 0)} per ${assembly.closingFrom.fileName}`
      + ` (${fmtDocDate(assembly.closingFrom.on)}).`,
    );
  }

  /* THE WALK, or the reason there is none. */
  const steps: StatementStep[] = [];
  let filable = false;

  if (r.closingStatementSen == null) {
    warnings.push(
      'No statement uploaded for this month prints a closing balance, so there is no bank figure to'
      + ' reconcile from. The movements are listed below; the statement itself cannot be drawn.',
    );
  } else if (!r.consistent) {
    /* The server already refused to stand behind the difference. Drawing a
       tidy walk over figures that do not satisfy the identity would launder
       exactly the error it caught. */
  } else {
    const bankNot = r.bankNotInBooks.sen;
    const booksNot = r.booksNotOnBank.sen;
    const bf = r.broughtForwardSen ?? 0;
    /* The earlier months' entries still waiting are a step of their own — the
       conventional "outstanding from prior periods" — and the brought-forward
       is printed only for the part of it they do NOT explain. Same arithmetic
       as before once the two are put together: bf + cleared + carried is the
       unexplained remainder (docs/bugs/0802). */
    const carriedSen = r.carried?.sen ?? 0;
    const carriedCount = r.carried?.count ?? 0;
    const unexplained = bf + (r.clearedFromBeforeSen ?? 0) + carriedSen;
    const arrived = r.closingStatementSen - bankNot + booksNot + carriedSen - unexplained;

    steps.push({ label: 'Balance per bank statement', sen: r.closingStatementSen, rule: 'total' });
    steps.push({
      label: 'Less: on the bank, not in the books',
      sen: -bankNot, count: r.bankNotInBooks.count,
    });
    steps.push({
      label: 'Add: in the books, not on the bank',
      sen: booksNot, count: r.booksNotOnBank.count,
    });
    if (carriedCount > 0) {
      steps.push({ label: 'Add: still in the books from earlier months', sen: carriedSen, count: carriedCount });
    }
    if (unexplained !== 0) {
      steps.push({ label: 'Less: difference brought forward, unexplained', sen: -unexplained });
    }
    steps.push({ label: 'Balance per the books', sen: arrived, rule: 'grand' });

    /* THE CHECK. The walk is arithmetic on four numbers; the ledger balance is
       a fifth, read off the posted entries. If they part company, something
       upstream is wrong and this is not a document anybody should file. */
    if (arrived !== r.closingLedgerSen) {
      warnings.push(
        `The statement walks to ${money(arrived)} and the general ledger says ${money(r.closingLedgerSen)}.`
        + ' These must agree before this reconciliation can be filed — the figures behind it disagree'
        + ' with each other.',
      );
    } else {
      filable = assembly.complete && r.consistent;
    }
  }

  /* ── The items behind each step ─────────────────────────────────────────
     Every line of the walk that is not a total stands for a list, and the list
     is here. A figure with no list behind it is a number nobody can chase. */

  const open = lines.filter((l) => l.state === 'OPEN');
  const ignored = lines.filter((l) => l.state === 'IGNORED');
  const posted = lines.filter((l) => l.state === 'POSTED');

  const sections: ReconSection[] = [
    {
      title: `On the bank, not in the books (${open.length})`,
      note: open.length === 0
        ? 'Nothing — every movement on the statement has been dealt with.'
        : undefined,
      head: ['Date', 'Description', 'Reference', 'From file', 'Amount'],
      body: open.map((l) => [
        fmtDocDate(l.booked_on), l.description, l.reference ?? '',
        l.file_name ?? '', signed(l.amount_sen),
      ]),
    },
    {
      title: `In the books, not on the bank (${unmatchedEntries.filter((e) => !e.carried).length})`,
      note: unmatchedEntries.filter((e) => !e.carried).length === 0
        ? 'Nothing — every entry posted in these days appears on the statement.'
        : 'Posted in these days and the bank has not shown it: an uncleared cheque, a deposit'
          + ' still on its way, or an entry belonging to a day not uploaded yet.',
      head: ['Entry', 'Date', 'Source', 'Who', 'Amount'],
      body: unmatchedEntries.filter((e) => !e.carried).map((e) => [
        e.jeNo, fmtDocDate(e.entryDate), sourceOf(e), e.partyName ?? e.notes ?? '', signed(e.debitSen - e.creditSen),
      ]),
    },
    {
      title: `From earlier months, still not on any statement (${unmatchedEntries.filter((e) => e.carried).length})`,
      note: unmatchedEntries.filter((e) => e.carried).length === 0
        ? 'Nothing — every earlier entry has appeared on a statement.'
        : 'Posted before this period and no bank statement has shown it yet. These make up the difference'
          + ' brought forward.',
      head: ['Entry', 'Date', 'Source', 'Who', 'Amount'],
      body: unmatchedEntries.filter((e) => e.carried).map((e) => [
        e.jeNo, fmtDocDate(e.entryDate), sourceOf(e), e.partyName ?? e.notes ?? '', signed(e.debitSen - e.creditSen),
      ]),
    },
    {
      /* THE AUDIT SECTION. An ignored movement leaves the difference for ever,
         and the sentence beside it is the only account anybody will ever have
         of why. It is printed whether or not the month reconciles. */
      title: `Left out of the reconciliation (${ignored.length})`,
      note: ignored.length === 0
        ? 'Nothing has been left out.'
        : 'Each of these was declared none of this account\'s business. The reason given is the'
          + ' whole record of that decision.',
      head: ['Date', 'Description', 'From file', 'Amount', 'Why it was left out'],
      body: ignored.map((l) => [
        fmtDocDate(l.booked_on), l.description, l.file_name ?? '',
        signed(l.amount_sen), l.note ?? 'no reason given',
      ]),
    },
    {
      title: `Agreed and posted (${posted.length})`,
      note: posted.length === 0
        ? 'Nothing on this month\'s statements has been posted yet.'
        : undefined,
      head: ['Date', 'Description', 'Reference', 'Entry', 'Amount'],
      body: posted.map((l) => [
        fmtDocDate(l.booked_on), l.description, l.reference ?? '',
        l.posted_je_no ?? '', signed(l.amount_sen),
      ]),
    },
  ];

  return {
    accountCode,
    month,
    periodFrom: assembly.periodFrom,
    periodTo: assembly.periodTo,
    warnings,
    steps,
    provenance,
    filable,
    sections,
  };
}

/* ── Drawing it ───────────────────────────────────────────────────────────── */

/** 2026-09 → 09/2026, the same numeric month the screen shows. */
const monthText = (month: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m ? `${m[2]}/${m[1]}` : month;
};

export async function generateBankReconciliationPdf(
  input: ReconReportInput, opts?: { action?: PdfAction },
): Promise<void> {
  const report = reconciliationStatement(input);
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  await ensurePdfCjkFont(doc, input.lines);

  let y = drawHeader(doc, {
    docTitle: 'BANK RECONCILIATION STATEMENT',
    rightMeta: [
      { label: 'Account', value: report.accountCode },
      { label: 'Month', value: monthText(report.month) },
      { label: 'Days covered', value: `${fmtDocDate(report.periodFrom)} – ${fmtDocDate(report.periodTo)}` },
      { label: 'Printed', value: fmtDocStamp() },
    ],
  });

  /* Warnings FIRST, and in red, because everything under them is conditional
     on them. A reader who takes the figures and misses the sentence has been
     misled by the layout, not by the numbers. */
  if (report.warnings.length > 0) {
    doc.setFontSize(9);
    doc.setTextColor(170, 30, 30);
    for (const w of report.warnings) {
      const wrapped = doc.splitTextToSize(w, 180) as string[];
      doc.text(wrapped, 15, y + 5);
      y += 5 + wrapped.length * 4;
    }
    doc.setTextColor(0, 0, 0);
    y += 2;
  }

  if (report.steps.length > 0) {
    autoTable(doc, {
      startY: y + 2,
      body: report.steps.map((s) => [
        s.count === undefined ? s.label : `${s.label} (${s.count})`,
        signed(s.sen),
      ]),
      theme: 'plain',
      styles: { ...DOC_TABLE_STYLES, fontSize: 10 },
      columnStyles: { 0: { cellWidth: 130 }, 1: { halign: 'right' } },
      didParseCell: (data) => {
        /* BODY ONLY. autoTable fires this for head and foot rows too, and their
           row index starts at 0 as well — without this gate a head row would be
           dressed as whichever step happens to sit first in the walk. */
        if (data.section !== 'body') return;
        const step = report.steps[data.row.index];
        if (step.rule === 'grand') {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.lineWidth = { top: 0.4, bottom: 0.4, left: 0, right: 0 };
        } else if (step.rule === 'total') {
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  }

  if (report.provenance.length > 0) {
    doc.setFontSize(8);
    doc.setTextColor(110, 110, 110);
    for (const p of report.provenance) {
      doc.text(p, 15, y + 5);
      y += 4;
    }
    doc.setTextColor(0, 0, 0);
  }

  for (const section of report.sections) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    /* A section title that would land at the foot of a page takes the next one
       with its table, rather than heading an empty strip of paper. */
    if (y > 250) { doc.addPage(); y = 20; }
    doc.text(section.title, 15, y + 8);
    doc.setFont('helvetica', 'normal');
    y += 8;

    if (section.note) {
      doc.setFontSize(8);
      doc.setTextColor(110, 110, 110);
      const wrapped = doc.splitTextToSize(section.note, 180) as string[];
      doc.text(wrapped, 15, y + 4);
      y += wrapped.length * 4;
      doc.setTextColor(0, 0, 0);
    }

    if (section.body.length > 0) {
      autoTable(doc, {
        startY: y + 3,
        head: [section.head],
        body: section.body,
        theme: 'plain',
        rowPageBreak: 'avoid',
        styles: { ...DOC_TABLE_STYLES, fontSize: 8 },
        headStyles: DOC_TABLE_HEAD_STYLES,
        columnStyles: { [section.head.length - 1]: { halign: 'right' } },
      });
      y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
    }
  }

  deliverPdf(
    doc,
    `${safeName(`bank-reconciliation-${report.accountCode}-${report.month}`)}.pdf`,
    opts?.action,
  );
}
