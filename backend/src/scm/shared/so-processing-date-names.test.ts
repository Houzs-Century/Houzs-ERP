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
  SO_PROCESSING_DATE_PAYLOAD_KEY,
  SO_PROCESSING_DATE_RETIRED_NAMES,
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
 * The files `target_date` / `targetDate` was removed FROM, each with the anchor
 * that proves the file is still the file. Both trees: the name lived on the
 * server's accept-maps and select lists AND on two frontend row types, and a
 * guard that only watched one side would let it grow back on the other.
 */
const SWEPT: readonly (readonly [name: string, src: string, anchor: string])[] = [
  // The SO header: create accept-map, PATCH key map, and the select list.
  ['scm/routes/mfg-sales-orders.ts', mfgSoSrc, "['processingDate', 'processing_date']"],
  // The consignment twin, which carried an identical copy of all three.
  ['scm/routes/consignment-orders.ts', consignmentRoutesSrc, "['processingDate', 'processing_date']"],
  ['scm/lib/consignment-order-shape.ts', consignmentShapeSrc, 'customer_delivery_date, processing_date'],
  // The reports export's embedded header select.
  ['scm/routes/reports.ts', reportsSrc, 'customer_delivery_date, processing_date'],
  // The two frontend row types that declared it, and the audit vocabulary.
  ['frontend SalesOrderDetail.tsx', feSoDetailSrc, 'processingDate: f.processingDate || null'],
  ['frontend ConsignmentOrders.tsx', feConsignmentOrdersSrc, 'processing_date: string | null'],
  ['frontend so-audit-labels.ts', feSoAuditLabelsSrc, "processingDate: 'Processing date'"],
];

describe('the retired name does not come back', () => {
  it.each(SWEPT)('%s', (_name, src, anchor) => {
    /* NON-VACUOUS FIRST. If this fails, the file moved or was gutted and the
       absence assertion below would have passed for the wrong reason. */
    expect(src).toContain(anchor);
    for (const retired of SO_PROCESSING_DATE_RETIRED_NAMES) {
      expect(src).not.toContain(retired);
    }
  });

  it('the retired list is not empty, and never names the live spellings', () => {
    /* An empty list would make every case above vacuously true. */
    expect(SO_PROCESSING_DATE_RETIRED_NAMES.length).toBeGreaterThan(0);
    expect(SO_PROCESSING_DATE_RETIRED_NAMES).toContain('target_date');
    expect(SO_PROCESSING_DATE_RETIRED_NAMES).not.toContain(SO_PROCESSING_DATE_COLUMN);
    expect(SO_PROCESSING_DATE_RETIRED_NAMES).not.toContain(SO_PROCESSING_DATE_PAYLOAD_KEY);
    /* And it never names the EXTERNAL one — see the block below for why that
       would be the most expensive mistake in this file. */
    expect(SO_PROCESSING_DATE_RETIRED_NAMES).not.toContain(SO_PROCESSING_DATE_AC_UDF);
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
  const FRAMING = [/go-to-production/i, /factory queue/i, /ready to build/i];
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
  ];

  it.each(CORRECTED)('%s', (_name, src) => {
    /* Non-vacuous: the file must still be ABOUT this date. */
    expect(src.toLowerCase()).toContain('processing date');
    for (const re of FRAMING) expect(src).not.toMatch(re);
  });

  it('the registry states the meaning the owner gave, so a copy has a source', () => {
    const registry = registrySrc;
    expect(registry).toContain('RELEASED FOR PURCHASING TO');
    expect(registry).toContain('THERE IS NO PRODUCTION SCHEDULING IN THIS BUSINESS');
    /* And it says so as a PROHIBITION, not just as prose — the sentence a
       reader who meets a stale comment elsewhere needs to find. */
    expect(registry).toContain('it is stale — fix it, do not copy it');
  });
});
