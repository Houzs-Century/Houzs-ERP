// ----------------------------------------------------------------------------
// The both-dates-or-neither rule, WIRED — the enumeration of every server write
// path that can set or clear either date, asserted against the source.
//
// THE RULE (owner, restated 2026-08-13): "processing date 和 delivery date 必须
// 同时有或者同时没有".
//
// WHY A SOURCE SCAN AND NOT MORE UNIT CASES. The predicate itself is tested in
// src/scm/shared/so-date-pair.test.ts and was never the bug. The bug was WHICH
// PATHS reached it: before this file the rule was hand-written in five places
// (SO create, SO header PATCH, CO create, amendment submit, and one direction
// inside so-save-problems) and simply absent from three others — the CO header
// PATCH, the amendment APPROVE path, and the /status proceed. Every unit test
// over the logic passed the whole time. Same source-anchored style as
// soConfirmGateWiring.test.ts: the logic lives in its own unit file, this makes
// sure a refactor cannot silently unhook it from a route.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import soRoutes from '../src/scm/routes/mfg-sales-orders.ts?raw';
import coRoutes from '../src/scm/routes/consignment-orders.ts?raw';
import amendRoutes from '../src/scm/routes/so-amendments.ts?raw';
import mirrorRoute from '../src/scm/routes/so-mirror.ts?raw';
import revision from '../src/scm/lib/so-revision.ts?raw';
import saveProblems from '../src/scm/shared/so-save-problems.ts?raw';
import unifyScript from '../scripts/unify-processing-date.mjs?raw';

/** Source with comments removed. Every anchor and every assertion below runs
 *  on THIS, not on the raw file: a rule named only in a comment is not a rule,
 *  and an anchor that can match inside a comment is an anchor that silently
 *  slices the wrong region. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const between = (hay: string, startAnchor: string, endAnchor: string): string => {
  const start = hay.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = hay.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `anchor not found after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
  return hay.slice(start, end);
};

const SO = code(soRoutes);
const CO = code(coRoutes);
const AMEND = code(amendRoutes);
const UNIFY = code(unifyScript);

describe('every SO / CO write path that touches a date calls the shared predicate', () => {
  test('SO create — before any PWP claim burns', () => {
    expect(between(SO, 'const procDate  = (body.processingDate', 'const todayMY'))
      .toContain('soDatePairRefusal');
  });

  test('SO header PATCH', () => {
    const patchBlock = between(SO, 'const effDeliv = effectiveDateAfterPatch', 'collectProcessingGateProblems({');
    expect(patchBlock).toContain('soDatePairRefusal');
    /* The cascade half — clearing the Processing Date must take the Delivery
       Date with it, on the header AND on every line (p_apply_delivery_date). */
    expect(patchBlock).toContain('soDatePairCascadeColumns');
    expect(SO).toContain("p_apply_delivery_date: body['customerDeliveryDate'] !== undefined || cascadedDeliveryClear");
  });

  test('SO /status proceed — the path that writes the date without a header patch', () => {
    /* The closing anchor is the DATE WRITE this pair rule guards. It used to be
       `patch.proceeded_at`, the Proceed stamp that followed it — which stopped
       existing on 2026-08-18 when the Processing Date was collapsed to one
       storage. Anchoring on the write itself is what the test meant all along:
       the refusal has to come BEFORE the date lands, not merely before some
       neighbouring statement that happened to sit underneath it. */
    expect(between(SO, "if (toStatus === 'IN_PRODUCTION')", 'patch[SO_PROCESSING_DATE_COLUMN] = resolved.date'))
      .toContain('soDatePairRefusal');
  });

  test('amendment SUBMIT', () => {
    expect(between(SO, "const nextDeliv = 'customerDeliveryDate' in headerChanges", 'amendment_date_in_past'))
      .toContain('soDatePairRefusal');
  });

  test('amendment APPROVE — the last write that can still say no', () => {
    expect(AMEND).toContain('soDatePairRefusal');
    expect(AMEND).toContain('amendment_dates_pair_stale');
    /* And it must read the CANONICAL stored keys, or a pre-rename amendment
       walks past every gate in that block and is applied anyway by
       so-revision.ts, which does canonicalise. */
    expect(AMEND).toContain('canonicaliseSoHeaderChanges(amendment.header_changes');
  });

  test('CO create', () => {
    expect(between(CO, 'const procDate  = (body.processingDate', 'const todayMY'))
      .toContain('soDatePairRefusal');
  });

  test('CO header PATCH — the path that had no pair check at all', () => {
    const coPatch = between(CO, 'const effDeliv = effectiveDateAfterPatch', 'collectProcessingGateProblems({');
    expect(coPatch).toContain('soDatePairRefusal');
    expect(coPatch).toContain('soDatePairCascadeColumns');
  });

  test('the aggregated save-problem report asks BOTH directions', () => {
    expect(code(saveProblems)).toContain('soDatePairRefusal');
  });
});

describe('the deliberate exclusions say why they are excluded', () => {
  /* CLAUDE.md: a route that is deliberately outside a sweep says so in a
     comment naming why, so the next sweep does not "fix" it — and so removing
     the reasoning removes the exemption with it. */
  test('the 2990 mirror is a replica, not an authored write', () => {
    expect(mirrorRoute).toContain('NO PAIR GATE HERE');
    expect(mirrorRoute).toContain('probe-so-date-xor.mjs');
  });
});

describe('repair scripts are write paths too', () => {
  test('unify-processing-date.mjs cannot write an unpaired Processing Date', () => {
    /* The two-column branch writes both dates at once and is safe by
       construction; it is the SINGLE-column branch that could leave a half
       pair, so anchor on that one specifically. */
    const single = UNIFY.slice(UNIFY.lastIndexOf('SET processing_date ='));
    expect(single).toContain('customer_delivery_date IS NOT NULL');
  });
});

/* ── The PAYLOAD key, which fails the same way and is even quieter ──────────
   A column name in a select string at least errors at the database. A payload
   key read off a `Record` returns `undefined` and the branch simply does not
   run: the create's auto-proceed read `body.internalExpectedDd`, which NO
   client sends, so `autoProceed` was always false and an order created WITH a
   Processing Date was created UN-proceeded — the inverse of the owner's pinned
   rule, with nothing anywhere saying so. */
describe('the Processing Date is read out of a request body through the helper', () => {
  test('create auto-proceed', () => {
    /* Ends at the statement's own `;` rather than at whatever declaration
       happens to follow. The end anchor was `const depositTotalSen`, which the
       deposit-gate removal deleted (owner 2026-08-20) — an unrelated change
       three lines away broke a test about the date helper. The statement's own
       terminator cannot be moved by a neighbour. */
    expect(between(SO, 'const procDateOnCreate =', ';'))
      .toContain('readSoProcessingDateFromBody');
  });

  test('/status proceed', () => {
    expect(between(SO, 'resolveProceedProcessingDate({', '})'))
      .toContain('readSoProcessingDateFromBody');
  });

  test('no route reads the legacy payload key by hand', () => {
    expect(SO).not.toMatch(/body\.internalExpectedDd/);
    expect(SO).not.toMatch(/body\['internalExpectedDd'\]/);
  });
});

/* ── The column migration 0286 renamed away ─────────────────────────────────
   internal_expected_dd -> processing_date. The /status proceed block was the
   reader that rename missed: it SELECTed, compared and WROTE the old name, so
   the read 42703'd and the write named a column that no longer exists. Nothing
   the compiler sees can catch a column name that lives in a string. */
describe('no live code names internal_expected_dd', () => {
  const FILES: Array<[string, string]> = [
    ['mfg-sales-orders.ts', SO],
    ['consignment-orders.ts', CO],
    ['so-amendments.ts', AMEND],
    ['so-revision.ts', code(revision)],
    ['so-save-problems.ts', code(saveProblems)],
  ];
  for (const [name, source] of FILES) {
    test(name, () => {
      expect(source).not.toMatch(/\binternal_expected_dd\b/);
    });
  }
});
