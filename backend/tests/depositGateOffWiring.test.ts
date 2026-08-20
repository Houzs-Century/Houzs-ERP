// ----------------------------------------------------------------------------
// THE DEPOSIT SAVE GATE IS OFF ON BOTH SURFACES — owner ruling, 2026-08-20.
//
// 「以电脑为准 —— 两边都不查」. Asserted against the SOURCE, same idiom and same
// reason as soProceedRefusalWiring: the failure mode this guards is not a wrong
// verdict, it is the condition coming back on ONE surface — which is exactly how
// it got here, and which no unit test over the collector could ever see.
//
// This replaces manualEntryDepositWaiverWiring.test.ts. That file pinned the
// opposite wiring (a waiver reachable only through `manualEntry === true`), and
// a per-surface flag is precisely what the ruling removes: the desktop sent it
// on every create, the phone sent nothing, and the same order was accepted on
// one screen and refused on the other.
//
// WHAT IS DELIBERATELY NOT ASSERTED HERE. `collectProceedGateProblems` /
// `proceedGateFailures` (order-rules) still carry a deposit condition. That path
// is an ORPHAN — `soProceedGateBlocked` has had no callers since 2026-08-18 and
// is kept on purpose — so it refuses nothing in production and is out of this
// ruling's scope. It is a live trap for whoever wires a future proceed path,
// and it is written up in the PR and the module guide rather than changed here.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import soRoutes from '../src/scm/routes/mfg-sales-orders.ts?raw';
import proceedGate from '../src/scm/lib/so-proceed-gate.ts?raw';
import saveProblems from '../src/scm/shared/so-save-problems.ts?raw';
import salesOrderNew from '../../frontend/src/pages/scm-v2/SalesOrderNew.tsx?raw';
import mobileNewSo from '../../frontend/src/mobile/MobileNewSO.tsx?raw';

/** Source with comments stripped — a rule named only in a comment is not a
 *  rule, and the comments here quote the very shapes this file forbids. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The slice of `s` between two markers, so an assertion aimed at ONE function
 *  cannot be satisfied — or broken — by an unrelated mention elsewhere in a
 *  12,000-line router. */
const sliceFrom = (s: string, from: string, to: string): string => {
  const a = s.indexOf(from);
  expect(a, `marker not found: ${from}`).toBeGreaterThan(-1);
  const b = s.indexOf(to, a + from.length);
  return s.slice(a, b > -1 ? b : undefined);
};

const SO = code(soRoutes);
const PG = code(proceedGate);
const SP = code(saveProblems);
const NEW_SO = code(salesOrderNew);
const MOBILE_SO = code(mobileNewSo);

describe('the deposit save gate is OFF on both surfaces (owner 2026-08-20)', () => {
  test('no surface carries a per-surface waiver flag', () => {
    /* The desktop sent `manualEntry: true` as a bare literal on EVERY create and
       the phone sent nothing, which is what made one screen accept the order the
       other refused. The fix is not a second copy of the flag on the phone — it
       is no flag at all. */
    expect(SO).not.toMatch(/manualEntry/);
    expect(NEW_SO).not.toMatch(/manualEntry/);
    expect(MOBILE_SO).not.toMatch(/manualEntry/);
  });

  test('the CREATE path hands the collector no deposit condition', () => {
    const create = sliceFrom(SO, 'const pricedGateProblems', 'if (pricedGateProblems');
    expect(create).not.toMatch(/deposit/i);
  });

  test('the EDIT path hands the collector no deposit condition', () => {
    /* This is the half that had no waiver at all. Precisely: the edit gate fired
       when a header PATCH SET or CHANGED the Processing Date — an unchanged
       value is dropped by the normalisation at the top of the handler, so an
       unrelated header edit never reached it. So the shape was a hand-keyed RM 0
       order accepted at CREATE and then refused the moment anyone RESCHEDULED
       it, naming a deposit the operator had been told was fine the day before. */
    expect(SO).not.toMatch(/deposit:\s*depositFacts/);
    expect(SO).not.toMatch(/depositFacts/);
  });

  test('the /status proceed path hands the collector no deposit condition', () => {
    const forDoc = sliceFrom(PG, 'export async function soProcessingDateProblemsForDoc', '\n}');
    expect(forDoc).not.toMatch(/deposit/i);
  });

  test('the collector itself has no deposit condition left to apply', () => {
    /* Removed where it is DECIDED, so every surface gets the same answer from
       one place rather than from whatever its own call site happened to pass. */
    const factsType = sliceFrom(SP, 'export type ProcessingGateFacts', 'export function collectProcessingGateProblems');
    expect(factsType).not.toMatch(/deposit/i);
    const collector = sliceFrom(SP, 'export function collectProcessingGateProblems', 'export function validationFailedBody');
    expect(collector).not.toMatch(/deposit/i);
    expect(collector).not.toMatch(/processing_date_unpaid/);
  });
});
