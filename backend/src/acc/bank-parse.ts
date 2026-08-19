// ----------------------------------------------------------------------------
// acc/bank-parse — reading a BANK's account statement.
//
// Layer 4, phase 4 (brief §3.5). The sibling of settlement-parse, and it obeys
// the same two rules for the same reasons:
//
//   "各家的差异做成设定档，不要写死在代码里" — every difference between banks
//   lives in config, never in an `if (bank === 'MBB')` here. The two real files
//   in hand could hardly be less alike:
//
//     Maybank  ACCOUNTACTIVITYREPORT_564418610346.csv — PIPE delimited, 22
//              columns, dates as 20260801, amounts as 000000000171000 (integer
//              sen, zero-padded to 15), and CR/DR in a column of its own.
//     Hong Leong  acs_23600602788_*.pdf — a PDF, decimal amounts, separate
//              debit and credit columns, and a running balance.
//
//   "误传格式要报错，不准安静解析出 0 笔" (§2.14) — a file that yields no lines
//   is a FAILURE that names what it looked for and what it found, never a clean
//   empty screen. Somebody uploading last month's file by mistake must be told.
//
// What comes out is deliberately narrow: date, description, reference, ONE
// signed amount, and the balance when the file carries one. Everything a bank
// statement means beyond that — which line is a merchant payout, which is a
// cheque, which is a charge — is the matcher's job, not the reader's.
// ----------------------------------------------------------------------------

import { splitCsvLine, toIsoDate, toSen } from './settlement-parse';

/** Which column holds what. Named by HEADER TEXT, matched case- and
    space-insensitively, because banks re-caption columns between exports. */
export type BankColumnMap = {
  date: string;
  description: string;
  reference?: string;
  /** ONE column carrying a signed (or indicator-qualified) amount… */
  amount?: string;
  /** …or a pair, the way a printed statement lays them out. */
  debit?: string;
  credit?: string;
  /** The CR/DR column that tells a single unsigned amount which way it went. */
  indicator?: string;
  balance?: string;
  /** Some exports date the posting and the value separately; this is the one
      the ledger should use when it differs from `date`. */
  valueDate?: string;
};

export type BankParseConfig = {
  /** For refusals that name the file's owner rather than "the bank". */
  code: string;
  /** Maybank's export is pipe delimited. Default is a comma. */
  delimiter?: string;
  columnMap: BankColumnMap;
  /** 'integer-sen' is Maybank's 000000000171000 = RM 1,710.00. Default reads
      an ordinary decimal. */
  amountFormat?: 'decimal' | 'integer-sen';
  /** The value of `indicator` that means money came IN. Default 'CR'. */
  creditIndicator?: string;
  /** YYYY-MM, for a file whose dates carry no year. The operator's answer,
      never a guess (§2.5). */
  statementMonth?: string | null;
  statement_format?: string | null;
};

export type BankLine = {
  lineNo: number;
  /** YYYY-MM-DD. The date the ledger will use. */
  bookedOn: string;
  description: string;
  reference: string | null;
  /** Signed: positive is money IN, negative is money OUT. One number, because
      a reconciliation adds them up and a two-column shape only invites the
      sign to be lost between here and there. */
  amountSen: number;
  /** The running balance after this line, when the file prints one. */
  balanceSen: number | null;
};

export type BankParseResult =
  | {
      ok: true;
      lines: BankLine[];
      periodFrom: string;
      periodTo: string;
      inSen: number;
      outSen: number;
      /** in − out. What the account moved by over the file's period. */
      netSen: number;
      /** The balance the file itself ends on, when it carries one — the number
          a reconciliation must arrive at. */
      closingBalanceSen: number | null;
      openingBalanceSen: number | null;
      skippedLines: number;
    }
  | { ok: false; reason: string };

/** Header lookup that survives a bank re-captioning "TRX DESCRIPTION" to
    "Trx_Description" between exports. */
const headerIndex = (headers: string[], wanted: string): number => {
  const norm = (s: string) => s.replace(/[\s_.]+/g, '').toLowerCase();
  const target = norm(wanted);
  return headers.findIndex((h) => norm(h) === target);
};

/** Maybank writes 000000000171000 for RM 1,710.00: integer sen, zero-padded,
    no decimal point anywhere. Read as a decimal it becomes RM 171,000,000. */
const senFromInteger = (raw: string): number | null => {
  const s = String(raw ?? '').trim().replace(/^'/, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
};

const splitLine = (line: string, delimiter: string): string[] =>
  (delimiter === ',' ? splitCsvLine(line) : line.split(delimiter).map((s) => s.trim()));

export function parseBankStatement(cfg: BankParseConfig, text: string): BankParseResult {
  const fmt = (cfg.statement_format ?? 'CSV').toUpperCase();
  if (fmt !== 'CSV' && fmt !== 'TXT') {
    return { ok: false, reason: `${cfg.code} is configured to send ${fmt} statements, which this screen cannot read yet. Export the account activity as CSV and upload that.` };
  }

  const delimiter = cfg.delimiter ?? ',';
  const map = cfg.columnMap;
  const rawLines = text.split(/\r?\n/);

  /* Find the header ROW rather than assuming line 1: bank exports print an
     account header, a blank line, sometimes a disclaimer, before the table. */
  let headerAt = -1;
  let headers: string[] = [];
  for (let i = 0; i < rawLines.length && i < 60; i += 1) {
    const cells = splitLine(rawLines[i] ?? '', delimiter);
    if (cells.length < 3) continue;
    if (headerIndex(cells, map.date) >= 0 && headerIndex(cells, map.description) >= 0) {
      headerAt = i;
      headers = cells;
      break;
    }
  }
  if (headerAt < 0) {
    /* Name BOTH what was wanted and what the file actually has — the refusal
       that let the owner fix a bad upload himself, rather than ask. */
    const firstReal = rawLines.find((l) => splitLine(l, delimiter).length >= 3) ?? '';
    const found = splitLine(firstReal, delimiter).filter(Boolean).slice(0, 8).join(', ');
    return {
      ok: false,
      reason: `Not a ${cfg.code} account statement — no "${map.date}" and "${map.description}" heading`
        + (found ? `. The file's first row has: ${found}` : '. The file has no table in it at all.'),
    };
  }

  const at = (name?: string) => (name ? headerIndex(headers, name) : -1);
  const iDate = at(map.date);
  const iValue = at(map.valueDate);
  const iDesc = at(map.description);
  const iRef = at(map.reference);
  const iAmount = at(map.amount);
  const iDebit = at(map.debit);
  const iCredit = at(map.credit);
  const iInd = at(map.indicator);
  const iBal = at(map.balance);

  if (iAmount < 0 && (iDebit < 0 || iCredit < 0)) {
    return {
      ok: false,
      reason: `${cfg.code} is configured to read its amount from "${map.amount ?? map.debit ?? '(unset)'}", which this file does not have. Its columns are: ${headers.filter(Boolean).join(', ')}`,
    };
  }

  const readAmount = (cells: string[]): number | null => {
    const asSen = (raw: string) => (cfg.amountFormat === 'integer-sen' ? senFromInteger(raw) : toSen(raw));
    if (iAmount >= 0) {
      const v = asSen(cells[iAmount] ?? '');
      if (v == null) return null;
      if (iInd < 0) return v;
      /* One unsigned amount plus a CR/DR column — Maybank's shape. An
         indicator that is neither is refused by the caller, not guessed at. */
      const ind = String(cells[iInd] ?? '').trim().toUpperCase();
      const credit = (cfg.creditIndicator ?? 'CR').toUpperCase();
      if (ind === credit) return Math.abs(v);
      if (!ind) return null;
      return -Math.abs(v);
    }
    /* Separate columns: exactly one of them carries the money. */
    const dr = asSen(cells[iDebit] ?? '') ?? 0;
    const cr = asSen(cells[iCredit] ?? '') ?? 0;
    if (dr === 0 && cr === 0) return null;
    return Math.abs(cr) - Math.abs(dr);
  };

  const lines: BankLine[] = [];
  let skipped = 0;
  let inSen = 0;
  let outSen = 0;
  let firstBalance: number | null = null;
  let lastBalance: number | null = null;

  for (let i = headerAt + 1; i < rawLines.length; i += 1) {
    const raw = rawLines[i] ?? '';
    if (!raw.trim()) continue;
    const cells = splitLine(raw, delimiter);
    if (cells.length < 3) { skipped += 1; continue; }

    /* A row with no readable date is a total, a footer or a page break — the
       things every statement prints between its transactions. Counted, so the
       screen can say how many were left out rather than quietly dropping them. */
    const dateCell = iValue >= 0 ? (cells[iValue] || cells[iDate]) : cells[iDate];
    const hint = cfg.statementMonth && /^\d{4}-\d{2}$/.test(cfg.statementMonth)
      ? { year: Number(cfg.statementMonth.slice(0, 4)), month: Number(cfg.statementMonth.slice(5, 7)) }
      : null;
    const bookedOn = toIsoDate(dateCell ?? '', hint);
    if (!bookedOn) { skipped += 1; continue; }

    const amountSen = readAmount(cells);
    if (amountSen == null) {
      return {
        ok: false,
        reason: `Line ${i + 1} of the ${cfg.code} statement is dated ${bookedOn} but its amount could not be read`
          + (iInd >= 0 ? ` — "${cells[iAmount] ?? ''}" marked "${cells[iInd] ?? ''}".` : ` — "${cells[iAmount] ?? cells[iCredit] ?? ''}".`),
      };
    }
    /* A zero-amount row is a statement artefact (a header repeat, a memo), not
       a movement. Left out and counted, never posted. */
    if (amountSen === 0) { skipped += 1; continue; }

    const balance = iBal >= 0 ? toSen(cells[iBal] ?? '') : null;
    if (balance != null) {
      if (firstBalance == null) firstBalance = balance;
      lastBalance = balance;
    }

    if (amountSen > 0) inSen += amountSen; else outSen += -amountSen;
    lines.push({
      lineNo: i + 1,
      bookedOn,
      description: String(cells[iDesc] ?? '').replace(/\s+/g, ' ').trim(),
      reference: iRef >= 0 ? (String(cells[iRef] ?? '').trim() || null) : null,
      amountSen,
      balanceSen: balance,
    });
  }

  if (lines.length === 0) {
    return {
      ok: false,
      reason: `The ${cfg.code} statement has a heading row but no transactions under it`
        + (skipped > 0 ? ` — ${skipped} row(s) were read and none carried both a date and an amount.` : '.'),
    };
  }

  const dates = lines.map((l) => l.bookedOn).sort();
  /* The opening balance is the one BEFORE the first line, which the file does
     not print — it prints the balance after it. Derived, so a reconciliation
     has both ends of the period without asking the operator for either. */
  const openingBalanceSen = firstBalance == null ? null : firstBalance - (lines[0]?.amountSen ?? 0);

  return {
    ok: true,
    lines,
    periodFrom: dates[0]!,
    periodTo: dates[dates.length - 1]!,
    inSen,
    outSen,
    netSen: inSen - outSen,
    closingBalanceSen: lastBalance,
    openingBalanceSen,
    skippedLines: skipped,
  };
}
