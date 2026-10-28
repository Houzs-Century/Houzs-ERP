// ----------------------------------------------------------------------------
// The proceed refusal, ON THE SCREEN. A string in a backend module is not a
// string in front of an operator, so the sentence the client actually composes
// is asserted here against the exact body the server now sends.
//
// WHAT THE OWNER READ on 2026-08-17, refusing a ZERO-TOTAL order:
//
//   "A Processing Date can only be set once the order has a customer name, a
//    full delivery address (line 1 and postcode), a delivery date, and the
//    deposit its company requires (Houzs 30%, 2990 50%)."
//
// 193 characters — under humanApiError's 200-character plain-sentence limit, so
// it reached him verbatim. He read "deposit" and spent a day on a money bug that
// did not exist; the deposit term had passed (a free order has nothing to
// collect) and the order was missing its postcode.
//
// The fix is additive: `error` is unchanged, and the body now also carries the
// `problems` list this file already parses for the aggregated save gate (owner
// 2026-07-18). No client edit was needed for the operator to start seeing the
// real reason — which is the point, and is what these tests pin.
// ----------------------------------------------------------------------------
import { describe, expect, test } from "vitest";
import { humanApiError, parseSaveProblems } from "./authed-fetch";

/** The body backend proceedGateUnmetBody() sends for the owner's order:
 *  total 0, paid 0, postcode missing. One condition failed, one is named. */
const OWNERS_REFUSAL = JSON.stringify({
  error: "proceed_gate_unmet",
  reason: "Delivery postcode is required before this order can be proceeded",
  problems: [{
    code: "processing_date_incomplete",
    message: "Delivery postcode is required before this order can be proceeded",
    field: "Postcode",
  }],
});

describe("a proceed refusal reaching the operator names the condition that failed", () => {
  test("the owner's case: the sentence says POSTCODE and never says deposit", () => {
    const shown = humanApiError(422, OWNERS_REFUSAL);
    expect(shown.toLowerCase()).toContain("postcode");
    expect(shown.toLowerCase()).not.toContain("deposit");
    /* And none of the three conditions that passed are recited at him. */
    expect(shown.toLowerCase()).not.toContain("customer name");
    expect(shown.toLowerCase()).not.toContain("delivery date");
  });

  test("the modal surfaces get the same list — no client change was required", () => {
    /* SalesOrderDetail / SalesOrderNew / MobileNewSO render this array in a
       popup. It keys off the presence of `problems`, not off the
       `validation_failed` code, so the proceed refusal renders there too. */
    const problems = parseSaveProblems(OWNERS_REFUSAL);
    expect(problems).toHaveLength(1);
    expect(problems![0]).toMatchObject({ field: "Postcode" });
  });

  test("several failed conditions become several lines, not a count", () => {
    const shown = humanApiError(422, JSON.stringify({
      error: "proceed_gate_unmet",
      reason: "Delivery postcode is required before this order can be proceeded; Deposit RM 100 of RM 500 needed (50%) before this order can be proceeded",
      problems: [
        { code: "processing_date_incomplete", message: "Delivery postcode is required before this order can be proceeded", field: "Postcode" },
        { code: "processing_date_unpaid", message: "Deposit RM 100 of RM 500 needed (50%) before this order can be proceeded", field: "Deposit" },
      ],
    }));
    expect(shown).toBe(
      "• Delivery postcode is required before this order can be proceeded\n"
      + "• Deposit RM 100 of RM 500 needed (50%) before this order can be proceeded",
    );
  });

  test("`problems` wins over `reason`, so an old-style recital can never win a race", () => {
    /* Defence for the migration window: a stale worker still sending only the
       five-condition sentence keeps working (the reason path below), and any
       body carrying both shows the specific list. */
    const shown = humanApiError(422, JSON.stringify({
      error: "proceed_gate_unmet",
      reason: "A Processing Date can only be set once the order has a customer name, a full delivery address (line 1 and postcode), a delivery date, and the deposit its company requires.",
      problems: [{ code: "processing_date_incomplete", message: "Delivery postcode is required before this order can be proceeded", field: "Postcode" }],
    }));
    expect(shown).toBe("Delivery postcode is required before this order can be proceeded");
  });

  test("a reason-only body still reaches the operator verbatim — the fallback is intact", () => {
    const shown = humanApiError(422, JSON.stringify({
      error: "proceed_gate_unmet",
      reason: "Delivery postcode is required before this order can be proceeded",
    }));
    expect(shown).toBe("Delivery postcode is required before this order can be proceeded");
  });
});
