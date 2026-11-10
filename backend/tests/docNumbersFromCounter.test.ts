// APO service PO numbers, MAN- supplier codes and HR penalty numbers come from
// the shared atomic counter (scm.next_doc_no_n), floored at the live max.
// They used to be "highest + 1" (or COUNT + 1), so two saves at the same moment
// read the same max and got the same number.
import { describe, expect, test } from "vitest";
import { nextManualCreditorCode, nextServicePONumber } from "../src/services/assrNumbers";
import { mintPenaltyNo } from "../src/routes/lib/hr-penalty-no";

type Counter = { series: string; floor: number }[];

function fakeEnv(rows: Record<string, string>[], counterAnswer: number | "missing", calls: Counter) {
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async all() {
          return { results: rows };
        },
        async first() {
          if (sql.includes("next_doc_no_n")) {
            if (counterAnswer === "missing") throw new Error("function scm.next_doc_no_n does not exist");
            calls.push({ series: String(args[0]), floor: Number(args[1]) });
            return { n: counterAnswer };
          }
          return rows[0] ?? null;
        },
      };
      return stmt;
    },
  };
  return { DB: db } as never;
}

const NOV = Date.parse("2026-11-10T04:00:00Z");

describe("APO service PO number", () => {
  test("takes the counter's number, floored at the month's numeric max", async () => {
    const calls: Counter = [];
    const env = fakeEnv([{ po_no: "APO/2611-999" }, { po_no: "APO/2611-1000" }], 1004, calls);
    expect(await nextServicePONumber(env, NOV)).toBe("APO/2611-1004");
    expect(calls).toEqual([{ series: "APO/2611", floor: 1000 }]);
  });

  test("falls back to max + 1 only where the counter does not exist", async () => {
    const env = fakeEnv([{ po_no: "APO/2611-007" }], "missing", []);
    expect(await nextServicePONumber(env, NOV)).toBe("APO/2611-008");
  });
});

describe("MAN- supplier code", () => {
  test("a gap in the run does not re-issue an existing code", async () => {
    const env = fakeEnv(
      [{ creditor_code: "MAN-0001" }, { creditor_code: "MAN-0002" }, { creditor_code: "MAN-0004" }],
      "missing",
      [],
    );
    expect(await nextManualCreditorCode(env)).toBe("MAN-0005");
  });

  test("takes the counter's number when present", async () => {
    const calls: Counter = [];
    const env = fakeEnv([{ creditor_code: "MAN-0004" }], 9, calls);
    expect(await nextManualCreditorCode(env)).toBe("MAN-0009");
    expect(calls).toEqual([{ series: "MAN", floor: 4 }]);
  });
});

describe("HR penalty number", () => {
  test("two companies keep separate series; the counter's number wins", async () => {
    const calls: Counter = [];
    const claim = async (series: string, floor: number) => {
      calls.push({ series, floor });
      return 12;
    };
    expect(await mintPenaltyNo(["PN-2611-003", "PN-2610-020"], 7, "2026-11-10", claim)).toBe("PN-2611-012");
    expect(calls).toEqual([{ series: "HR-C7-PN-2611", floor: 3 }]);
  });

  test("without the counter it is max + 1 for that month", async () => {
    expect(await mintPenaltyNo(["PN-2611-003"], 7, "2026-11-10", async () => null)).toBe("PN-2611-004");
  });
});
