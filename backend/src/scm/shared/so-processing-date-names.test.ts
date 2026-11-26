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

import consignmentShapeSrc from '../lib/consignment-order-shape.ts?raw';
import soEditHeaderSrc from '../lib/so-edit-header.ts?raw';
import consignmentRoutesSrc from '../routes/consignment-orders.ts?raw';
import { soRouterSource } from '../../../tests/lib/so-router-source';
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
const mfgSoSrc = soRouterSource();

const TARGET_DATE_DOORS: readonly (readonly [name: string, src: string, must: string])[] = [
  ['SO create accepts targetDate', mfgSoSrc, 'target_date: dateOrNull(body.targetDate)'],
  ['SO header PATCH maps it', mfgSoSrc, "['targetDate', 'target_date']"],
  ['CO create accepts targetDate', consignmentRoutesSrc, 'target_date: dateOrNull(body.targetDate)'],
  ['CO header PATCH maps it', consignmentRoutesSrc, "['targetDate', 'target_date']"],
  ['the reports export selects it', reportsSrc, 'target_date'],
  ['the CO read shape selects it', consignmentShapeSrc, 'target_date'],
];

describe('target_date is LIVE — the retirement the measurement stopped', () => {
  it('the finding is recorded, not just remembered', () => {
    expect(SO_TARGET_DATE_RETIREMENT_BLOCKED).toBe(true);
    expect(registrySrc).toContain('46 of 2826 SO rows carry a `target_date`');
    expect(registrySrc).toContain('TO RETIRE IT LATER');
  });

  it.each(TARGET_DATE_DOORS)('%s', (_name, src, must) => {
    expect(src.length).toBeGreaterThan(500);
    expect(src).toContain(must);
  });

  it('no client in THIS repo sends the key — which is why the source reads dead', () => {
    for (const src of [feSoDetailSrc, feConsignmentOrdersSrc]) {
      expect(src).not.toContain('targetDate:');
    }
  });
});

describe('the names that must SURVIVE the unification', () => {
  it("PDate stays at both AutoCount write sites — it is AutoCount's name, not ours", () => {
    expect(SO_PROCESSING_DATE_AC_UDF).toBe('PDate');

    const create = acWritebackSrc;
    expect(create).toContain('SO_PROCESSING_DATE_AC_UDF');
    expect(create).toContain('DO NOT "UNIFY" IT');

    const edit = soEditHeaderSrc;
    expect(edit).toContain('udf[SO_PROCESSING_DATE_AC_UDF] = pdate');
    expect(edit).toContain('DO NOT "UNIFY" IT');
  });

  it('internal_expected_dd stays as an INBOUND alias until 2990 has deployed', () => {
    expect(SO_PROCESSING_DATE_LEGACY_COLUMNS).toContain('internal_expected_dd');
    expect(registrySrc).toContain('STATUS 2026-08-18: STAYS');
  });

  it('internalExpectedDd stays as a STORED-jsonb alias until the queue is empty', () => {
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
    const src = salesSrc();
    expect(src.split('canonicaliseSalesEntryBody(').length - 1)
      .toBeGreaterThanOrEqual(4);
  });

  it('has NOT retired the old key, and says what stage 2 needs first', () => {
    const src = salesSrc();
    expect(src).toContain('"processing_date",');
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
    expect(src).toMatch(/processing[- ]date/i);
    for (const re of FRAMING) expect(src).not.toMatch(re);
  });

  it('the registry states the meaning the owner gave, so a copy has a source', () => {
    expect(SO_PROCESSING_DATE_MEANING).toContain('RELEASED FOR PURCHASING TO ORDER GOODS');
    const registry = registrySrc;
    expect(registry).toContain('RELEASED FOR PURCHASING TO');
    expect(registry).toContain('THERE IS NO PRODUCTION SCHEDULING IN THIS BUSINESS');
    expect(registry).toContain('it is stale — fix it, do not copy it');
  });
});
