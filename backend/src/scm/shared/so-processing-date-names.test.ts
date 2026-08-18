// ----------------------------------------------------------------------------
// THE ONE NAME, ENFORCED — a retired spelling of the Processing Date may not
// come back, and the two that must SURVIVE may not be swept away.
//
// WHY A SOURCE-TEXT TEST AND NOT A TYPE. Every failure in this family is
// invisible to the compiler, because every one of them is a name inside a
// STRING: a PostgREST select list, a `[payloadKey, column]` map entry, an
// AutoCount UDF key, a `Record<string, unknown>` lookup. `target_date` sat in
// four accept-maps and three select lists for three months after PR #140
// dropped the field, and `tsc` had nothing to say about any of it. The idiom is
// the one in return-unlinked-lines.test.ts — read the real source and assert on
// what it contains.
//
// EVERY CASE PROVES ITSELF NON-VACUOUS FIRST. A file that moves, is renamed or
// is emptied would otherwise pass this test by containing nothing at all, which
// is the exact failure shape it exists to catch. So each entry names an ANCHOR
// it must still contain — a string that is there because the file is still
// doing its job — and the anchor is asserted BEFORE the absence is.
// ----------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import {
  SO_HEADER_LEGACY_PAYLOAD_KEYS,
  SO_PROCESSING_DATE_AC_UDF,
  SO_PROCESSING_DATE_COLUMN,
  SO_PROCESSING_DATE_LEGACY_COLUMNS,
  SO_PROCESSING_DATE_MEANING,
  SO_PROCESSING_DATE_PAYLOAD_KEY,
  SO_TARGET_DATE_RETIREMENT_BLOCKED,
} from './so-processing-date';

/* `?raw` — the file's SOURCE TEXT, the idiom return-unlinked-lines.test.ts uses.
   Imports rather than an fs walk on purpose: an import is resolved at BUILD
   time, so a file that is moved or renamed out from under this guard breaks the
   suite loudly instead of leaving a path string that silently reads nothing.
   The frontend paths cross the package boundary deliberately — the retired name
   lived on BOTH sides, and a guard watching one tree would let it grow back on
   the other. */
import consignmentShapeSrc from '../lib/consignment-order-shape.ts?raw';
import soEditHeaderSrc from '../lib/so-edit-header.ts?raw';
import consignmentRoutesSrc from '../routes/consignment-orders.ts?raw';
import mfgSoSrc from '../routes/mfg-sales-orders.ts?raw';
import reportsSrc from '../routes/reports.ts?raw';
import orderRulesSrc from './order-rules.ts?raw';
import orderRulesTestSrc from './order-rules.test.ts?raw';
import soSaveProblemsTestSrc from './so-save-problems.test.ts?raw';
import variantSummarySrc from './variant-summary.ts?raw';
import registrySrc from './so-processing-date.ts?raw';
import soDatePairTestSrc from './so-date-pair.test.ts?raw';
import soSaveProblemsSrc from './so-save-problems.ts?raw';
import salesSrcRaw from '../../routes/sales.ts?raw';
import acWritebackSrc from '../../services/autocount-writeback.ts?raw';
import probeSoDateXorSrc from '../../../scripts/probe-so-date-xor.mjs?raw';
import feConsignmentOrdersSrc from '../../../../frontend/src/pages/scm-v2/ConsignmentOrders.tsx?raw';
import feSoAuditLabelsSrc from '../../../../frontend/src/pages/scm-v2/so-audit-labels.ts?raw';
import feSoDetailSrc from '../../../../frontend/src/pages/scm-v2/SalesOrderDetail.tsx?raw';
import feSoDetailGatesSrc from '../../../../frontend/src/vendor/scm/lib/so-detail-gates.ts?raw';

/**
 * `target_date` IS LIVE, and every one of these files must keep saying so.
 *
 * THIS BLOCK IS THE INVERSE OF WHAT IT STARTED AS. The sweep that wrote this
 * file removed `target_date` from all eight sites as a dead POS-era field —
 * every signal inside the repo agreed it was dead, including a zero-hit grep for
 * any client that sends the key. Then `probe-rename-preconditions.mjs` section F
 * read production: **46 of 2826 SO rows carry one and ALL 46 were CREATED inside
 * the last 90 days**, newest 6.75 days old. A row born with the value was given
 * it at create, and the ERP has not written it at create since PR #140 — so the
 * POS handover is still sending it. `routes/reports.ts` still reads it into the
 * sales-report export. The removal was reverted the same day.
 *
 * So the guard now protects the DOOR rather than its absence. Shipping that
 * removal would have been the exact defect this whole area exists to end: the
 * POS keeps POSTing `targetDate`, the create returns **201**, and the value
 * disappears with no error anywhere.
 */
const TARGET_DATE_DOORS: readonly (readonly [name: string, src: string, must: string])[] = [
  // The two ACCEPT paths — remove one of these and a live producer's value is
  // silently dropped on a 201.
  ['SO create accepts targetDate', mfgSoSrc, 'target_date: dateOrNull(body.targetDate)'],
  ['SO header PATCH maps it', mfgSoSrc, "['targetDate', 'target_date']"],
  ['CO create accepts targetDate', consignmentRoutesSrc, 'target_date: dateOrNull(body.targetDate)'],
  ['CO header PATCH maps it', consignmentRoutesSrc, "['targetDate', 'target_date']"],
  // The READ path — the sales-report export surfaces the column.
  ['the reports export selects it', reportsSrc, 'target_date'],
  ['the CO read shape selects it', consignmentShapeSrc, 'target_date'],
];

describe('target_date is LIVE — the retirement the measurement stopped', () => {
  it('the finding is recorded, not just remembered', () => {
    expect(SO_TARGET_DATE_RETIREMENT_BLOCKED).toBe(true);
    /* The reason travels with the flag, or the next sweep deletes the flag and
       the field together. */
    expect(registrySrc).toContain('46 of 2826 SO rows carry a `target_date`');
    expect(registrySrc).toContain('TO RETIRE IT LATER');
  });

  it.each(TARGET_DATE_DOORS)('%s', (_name, src, must) => {
    /* Non-vacuous first: the file must still be the file. */
    expect(src.length).toBeGreaterThan(500);
    expect(src).toContain(must);
  });

  it('no client in THIS repo sends the key — which is why the source reads dead', () => {
    /* Pinned so the reasoning above stays checkable. If a frontend ever starts
       sending `targetDate`, this fails and the comment needs rewriting rather
       than trusting. */
    for (const src of [feSoDetailSrc, feConsignmentOrdersSrc]) {
      expect(src).not.toContain('targetDate:');
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   THE OTHER DIRECTION, and the one that costs more. A sweep told "collapse the
   names" will happily delete a name this repo does not own or a name production
   rows still carry. These three assertions are what make "leave it" a rule
   instead of a comment.
   ────────────────────────────────────────────────────────────────────────── */
describe('the names that must SURVIVE the unification', () => {
  it("PDate stays at both AutoCount write sites — it is AutoCount's name, not ours", () => {
    /* AutoCount matches UDFs by NAME. Rename this and the connector drops an
       unknown key, the document posts 200 without it, and every Processing Date
       silently stops reaching the account book — no error anywhere to catch it. */
    expect(SO_PROCESSING_DATE_AC_UDF).toBe('PDate');

    const create = acWritebackSrc;
    expect(create).toContain('SO_PROCESSING_DATE_AC_UDF'); // create + clearable map
    expect(create).toContain('DO NOT "UNIFY" IT');

    const edit = soEditHeaderSrc;
    expect(edit).toContain('udf[SO_PROCESSING_DATE_AC_UDF] = pdate');
    expect(edit).toContain('DO NOT "UNIFY" IT');
  });

  it('internal_expected_dd stays as an INBOUND alias until 2990 has deployed', () => {
    /* mirror-map's applyMap filters an inbound row against the destination
       table's columns and DROPS what it does not recognise: no error, upsert
       returns 200, and company 2's Processing Date stops arriving. 2990 is a
       separate repository on its own deploy schedule, so this list is what
       turns that silent drop into a rename. */
    expect(SO_PROCESSING_DATE_LEGACY_COLUMNS).toContain('internal_expected_dd');
    expect(registrySrc).toContain('STATUS 2026-08-18: STAYS');
  });

  it('internalExpectedDd stays as a STORED-jsonb alias until the queue is empty', () => {
    /* A pending amendment is jsonb written at REQUEST time and read at APPROVE
       time, days later and across deploys. Drop the alias and the approve loop
       simply never emits the date: approved, audited, SO_APPROVED, silent. */
    expect(SO_HEADER_LEGACY_PAYLOAD_KEYS.internalExpectedDd)
      .toBe(SO_PROCESSING_DATE_PAYLOAD_KEY);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   THE LEGACY NATIVE SALES MODULE. Owner 2026-08-18: "全部我们只有一个 Processing
   Date" — same concept, so it accepts the canonical key too. Stage 1 only: the
   old key is still accepted, because that module's approve path REPLAYS payloads
   stored days earlier and dropping a key there is silent.
   ────────────────────────────────────────────────────────────────────────── */
describe('the native Sales module accepts BOTH keys (stage 1)', () => {
  const salesSrc = () => salesSrcRaw;

  it('folds the canonical payload key onto the column it stores', () => {
    const src = salesSrc();
    expect(src).toContain('SALES_ENTRY_KEY_ALIASES');
    expect(src).toContain('[SO_PROCESSING_DATE_PAYLOAD_KEY]: SO_PROCESSING_DATE_COLUMN');
  });

  it('folds on EVERY road in — create, direct PATCH, queue, and approve replay', () => {
    /* Four call sites and not three: the queue stores the payload and the
       approve replays it, and a fold on only one of the two leaves either the
       already-parked rows or the newly-parked ones unhandled. `applyEntryPatch`
       is the single seam both the direct PATCH and the approve pass through. */
    const src = salesSrc();
    expect(src.split('canonicaliseSalesEntryBody(').length - 1)
      .toBeGreaterThanOrEqual(4);
  });

  it('has NOT retired the old key, and says what stage 2 needs first', () => {
    /* The removal is the dangerous half. It stays unshipped until a production
       count says no pending change request still carries the old spelling. */
    const src = salesSrc();
    expect(src).toContain('"processing_date",'); // still in SO_FORM_TEXT_FIELDS
    expect(src).toContain('STAGE 2 (NOT SHIPPED)');
    expect(src).toContain('FROM sales_entry_change_requests');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   WHAT THE DATE MEANS. Owner 2026-08-18: "Processing Date 就代表这张单可以安排
   订货了" and "我们都没有排产的，我们都不是 Production". Comments describing a
   factory queue were describing a business that does not exist, and they are
   what kept the wrong mental model alive long enough to produce the bugs above.
   ────────────────────────────────────────────────────────────────────────── */
describe('no surface still calls this a production date', () => {
  /* WIDENED 2026-08-18, the same day it was written, because the first version
     was already too narrow: PR #2383 landed between the sweep and the merge and
     brought THREE fresh "the day the factory starts" comments into a file this
     list already watched. The guard did not fire, because it was matching the
     three phrasings that happened to exist rather than the IDEA. These patterns
     match the idea — a factory, a production start, a build queue.

     `IN_PRODUCTION` is deliberately NOT matched: it is a real status value in
     the enum, not a claim about the business, and a guard that fails on the name
     of a live status is a guard someone deletes. */
  const FRAMING = [
    /go-to-production/i,
    /factory queue/i,
    /ready to build/i,
    /the factory\b/i,
    /factory start/i,
    /production planning/i,
    /start production/i,
    /production'?s (?:go-ahead|"ready)/i,
  ];
  /* so-processing-date.ts is deliberately NOT in this list: it is the one file
     entitled to SAY the retired framing, because forbidding it is its job. It
     gets the positive assertion below instead. */
  const CORRECTED: readonly (readonly [name: string, src: string])[] = [
    ['scm/shared/so-save-problems.ts', soSaveProblemsSrc],
    ['scm/shared/order-rules.ts', orderRulesSrc],
    ['scm/shared/so-date-pair.test.ts', soDatePairTestSrc],
    ['scm/routes/mfg-sales-orders.ts', mfgSoSrc],
    ['frontend so-detail-gates.ts', feSoDetailGatesSrc],
    ['scripts/probe-so-date-xor.mjs', probeSoDateXorSrc],
    /* The TESTS too, and the KIV helper. #2383 showed the framing travels by
       copy-paste from wherever it still reads naturally, and a test comment is
       exactly as readable as the code's. */
    ['scm/shared/order-rules.test.ts', orderRulesTestSrc],
    ['scm/shared/so-save-problems.test.ts', soSaveProblemsTestSrc],
    ['scm/shared/variant-summary.ts', variantSummarySrc],
  ];

  it.each(CORRECTED)('%s', (_name, src) => {
    /* Non-vacuous: the file must still be ABOUT this date. Hyphen OR space —
       "Processing-Date gate" is as much a mention as "Processing Date", and an
       anchor that missed the hyphen would let a hyphen-using file pass this
       whole block by being unrecognised. */
    expect(src).toMatch(/processing[- ]date/i);
    for (const re of FRAMING) expect(src).not.toMatch(re);
  });

  it('the registry states the meaning the owner gave, so a copy has a source', () => {
    expect(SO_PROCESSING_DATE_MEANING).toContain('RELEASED FOR PURCHASING TO ORDER GOODS');
    const registry = registrySrc;
    expect(registry).toContain('RELEASED FOR PURCHASING TO');
    expect(registry).toContain('THERE IS NO PRODUCTION SCHEDULING IN THIS BUSINESS');
    /* And it says so as a PROHIBITION, not just as prose — the sentence a
       reader who meets a stale comment elsewhere needs to find. */
    expect(registry).toContain('it is stale — fix it, do not copy it');
  });
});
