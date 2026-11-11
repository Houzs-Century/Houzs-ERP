// Chat-side format hints for a sales-report message. The parser already tells us
// what each paste means; this module turns that reading into one short sentence
// the floor can act on without opening the panel. Owner 2026-11-10: "boleh juga
// bagi warning kalau sales person kurang satu format or salah format … option A
// (keluar dekat bawah mesej)". UI-only, so it lives outside the shared mirror
// (frontend/src/vendor/shared/sales-report-parse.ts stays byte-identical to the
// backend).
import { parseSalesReport } from "../vendor/shared/sales-report-parse";

export type SalesReportFormatIssue = {
  /** Machine-readable so a later caller can gate on specific codes (e.g.
   *  always show `summary_only`, drop `extras_not_counted` when the panel
   *  already handles it). */
  code:
    | "summary_only"
    | "bills_missing_name"
    | "total_mismatch"
    | "skipped_lines";
  /** The sentence shown under the message — one line, plain English, written
   *  for the sales person who posted it so they can fix it next time. */
  message: string;
  /** "hint" is a nudge (format is OK but something is missing for the tally),
   *  "warn" is a real inconsistency (total does not add up). The chat renders
   *  the two tones differently. */
  tone: "hint" | "warn";
};

/** The chat shows issues only for messages that look like a sales report.
 *  A regular note ("@Ali remember the booth number") is not flagged — the
 *  parser gives it empty bills / days / total and this returns []. */
export function salesReportFormatIssues(note: string | null | undefined): SalesReportFormatIssue[] {
  const text = String(note ?? "");
  if (!text.trim()) return [];
  const parsed = parseSalesReport(text);
  const looksLikeReport = parsed.bills.length > 0 || parsed.days.length > 0 || parsed.total_sen != null;
  if (!looksLikeReport) return [];

  const issues: SalesReportFormatIssue[] = [];

  // Summary-only paste (dates + total, no bill lines). The panel sets Total
  // Sales but can't tally per-bill or flag who has not opened their receipts,
  // so nudge the floor toward the bill format they already use elsewhere.
  if (parsed.bills.length === 0 && (parsed.days.length > 0 || parsed.total_sen != null)) {
    issues.push({
      code: "summary_only",
      tone: "hint",
      message:
        "Summary only — tak boleh tally per-bill atau detect siapa belum buka. Guna format: `date - bill# - nama - RM amount` setiap baris.",
    });
  }

  // Bill lines without a sales-person name — the panel can't attribute them,
  // so they won't appear under anyone's "still to open" list.
  if (parsed.bills.length > 0) {
    const missing = parsed.bills.filter((b) => !b.salesperson_name || b.salesperson_name.length === 0).length;
    if (missing > 0) {
      issues.push({
        code: "bills_missing_name",
        tone: "hint",
        message:
          missing === 1
            ? "1 bill tiada nama sales person — tak boleh attribute dalam panel."
            : `${missing} bills tiada nama sales person — tak boleh attribute dalam panel.`,
      });
    }
  }

  // The parser's own total-vs-bills / total-vs-days mismatch. Keep the original
  // sentence from the parser — it already says the two numbers and that's the
  // detail the author needs to find the typo.
  for (const w of parsed.warnings) {
    if (/is not the sum/i.test(w)) {
      issues.push({ code: "total_mismatch", tone: "warn", message: w });
    }
  }

  // A pile of skipped lines inside a report usually means the dash/colon
  // separator went missing — common on the phone keyboard. Only flag it when
  // there are at least two: a lone skipped line is usually a venue header or a
  // blank spacer. (`looksLikeReport` is already guaranteed by the early return
  // above, so the condition here reads the skipped count alone.)
  if (parsed.skipped.length >= 2) {
    issues.push({
      code: "skipped_lines",
      tone: "hint",
      message: `${parsed.skipped.length} baris tak dikenal format bill — check dash/RM antara bill number, amount, dan nama.`,
    });
  }

  return issues;
}
