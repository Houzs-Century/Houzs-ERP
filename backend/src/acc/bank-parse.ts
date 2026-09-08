// ----------------------------------------------------------------------------
// acc/bank-parse — reading a BANK's account statement.
//
// Layer 4, phase 4 (brief §3.5). The sibling of settlement-parse, and it obeys
// the same two rules for the same reasons:
//
//   "各家的差异做成设定档，不要写死在代码里" — every difference between banks
//   lives in config, never in an `if (bank === 'MBB')` here. The real files
//   in hand could hardly be less alike:
//
//     Maybank  ACCOUNTACTIVITYREPORT_564418610346.csv — PIPE delimited, 22
//              columns, dates as 20260801, amounts as 000000000171000 (integer
//              sen, zero-padded to 15), and CR/DR in a column of its own.
//     Hong Leong  acs_23600602788_*.csv — the monthly statement: a title row,
//              then Date / Transaction Description / Cheque No. / Ref. No. /
//              Deposit / Withdrawal / Balance, EVERY cell wrapped as ="…"
//              (Excel's keep-my-zeros guard), an opening "Balance from previous
//              statement" row, and the balance printed only on a day's last line.
//     Hong Leong  Transaction_Statement_*.csv — the any-day export: eleven
//              preamble rows (account, period, "Prior Day Balance"), then
//              Transaction Date / Remarks / Sender-Receiver Name / Receipient
//              Reference / Other Payment Details / Payment Amount / Credit
//              Amount / Balance, thousands separators, NEWEST FIRST.
//
//   "误传格式要报错，不准安静解析出 0 笔" (§2.14) — a file that yields no lines
//   is a FAILURE that names what it looked for and what it found, never a clean
//   empty screen. Somebody uploading last month's file by mistake must be told.
//
// HEADINGS, NOT POSITIONS (owner 2026-09-08: 别卡死读 column, 我怕未来 bank 可能
// 换 format). A column is found by its heading text — case, spaces and
// punctuation folded — never by where it sits, so a bank that inserts a
// column or reorders its export still reads. Each role carries the names the
// config teaches AND a built-in list of the names banks use for it, so a
// re-captioned heading ("Date" → "Transaction Date") reads without anyone
// touching the setup; a file whose headings match none of them is refused
// with its own headings quoted, so the operator can add the new name in
// Reconciliation setup rather than ask.
//
// What comes out is deliberately narrow: date, description, reference, ONE
// signed amount, and the balance when the file carries one — in DATE ORDER,
// whichever way the bank printed it. Everything a bank statement means beyond
// that — which line is a merchant payout, which is a cheque, which is a charge
// — is the matcher's job, not the reader's.
// ----------------------------------------------------------------------------

import { splitCsvLine, toIsoDate, toSen } from './settlement-parse';

/** One heading, or several the bank has used for the same column. */
export type Heading = string | string[];

/** Which column holds what. Named by HEADER TEXT, matched case-, space- and
    punctuation-insensitively, because banks re-caption columns between exports. */
export type BankColumnMap = {
  date: Heading;
  description: Heading;
  /** Several headings here are JOINED (space-separated, in this order) when
      the file has more than one — Hong Leong's any-day export splits the
      narrative into a name, a reference and "other details". */
  reference?: Heading;
  /** ONE column carrying a signed (or indicator-qualified) amount… */
  amount?: Heading;
  /** …or a pair, the way a printed statement lays them out. */
  debit?: Heading;
  credit?: Heading;
  /** The CR/DR column that tells a single unsigned amount which way it went. */
  indicator?: Heading;
  balance?: Heading;
  /** Some exports date the posting and the value separately; this is the one
      the ledger should use when it differs from `date`. */
  valueDate?: Heading;
};

/** The names banks actually print, per role — tried AFTER what the config
    names, so a config is never wrong for being short. Kept as data, in one
    place, so a new bank's caption is one line here or one field in setup. */
export const DEFAULT_HEADINGS: Record<keyof BankColumnMap, string[]> = {
  date: ['Date', 'Transaction Date', 'Txn Date', 'Trans Date', 'Trx Date', 'Posting Date', 'Effect Date', 'Entry Date', 'Tarikh'],
  valueDate: ['Value Date'],
  description: ['Transaction Description', 'Description', 'Remarks', 'Trx Description', 'Transaction Type', 'Particulars', 'Details', 'Narration', 'Transaction Details', 'Butiran'],
  reference: ['Ref. No.', 'Ref No', 'Reference', 'Reference No', 'Trx Reference', 'Transaction Reference', 'Sender / Receiver Name', 'Recipient Reference', 'Receipient Reference', 'Other Payment Details', 'Payment Details', 'Beneficiary Name'],
  amount: ['Amount', 'Transaction Amount', 'Trx Amount'],
  debit: ['Withdrawal', 'Withdrawals', 'Debit', 'Debit Amount', 'Payment Amount', 'Money Out', 'Out'],
  credit: ['Deposit', 'Deposits', 'Credit', 'Credit Amount', 'Money In', 'In'],
  indicator: ['Amount Ind', 'CR/DR', 'DR/CR', 'Indicator', 'Dr/Cr'],
  balance: ['Balance', 'Running Balance', 'Ledger Balance', 'Statement Balance', 'Closing Balance'],
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
      /** In date order, oldest first, whichever way the file printed them. */
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

/** Heading text folded so "TRX DESCRIPTION", "Trx_Description" and
    "Trx. Description" are one heading. */
const foldHeading = (s: string) => s.replace(/[\s_.\-/()':]+/g, '').toLowerCase();

const asList = (h: Heading | undefined): string[] => (h == null ? [] : Array.isArray(h) ? h : [h]);

/** Header lookup that survives a bank re-captioning a column between exports:
    the config's own names first, then the names banks are known to print. */
const findColumn = (headers: string[], role: keyof BankColumnMap, map: BankColumnMap): number => {
  const folded = headers.map(foldHeading);
  for (const name of [...asList(map[role]), ...DEFAULT_HEADINGS[role]]) {
    const i = folded.indexOf(foldHeading(name));
    if (i >= 0) return i;
  }
  return -1;
};

/** EVERY matching column, deduplicated, in the order named — for the roles
    whose text is joined (reference). */
const findColumns = (headers: string[], role: keyof BankColumnMap, map: BankColumnMap): number[] => {
  const folded = headers.map(foldHeading);
  const out: number[] = [];
  for (const name of [...asList(map[role]), ...DEFAULT_HEADINGS[role]]) {
    const i = folded.indexOf(foldHeading(name));
    if (i >= 0 && !out.includes(i)) out.push(i);
  }
  return out;
};

/** Maybank writes 000000000171000 for RM 1,710.00: integer sen, zero-padded,
    no decimal point anywhere. Read as a decimal it becomes RM 171,000,000. */
const senFromInteger = (raw: string): number | null => {
  const s = String(raw ?? '').trim().replace(/^'/, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
};

/** Excel's two "keep this as text" guards — a leading apostrophe, and the
    ="…" formula wrapper Hong Leong Connect puts round EVERY cell (the quotes
    are gone by the time the CSV splitter hands the cell over; the = is not). */
const unguard = (cell: string): string => cell.replace(/^=/, '').replace(/^'/, '').trim();

const splitLine = (line: string, delimiter: string): string[] =>
  (delimiter === ',' ? splitCsvLine(line) : line.split(delimiter).map((s) => s.trim())).map(unguard);

/** The row a statement prints for the balance it STARTED from — "Balance from
    previous statement", "Prior Day Balance :", "Balance b/f", "Opening balance". */
const OPENING_ROW = /(?:prior\s*day|opening|previous|beginning|brought\s*forward|b\/f)\s*(?:day\s*)?balance|balance\s*(?:b\/f|brought\s*forward|from\s*previous|carried\s*from)/i;

export function parseBankStatement(cfg: BankParseConfig, text: string): BankParseResult {
  const fmt = (cfg.statement_format ?? 'CSV').toUpperCase();
  if (fmt !== 'CSV' && fmt !== 'TXT') {
    return { ok: false, reason: `${cfg.code} is configured to send ${fmt} statements, which this screen cannot read yet. Export the account activity as CSV and upload that.` };
  }

  const delimiter = cfg.delimiter ?? ',';
  const map = cfg.columnMap;
  const rawLines = text.split(/\r?\n/);

  /* Find the header ROW rather than assuming line 1: bank exports print an
     account header, a blank line, a report preamble, sometimes a disclaimer,
     before the table. A row is the header when a date column AND a
     description column can be named on it. */
  let headerAt = -1;
  let headers: string[] = [];
  for (let i = 0; i < rawLines.length && i < 60; i += 1) {
    const cells = splitLine(rawLines[i] ?? '', delimiter);
    if (cells.length < 3) continue;
    if (findColumn(cells, 'date', map) >= 0 && findColumn(cells, 'description', map) >= 0) {
      headerAt = i;
      headers = cells;
      break;
    }
  }
  if (headerAt < 0) {
    /* Name BOTH what was wanted and what the file actually has — the refusal
       that let the owner fix a bad upload himself, rather than ask. */
    const firstReal = rawLines.find((l) => splitLine(l, delimiter).filter(Boolean).length >= 3) ?? '';
    const found = splitLine(firstReal, delimiter).filter(Boolean).slice(0, 8).join(', ');
    const wanted = (role: keyof BankColumnMap) => [...asList(map[role]), ...DEFAULT_HEADINGS[role]].slice(0, 3).join('" / "');
    return {
      ok: false,
      reason: `Not a ${cfg.code} account statement — no heading row with a date column ("${wanted('date')}"…) and a description column ("${wanted('description')}"…)`
        + (found ? `. The file's first row has: ${found}` : '. The file has no table in it at all.'),
    };
  }

  const iDate = findColumn(headers, 'date', map);
  const iValue = findColumn(headers, 'valueDate', map);
  const iDesc = findColumn(headers, 'description', map);
  const iRefs = findColumns(headers, 'reference', map);
  const iAmount = findColumn(headers, 'amount', map);
  const iDebit = findColumn(headers, 'debit', map);
  const iCredit = findColumn(headers, 'credit', map);
  const iInd = findColumn(headers, 'indicator', map);
  const iBal = findColumn(headers, 'balance', map);

  if (iAmount < 0 && (iDebit < 0 || iCredit < 0)) {
    const wanted = [...asList(map.amount), ...asList(map.debit), ...asList(map.credit)].filter(Boolean).slice(0, 3).join('" / "') || DEFAULT_HEADINGS.debit.slice(0, 2).join('" / "');
    return {
      ok: false,
      reason: `${cfg.code} is configured to read its amount from "${wanted}", which this file does not have. Its columns are: ${headers.filter(Boolean).join(', ')}`,
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

  /* The balance the statement STARTED from, when it says so — a preamble row
     ("Prior Day Balance :", followed by the figure) or the opening row printed
     inside the table ("Balance from previous statement", figure in the balance
     column). Read, not derived: a day of several lines prints ONE balance,
     after the last of them, and deriving the opening from that line alone was
     wrong by the rest of the day. */
  let openingExplicit: number | null = null;
  const openingIn = (cells: string[]): number | null => {
    if (!cells.some((c) => OPENING_ROW.test(c))) return null;
    if (iBal >= 0) {
      const v = toSen(cells[iBal] ?? '');
      if (v != null) return v;
    }
    for (const c of cells) {
      if (OPENING_ROW.test(c)) continue;
      const v = toSen(c);
      if (v != null) return v;
    }
    return null;
  };
  for (let i = 0; i < headerAt; i += 1) {
    const cells = splitLine(rawLines[i] ?? '', delimiter);
    const v = openingIn(cells);
    if (v != null) { openingExplicit = v; break; }
  }

  const hint = cfg.statementMonth && /^\d{4}-\d{2}$/.test(cfg.statementMonth)
    ? { year: Number(cfg.statementMonth.slice(0, 4)), month: Number(cfg.statementMonth.slice(5, 7)) }
    : null;

  const lines: BankLine[] = [];
  let skipped = 0;
  let inSen = 0;
  let outSen = 0;

  for (let i = headerAt + 1; i < rawLines.length; i += 1) {
    const raw = rawLines[i] ?? '';
    if (!raw.trim()) continue;
    const cells = splitLine(raw, delimiter);
    if (cells.filter(Boolean).length < 2) { skipped += 1; continue; }

    /* A row with no readable date is a total, a footer, a page break — or the
       opening row, which is kept for its figure. Counted, so the screen can say
       how many were left out rather than quietly dropping them. */
    const dateCell = iValue >= 0 ? (cells[iValue] || cells[iDate]) : cells[iDate];
    const bookedOn = toIsoDate(dateCell ?? '', hint);
    if (!bookedOn) {
      if (openingExplicit == null) {
        const v = openingIn(cells);
        if (v != null) openingExplicit = v;
      }
      skipped += 1;
      continue;
    }

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
    if (amountSen > 0) inSen += amountSen; else outSen += -amountSen;
    lines.push({
      lineNo: i + 1,
      bookedOn,
      description: String(cells[iDesc] ?? '').replace(/\s+/g, ' ').trim(),
      reference: iRefs.length > 0
        ? (iRefs.map((k) => String(cells[k] ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ') || null)
        : null,
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

  /* DATE ORDER, oldest first, whichever way the bank printed it: Hong Leong's
     any-day export runs newest first, its monthly statement oldest first, and
     a reconciliation must not care. The file's own order within a day is
     kept (reversed as a whole when the file ran backwards). */
  if (lines.length > 1 && lines[0]!.bookedOn > lines[lines.length - 1]!.bookedOn) lines.reverse();

  const dates = lines.map((l) => l.bookedOn);
  /* The closing balance is the last one the file prints, in date order. The
     opening is what the file SAYS it opened at when it says so; otherwise
     derived from the first printed balance less every movement up to and
     including the line that carries it — a day's balance is printed once,
     after the day's last line. */
  let closingBalanceSen: number | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.balanceSen != null) { closingBalanceSen = lines[i]!.balanceSen; break; }
  }
  let openingBalanceSen: number | null = openingExplicit;
  if (openingBalanceSen == null) {
    const firstAt = lines.findIndex((l) => l.balanceSen != null);
    if (firstAt >= 0) {
      openingBalanceSen = lines[firstAt]!.balanceSen! - lines.slice(0, firstAt + 1).reduce((s, l) => s + l.amountSen, 0);
    }
  }

  return {
    ok: true,
    lines,
    periodFrom: dates[0]!,
    periodTo: dates[dates.length - 1]!,
    inSen,
    outSen,
    netSen: inSen - outSen,
    closingBalanceSen,
    openingBalanceSen,
    skippedLines: skipped,
  };
}

/* ── The same movement, however the bank printed it ─────────────────────────
   Two exports of one account overlap whenever the owner reconciles every few
   days and again at month end (2026-09-08: 可能隔几天我就做一次). The same
   transaction reads "Fund transfer RACHEL NG" on one and "RACHEL NG Fund
   transfer" on the other, and Hong Leong's any-day export even splits
   "MERCHANT" into "MERCHAN" + "T" across two columns. So a movement's
   fingerprint is its day, its amount and its WORDS — folded, one-letter
   fragments glued back onto the word before them, sorted — not its text. */
export function movementFingerprint(m: { bookedOn: string; amountSen: number; description: string; reference: string | null }): string {
  const raw = `${m.description} ${m.reference ?? ''}`.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').trim();
  const tokens: string[] = [];
  for (const t of raw.split(/\s+/).filter(Boolean)) {
    if (t.length === 1 && tokens.length > 0) tokens[tokens.length - 1] += t;
    else tokens.push(t);
  }
  return `${m.bookedOn}|${m.amountSen}|${[...new Set(tokens)].sort().join(' ')}`;
}
