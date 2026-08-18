// ----------------------------------------------------------------------------
// EVERY proceed refusal goes through the one collector — asserted against the
// source, in the style of soDatePairWiring.test.ts and for the same reason.
//
// This repo's repeat offender is a rule expressed at N call sites and present at
// N-1: the both-dates rule was hand-written in five places and simply absent
// from three others, and every unit test over the logic passed the whole time.
// The proceed refusal is now one sentence-builder with one condition list; this
// file makes sure a later edit cannot unhook a route from it, or grow a second
// hand-written sentence that recites conditions it did not check.
//
// The behaviour itself is tested twice elsewhere — the collector in
// src/scm/shared/so-save-problems.test.ts, the HTTP body in
// tests/soProceedRefusalNamesCondition.test.ts. Nothing here re-tests logic.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import soRoutes from '../src/scm/routes/mfg-sales-orders.ts?raw';
import proceedGate from '../src/scm/lib/so-proceed-gate.ts?raw';
import orderRules from '../src/scm/shared/order-rules.ts?raw';
import saveProblems from '../src/scm/shared/so-save-problems.ts?raw';

/** Source with comments stripped. Every assertion runs on THIS: a rule named
 *  only in a comment is not a rule, and the comments below deliberately quote
 *  the very sentence this file forbids in code. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SO = code(soRoutes);
const GATE = code(proceedGate);
const RULES = code(orderRules);
const PROBLEMS = code(saveProblems);

const between = (hay: string, startAnchor: string, endAnchor: string): string => {
  const start = hay.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = hay.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `anchor not found after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
  return hay.slice(start, end);
};

const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe('the gate and its reasons are ONE expression', () => {
  test('meetsProceedGate IS "the failure list is empty" — not a second reading of the rule', () => {
    /* Two expressions is how the verdict and the explanation drift apart. The
       boolean is derived from the list, so no input can make them disagree. */
    expect(between(RULES, 'export const meetsProceedGate', ';'))
      .toContain('proceedGateFailures(i).length === 0');
  });

  test('the five conditions are enumerated in exactly ONE place', () => {
    /* The old chained predicate. If it comes back anywhere, some caller has its
       own copy of the rule again. */
    expect(countOf(RULES, 'i.hasCustomerName &&')).toBe(0);
    expect(countOf(RULES, 'proceedGateFailures = ')).toBe(1);
    for (const cond of ["'customer_name'", "'address'", "'postcode'", "'delivery_date'", "'deposit'"]) {
      expect(between(RULES, 'export const proceedGateFailures', '\nexport '), `missing condition ${cond}`)
        .toContain(cond);
    }
  });

  test('the deposit condition asks meetsDepositGate, so a free order can never raise it', () => {
    /* total <= 0 is vacuously met there (its own docblock). A `totalCenti > 0`
       guard written out here instead would read the same today and drift the
       first time the threshold rule grows a branch. */
    expect(between(RULES, 'export const proceedGateFailures', '\nexport '))
      .toContain('meetsDepositGate(i.paid, i.total, i.companyCode)');
    expect(between(PROBLEMS, 'const depositProblem = (', '};'))
      .toContain('if (meetsDepositGate(paidCenti, totalCenti, companyCode)) return null;');
  });
});

describe('the wording is one table, not two lists that look alike', () => {
  test('the aggregated save report and the proceed refusal share the emitters', () => {
    expect(countOf(PROBLEMS, 'const completenessProblem = (')).toBe(1);
    expect(countOf(PROBLEMS, 'const depositProblem = (')).toBe(1);
    /* Both collectors render through them; neither writes its own sentence. */
    expect(between(PROBLEMS, 'export function collectProcessingGateProblems', '\nexport function'))
      .toContain("completenessProblem('postcode', 'processing_date')");
    expect(between(PROBLEMS, 'export function collectProceedGateProblems', '\n}'))
      .toContain("completenessProblem(cond, 'proceed')");
  });

  test('no refusal sentence recites a condition it did not check', () => {
    /* THE DEFECT ITSELF, as a source test. The old refusal was ONE literal
       naming all five conditions, returned whenever any single one failed —
       which is how a zero-total order came to be told about a deposit. Scoped to
       what an operator actually reads (`message:` / `reason:` literals) rather
       than every string in the file: a column list that happens to contain the
       word "postcode" is nobody's refusal, and a gate that fails someone for
       something they did not write is worse than no gate. */
    const CONDITION_WORDS = ['customer name', 'address', 'postcode', 'delivery date', 'deposit'];
    const offenders: string[] = [];
    for (const src of [SO, GATE, PROBLEMS, RULES]) {
      for (const m of src.matchAll(/\b(?:message|reason):\s*(['`])((?:[^\\`'])*?)\1/g)) {
        const lit = m[2]!.toLowerCase();
        if (CONDITION_WORDS.filter((w) => lit.includes(w)).length > 1) offenders.push(m[2]!);
      }
    }
    expect(offenders, `a refusal sentence names more than one gate condition: ${JSON.stringify(offenders)}`)
      .toEqual([]);
  });
});

describe('every proceed refusal path carries the detail', () => {
  test('the routes never mint a proceed_gate_unmet body of their own', () => {
    expect(countOf(SO, 'proceed_gate_unmet')).toBe(0);
    expect(countOf(GATE, 'proceed_gate_unmet')).toBe(0);
    /* One builder, in the shared module, and the routes reach it by calling it. */
    expect(PROBLEMS).toContain(
      "return { error: 'proceed_gate_unmet', reason: proceedGateReason(problems), problems };",
    );
    expect(countOf(PROBLEMS, 'export function proceedGateUnmetBody')).toBe(1);
  });

  test('soProceedGateBlocked is the one gate, and it returns the aggregated body', () => {
    const helper = between(GATE, 'export async function soProceedGateBlocked', '\nexport async function soProcessingDateProblemsForDoc');
    expect(helper).toContain('collectProceedGateProblems({');
    expect(helper).toContain('proceedGateUnmetBody(problems)');
    /* Both amounts are handed over under their centi names — these numbers are
       PRINTED, unlike the ratio-only paid/total on ProceedGateInput. */
    expect(helper).toContain('paidCenti');
    expect(helper).toContain('totalCenti');
  });

  /* THE TWO CALL SITES THIS FILE COUNTED ARE GONE (2026-08-18), and the count is
     kept rather than deleted — an assertion that a population is EMPTY is worth
     as much as one that it is two, and more here, because it is what stops the
     old paths coming back by habit.

     Both were removed by the one-storage work, hours after this file landed:
       · /status -> IN_PRODUCTION ran the gate only when the order ALREADY had a
         Processing Date, i.e. re-gated a state that had passed the same gate —
         and inconsistently, since an order that also carried a Proceed stamp was
         not re-gated at all. The first proceed is the request that PUTS the date
         on, and it already runs soProcessingDateProblemsForDoc, a superset.
       · the header PATCH's `proceededAt` branch cannot be reached at all now
         that the key is out of the PATCH map.
     The per-condition refusal this file exists to protect did NOT go with them:
     it is asserted end-to-end, over the surviving act, in
     tests/soProceedRefusalNamesCondition.test.ts. */
  test('no route mints its own proceed refusal — there are no call sites left to', () => {
    expect(countOf(SO, 'await soProceedGateBlocked(sb, docNo, {')).toBe(0);
    expect(countOf(SO, 'if (gate) return c.json(gate, 422);')).toBe(0);
    /* And the one gate to call still exists, unedited, for the next path that
       needs to refuse. Deleting a freshly-shipped export to tidy a merge is how
       work gets silently undone. */
    expect(countOf(GATE, 'export async function soProceedGateBlocked')).toBe(1);
  });

  test('the create path no longer weighs the gate at all, so it has no refusal to name', () => {
    /* CREATE auto-proceed was the third meetsProceedGate caller and the only one
       that refused NOTHING — a handover that missed the gate was simply created
       un-proceeded, in Order Placed. It went with the Proceed stamp it existed
       to decide: `autoProceed` could only ever be true when a Processing Date
       was ALSO being written, and the create already refuses (422) to write that
       date unless the same conditions pass. So the rule did not loosen; it
       stopped being asked twice. */
    expect(countOf(SO, 'meetsProceedGate({')).toBe(0);
    expect(countOf(SO, 'autoProceed')).toBe(0);
  });
});
