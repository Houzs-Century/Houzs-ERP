// ----------------------------------------------------------------------------
// sales-report-parse — reads the daily sales report the floor posts in the
// WhatsApp group, one bill per line, so a project can count it.
//
// WHY (owner 2026-10-14). Every evening a salesperson posts, per booth:
//
//     11/10 Akemi @ SUNWAY KLUANG MALL
//     1. HC8993 RM6500 Jason
//     2. HC10785 RM4999 Melvin
//     Total - RM 11,499
//
// and at the end of the fair a summary of the days:
//
//     Homedec@Zanotti 2-4/10
//     2/10 - RM6288
//     4/10 - RM8538+150(D)
//     Total- RM23,714+150(D)
//
// The bill list is the ONLY per-bill, per-person record of what the fair sold
// until each bill is keyed into the Sales Order module days later; the summary
// is the figure the office keys into Total Sales. Pasted into the project's
// chat, the project counts both.
//
// THE GRAMMAR, deliberately tolerant — this is typed on a phone, not a form:
//   · a BILL line is  (n.)  <booklet no>  (- or :)  (RM) <amount>  (+ extra (TAG))  (- or :)  (name)
//     booklet no  = 1–5 letters, optional space/dash, 3–6 digits  (HC8993,
//                   HC 10785, ZNT-6042, CR0315); kept as typed in `ref_raw`
//                   and normalised (upper, letters+digits only) in `ref_token`,
//                   the key every other surface matches on (customer-ref.ts
//                   puts the same number in the SO's Ref No.).
//     amount      = "RM6500", "RM 6,500", "6500", "6,500.00" → sen.
//     extra       = "+ 710(T)" transport, "+150(D)" disposal: kept APART from
//                   the amount, because Total Sales is keyed without them
//                   (owner 2026-10-14). The closing parenthesis is optional —
//                   it is often lost when typing.
//     name        = whatever follows, trimmed; absent is allowed.
//   · a DAY line  ("9/10: RM10,500", "4/10 - RM8538+150(D)") is one day's
//     total in a summary; its extra is likewise kept apart.
//   · a TOTAL line ("Total - RM 11,499", "TOTAL: RM37,865+2883(T)") is read,
//     never trusted: when the bills or the days do not add up to it, a
//     warning says so.
//   · a DATE comes from the first line that starts with d/m and is not a day
//     line (the header); the year is the project's — never guessed here.
// Anything else is skipped and listed, so a person can see what was not
// understood instead of discovering a missing bill a week later.
//
// MIRRORED byte-for-byte to frontend/src/vendor/shared/sales-report-parse.ts
// (check-shared-mirrors.mjs): the chat reads a message with the same code the
// server counts it with.
// ----------------------------------------------------------------------------

export type ParsedBill = {
  /** 1-based line number in the pasted text. */
  line: number;
  ref_raw: string;
  ref_token: string;
  amount_sen: number;
  /** A "+ 710(T)" tail after the amount: kept apart from the bill, not counted
   *  in amount_sen, only shown. The tag is what sat in the parentheses. */
  extra_sen: number | null;
  extra_tag: string | null;
  salesperson_name: string | null;
};

export type ParsedDay = {
  line: number;
  day: number;
  month: number;
  amount_sen: number;
  extra_sen: number | null;
  extra_tag: string | null;
};

export type ParsedSalesReport = {
  /** The report's day/month: a line that is a date, else a date inside the
   *  header line (not a range of days). */
  date: { day: number; month: number } | null;
  bills: ParsedBill[];
  /** A summary's per-day totals. */
  days: ParsedDay[];
  /** The message's own "Total" line, in sen, without its "+" extra. */
  total_sen: number | null;
  /** Lines that were neither a bill, a day, the header, the total nor blank. */
  skipped: Array<{ line: number; text: string }>;
  /** Human warnings: extras kept apart, a total that does not add up. */
  warnings: string[];
};

/** "HC 8993" / "hc-8993" / "HC8993" → "HC8993". Letters and digits only,
 *  upper-cased — the one spelling two surfaces can agree on. */
export function normalizeRefToken(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Every booklet-number-shaped token in a free-text field, normalised. The
 *  SO's Ref No. is typed by hand ("HC13263 share with yuny", "HC13503 +
 *  ZNT6191"), so a field can carry more than one and some other words. */
export function extractRefTokens(text: string | null | undefined): string[] {
  const out: string[] = [];
  const re = /([A-Za-z]{1,5})\s*-?\s*(\d{3,6})(?!\d)/g;
  for (const m of String(text ?? "").matchAll(re)) {
    out.push(normalizeRefToken(`${m[1]}${m[2]}`));
  }
  return Array.from(new Set(out));
}

/* Spelled as alternations, not character classes, and no bracket-colon form
   anywhere in this file, comments included: Tailwind scans every source file
   for class candidates and turned the dash/colon class into an invalid CSS
   rule that failed the production build. */
const AMOUNT = String.raw`([\d][\d,]*(?:\.\d{1,2})?)`;
const EXTRA = String.raw`(?:\s*\+\s*(?:RM|rm|Rm)?\s*([\d][\d,]*(?:\.\d{1,2})?)(?:\s*\(\s*([A-Za-z]{1,3})\s*\)?)?)?`;
const SEP = String.raw`(?:-|:|–|=)`;
const BILL_RE = new RegExp(
  String.raw`^\s*(?:\d{1,3}\s*[.)]\s*)?([A-Za-z]{1,5}\s*-?\s*\d{3,6})\b\s*${SEP}?\s*(?:RM|rm|Rm)?\s*${AMOUNT}${EXTRA}\s*${SEP}?\s*(.*?)\s*$`,
);
const DAY_RE = new RegExp(
  String.raw`^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*${SEP}\s*(?:RM|rm|Rm)?\s*${AMOUNT}${EXTRA}\s*$`,
);
const TOTAL_RE = new RegExp(String.raw`^\s*total\b\s*${SEP}?\s*(?:RM|rm|Rm)?\s*${AMOUNT}${EXTRA}\s*$`, "i");
const DATE_RE = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\b/;
const RANGE_RE = /\d{1,2}\s*-\s*\d{1,2}\s*\/\s*\d{1,2}/g;
const EMBEDDED_DATE_RE = /(?:^|\D)(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/;

/** sen → "1,234.00" for the sentences this module writes; the shared
 *  formatter lives outside the mirrored pair, so this stays dependency-free. */
const ringgit = (sen: number): string =>
  (sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function amountToSen(s: string): number | null {
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function extraOf(amount: string | undefined, tag: string | undefined): { extra_sen: number | null; extra_tag: string | null } {
  const sen = amount ? amountToSen(amount) : null;
  return { extra_sen: sen != null && sen > 0 ? sen : null, extra_tag: tag ? tag.toUpperCase() : null };
}

const validDayMonth = (day: number, month: number): boolean => day >= 1 && day <= 31 && month >= 1 && month <= 12;

export function parseSalesReport(text: string | null | undefined): ParsedSalesReport {
  const lines = String(text ?? "").split(/\r?\n/);
  const bills: ParsedBill[] = [];
  const days: ParsedDay[] = [];
  const skipped: Array<{ line: number; text: string }> = [];
  const warnings: string[] = [];
  /* A line that IS a date ("10/10") wins over a date inside a header
     ("AKEMI@Setia Spice Convention Centre 3/10"); a range ("9-11/10") is the
     fair's days, never the report's. */
  let lineDate: ParsedSalesReport["date"] = null;
  let headerDate: ParsedSalesReport["date"] = null;
  let total_sen: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    /* WhatsApp and iOS copy a numbered list with invisible joiners (U+2060,
       zero-width spaces, a BOM) and non-breaking spaces. The eye cannot see
       them and neither could this reader: three of seven bills were dropped
       on the first live paste (2026-10-14). Strip the former and fold the
       latter to a space before anything is matched. */
    const t = lines[i]!.replace(/[​-‍⁠﻿]/g, "").replace(/ /g, " ").trim();
    if (!t) continue;

    const total = t.match(TOTAL_RE);
    if (total) {
      total_sen = amountToSen(total[1]!);
      continue;
    }

    const bill = t.match(BILL_RE);
    if (bill) {
      const amount = amountToSen(bill[2]!);
      if (amount != null && amount > 0) {
        const name = bill[5]!.replace(/^(?:-|:|–)\s*/, "").trim();
        bills.push({
          line,
          ref_raw: bill[1]!.replace(/\s+/g, " ").trim(),
          ref_token: normalizeRefToken(bill[1]!),
          amount_sen: amount,
          ...extraOf(bill[3], bill[4]),
          salesperson_name: name || null,
        });
        continue;
      }
    }

    const dayLine = t.match(DAY_RE);
    if (dayLine) {
      const day = Number(dayLine[1]);
      const month = Number(dayLine[2]);
      const amount = amountToSen(dayLine[3]!);
      if (validDayMonth(day, month) && amount != null) {
        days.push({ line, day, month, amount_sen: amount, ...extraOf(dayLine[4], dayLine[5]) });
        continue;
      }
    }

    const d = t.match(DATE_RE);
    if (d && lineDate == null && bills.length === 0) {
      const day = Number(d[1]);
      const month = Number(d[2]);
      if (validDayMonth(day, month)) {
        lineDate = { day, month };
        continue;
      }
    }

    if (headerDate == null && bills.length === 0) {
      const inside = t.replace(RANGE_RE, " ").match(EMBEDDED_DATE_RE);
      if (inside && validDayMonth(Number(inside[1]), Number(inside[2]))) {
        headerDate = { day: Number(inside[1]), month: Number(inside[2]) };
      }
    }
    skipped.push({ line, text: t });
  }
  const date = lineDate ?? headerDate;

  const withExtra = [...bills, ...days].filter((b) => b.extra_sen != null);
  if (withExtra.length > 0) {
    const extraSum = withExtra.reduce((s, b) => s + (b.extra_sen ?? 0), 0);
    const noun = bills.length > 0 ? "bill" : "day";
    warnings.push(
      `${withExtra.length} ${noun}${withExtra.length === 1 ? " carries" : "s carry"} a "+" amount (RM ${ringgit(extraSum)} in total) that is not counted in the amount.`,
    );
  }

  if (total_sen != null && bills.length > 0) {
    const sum = bills.reduce((s, b) => s + b.amount_sen, 0);
    if (total_sen !== sum) {
      warnings.push(`The message's Total (RM ${ringgit(total_sen)}) is not the sum of its bills (RM ${ringgit(sum)}).`);
    }
  } else if (total_sen != null && days.length > 0) {
    const sum = days.reduce((s, b) => s + b.amount_sen, 0);
    if (total_sen !== sum) {
      warnings.push(`The message's Total (RM ${ringgit(total_sen)}) is not the sum of its days (RM ${ringgit(sum)}).`);
    }
  }

  return { date, bills, days, total_sen, skipped, warnings };
}

/** The chat's question: does this message carry at least one bill line? */
export function looksLikeSalesReport(text: string | null | undefined): boolean {
  return parseSalesReport(text).bills.length > 0;
}

/** A summary message's figure for Total Sales: its Total line when the
 *  message has no bills. `days_sen` is the sum of its day lines (null when it
 *  has none) so a caller can refuse to act on a total that does not add up. */
export function summaryTotalOf(report: ParsedSalesReport): { total_sen: number; days_sen: number | null } | null {
  if (report.bills.length > 0 || report.total_sen == null || report.total_sen <= 0) return null;
  const days_sen = report.days.length > 0 ? report.days.reduce((s, d) => s + d.amount_sen, 0) : null;
  return { total_sen: report.total_sen, days_sen };
}

/** "DD/MM" + the project's year → YYYY-MM-DD, or null when either is missing. */
export function reportDateFor(
  date: { day: number; month: number } | null,
  projectStartDate: string | null | undefined,
): string | null {
  if (!date) return null;
  const m = String(projectStartDate ?? "").match(/^(\d{4})-/);
  if (!m) return null;
  const mm = String(date.month).padStart(2, "0");
  const dd = String(date.day).padStart(2, "0");
  return `${m[1]}-${mm}-${dd}`;
}
