// What OCR extracts must feed the chat parser cleanly (owner 2026-11-25).
// The model-side prompt in services/salesReportOcr.ts tells Claude to produce
// text in the exact shape the parser expects. This test guards that shape:
// whatever the prompt's example emits, parseSalesReport must count. If someone
// loosens the example (or a future prompt tweak lets the model add commentary
// above the bills), the parser will drop bills on the floor and this test
// surfaces that before the branch merges.
import { describe, expect, it } from "vitest";
import { collectReport } from "../src/routes/lib/sales-report-bills";
import { parseSalesReport, summaryTotalOf } from "../src/scm/shared/sales-report-parse";

/* The exact example from SALES_REPORT_OCR_PROMPT. If the prompt changes, this
   constant must change with it — otherwise we are not testing what Claude is
   actually being asked to produce. */
const PROMPT_EXAMPLE = `20/11 Akemi @ SCCC

1. HC11694 RM10,200 Yuny
2. HC13801 RM1,950 Yuny
3. HC11695 RM6,888 James

Total: RM19,038`;

/* A fair-end summary — the other shape the floor pastes. The prompt's rules
   tell Claude to keep the layout the sender used, so this covers the second
   case: a days-only message with its own Total. */
const SUMMARY_EXAMPLE = `20-22/11 Akemi @ SCCC

20/11 - RM12,150
21/11 - RM40,176
22/11 - RM23,188

Total: RM75,514`;

/* The all-in-one paste covered by PR #5988 — bills for every day plus a
   day-summary and a grand Total all in one message. The OCR path must match
   what the parser's bills+days branch does when the floor types this straight
   in. */
const ALL_IN_ONE_EXAMPLE = `20/11 Akemi @ SCCC
1. HC11694 RM10,200 Yuny
2. HC13801 RM1,950 Yuny
Total: RM12,150

21/11 Akemi @ SCCC
1. HC13717 RM6,988 Shawn
2. HC11695 RM6,888 James
Total: RM13,876

Akemi @ SCCC 20-21/11
20/11 - RM12,150
21/11 - RM13,876
Total: RM26,026`;

const AUTHOR = {
  author_email: "weisiang329@gmail.com",
  author_position: null,
  author_role: null,
};

describe("sales-report OCR text feeds the parser cleanly", () => {
  it("per-day prompt example parses to three bills and a total line", () => {
    const r = parseSalesReport(PROMPT_EXAMPLE);
    expect(r.bills.map((b) => b.ref_token)).toEqual(["HC11694", "HC13801", "HC11695"]);
    expect(r.bills.reduce((s, b) => s + b.amount_sen, 0)).toBe(1_903_800);
    expect(r.total_sen).toBe(1_903_800);
    expect(r.date).toEqual({ day: 20, month: 11 });
  });

  it("summary-only prompt example yields a summary total (and no bills)", () => {
    const r = parseSalesReport(SUMMARY_EXAMPLE);
    expect(r.bills).toHaveLength(0);
    expect(r.days).toHaveLength(3);
    expect(r.total_sen).toBe(7_551_400);
    const s = summaryTotalOf(r);
    expect(s).toEqual({ total_sen: 7_551_400, days_sen: 7_551_400 });
  });

  it("all-in-one example lands in collectReport as bills + grand summary", () => {
    const notes = [{
      id: 1, note: ALL_IN_ONE_EXAMPLE, created_at: "2026-11-21T08:00:00Z",
      ...AUTHOR,
    }];
    const r = collectReport(notes, "2026-11-20", null);
    expect(r.bills).toHaveLength(4);
    expect(r.summary?.total_sen).toBe(2_602_600);
  });
});
