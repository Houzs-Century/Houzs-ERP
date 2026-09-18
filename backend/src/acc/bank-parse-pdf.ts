// ----------------------------------------------------------------------------
// acc/bank-parse-pdf — a bank's MONTHLY STATEMENT PDF, read into the same
// shape the CSV reader hands over (docs/bugs/0869).
//
// Owner, 2026-09-14, after Maybank's own Account Activity export turned out
// to omit two June credits that the monthly statement PDF printed: 我觉得可以
// pdf，就也支持 csv，也支持 pdf. The statement PDF is the bank's own paper —
// every movement of the month, the balance it opened at and the balance it
// closed at — so a month read off it needs no typed month-end figure
// (bank-month rule 4) and no export to be complete.
//
// WHAT ARRIVES. The browser does the extraction (pdf.js, lib/pdf-text.ts):
// every piece of text on every page with the x/y it was drawn at, grouped
// into lines by y and ordered by x. Nothing is interpreted there — the
// bank-specific reading lives HERE, on the server, the way the CSV column
// maps do, so a layout rule cannot exist in two spellings.
//
// MAYBANK (SME FIRST ACCOUNT-I, "URUSNIAGA AKAUN / ACCOUNT TRANSACTIONS"):
//   ENTRY DATE  VALUE DATE  TRANSACTION DESCRIPTION  TRANSACTION AMOUNT  STATEMENT BALANCE
//   BEGINNING BALANCE                                                     1,876.20
//   03/08       CR/CARD SALES MN 32649964 D            6,820.80+          8,697.00
//   05/08       TRANSFER FR A/C                        7,379.25-          1,317.75
//               ENG SUI HOR *            ← continuation lines: no date, no amount
//               Transfer
//   ...
//   ENDING BALANCE :                                                     44,059.61
// The entry date carries no year; the header's STATEMENT DATE (dd/mm/yy)
// does. The amount's sign is a suffix: + in, - out. The page header repeats on
// every page; rows may continue on the next page; ENDING BALANCE ends them.
// The file prints no transaction reference.
//
// A bank with no PDF layout here is refused by name — the CSV export still
// works for it — rather than guessed at.
// ----------------------------------------------------------------------------

import type { BankLine, BankParseResult } from './bank-parse';

export type PdfCell = { x: number; t: string };
export type PdfLine = { y: number; cells: PdfCell[] };
export type PdfPage = { lines: PdfLine[] };
/** What the browser sends: the marker, then the pages. */
export type PdfStatement = { kind: typeof PDF_TEXT_KIND; pages: PdfPage[] };

export const PDF_TEXT_KIND = 'houzs-pdf-text/1';

/** The upload body's `content` when the file was a PDF — JSON in this shape,
    or null when it is not (a CSV, or a PDF extraction this reader does not
    know). Shape-checked cell by cell: a page that is not a page is refused
    here, not three functions later. */
export function readPdfContent(content: string): PdfStatement | null {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as { kind?: unknown; pages?: unknown };
  if (o.kind !== PDF_TEXT_KIND || !Array.isArray(o.pages)) return null;
  const pages: PdfPage[] = [];
  for (const pg of o.pages as unknown[]) {
    if (!pg || typeof pg !== 'object' || !Array.isArray((pg as { lines?: unknown }).lines)) return null;
    const lines: PdfLine[] = [];
    for (const ln of (pg as { lines: unknown[] }).lines) {
      if (!ln || typeof ln !== 'object') return null;
      const l = ln as { y?: unknown; cells?: unknown };
      if (typeof l.y !== 'number' || !Array.isArray(l.cells)) return null;
      const cells: PdfCell[] = [];
      for (const c of l.cells as unknown[]) {
        const cell = c as { x?: unknown; t?: unknown } | null;
        if (!cell || typeof cell.x !== 'number' || typeof cell.t !== 'string') return null;
        cells.push({ x: cell.x, t: cell.t });
      }
      lines.push({ y: l.y, cells: [...cells].sort((a, b) => a.x - b.x) });
    }
    /* Top of the page first: pdf.js measures y upwards from the bottom. */
    pages.push({ lines: [...lines].sort((a, b) => b.y - a.y) });
  }
  return { kind: PDF_TEXT_KIND, pages };
}

/** Every digit on every page, for the account-number check the upload makes. */
export const pdfDigits = (pdf: PdfStatement): string =>
  pdf.pages.map((p) => p.lines.map((l) => l.cells.map((c) => c.t).join(' ')).join(' ')).join(' ').replace(/\D/g, '');

/** The banks this file can read a statement PDF for, by bank code. */
export const PDF_LAYOUTS: ReadonlySet<string> = new Set(['MBB']);

const rm = (sen: number) =>
  `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "6,820.80" → 682080; null when it is not money. */
const senOf = (raw: string): number | null => {
  const s = raw.replace(/,/g, '').trim();
  if (!/^\d+\.\d{2}$/.test(s)) return null;
  const n = Math.round(Number(s) * 100);
  return Number.isSafeInteger(n) ? n : null;
};

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Read a statement PDF for one bank. `statementMonth` (YYYY-MM, the
 * operator's Year-and-month box) is the fallback for a file whose header
 * carries no statement date; the file's own date wins when it prints one.
 */
export function parsePdfStatement(p: { bankCode: string; pdf: PdfStatement; statementMonth: string | null }): BankParseResult {
  const bank = p.bankCode.trim().toUpperCase();
  if (bank === 'MBB') return parseMaybank(p.pdf, p.statementMonth);
  return {
    ok: false,
    reason: `No statement-PDF layout is set up for ${bank} yet — upload its CSV export instead.`,
  };
}

/* ── Maybank ─────────────────────────────────────────────────────────────── */

const MBB = {
  /** The entry date sits at the left edge; the description starts past it. */
  dateMaxX: 70,
  descFromX: 90,
  descToX: 320,
  /** The running balance is the rightmost figure. */
  balanceFromX: 400,
};

const DATE_DDMM = /^(\d{2})\/(\d{2})$/;
const DATE_DDMMYY = /^(\d{2})\/(\d{2})\/(\d{2})$/;
const SIGNED_MONEY = /^([\d,]+\.\d{2})([+-])$/;
const MONEY = /^[\d,]+\.\d{2}$/;

function parseMaybank(pdf: PdfStatement, statementMonth: string | null): BankParseResult {
  /* THE YEAR. The rows print dd/mm; the header prints the statement date
     dd/mm/yy. That date is the month's last day, so its month is the month
     the rows belong to — except a row from the month before, which a
     statement opening on the 1st never carries but a rollover would. */
  let year: number | null = null;
  let month: number | null = null;
  for (const page of pdf.pages) {
    for (const line of page.lines) {
      const hit = line.cells.map((c) => DATE_DDMMYY.exec(c.t)).find(Boolean);
      if (hit) { year = 2000 + Number(hit[3]); month = Number(hit[2]); break; }
    }
    if (year != null) break;
  }
  if (year == null || month == null) {
    const m = /^(\d{4})-(\d{2})$/.exec(statementMonth ?? '');
    if (m) { year = Number(m[1]); month = Number(m[2]); }
  }
  if (year == null || month == null) {
    return { ok: false, reason: 'This PDF prints no statement date, and no year and month was named. Choose the year and month it is for.' };
  }
  const yearOf = (rowMonth: number): number => (rowMonth > month! + 6 ? year! - 1 : year!);

  const lines: BankLine[] = [];
  let openingBalanceSen: number | null = null;
  let closingBalanceSen: number | null = null;
  let ended = false;

  for (const page of pdf.pages) {
    if (ended) break;
    /* The page header repeats above the table on every page; rows start once
       the column headings, or the beginning balance, have gone by. */
    let inTable = false;
    for (const line of page.lines) {
      const texts = line.cells.map((c) => c.t.trim());
      const joined = texts.join(' ');
      const balanceCell = [...line.cells].reverse().find((c) => c.x >= MBB.balanceFromX && MONEY.test(c.t.trim()));
      /* The balance rows carry a FIGURE. The page footer prints "LEDGER
         BALANCE = ENDING BALANCE - UNCLEARED CHEQUES" under every page's
         table, and those words alone must neither open nor end the reading. */
      if (/ENTRY DATE/.test(joined) || (/BEGINNING BALANCE/.test(joined) && balanceCell)) inTable = true;
      if (!inTable) continue;
      if (/BEGINNING BALANCE/.test(joined) && balanceCell) {
        openingBalanceSen = senOf(balanceCell.t);
        continue;
      }
      if (/ENDING BALANCE\s*:/.test(joined) && balanceCell) {
        closingBalanceSen = senOf(balanceCell.t);
        ended = true;
        break;
      }
      const first = line.cells[0];
      const dateHit = first && first.x < MBB.dateMaxX ? DATE_DDMM.exec(first.t.trim()) : null;
      const amountCell = line.cells.find((c) => c.x >= MBB.descToX && SIGNED_MONEY.test(c.t.trim()));
      const descCells = line.cells.filter((c) => c.x >= MBB.descFromX && c.x < MBB.descToX && c !== amountCell && c !== balanceCell);
      const description = descCells.map((c) => c.t.trim()).filter(Boolean).join(' ').replace(/\s+\*$/, '').trim();

      if (dateHit && amountCell) {
        const m = SIGNED_MONEY.exec(amountCell.t.trim())!;
        const magnitude = senOf(m[1]!);
        if (magnitude == null) return { ok: false, reason: `Line ${lines.length + 1}: "${amountCell.t}" is not an amount.` };
        const dd = Number(dateHit[1]);
        const mm = Number(dateHit[2]);
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return { ok: false, reason: `Line ${lines.length + 1}: "${first!.t}" is not a day.` };
        lines.push({
          lineNo: lines.length + 1,
          bookedOn: `${yearOf(mm)}-${pad(mm)}-${pad(dd)}`,
          description,
          reference: null,
          amountSen: m[2] === '-' ? -magnitude : magnitude,
          balanceSen: balanceCell ? senOf(balanceCell.t) : null,
        });
        continue;
      }
      /* A continuation line: the rest of the description of the row above
         (the payer's name, "Transfer", the bank's own tag). Only text inside
         the description column, with no date and no figure, counts. */
      if (!dateHit && !amountCell && !balanceCell && description && lines.length > 0
        && line.cells.every((c) => c.x >= MBB.descFromX && c.x < MBB.descToX)) {
        const last = lines[lines.length - 1]!;
        last.description = `${last.description} ${description}`.trim();
      }
    }
  }

  if (lines.length === 0 && openingBalanceSen == null && closingBalanceSen == null) {
    return { ok: false, reason: 'No transaction rows, and no beginning or ending balance, were found on this PDF — is it a Maybank account statement?' };
  }

  /* THE CHECK. The rows must walk from the balance the statement opened at
     to the balance it closed at; where they do not, a row was misread (or a
     page was missing) and the file is refused rather than trusted. */
  const netSen = lines.reduce((s, l) => s + l.amountSen, 0);
  if (openingBalanceSen != null && closingBalanceSen != null && openingBalanceSen + netSen !== closingBalanceSen) {
    return {
      ok: false,
      reason: `The rows read do not walk from the beginning balance ${rm(openingBalanceSen)} to the ending balance ${rm(closingBalanceSen)}`
        + ` — they come to ${rm(openingBalanceSen + netSen)}. A row was misread or a page is missing; the file was not loaded.`,
    };
  }

  const ordered = [...lines].sort((a, b) => a.bookedOn.localeCompare(b.bookedOn) || a.lineNo - b.lineNo)
    .map((l, i) => ({ ...l, lineNo: i + 1 }));
  const inSen = ordered.filter((l) => l.amountSen > 0).reduce((s, l) => s + l.amountSen, 0);
  const outSen = ordered.filter((l) => l.amountSen < 0).reduce((s, l) => s - l.amountSen, 0);
  /* A quiet month prints its balances and no row: the statement stands for
     the whole month it is dated in (docs/bugs/0794). */
  const monthFrom = `${year}-${pad(month)}-01`;
  const monthTo = `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
  return {
    ok: true,
    lines: ordered,
    periodFrom: ordered[0]?.bookedOn ?? monthFrom,
    periodTo: ordered[ordered.length - 1]?.bookedOn ?? monthTo,
    inSen,
    outSen,
    netSen,
    closingBalanceSen,
    openingBalanceSen,
    skippedLines: 0,
  };
}
