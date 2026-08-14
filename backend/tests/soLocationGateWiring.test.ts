import { describe, expect, test } from 'vitest';
import rawRouteSource from '../src/scm/routes/mfg-sales-orders.ts?raw';

/* NORMALISE LINE ENDINGS. This file's assertions are source-TEXT anchors that
   embed `\n`, and on Windows the working copy is checked out CRLF (git's
   autocrlf), so every multi-line anchor missed and the suite failed HERE while
   CI stayed green on Linux — the same Windows-only-red shape CLAUDE.md already
   records for the shebang trap. The wiring was never broken; only the search
   was. A source-text test must be indifferent to a checkout setting. */
const routeSource = rawRouteSource.replace(/\r\n/g, '\n');

/* Owner ruling 2026-08-13 — a company-1 Sales Order must resolve a stock
   location, because AutoCount refuses a document line whose Location is not in
   dbo.Location (HC-SO-2608-002: "refused, nothing sent — MissingLocationError").

   THE INVARIANT THESE PIN: wherever the router enqueues an AutoCount CREATE, the
   location gate has already run. There are exactly two such places — the create
   path and the DRAFT -> live status transition — and this file fails if a third
   ever appears un-gated, or if either existing one loses its guard.

   Same source-anchored style as soConfirmGateWiring.test.ts: the LOGIC is
   unit-tested in src/scm/lib/so-location-gate.test.ts; this makes sure a
   refactor cannot silently unhook it. */

const between = (hay: string, startAnchor: string, endAnchor: string): string => {
  const start = hay.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = hay.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `anchor not found after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
  return hay.slice(start, end);
};

describe('every AutoCount create enqueue is gated', () => {
  test('the router enqueues an SO create in exactly TWO places', () => {
    const enqueues = routeSource.match(/enqueueSoCreate\(/g) ?? [];
    expect(
      enqueues.length,
      'a new enqueueSoCreate callsite needs its own location gate — see so-location-gate.ts',
    ).toBe(2);
  });
});

describe('create path (createSalesOrderCore)', () => {
  test('the gate runs on the DERIVED location, not on a bare State check', () => {
    const gateAt = routeSource.indexOf('soLocationProblem({');
    expect(gateAt).toBeGreaterThan(0);
    const block = routeSource.slice(gateAt, gateAt + 400);
    expect(block).toContain('salesLocation: derivedSalesLocation');
    expect(block).toContain("companyCode: c.get('companyCode')");
  });

  test('drafts are exempt (the scan pipeline must stay freely saveable)', () => {
    const gateAt = routeSource.indexOf('soLocationProblem({');
    const before = routeSource.slice(gateAt - 400, gateAt);
    expect(before).toContain('asDraft !== true');
  });

  test('a refusal rolls back the PWP claims and returns the shared 422 shape', () => {
    const gateAt = routeSource.indexOf('soLocationProblem({');
    const block = routeSource.slice(gateAt, gateAt + 600);
    expect(block).toContain('await rollbackPwpClaims();');
    expect(block).toContain('validationFailedBody([locationProblem]), 422');
  });

  test('it runs BEFORE the header insert, so a refused order leaves nothing behind', () => {
    const gateAt = routeSource.indexOf('soLocationProblem({');
    const insertAt = routeSource.indexOf("sb.from('mfg_sales_orders').insert({");
    expect(insertAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(insertAt);
  });
});

describe('status route (DRAFT -> live)', () => {
  const block = () =>
    between(routeSource, "mfgSalesOrders.patch('/:docNo/status',", 'const commitStatusChange');

  test('a draft going live is gated before the status write commits', () => {
    expect(block()).toContain("fromNorm === 'DRAFT' && toStatus !== 'CANCELLED'");
    expect(block()).toContain("soLocationProblemForDoc(sb, docNo, c.get('companyCode')");
    expect(block()).toContain('validationFailedBody([locationProblem]), 422');
  });

  test('the gate condition matches the enqueue condition exactly', () => {
    /* The enqueue is `else if (fromNorm === 'DRAFT')` on the non-cancel arm of
       an `isCancel` if — i.e. out of DRAFT and not a cancel. The gate must not
       be narrower (an un-gated live transition) nor wider (a cancelled junk
       scan draft the operator is discarding would be stranded). */
    const enqueueAt = routeSource.indexOf('await enqueueSoCreate(sb, {\n      companyId: activeCompanyId(c),');
    expect(enqueueAt).toBeGreaterThan(0);
    const arm = routeSource.slice(enqueueAt - 400, enqueueAt);
    expect(arm).toContain("} else if (fromNorm === 'DRAFT') {");
  });
});
