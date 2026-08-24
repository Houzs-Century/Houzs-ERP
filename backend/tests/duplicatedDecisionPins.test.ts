// ----------------------------------------------------------------------------
// THE PINS — for rules that must keep TWO HOMES, and for one that must keep
// THREE until the owner rules on it.
//
// check-duplicated-decisions.mjs finds a set of values written out twice. It
// cannot decide whether the two copies are the same QUESTION, and it cannot
// stop them drifting — an allowlist entry records a decision, it does not
// enforce one. This file is the enforcement half: for each pair that genuinely
// cannot be collapsed, one corpus is fed through BOTH implementations (or both
// literals are read out of the source) and the answers are compared.
//
// FOUR PINS, and each one is here for a different reason:
//
//   1. THE SO "DONE" DISAGREEMENT — three live answers: FOUR, FIVE and SIX.
//      MUST NOT BE MERGED. Both ends of the codebase say so in prose already
//      (so-terminal-states.ts:29-34 "deliberately NOT collapsed into this file
//      — resolving it changes the numbers on the Inventory page and is the
//      owner's call"; inventory.ts:542-548 adds "Do not 'helpfully' merge them
//      without it."). What is outstanding is a RULING, not a PR: does a DRAFT
//      order reserve stock, and does a SHIPPED one still? So this pins all
//      three memberships exactly and fails if a FOURTH spelling appears — the
//      count cannot quietly grow while the answer is pending.
//
//   2. THE SO AND PO THRESHOLD FAMILIES — sets that are NOT drifted today and
//      are therefore worth pinning rather than merging. Each is a refusal gate
//      on a write path that moves stock or commits spend, and the PO family is
//      a TWO-member set, which is below check-duplicated-decisions' floor and
//      invisible to it (see limit 4 in that script's header). This is the
//      mechanism that covers what the detector cannot see.
//
//   3. THE CREW-SCOPE PREDICATE — a genuine twin (the filter bar has to render
//      before any round-trip) that had ALREADY drifted in semantics. Both
//      implementations are imported and one corpus of (position, permissions)
//      pairs is run through them.
//
//   4. THE TWO NORMALISERS — quote-folding for "is this value in the priced
//      pool" versus case/whitespace-folding for "is this the same physical
//      item". These must NEVER converge, so the pin asserts the DIVERGENCE:
//      folding quotes inside computeVariantKey would re-key every stored
//      variant_key, movement and ship-commitment binding and orphan live FIFO
//      buckets (maintenance-pools.ts:123 records the same reason).
//
// HOW THE SOURCE-READ PINS WORK. Most of these constants are module-local in a
// route file and cannot be imported, so the literal is read out of the source
// with `?raw` — the idiom scm/lib/convert-ceilings.test.ts and
// frontend/src/auth/capabilities.test.ts already use. Every extraction carries
// a vacuity guard: a scan that found nothing must FAIL, never pass quietly over
// an empty set. That failure mode — a verdict computed over nothing — is the
// one this repo has now produced five times.
// ----------------------------------------------------------------------------
import { describe, expect, test } from "vitest";

import poRouterSrc from "../src/scm/routes/mfg-purchase-orders.ts?raw";
import sourceGatesSrc from "../src/scm/lib/source-document-gates.ts?raw";
import poBucketsSrc from "../src/scm/lib/po-status-buckets.ts?raw";
import soDeliverableSrc from "../src/scm/shared/so-deliverable-states.ts?raw";
import inventoryRouterSrc from "../src/scm/routes/inventory.ts?raw";
import procurementLearningSrc from "../src/services/agents/procurement-learning.ts?raw";
import soRouterSrc from "../src/scm/routes/mfg-sales-orders.ts?raw";
import soDetailGatesSrc from "../../frontend/src/vendor/scm/lib/so-detail-gates.ts?raw";

import { SO_TERMINAL_STATES } from "../src/scm/shared/so-terminal-states";
import { isCrewScopedUser as backendIsCrewScoped } from "../src/services/projectGates";
import { isCrewScopedUser as frontendIsCrewScoped } from "../../frontend/src/auth/crewScope";
import { normaliseTypographicQuotes } from "../src/scm/shared/mfg-pricing";
import { computeVariantKey } from "../src/scm/shared/variant-key";

/* ── Source-read helpers ───────────────────────────────────────────────────
   Comments in this repo QUOTE the sets they explain, so they are blanked
   before scanning; otherwise a doc-comment showing the old membership would be
   read as a declaration. */
const decomment = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");

/** Every `['A', 'B']` string-literal array declared for `name` in `src`. */
function literalsFor(src: string, name: string): string[][] {
  const text = decomment(src);
  const out: string[][] = [];
  const decl = new RegExp(
    `(?:const|let)\\s+${name}\\s*(?::[^=;]*)?=\\s*(?:new Set\\s*\\(\\s*)?\\[([^\\]]*)\\]`,
    "g",
  );
  for (const m of text.matchAll(decl)) {
    out.push([...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]));
  }
  return out;
}

/** Exactly one declaration of `name`, as a sorted, uppercased member list. */
function oneSet(src: string, name: string, where: string): string[] {
  const all = literalsFor(src, name);
  expect(all.length, `expected exactly ONE declaration of ${name} in ${where}, found ${all.length}`).toBe(1);
  expect(all[0].length, `${name} in ${where} parsed as an EMPTY set — the scan is broken, not the source`).toBeGreaterThan(0);
  return [...all[0]].map((s) => s.toUpperCase()).sort();
}

const sorted = (xs: readonly string[]) => [...xs].map((s) => s.toUpperCase()).sort();

// ─────────────────────────────────────────────────────────────────────────────
// PIN 1 — SO "DONE": FOUR, FIVE AND SIX. A ruling is outstanding.
// ─────────────────────────────────────────────────────────────────────────────
describe("SO 'done' has three live answers and the count must not change", () => {
  const soDones = literalsFor(inventoryRouterSrc, "SO_DONE");

  test("routes/inventory.ts still declares SO_DONE exactly TWICE, under one name", () => {
    /* This is the finding, not a quirk: two constants with the SAME NAME and
       DIFFERENT contents in one file, one consumed by the reservations bucket
       and one by the READY roll-up. If this becomes 1 or 3, somebody has
       resolved or widened the disagreement and this whole suite needs re-reading
       against the owner's answer. */
    expect(soDones.length).toBe(2);
  });

  test("the FOUR-status spelling is exactly CANCELLED, CLOSED, DELIVERED, INVOICED", () => {
    expect(sorted(soDones[0])).toEqual(["CANCELLED", "CLOSED", "DELIVERED", "INVOICED"]);
  });

  test("the FIVE-status spelling adds SHIPPED and nothing else", () => {
    expect(sorted(soDones[1])).toEqual(["CANCELLED", "CLOSED", "DELIVERED", "INVOICED", "SHIPPED"]);
    const four = new Set(sorted(soDones[0]));
    expect(sorted(soDones[1]).filter((s) => !four.has(s))).toEqual(["SHIPPED"]);
  });

  test("the SIX-status spelling (SO_TERMINAL_STATES) adds DRAFT on top of the five", () => {
    expect(sorted(SO_TERMINAL_STATES)).toEqual([
      "CANCELLED", "CLOSED", "DELIVERED", "DRAFT", "INVOICED", "SHIPPED",
    ]);
    const five = new Set(sorted(soDones[1]));
    expect(sorted(SO_TERMINAL_STATES).filter((s) => !five.has(s))).toEqual(["DRAFT"]);
  });

  test("the two questions still outstanding are exactly DRAFT and SHIPPED", () => {
    // Stated as an assertion so the open ruling is machine-checked rather than
    // remembered: does a DRAFT order reserve stock, and does a SHIPPED one?
    const all = new Set([...sorted(soDones[0]), ...sorted(soDones[1]), ...sorted(SO_TERMINAL_STATES)]);
    const inAllThree = [...all].filter(
      (s) => sorted(soDones[0]).includes(s) && sorted(soDones[1]).includes(s) && sorted(SO_TERMINAL_STATES).includes(s),
    );
    expect([...all].filter((s) => !inAllThree.includes(s)).sort()).toEqual(["DRAFT", "SHIPPED"]);
  });

  test("the FIVE-status set is also written out at two more homes, and they agree", () => {
    /* mfg-sales-orders.ts's amendment terminal check and the frontend's
       LOCKED_STATUSES are the same five. They are a different QUESTION (may
       this order still be amended / edited) that happens to have the same
       answer, so they are pinned equal rather than merged. */
    const amendInline = decomment(soRouterSrc).match(
      /const amendTerminalStatus = \[([^\]]*)\]/,
    );
    expect(amendInline, "amendTerminalStatus literal not found in mfg-sales-orders.ts").not.toBeNull();
    const amend = sorted([...amendInline![1].matchAll(/'([^']*)'/g)].map((m) => m[1]));
    expect(amend.length).toBeGreaterThan(0);
    expect(amend).toEqual(sorted(soDones[1]));

    const locked = oneSet(soDetailGatesSrc, "LOCKED_STATUSES", "frontend so-detail-gates.ts");
    expect(locked).toEqual(sorted(soDones[1]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PIN 2 — THE TWO THRESHOLD FAMILIES.
// ─────────────────────────────────────────────────────────────────────────────
describe("the SO threshold: a PO and a DO refuse the same orders", () => {
  /* MOVED 2026-08-22 out of mfg-purchase-orders.ts into lib/source-document-gates.ts,
     beside the DO threshold it has to agree with and the PO-receivable one below.
     All three had to learn to read the mig-0324 hold MARKER, because the hold left
     the `status` column every one of them was already reading. The pin follows the
     set to its new home rather than being deleted with the old one. */
  const unorderable = oneSet(sourceGatesSrc, "SO_UNORDERABLE_STATUSES", "lib/source-document-gates.ts");
  /* MOVED 2026-08-21 out of delivery-orders-mfg.ts into shared/so-deliverable-states.ts,
     because the same rule was ALSO hand-written in the SO list as an allow-list of one
     value and the Transfer button vanished on READY_TO_SHIP. This pin follows the set to
     its new home rather than being deleted with the old one — the PO and DO thresholds
     still have to agree, and now one of them has a single home to agree FROM. */
  const undeliverable = oneSet(soDeliverableSrc, "SO_UNDELIVERABLE_STATUSES", "shared/so-deliverable-states.ts");

  /* CLOSED joined both on 2026-08-22. Close means the remainder is not coming,
     so nothing more ships against the order and nothing more is bought for it —
     one reason, both write paths, which is what this pin is for. */
  test("both are exactly DRAFT, CANCELLED, ON_HOLD, CLOSED", () => {
    expect(unorderable).toEqual(["CANCELLED", "CLOSED", "DRAFT", "ON_HOLD"]);
    expect(undeliverable).toEqual(["CANCELLED", "CLOSED", "DRAFT", "ON_HOLD"]);
  });

  test("and they are equal to each other — one threshold, two write paths", () => {
    // A DO writes an OUT movement and a PO commits money. If these two ever
    // disagree, one document type can be built from an order the other refuses.
    expect(undeliverable).toEqual(unorderable);
  });
});

describe("the PO receivable threshold: four spellings, one membership", () => {
  /* BELOW THE DETECTOR'S FLOOR. check-duplicated-decisions only fingerprints
     sets of three or more members and this one has two, so no static check in
     the repo can see these four copies. That is exactly why the pin exists. */
  const expected = ["PARTIALLY_RECEIVED", "SUBMITTED"];

  /* MOVED 2026-08-22 out of grns.ts into lib/source-document-gates.ts with the
     predicate that reads it, which had to start consulting the mig-0324 hold
     MARKER: mig 0318 called this block free "and cannot be forgotten", and it
     was free only while a hold OVERWROTE the status. */
  test("lib/source-document-gates.ts RECEIVABLE_PO_STATUSES", () => {
    expect(oneSet(sourceGatesSrc, "RECEIVABLE_PO_STATUSES", "lib/source-document-gates.ts")).toEqual(expected);
  });

  test("inventory.ts PO_LIVE", () => {
    expect(oneSet(inventoryRouterSrc, "PO_LIVE", "inventory.ts")).toEqual(expected);
  });

  /* MOVED 2026-08-21 into lib/po-status-buckets.ts, out of a router that is over
     its file-size ceiling. The pin follows the map: this membership still has to
     agree with the other three spellings of "a PO you can still receive
     against", and now one of them has its own home to agree from. */
  test("lib/po-status-buckets.ts PO_STATUS_BUCKETS.outstanding", () => {
    const m = decomment(poBucketsSrc).match(/outstanding:\s*\[([^\]]*)\]/);
    expect(m, "PO_STATUS_BUCKETS.outstanding not found").not.toBeNull();
    const members = [...m![1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    expect(members.length, "outstanding bucket parsed empty").toBeGreaterThan(0);
    expect(sorted(members)).toEqual(expected);
  });

  test("procurement-learning.ts's inline PostgREST filter", () => {
    const m = decomment(procurementLearningSrc).match(/\.in\('po\.status',\s*\[([^\]]*)\]/);
    expect(m, "the inline .in('po.status', [...]) filter not found").not.toBeNull();
    const members = [...m![1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    expect(members.length, "inline filter parsed empty").toBeGreaterThan(0);
    expect(sorted(members)).toEqual(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PIN 3 — THE CREW-SCOPE PREDICATE, both implementations, one corpus.
// ─────────────────────────────────────────────────────────────────────────────
describe("is this user force-scoped crew — the server and the UI must agree", () => {
  /* Every case below distinguishes the two implementations as they were BEFORE
     this change: the desktop copy substring-matched and had no permission
     escape, so "Warehouse Helper" caged the UI while the server returned
     everything, and an admin holding Storekeeper lost controls they were
     entitled to. */
  const CORPUS: Array<[string | null | undefined, string[], string]> = [
    ["Helper", [], "the exact position, no permissions"],
    ["helper", [], "lowercased"],
    ["  Helper  ", [], "padded — both sides trim"],
    ["Storekeeper", [], "the exact position"],
    ["Storekeeper Supervisor", [], "the two-word position, which a /storekeeper/ substring also claims"],
    ["Driver", [], "drivers are NOT force-scoped — owner kept them see-all"],
    ["Sales Executive", [], "an unrelated position"],
    ["Warehouse Helper", [], "an owner-created position a SUBSTRING test would wrongly cage"],
    ["Helper Supervisor", [], "another substring trap"],
    ["Assistant Storekeeper", [], "and another"],
    ["Helpers", [], "a plural a word-boundary regex would miss but a substring would not"],
    ["Storekeeper", ["*"], "an ADMIN who happens to hold the Storekeeper position"],
    ["Helper", ["projects.write"], "a helper who can write projects"],
    ["Helper", ["projects.checklist.tick"], "a helper with only the tick grant — still caged"],
    ["Storekeeper Supervisor", ["*"], "the defect reviewer holding the wildcard"],
    ["", [], "empty position"],
    [null, [], "null position"],
    [undefined, [], "absent position"],
  ];

  test("the corpus is not vacuous: it produces both answers", () => {
    const answers = CORPUS.map(([p, perms]) => backendIsCrewScoped({ position_name: p, permissions: perms }));
    expect(answers.some(Boolean), "no case is crew-scoped").toBe(true);
    expect(answers.some((a) => !a), "no case is unscoped").toBe(true);
  });

  for (const [position, permissions, what] of CORPUS) {
    test(`same answer: ${what}`, () => {
      const be = backendIsCrewScoped({ position_name: position, permissions });
      const fe = frontendIsCrewScoped({ position_name: position, permissions });
      expect(fe, `frontend and backend disagree for position=${JSON.stringify(position)} perms=${JSON.stringify(permissions)}`).toBe(be);
    });
  }

  test("a null user is not crew-scoped on either side", () => {
    expect(backendIsCrewScoped(null)).toBe(false);
    expect(frontendIsCrewScoped(null)).toBe(false);
    expect(backendIsCrewScoped(undefined)).toBe(false);
    expect(frontendIsCrewScoped(undefined)).toBe(false);
  });

  test("the answers themselves, not just the agreement", () => {
    // Two copies that drifted the same way would still agree, so the rule is
    // stated outright: exact position name, and a permission escape.
    expect(frontendIsCrewScoped({ position_name: "Helper", permissions: [] })).toBe(true);
    expect(frontendIsCrewScoped({ position_name: "Warehouse Helper", permissions: [] })).toBe(false);
    expect(frontendIsCrewScoped({ position_name: "Storekeeper", permissions: ["*"] })).toBe(false);
    expect(frontendIsCrewScoped({ position_name: "Driver", permissions: [] })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PIN 4 — TWO NORMALISERS THAT HAVE NOW CONVERGED, ON PURPOSE.
// ─────────────────────────────────────────────────────────────────────────────
describe("quote-folding and identity-folding — one question after all", () => {
  const bedframe = (gap: string) =>
    computeVariantKey("bedframe", {
      fabricCode: "FAB-1",
      gap,
      divanHeight: '10"',
      legHeight: '6"',
      totalHeight: '18"',
    });

  test("the pricing/allowed-options normaliser FOLDS typographic quotes", () => {
    expect(normaliseTypographicQuotes("12“")).toBe('12"');
    expect(normaliseTypographicQuotes("12”")).toBe('12"');
    expect(normaliseTypographicQuotes("12″")).toBe('12"');
    expect(normaliseTypographicQuotes("12‘")).toBe("12'");
    expect(normaliseTypographicQuotes("12′")).toBe("12'");
    // Deliberately narrow: quotes only. No trim, no case folding.
    expect(normaliseTypographicQuotes(" 12“ ")).toBe(' 12" ');
    expect(normaliseTypographicQuotes("Ab“")).toBe('Ab"');
  });

  test("the variant-key normaliser FOLDS them too — one inch mark, one stock bucket", () => {
    /* THIS PIN WAS WRITTEN THE OTHER WAY UP AND `main` OVERTOOK IT.
       It used to assert the divergence was the point: since PR #2379 the system
       PRICED and PERMITTED a curly-quoted value as equal to its ASCII sibling
       while STOCKING them as two, and folding here would re-key every stored
       variant_key. PR #2430 (2026-08-18) ruled the opposite way and shipped the
       fold, because the divergence WAS the bug — BUG-HISTORY "Typographic inch
       marks split inventory variant_key buckets" [sev: high — silent stock
       fragmentation]: a line priced correctly and then allocated to a bucket
       nothing could match, so the same physical item never pooled and MRP saw
       two variants where there is one. Historical curly-keyed movements are
       deliberately NOT migrated, the same stance the POS seat/leg aliases take.
       The assertion is FLIPPED, not deleted: this file's job is to pin what the
       system actually decided, and what it decided changed. */
    expect(bedframe('12"')).toBe(bedframe("12“"));
  });

  test("…while it DOES fold case and surrounding whitespace, which the quote folder does not", () => {
    expect(bedframe('12"')).toBe(bedframe(' 12" '));
    expect(bedframe('12A"')).toBe(bedframe('12a"'));
    // And the mirror of that: the quote folder leaves case and space alone.
    expect(normaliseTypographicQuotes("12A")).toBe("12A");
  });

  test("this pin is not vacuous — the two keys it compares are both real keys", () => {
    expect(bedframe('12"').length).toBeGreaterThan(0);
    expect(bedframe("12“").length).toBeGreaterThan(0);
  });

  test("…and the fold is what makes them equal, not an empty key on both sides", () => {
    /* An equality assertion can pass because both sides collapsed to ''. Prove
       the curly mark is really being folded rather than dropped: the key carries
       the ASCII form of the gap, and a DIFFERENT gap still keys differently. */
    expect(bedframe("12“")).toContain('gap=12"');
    expect(bedframe("12“")).not.toBe(bedframe('13"'));
  });
});
