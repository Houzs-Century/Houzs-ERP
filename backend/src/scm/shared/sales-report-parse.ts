// ----------------------------------------------------------------------------
// sales-report-parse — reads the daily sales report the floor posts in the
// WhatsApp group, one bill per line, so a project can keep it.
//
// WHY (owner 2026-10-14). Every evening a salesperson posts, per booth:
//
//     11/10 Akemi @ SUNWAY KLUANG MALL
//     1. HC8993 RM6500 Jason
//     2. HC10785 RM4999 Melvin
//     Total - RM 11,499
//
// That message is the ONLY per-bill, per-person record of what the fair sold
// until each bill is keyed into the Sales Order module days later. Pasted into
// the project's chat and saved, it lets the project say which bills are still
// not opened as orders and how much of that sits with each salesperson.
//
// THE GRAMMAR, deliberately tolerant — this is typed on a phone, not a form:
//   · a BILL line is  [n.]  <booklet no>  [-|:]  [RM] <amount>  [-|:]  [name]
//     booklet no  = 1–5 letters, optional space/dash, 3–6 digits  (HC8993,
//                   HC 10785, ZNT-6042, CR0315); kept as typed in `ref_raw`
//                   and normalised (upper, letters+digits only) in `ref_token`,
//                   the key every other surface matches on (customer-ref.ts
//                   puts the same number in the SO's Ref No.).
//     amount      = "RM6500", "RM 6,500", "6500", "6,500.00" → sen.
//     name        = whatever follows the amount, trimmed; absent is allowed.
//   · a TOTAL line  ("Total - RM 11,499") is read, never trusted: the sum of
//     the bills is the total, and a difference is reported as a warning.
//   · a DATE comes from the first line that starts with d/m (the header);
//     the year is the project's — this module never guesses one.
//   · a day-summary message ("7/10 - RM 126") has no bills, so it parses to
//     zero bills; it is not an error, it is just not this report.
// Anything else is skipped and listed, so the person saving can see what was
// not understood instead of discovering a missing bill a week later.
//
// MIRRORED byte-for-byte to frontend/src/vendor/shared/sales-report-parse.ts
// (check-shared-mirrors.mjs): the chat decides whether a message LOOKS like a
// report with the same code the server saves it with.
// ----------------------------------------------------------------------------

export type ParsedBill = {
  /** 1-based line number in the pasted text, for the preview. */
  line: number;
  ref_raw: string;
  ref_token: string;
  amount_sen: number;
  salesperson_name: string | null;
};

export type ParsedSalesReport = {
  /** The header's day/month, when the first line starts with one. */
  date: { day: number; month: number } | null;
  bills: ParsedBill[];
  /** The message's own "Total" line, in sen, when it has one. */
  total_sen: number | null;
  /** Lines that were neither a bill, the header, the total nor blank. */
  skipped: Array<{ line: number; text: string }>;
  /** Human warnings — today only a total line that does not match the sum. */
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

const BILL_RE =
  /^\s*(?:\d{1,3}\s*[.)]\s*)?([A-Za-z]{1,5}\s*-?\s*\d{3,6})\b\s*[-:–]?\s*(?:RM|rm|Rm)?\s*([\d][\d,]*(?:\.\d{1,2})?)\s*[-:–]?\s*(.*?)\s*$/;
const TOTAL_RE = /^\s*total\b\s*[-:–=]?\s*(?:RM|rm|Rm)?\s*([\d][\d,]*(?:\.\d{1,2})?)\s*$/i;
const DATE_RE = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\b/;

/** sen → "1,234.00" for the one sentence this module writes; the shared
 *  formatter lives outside the mirrored pair, so this stays dependency-free. */
const ringgit = (sen: number): string =>
  (sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function amountToSen(s: string): number | null {
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function parseSalesReport(text: string | null | undefined): ParsedSalesReport {
  const lines = String(text ?? "").split(/\r?\n/);
  const bills: ParsedBill[] = [];
  const skipped: Array<{ line: number; text: string }> = [];
  const warnings: string[] = [];
  let date: ParsedSalesReport["date"] = null;
  let total_sen: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const t = lines[i]!.trim();
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
        const name = bill[3]!.replace(/^[-:–]\s*/, "").trim();
        bills.push({
          line,
          ref_raw: bill[1]!.replace(/\s+/g, " ").trim(),
          ref_token: normalizeRefToken(bill[1]!),
          amount_sen: amount,
          salesperson_name: name || null,
        });
        continue;
      }
    }

    const d = t.match(DATE_RE);
    if (d && date == null && bills.length === 0) {
      const day = Number(d[1]);
      const month = Number(d[2]);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        date = { day, month };
        continue;
      }
    }

    skipped.push({ line, text: t });
  }

  const sum = bills.reduce((s, b) => s + b.amount_sen, 0);
  if (total_sen != null && bills.length > 0 && total_sen !== sum) {
    warnings.push(
      `The message's Total (RM ${ringgit(total_sen)}) is not the sum of its bills (RM ${ringgit(sum)}).`,
    );
  }

  return { date, bills, total_sen, skipped, warnings };
}

/** The chat's question: does this message carry at least one bill line? */
export function looksLikeSalesReport(text: string | null | undefined): boolean {
  return parseSalesReport(text).bills.length > 0;
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
