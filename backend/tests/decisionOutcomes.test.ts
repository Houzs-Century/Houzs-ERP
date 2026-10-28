import { describe, expect, test } from "vitest";
import {
  summarisePromotionEvidence,
  type OutcomeRow,
} from "../src/services/agents/decision-outcomes";

/* Spec §9.1 wants the loop closed: was the approved action executed, and did the
   expected result occur? Two properties matter more than the counting.

   1. PRECEDENCE, NOT RECENCY. A later "verified" must not erase an earlier
      "contradicted". Bad news is the part worth keeping, and a summary that lets
      it be overwritten is a summary that flatters.
   2. THE EVIDENCE NEVER PROMOTES. Stage 1→2→3 is a human act (§10.5). Encoding a
      success threshold would turn a governance question into arithmetic. */

const row = (p: Partial<OutcomeRow> & { decisionId: string; kind: OutcomeRow["kind"] }): OutcomeRow => ({
  agent: "HZS-REP-004",
  observedAt: "2026-07-18T00:00:00Z",
  ...p,
});

describe("summarisePromotionEvidence", () => {
  test("counts DECISIONS, not observations — three notes on one action is one action", () => {
    const ev = summarisePromotionEvidence([
      row({ decisionId: "d1", kind: "EXECUTED" }),
      row({ decisionId: "d1", kind: "VERIFIED" }),
      row({ decisionId: "d1", kind: "VERIFIED" }),
    ]);
    expect(ev.decisionsObserved).toBe(1);
    expect(ev.verified).toBe(1);
  });

  test("THE ONE THAT MATTERS: a later VERIFIED does not erase a CONTRADICTED", () => {
    const ev = summarisePromotionEvidence([
      row({ decisionId: "d1", kind: "EXECUTED", observedAt: "2026-07-18T01:00:00Z" }),
      row({ decisionId: "d1", kind: "CONTRADICTED", observedAt: "2026-07-18T02:00:00Z" }),
      row({ decisionId: "d1", kind: "VERIFIED", observedAt: "2026-07-18T09:00:00Z" }),
    ]);
    expect(ev.contradicted).toBe(1);
    expect(ev.verified).toBe(0);
    expect(ev.concerns.some((c) => /contradicted/i.test(c))).toBe(true);
  });

  test("executed but never checked is its own state, not a success", () => {
    const ev = summarisePromotionEvidence([row({ decisionId: "d1", kind: "EXECUTED" })]);
    expect(ev.executed).toBe(1);
    expect(ev.verified).toBe(0);
    expect(ev.executedButUnverified).toBe(1);
    expect(ev.concerns.some((c) => /never verified/i.test(c))).toBe(true);
  });

  test("a failure WITH a recovery task is not counted unrecovered", () => {
    const ev = summarisePromotionEvidence([
      row({ decisionId: "d1", kind: "FAILED", recoveryRef: "TASK-19" }),
    ]);
    expect(ev.failed).toBe(1);
    expect(ev.unrecovered).toBe(0);
  });

  test("a failure with a BLANK recovery ref is unrecovered — whitespace is not a task", () => {
    const ev = summarisePromotionEvidence([
      row({ decisionId: "d1", kind: "CONTRADICTED", recoveryRef: "   " }),
    ]);
    expect(ev.unrecovered).toBe(1);
    expect(ev.concerns.some((c) => /no recovery task/i.test(c))).toBe(true);
  });

  test("an empty record is a CONCERN, not a clean bill of health", () => {
    // The most dangerous summary is "0 failures" computed over 0 actions.
    const ev = summarisePromotionEvidence([]);
    expect(ev.decisionsObserved).toBe(0);
    expect(ev.concerns.some((c) => /no track record/i.test(c))).toBe(true);
  });

  test("a perfect record still does NOT auto-promote", () => {
    const ev = summarisePromotionEvidence([
      row({ decisionId: "d1", kind: "EXECUTED" }),
      row({ decisionId: "d1", kind: "VERIFIED" }),
      row({ decisionId: "d2", kind: "EXECUTED" }),
      row({ decisionId: "d2", kind: "VERIFIED" }),
    ]);
    expect(ev.verified).toBe(2);
    expect(ev.concerns).toEqual([]);
    // Empty concerns is not consent. The ladder stays a human act.
    expect(ev.autoPromote).toBe(false);
  });

  test("SKIPPED is tracked separately — approved-then-not-done is not a failure", () => {
    const ev = summarisePromotionEvidence([row({ decisionId: "d1", kind: "SKIPPED" })]);
    expect(ev.skipped).toBe(1);
    expect(ev.failed).toBe(0);
    expect(ev.unrecovered).toBe(0);
  });

  test("mixed agents fold together — the caller scopes the read, not this fold", () => {
    const ev = summarisePromotionEvidence([
      row({ decisionId: "d1", kind: "VERIFIED", agent: "HZS-REP-004" }),
      row({ decisionId: "d2", kind: "FAILED", agent: "HZS-DLV-002" }),
    ]);
    expect(ev.decisionsObserved).toBe(2);
  });
});
