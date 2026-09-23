/* The slip-date window, as the THREE keying surfaces apply it (owner 2026-09-23:
   a transaction slip may not be dated more than 14 days back).

   The window itself is pinned on the shared module
   (backend/src/scm/shared/payment-slip-date.test.ts, whose byte-identical twin
   this side imports). What is pinned HERE is the part the rule must not know:
   who is exempt, which rows are not keyed slips at all, and that each surface
   actually bounds its own date field — desktop, phone and the two New SO forms,
   because one surface enforcing it and another not is this repo's oldest bug
   class.

   Source-slice assertions for the fields, the idiom permissionDivergence.test.ts
   uses: these gates sit inline in components far too large to render for one
   attribute, and what must not drift is which rule each field reads. */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { slipDateProblem } from "./PaymentsTable";
import { CONVERT_LABEL } from "../lib/so-money-queries";
import { PAYMENT_SLIP_WINDOW_DAYS, shiftIsoDay } from "../lib/payment-slip-date";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");

const TODAY = "2026-09-23";
const OUT = shiftIsoDay(TODAY, -(PAYMENT_SLIP_WINDOW_DAYS + 1));

describe("slipDateProblem — the rule plus the two things the rule must not know", () => {
  test("an in-window date is no problem, an older one is, in words the operator can act on", () => {
    expect(slipDateProblem({ paidAt: TODAY, methodLabel: "Cash" }, TODAY, false)).toBeNull();
    const problem = slipDateProblem({ paidAt: OUT, methodLabel: "Cash" }, TODAY, false);
    expect(problem).toContain("14 days");
    expect(problem).toContain("09/09/2026");
  });

  test("the backdate right clears it — that is the whole exception", () => {
    expect(slipDateProblem({ paidAt: OUT, methodLabel: "Cash" }, TODAY, true)).toBeNull();
  });

  test("money MOVED from another order is exempt: it carries that order's day, not a keyed slip", () => {
    expect(slipDateProblem({ paidAt: "2026-01-01", methodLabel: CONVERT_LABEL }, TODAY, false)).toBeNull();
  });
});

describe("every surface that keys a payment date bounds its own field", () => {
  const surfaces: Array<[string, string]> = [
    ["the desktop payments panel", "./PaymentsTable.tsx"],
    ["the mobile payments sheet", "../../../mobile/RecordedPayments.tsx"],
    ["the mobile New SO", "../../../mobile/MobileNewSO.tsx"],
  ];

  for (const [name, rel] of surfaces) {
    test(`${name} reads the shared window and bounds the picker`, () => {
      const text = src(rel);
      // Non-vacuous: the file still renders a payment date field.
      expect(text).toContain("paymentSlipDateWindow");
      expect(text).toMatch(/min=\{may\w*[Bb]ackdate\w*\s*\?\s*undefined\s*:\s*slipWindow\.min\}/);
      expect(text).toMatch(/max=\{may\w*[Bb]ackdate\w*\s*\?\s*undefined\s*:\s*slipWindow\.max\}/);
      // Quote style differs by file; the KEY is what must not drift.
      expect(text).toMatch(/can\w*\(\s*["']scm\.payment\.backdate["']\s*\)/);
    });
  }

  test("the desktop New SO blocks the SAVE, because its payments post after the order is created", () => {
    const text = src("../../../pages/scm-v2/SalesOrderNew.tsx");
    expect(text).toContain("slipDateProblem");
    expect(text).toContain("slip_date_out_of_window");
    expect(text).toMatch(/const problems = \[\.\.\.serverProblems,[^\]]*slipDateExtras\]/);
  });

  test("the mobile New SO blocks the SAVE the same way", () => {
    const text = src("../../../mobile/MobileNewSO.tsx");
    expect(text).toContain("slip_date_out_of_window");
    expect(text).toMatch(/soClientExtras[\s\S]{0,900}outOfWindowPayments/);
  });
});
