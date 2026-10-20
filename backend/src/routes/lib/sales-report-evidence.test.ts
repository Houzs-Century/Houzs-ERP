import { describe, expect, test } from "vitest";
import type { NoteRow } from "./sales-report-bills";
import { buildReportEvidence, loadReportEvidence, orderBookletTokens, reportVerdict } from "./sales-report-evidence";

/* Which fair the evening reports (project chat) say an order belongs to
   (owner 2026-10-20) — the 2026-10-12 IOI scans are the shape: three orders
   linked to the September IOI CITY MALL roadshow (#343), one to nothing, all
   four in the IOIGECC fair's (#307) report of 10-11 October. */

const ummu = { author_email: "ummuaimanlm@gmail.com", author_position: "Operation Executive" };
const note = (id: number, text: string, author: Partial<Pick<NoteRow, "author_email" | "author_position">> = ummu): NoteRow => ({
  id, note: text, created_at: `2026-10-14 0${id}:00:00`, author_email: null, author_position: null, ...author,
});

const EVIDENCE = buildReportEvidence(
  new Map([
    [307, [note(1, "10/10\n1. HC13315 RM11000 Luis\n2. HC13316 RM3388 Shawn\n3. HC13548 RM4300 Shawn"), note(2, "11/10\n1. HC13317 RM9888 Luis")]],
    [2260, [note(3, "16/10\n1. HC13420 RM11776 Melvin")]],
    /* Two fairs' reports naming one booklet: a person decides. */
    [500, [note(4, "12/10\n1. HC20000 RM100 A")]],
    [501, [note(5, "12/10\n1. HC20000 RM100 A")]],
    /* A rep pasting numbers is not a report. */
    [600, [note(6, "1. HC13999 RM100 Me", { author_email: "rep@houzs.com", author_position: "Sales Executive" })]],
  ]),
  new Map([[307, "2026-10-09"], [2260, "2026-10-15"], [500, "2026-10-12"], [501, "2026-10-12"], [600, "2026-10-12"]]),
);

describe("reportVerdict", () => {
  test("another fair's report lists it: elsewhere, with the report's day — linked to the wrong fair or to none", () => {
    expect(reportVerdict({ project_id: 343, customer_so_no: "HC13317" }, EVIDENCE)).toEqual({
      kind: "elsewhere", sighting: { projectId: 307, reportDate: "2026-10-11", amountSen: 988800, salesperson: "Luis" },
    });
    expect(reportVerdict({ project_id: null, customer_so_no: "HC 13548" }, EVIDENCE)).toMatchObject({ kind: "elsewhere", sighting: { projectId: 307 } });
  });

  test("its own fair's report lists it: confirmed, whatever the slip's place said", () => {
    expect(reportVerdict({ project_id: 2260, customer_so_no: "HC13420" }, EVIDENCE).kind).toBe("confirmed");
  });

  test("two other fairs' reports: conflict; no report, or a rep's chat: none", () => {
    expect(reportVerdict({ project_id: 1, customer_so_no: "HC20000" }, EVIDENCE)).toEqual({ kind: "conflict", projectIds: [500, 501] });
    expect(reportVerdict({ project_id: 1, customer_so_no: "HC13999" }, EVIDENCE)).toEqual({ kind: "none" });
    expect(reportVerdict({ project_id: 1, customer_so_no: null, ref: null }, EVIDENCE)).toEqual({ kind: "none" });
  });

  test("an AutoCount order's ref is a booklet number too", () => {
    expect(orderBookletTokens({ customer_so_no: null, ref: "HC-13316" })).toEqual(["HC13316"]);
    expect(reportVerdict({ project_id: 343, ref: "HC-13316" }, EVIDENCE).kind).toBe("elsewhere");
  });
});

describe("loadReportEvidence", () => {
  test("reads the chat of this company's fairs, by start day or by id, and parses the reports", async () => {
    const asked: Array<[string, unknown[]]> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...vals: unknown[]) => ({
          all: async <T>() => {
            asked.push([sql, vals]);
            return { results: [{ id: 1, project_id: 307, note: "10/10\n1. HC13315 RM11000 Luis", created_at: "2026-10-10 22:00:00", start_date: "2026-10-09", ...ummu }] as unknown as T[] };
          },
        }),
      }),
    };
    const bySince = await loadReportEvidence(db, " AND p.company_id = 1", { since: "2026-08-01" });
    expect(bySince.get("HC13315")).toEqual([{ projectId: 307, reportDate: "2026-10-10", amountSen: 1100000, salesperson: "Luis" }]);
    await loadReportEvidence(db, " AND p.company_id = 1", { projectIds: [307, 307, 2260] });
    expect(asked.map(([sql, vals]) => [/p\.start_date >= \?/.test(sql) || /p\.id IN \(\?, \?\)/.test(sql), /AND p\.company_id = 1$/.test(sql), vals])).toEqual([
      [true, true, ["2026-08-01"]],
      [true, true, [307, 2260]],
    ]);
    expect(await loadReportEvidence(db, "", { projectIds: [] })).toEqual(new Map());
  });
});
