import { describe, expect, test } from "vitest";
import { scopeFor, type AgentCompany } from "../src/services/agents/agent-company";

/* scopeFor is the whole reason agent-company.ts exists as a module rather than a
   line inside each agent.

   The three states have OPPOSITE correct behaviours, and two of them look alike:
   "the companies master would not load" and "your configured company is gone"
   both arrive as "I have no company id". One means carry on unscoped, because a
   single-company install has always run that way. The other means STOP, because
   running unscoped there pools two companies' books — the exact bug this module
   was written to kill.

   This file exists because the first draft of that module collapsed them. It
   returned {id: null} for a stale pin, which every caller reads as "no filter",
   which is cross-company pooling in response to a bad setting. tsc was happy.
   These tests are what would have caught it. */

const resolved = (id: number, code: string): AgentCompany => ({ state: "RESOLVED", id, code });

describe("scopeFor — RESOLVED", () => {
  test("scopes to the named book and never refuses", () => {
    const r = scopeFor(resolved(2, "HOUZS"));
    expect(r.companyId).toBe(2);
    expect(r.code).toBe("HOUZS");
    expect(r.refuse).toBeNull();
  });

  test("carries the CODE as a string — a doc prefix is built from it", () => {
    // companyDocPrefix stringifies whatever it gets; an object here became
    // "[object Object]-SO-2607-001" in production once already.
    expect(typeof scopeFor(resolved(7, "2990")).code).toBe("string");
  });
});

describe("scopeFor — UNRESOLVED", () => {
  test("runs UNSCOPED and does not refuse", () => {
    /* Pre-migration / cold-start / single-company Houzs. Undefined companyId is
       correct: it is what every scoping helper does in this state, and what this
       agent did before multi-company existed. Refusing here would take the agent
       down whenever a master read blipped. */
    const r = scopeFor({ state: "UNRESOLVED" });
    expect(r.companyId).toBeUndefined();
    expect(r.refuse).toBeNull();
  });
});

describe("scopeFor — STALE_PIN", () => {
  test("REFUSES — it must never degrade to unscoped", () => {
    /* THE TEST THIS FILE IS FOR. A stale pin resolving to "no filter" is how a
       bad setting turns into cross-company pooling: MRP would let one book's
       stock cover the other's shortage, and the CS agent would promise a
       customer a date backed by the other company's supply. */
    const r = scopeFor({ state: "STALE_PIN", pinnedId: 99 });
    expect(r.refuse).not.toBeNull();
    expect(r.refuse).toContain("99");
  });

  test("REFUSES rather than silently falling back to the base company", () => {
    // Planning HOUZS because the owner's pin went stale is the wrong-book bug
    // wearing a helpful face: every quantity on the proposal would be a fiction.
    const r = scopeFor({ state: "STALE_PIN", pinnedId: 99 });
    expect(r.companyId).toBeUndefined();
    expect(r.code).toBeNull();
  });

  test("the no-base-company case refuses too, and says it is a guess it won't make", () => {
    // Companies exist, none is HOUZS, nothing pinned. No defensible guess.
    const r = scopeFor({ state: "STALE_PIN", pinnedId: 0 });
    expect(r.refuse).toContain("refusing to guess");
  });

  test("the refusal names the pin, so the fix is obvious from the run summary", () => {
    expect(scopeFor({ state: "STALE_PIN", pinnedId: 41 }).refuse).toMatch(/41/);
  });
});

describe("the states never collapse", () => {
  test("UNRESOLVED and STALE_PIN both yield no companyId but disagree on refuse", () => {
    /* This is the distinction in one assertion. Both have companyId undefined —
       which is exactly why collapsing them is so easy and so quiet. `refuse` is
       the only thing that tells them apart, so it is the only thing a caller may
       branch on. */
    const unresolved = scopeFor({ state: "UNRESOLVED" });
    const stale = scopeFor({ state: "STALE_PIN", pinnedId: 5 });
    expect(unresolved.companyId).toBeUndefined();
    expect(stale.companyId).toBeUndefined();
    expect(unresolved.refuse).toBeNull();
    expect(stale.refuse).not.toBeNull();
  });
});
