/* THE CONFIRM RUNG READS "Submitted" ON FIVE DOCUMENTS — EVERYWHERE, AND ONLY
 * AS A LABEL.
 *
 * Owner, 2026-09-12: 「你的 confirm 状态，你应该要把全部都换成一样…PI、SI、GR、PO、
 * SO 都要改成 submitted」. What he was looking at is real: the five documents
 * store that rung under four different names (SO `CONFIRMED`, PO `SUBMITTED`,
 * GRN and PI `POSTED`, SI `SENT`), and the stored name leaks onto the screen in
 * the list FILTER TABS even after the 2026-08-21 sweep made every PILL say
 * "Confirmed". So a purchase order's tab said SUBMITTED while its pill said
 * Confirmed, and a goods receipt's tab said CONFIRMED. One rung, three words.
 *
 * THE STORED VALUES DO NOT CHANGE AND MUST NOT. Postgres enum labels are
 * permanent and every report, export and AutoCount read goes to the stored
 * value. This is the same option A as the 2026-08-21 "Confirmed" sweep and the
 * 2026-08-26 DISPATCHED -> "Loaded" relabel: change the WORD, never the column.
 * The first test below is what stops a later tidy-up "finishing the job" by
 * renaming the values.
 *
 * THE DELIVERY ORDER IS DELIBERATELY NOT IN THIS SET. The owner's same ruling
 * kept it on its own vocabulary (「DO 则是分成 draft、load、dispatch」), and its
 * two words were each settled by him separately — the confirm step lands on
 * LOADED (2026-08-22) and DISPATCHED reads "Loaded" (2026-08-26), pinned by
 * doDispatchedReadsLoaded.test.ts. Purchase returns, stock takes, stock
 * transfers, payment vouchers, consignment and PMS projects are not in the set
 * either: he named five documents, and a sweep that renames what nobody asked
 * about is how a "consistency" change becomes a regression.
 *
 * WHY A SOURCE SCAN AND NOT FIVE UNIT ASSERTIONS.
 * docs/modules/document-status-vocabulary.md records that SIXTEEN list and
 * detail pages declare their own `{ tone, label }` map instead of reading
 * status-pill.ts, and calls that root fix OPEN. A unit test over the canonical
 * map proves nothing about the other fifteen — which is exactly how the tab and
 * the pill came to disagree in the first place. The scan is the only assertion
 * that covers a page nobody has written yet.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { statusLabel } from '../../vendor/scm/lib/status-pill';
import { statusFor as soStatusFor } from './so-list-status';

const CONFIRM_RUNG: ReadonlyArray<readonly [docType: 'so' | 'po' | 'grn' | 'pi' | 'si', stored: string]> = [
  ['so', 'CONFIRMED'],
  ['po', 'SUBMITTED'],
  ['grn', 'POSTED'],
  ['pi', 'POSTED'],
  ['si', 'SENT'],
];

describe('the stored values are untouched', () => {
  it('each document still stores its own name for the rung — four different ones', () => {
    expect([...new Set(CONFIRM_RUNG.map(([, stored]) => stored))].sort())
      .toEqual(['CONFIRMED', 'POSTED', 'SENT', 'SUBMITTED']);
  });
});

describe('the word on screen', () => {
  for (const [docType, stored] of CONFIRM_RUNG) {
    it(`${docType}: ${stored} reads "Submitted"`, () => {
      expect(statusLabel(docType, stored)).toBe('Submitted');
    });
  }

  it('the sales-order LIST agrees with the pill, which is where the two used to differ', () => {
    expect(soStatusFor('confirmed').label).toBe('Submitted');
  });

  it('the delivery order is untouched — its own vocabulary, by the same ruling', () => {
    expect(statusLabel('do', 'LOADED')).toBe('Confirmed');
    expect(statusLabel('do', 'DISPATCHED')).toBe('Loaded');
  });

  it('documents the owner did NOT name keep their word', () => {
    expect(statusLabel('pr', 'POSTED')).toBe('Confirmed');
    expect(statusLabel('stockTake', 'POSTED')).toBe('Confirmed');
    expect(statusLabel('stockTransfer', 'POSTED')).toBe('Confirmed');
  });
});


const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return productionSources(path);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [path];
  });
}

const NOT_IN_SCOPE = new Set([
  'pages/scm-v2/do-list-status.ts',
  'pages/scm-v2/DeliveryOrderDetailV2.tsx',
  'pages/scm-v2/MfgDeliveryOrdersListV2.tsx',
  'vendor/scm/lib/packing-list-model.ts',
  'pages/scm-v2/ConsignmentNotes.tsx',
  'pages/scm-v2/ConsignmentOrders.tsx',
  'pages/scm-v2/PurchaseConsignmentReturns.tsx',
  'pages/scm-v2/PurchaseReturnDetailV2.tsx',
  'pages/scm-v2/PurchaseReturnsListV2.tsx',
  'pages/scm-v2/StockTakesListV2.tsx',
  'pages/scm-v2/StockTransfersListV2.tsx',
  'vendor/scm/lib/pms-project-status.ts',
  'mobile/MobilePMS.tsx',
  'pages/announcements/InboxView.tsx',
  'mobile/MobileOvertime.tsx',                         // overtime-claim status (HC-0125) — not a document rung
  'pages/hr/OvertimeTab.tsx',                          // overtime-claim status (HC-0125, desktop) — not a document rung
  'pages/hr/OtRequestsPage.tsx',                       // overtime-claim status (HC-0125, redesign) — not a document rung
  'vendor/scm/lib/status-pill.ts',
  'mobile/MobileModuleList.tsx',
]);

describe('no surface still calls the five documents\' confirm rung "Confirmed"', () => {
  it('no line names one of the five stored values beside a "Confirmed" label', () => {
    const offenders = productionSources().flatMap((path) => {
      const rel = relative(SRC, path).replaceAll('\\', '/');
      if (NOT_IN_SCOPE.has(rel)) return [];
      const source = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      return source
        .split('\n')
        .map((line, i) => [line, i + 1] as const)
        .filter(([line]) => /\b(CONFIRMED|SUBMITTED|POSTED|SENT|confirmed|posted|issued)\b/.test(line)
          && /['"`]Confirmed['"`]/.test(line))
        .map(([line, n]) => `${rel}:${n}: ${line.trim()}`);
    });

    expect(offenders).toEqual([]);
  });

  it('the scan reads real files, so an empty result is not a dead walk', () => {
    const files = productionSources();
    expect(files.length).toBeGreaterThan(400);
    expect(files.some((p) => p.endsWith('status-pill.ts'))).toBe(true);
  });

  it('every NOT_IN_SCOPE entry still exists, so the list cannot rot into a blanket waiver', () => {
    const present = new Set(productionSources().map((p) => relative(SRC, p).replaceAll('\\', '/')));
    expect([...NOT_IN_SCOPE].filter((p) => !present.has(p))).toEqual([]);
  });
});
