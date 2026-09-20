// Convention guard for Option A (owner 2026-09-18): the forms migrated to the
// shared add-line CHROME must keep using it. Each migrated editor imports the
// shared AddLineButton and no longer hand-rolls its own dashed "Add Line Item"
// button. This is a RATCHET over the already-migrated set — it does not fail on
// forms not yet migrated; a form joins the list only when its PR moves it over,
// and from then on this test stops it drifting back to a bespoke button/label.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string): string => {
  const roots = ['frontend/src/', 'src/'];
  for (const r of roots) {
    try { return readFileSync(resolve(process.cwd(), r + rel), 'utf8'); } catch { /* try next */ }
  }
  for (const r of roots) {
    try { return readFileSync(resolve(process.cwd(), '..', r + rel), 'utf8'); } catch { /* try next */ }
  }
  throw new Error(`${rel} not found from ${process.cwd()} — this scan must never pass on an empty read`);
};

// Forms migrated to the shared add-line chrome. Append here as each rollout PR
// moves a form over.
const MIGRATED = [
  'pages/scm-v2/SalesOrderNew.tsx',
  'pages/scm-v2/SalesInvoiceNew.tsx',
  'pages/scm-v2/ConsignmentNoteNew.tsx',
  'pages/scm-v2/ConsignmentOrderNew.tsx',
  'pages/scm-v2/ConsignmentReturnNew.tsx',
  'pages/scm-v2/StockTransferNew.tsx',
  'pages/scm-v2/StockAdjustmentNew.tsx',
  'pages/scm-v2/PurchaseOrderNew.tsx',
  'pages/scm-v2/GrnNew.tsx',
  'pages/scm-v2/PurchaseInvoiceNew.tsx',
  'pages/scm-v2/PurchaseConsignmentOrderNew.tsx',
  'pages/scm-v2/PurchaseConsignmentReturnNew.tsx',
  'pages/scm-v2/PurchaseReturnNew.tsx',
  'pages/scm-v2/PaymentVoucherNew.tsx',
  'pages/scm-v2/ApInvoiceForm.tsx',
  'pages/scm-v2/DebtorBillForm.tsx',
  'pages/scm-v2/CreditNotes.tsx',
  'pages/scm-v2/DeliveryOrderNewV2.tsx',
  'pages/scm-v2/PurchaseConsignmentReceiveNew.tsx',
];

// Strip comments so a WHY-comment mentioning the old wording never trips the scan.
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('add-line shell — migrated forms keep the shared chrome', () => {
  it('every migrated form imports the shared AddLineButton', () => {
    for (const f of MIGRATED) {
      // Quote-agnostic: some files quote imports with " and some with '.
      expect(read(f), f).toContain('vendor/scm/components/AddLineButton');
    }
  });

  it('no migrated form hand-rolls its own dashed add-line button any more', () => {
    for (const f of MIGRATED) {
      const src = stripComments(read(f));
      // The bespoke shape every one of these forms used before the shell was an
      // inline dashed-orange add button (labelled "Add Line Item" or "Add
      // another item"). The dashed style now lives ONLY in AddLineButton's CSS
      // module, so no migrated form should carry it inline any more —
      // label-agnostic, so it also catches a revert to the old wording.
      expect(src, f).not.toMatch(/1px dashed var\(--c-orange\)/);
      expect(src, f).not.toMatch(/>\s*(\+ )?Add (Line Item|another item|another line)\s*</);
    }
  });
});
