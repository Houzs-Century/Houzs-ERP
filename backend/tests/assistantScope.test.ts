import { describe, expect, test } from "vitest";
import {
  REDACTED,
  allowedCapabilityKeys,
  isCapabilityAllowed,
  redactFacts,
  scopeNote,
  scopeForUser,
  canUseAssistant,
  ASSISTANT_DENIED_POSITIONS,
  ASSISTANT_KNOWN_POSITIONS,
  type AssistantScope,
} from "../src/services/assistant-scope";

/* The Assistant is owner-only because the specialists' briefs carry margin and
   per-salesperson performance. This module is what has to be right BEFORE it can
   be opened to staff, and the property that matters is WHERE redaction happens:
   before the model is called, not in the instructions to it. A number in the
   context window is disclosed regardless of what the prompt asks. */

const OWNER: AssistantScope = { wildcard: true, canSeeMargin: true, canSeeCommission: true, orderScope: "all" };
const DIRECTOR: AssistantScope = { canSeeMargin: true, canSeeCommission: true, orderScope: "all" };
const SALES_REP: AssistantScope = { canSeeMargin: false, canSeeCommission: false, orderScope: "own_downline" };

describe("capability gating", () => {
  test("a rep cannot consult receivables or commercial intelligence", () => {
    expect(isCapabilityAllowed("receivables", SALES_REP)).toBe(false);
    expect(isCapabilityAllowed("sales_intel", SALES_REP)).toBe(false);
  });

  test("but CAN consult the operational specialists — this is not a lockout", () => {
    for (const k of ["order_fulfilment", "delivery", "procurement"]) {
      expect(isCapabilityAllowed(k, SALES_REP), k).toBe(true);
    }
  });

  test("a director passes the money gates", () => {
    expect(isCapabilityAllowed("receivables", DIRECTOR)).toBe(true);
    expect(isCapabilityAllowed("sales_intel", DIRECTOR)).toBe(true);
  });

  test("wildcard bypasses every gate but still走 the same path", () => {
    expect(allowedCapabilityKeys(["receivables", "sales_intel", "delivery"], OWNER))
      .toEqual(["receivables", "sales_intel", "delivery"]);
  });

  test("an UNKNOWN capability is allowed — new operational agents are not money", () => {
    // Fails toward usable. A future money capability must add its own requirement;
    // that is a deliberate, reviewable act rather than a silent default.
    expect(isCapabilityAllowed("some_future_agent", SALES_REP)).toBe(true);
  });
});

describe("redactFacts — the numbers never reach the model", () => {
  const facts = {
    sales_intel: {
      brief: { headline: "Q3 up", marginCenti: 123456, grossProfit: 9, revenue_centi: 5_000_00 },
      openItems: [
        { id: 1, note: "low margin order", unitCost: 700, commission: 250, customer: "Tan" },
        { id: 2, nested: { landed_cost: 42, quantity: 3 } },
      ],
    },
  };

  test("THE ONE THAT MATTERS: margin/cost keys are replaced at every depth", () => {
    const r = redactFacts(facts, SALES_REP) as typeof facts;
    expect(r.sales_intel.brief.marginCenti).toBe(REDACTED);
    expect(r.sales_intel.brief.grossProfit).toBe(REDACTED);
    expect(r.sales_intel.openItems[0].unitCost).toBe(REDACTED);
    expect((r.sales_intel.openItems[1] as { nested: { landed_cost: unknown } }).nested.landed_cost).toBe(REDACTED);
  });

  test("commission is gated on its OWN flag, not on margin", () => {
    const marginOnly: AssistantScope = { canSeeMargin: true, canSeeCommission: false, orderScope: "all" };
    const r = redactFacts(facts, marginOnly) as typeof facts;
    expect(r.sales_intel.brief.marginCenti).toBe(123456);          // allowed
    expect(r.sales_intel.openItems[0].commission).toBe(REDACTED);  // still hidden
  });

  test("non-money data is untouched — redaction must not gut the answer", () => {
    const r = redactFacts(facts, SALES_REP) as typeof facts;
    expect(r.sales_intel.brief.headline).toBe("Q3 up");
    expect(r.sales_intel.brief.revenue_centi).toBe(5_000_00);
    expect(r.sales_intel.openItems[0].customer).toBe("Tan");
    expect((r.sales_intel.openItems[1] as { nested: { quantity: number } }).nested.quantity).toBe(3);
  });

  test("a redacted value is a MARKER, not a deletion or a zero", () => {
    // A missing key lets the model reason as if the figure were nil, and a 0 is an
    // outright lie. The marker makes "I am not allowed to tell you" expressible.
    const r = redactFacts(facts, SALES_REP) as typeof facts;
    expect("marginCenti" in r.sales_intel.brief).toBe(true);
    expect(r.sales_intel.brief.marginCenti).not.toBe(0);
  });

  test("the owner's payload is returned untouched", () => {
    expect(redactFacts(facts, OWNER)).toEqual(facts);
    expect(redactFacts(facts, DIRECTOR)).toEqual(facts);
  });

  test("null / primitives / empty do not crash the walker", () => {
    expect(redactFacts(null, SALES_REP)).toBeNull();
    expect(redactFacts(7, SALES_REP)).toBe(7);
    expect(redactFacts({}, SALES_REP)).toEqual({});
    expect(redactFacts([], SALES_REP)).toEqual([]);
  });
});

describe("scopeNote", () => {
  test("tells the model to say 'not available', never to guess", () => {
    const n = scopeNote(SALES_REP)!;
    expect(n).toMatch(/margin and cost/);
    expect(n).toMatch(/commission/);
    expect(n).toMatch(/Never guess/i);
  });

  test("no note when nothing is hidden — no needless hedging in owner answers", () => {
    expect(scopeNote(OWNER)).toBeNull();
    expect(scopeNote(DIRECTOR)).toBeNull();
  });
});

describe("scopeForUser — derived from the ONE policy, never re-authored", () => {
  const resolve = (i: { position_name: string | null }) =>
    i.position_name === "Sales Executive"
      ? { flags: { canSeeMargin: false, canSeeCommission: false, orderScope: "own_downline" as const } }
      : { flags: { canSeeMargin: true, canSeeCommission: true, orderScope: "all" as const } };

  test("wildcard sees everything", () => {
    expect(scopeForUser({ permissions: ["*"] }, resolve).wildcard).toBe(true);
    expect(scopeForUser({ permissions: "*" }, resolve).wildcard).toBe(true);
  });

  test("a positioned user gets the policy's flags VERBATIM", () => {
    const rep = scopeForUser({ permissions: [], position_name: "Sales Executive" }, resolve);
    expect(rep).toEqual({ canSeeMargin: false, canSeeCommission: false, orderScope: "own_downline" });
  });

  test("the owner's default-FULL model is honoured, not quietly tightened", () => {
    // An unclassified position sees money because that is his ruling. This surface
    // must not be stricter than every other one — that inconsistency is the bug.
    const other = scopeForUser({ permissions: [], position_name: "HR Manager" }, resolve);
    expect(other.canSeeMargin).toBe(true);
  });

  test("THE ONE THAT MATTERS: no position = money HIDDEN, not granted", () => {
    // The policy has no input to decide from. "Cannot tell" must not resolve to
    // "entitled" — defaulting the unknown to permissive is how a nullish fallback
    // becomes a disclosure.
    for (const u of [null, undefined, {}, { permissions: [] }, { permissions: [], position_name: null }]) {
      const s = scopeForUser(u as never, resolve);
      expect(s.canSeeMargin, JSON.stringify(u)).toBe(false);
      expect(s.canSeeCommission, JSON.stringify(u)).toBe(false);
    }
  });

  test("a policy that cannot resolve also hides", () => {
    const s = scopeForUser({ permissions: [], position_name: "Ghost" }, () => null);
    expect(s.canSeeMargin).toBe(false);
  });

  test("a stray '*' inside a longer permission string is NOT wildcard", () => {
    expect(scopeForUser({ permissions: "scm.*" }, resolve).wildcard).toBeUndefined();
  });
});

describe("canUseAssistant — field crew and Sales get no surface, unknown fails closed", () => {
  test("the field crew the owner named are denied", () => {
    for (const p of ["Driver", "Helper", "Storekeeper", "Storekeeper Supervisor"]) {
      expect(canUseAssistant({ permissions: [], position_name: p }), p).toBe(false);
    }
  });

  test("case and spacing do not smuggle access", () => {
    for (const p of ["driver", "  DRIVER ", "Store keeper".replace(" ", ""), "helper"]) {
      expect(canUseAssistant({ permissions: [], position_name: p }), p).toBe(false);
    }
  });

  test("Storekeeper Supervisor is denied too — owner confirmed the fourth", () => {
    expect(canUseAssistant({ permissions: [], position_name: "Storekeeper Supervisor" })).toBe(false);
    // ...and spacing/case still cannot smuggle it back in.
    expect(canUseAssistant({ permissions: [], position_name: "  storekeeper   supervisor " })).toBe(false);
  });

  test("the deny list is field crew + Sales, lowercased", () => {
    // Two lists that mean the same thing are two lists that can drift. This pins
    // it so the FE mirror (auth/assistantAccess.ts) can assert the same set.
    expect([...ASSISTANT_DENIED_POSITIONS].sort())
      .toEqual(["driver", "helper", "sales director", "sales executive", "sales manager", "sales person", "storekeeper", "storekeeper supervisor"]);
  });

  test("FAIL CLOSED: an unrecognised name is denied, and exact-match keeps the deny list precise", () => {
    // /Storekeeper/ would swallow "Storekeeper Supervisor". A word-boundary
    // regex over a free-text position name has already misfired twice here. Under
    // fail-closed this name is denied for being UNKNOWN, not for the substring
    // "driver" — exact .has() still keeps the deny list precise; whitelist first.
    expect(canUseAssistant({ permissions: [], position_name: "Assistant Driver Coordinator" })).toBe(false);
  });

  test("recognised non-denied positions, and no-position, may open it", () => {
    for (const p of ["Operation Manager", "Operation Executive", "HR Manager", "Finance Manager", "Service Admin", null]) {
      expect(canUseAssistant({ permissions: [], position_name: p }), String(p)).toBe(true);
    }
  });

  test("wildcard is never denied", () => {
    expect(canUseAssistant({ permissions: ["*"], position_name: "Driver" })).toBe(true);
  });

  test("Sales is denied — owner 2026-07-19 'remove the Assistant from Sales first'", () => {
    for (const p of ["Sales Director", "Sales Manager", "Sales Executive", "Sales Person", "  SALES   PERSON "]) {
      expect(canUseAssistant({ permissions: [], position_name: p }), p).toBe(false);
    }
  });

  test("FAIL CLOSED even with no denied token — an unknown name gets nothing until whitelisted", () => {
    // The owner's concern: a NEW position row must not silently inherit the
    // Assistant (positionPolicy fails OPEN into cohort "full"). "Regional Head"
    // holds no denied token and is denied purely for being unrecognised.
    for (const p of ["Regional Head", "Marketing Manager", "Senior Sales Consultant"]) {
      expect(canUseAssistant({ permissions: [], position_name: p }), p).toBe(false);
    }
  });

  test("every denied position is also a known position — the two lists cannot silently drift", () => {
    for (const p of ASSISTANT_DENIED_POSITIONS) {
      expect(ASSISTANT_KNOWN_POSITIONS.has(p), p).toBe(true);
    }
  });
});
