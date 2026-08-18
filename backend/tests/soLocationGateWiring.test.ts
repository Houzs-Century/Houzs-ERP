import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

   THE INVARIANT THESE PIN: wherever an AutoCount SO CREATE is enqueued, a stock
   location has already been settled. In THIS ROUTER that is the location gate,
   at exactly two places — the create path and the DRAFT -> live status
   transition — and this file fails if a third appears un-gated there, or if
   either existing one loses its guard.

   Outside the router the mechanism differs, so the tree-wide test below holds
   the whole population rather than this one file: a callsite elsewhere must be
   named with the mechanism that makes it safe. Say "the gate covers every
   enqueue" only about the router; repo-wide, the sentence is "every enqueue has
   a settled location, by one of two mechanisms".

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
      'a new enqueueSoCreate callsite in this ROUTER needs its own location gate — see so-location-gate.ts',
    ).toBe(2);
  });

  /* THE SENTENCE ABOVE WAS WIDER THAN THE CHECK UNDER IT (2026-08-15).
     Its failure message says "a new enqueueSoCreate callsite needs its own
     location gate", which reads as a promise about the repository — but it
     counts inside ONE imported file, so a callsite in any other module is
     invisible to it. There already was one: `scm/lib/autocount-requeue.ts`,
     the operator re-send tool. Nothing was broken by it; the guard simply did
     not cover what its own message claimed, which is the failure shape
     CLAUDE.md records twice over ("a checker that cannot match reports a clean
     run", "a verdict computed over nothing must never read as a pass").

     So the population is the TREE, and every callsite outside the router is
     named here with the mechanism that makes it safe. A new one fails until
     someone writes that mechanism down. */
  const KNOWN_OUTSIDE_ROUTER: Record<string, string> = {
    'scm/lib/autocount-requeue.ts':
      're-sends an outbox row that already exists, so the document already went '
      + 'through a gated create. It is safe WITHOUT so-location-gate for a second '
      + 'reason worth knowing: enqueueSoCreate itself catches MissingLocationError '
      + 'and writes a `skipped` outbox row with the reason (autocount-outbox.ts), '
      + 'rather than sending a create AutoCount would refuse.',
  };

  test('every enqueueSoCreate callsite in the tree is either the router or a named exception', () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) files.push(abs);
      }
    };
    walk(SRC);

    /* A scan that read nothing would "find" no callsite and pass. */
    expect(files.length, `only ${files.length} source file(s) walked — the path is wrong, not the tree`)
      .toBeGreaterThan(200);

    const hits: string[] = [];
    for (const abs of files) {
      const text = fs.readFileSync(abs, 'utf8');
      /* The definition and its re-exports are not callsites. */
      const calls = text.split('\n').filter((l) => /\benqueueSoCreate\(/.test(l)
        && !/^\s*(import|export)\b/.test(l)
        && !/export\s+(async\s+)?function\s+enqueueSoCreate/.test(l));
      if (calls.length > 0) hits.push(path.relative(SRC, abs).replace(/\\/g, '/'));
    }

    expect(hits.length, 'enqueueSoCreate is called nowhere — this guard is reading the wrong tree')
      .toBeGreaterThan(0);

    const unexpected = hits.filter((f) => f !== 'scm/routes/mfg-sales-orders.ts' && !(f in KNOWN_OUTSIDE_ROUTER));
    expect(
      unexpected,
      'these files enqueue an AutoCount SO create and are covered by NO location gate and NO recorded '
      + 'exception:\n  ' + unexpected.join('\n  ')
      + '\nEither run soLocationProblem before the enqueue, or add the file to KNOWN_OUTSIDE_ROUTER above '
      + 'with the mechanism that makes it safe. "It looked fine" is not a mechanism.',
    ).toEqual([]);

    /* An exception whose file is gone is a stale promise, and it hides the day
       the callsite comes back somewhere else. */
    const staleExceptions = Object.keys(KNOWN_OUTSIDE_ROUTER).filter((f) => !hits.includes(f));
    expect(
      staleExceptions,
      'these files are recorded as known enqueueSoCreate exceptions but no longer call it — delete the '
      + 'entry:\n  ' + staleExceptions.join('\n  '),
    ).toEqual([]);
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
    // Anchor changed 2026-08-18 — the handler is now a named export, mounted at the
    // bottom of the file; the old route-mount anchor slices nothing.
    between(routeSource, 'export const patchMfgSalesOrderStatusHandler', 'const commitStatusChange');

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
