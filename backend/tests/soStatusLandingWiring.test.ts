// ----------------------------------------------------------------------------
// THE DATE DECIDES WHERE A LIVE ORDER LANDS — asserted against the source, in
// the style of soProceedRefusalWiring.test.ts and for the same reason.
//
// The rule (shared/so-proceeded-status.ts) existed and was tested; three
// writers simply never asked it. On 2026-10-13 production held 171 Submitted
// orders carrying a Processing Date — the create and the DRAFT confirm wrote
// the literal 'CONFIRMED' — and two DELIVERED orders with goods added after
// delivery, because the reconciler that re-opens an order only ran from DO
// routes. This file is what stops a later edit putting the literal back.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { soRouterSource } from './lib/so-router-source';
import allocation from '../src/scm/lib/so-stock-allocation.ts?raw';
import revision from '../src/scm/lib/so-revision.ts?raw';

const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SO = code(soRouterSource());
const ALLOC = code(allocation);
const REVISION = code(revision);
const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe('every writer of a live status asks liveStatusForProcessingDate', () => {
  test('the create no longer hard-codes CONFIRMED beside DRAFT', () => {
    expect(countOf(SO, "asDraft === true ? 'DRAFT' : 'CONFIRMED'")).toBe(0);
    /* The insert and its CREATE audit snapshot both read the same answer. */
    expect(countOf(SO, "asDraft === true ? 'DRAFT' : liveStatusForProcessingDate(dateOrNull(procDateOnCreate))")).toBe(2);
  });

  test('a DRAFT confirm lands where the stored Processing Date says', () => {
    expect(SO).toContain("const isConfirm = fromNorm === 'DRAFT' && toStatus === 'CONFIRMED';");
    expect(SO).toContain('toStatus = liveStatusForProcessingDate(');
    /* The confirm gate still judges the CONFIRM itself. */
    expect(SO).toContain('if (isConfirm) {\n    const confirmProblems = await soConfirmProblemsForDoc(sb, docNo);');
  });

  test("the stock sweep's regress out of READY_TO_SHIP follows the date too", () => {
    expect(ALLOC).toContain('const regressTo = liveStatusForProcessingDate(order.processing_date);');
    expect(countOf(ALLOC, "{ status: 'CONFIRMED' }")).toBe(0);
  });
});

describe('a line added to a DELIVERED order re-opens it', () => {
  test('both add-line branches of PATCH /:docNo/items run the delivery reconciler', () => {
    /* The sofa split returns early; the single-row path is the other. */
    expect(countOf(SO, 'await syncSoDeliveredFromDo(sb, [docNo], user.id);')).toBe(2);
  });

  test('an approved amendment that ADDED a line runs it, and only then', () => {
    expect(REVISION).toContain('if (addedLineIds.length > 0) await syncSoDeliveredFromDo(sb, [docNo], userId);');
  });
});
