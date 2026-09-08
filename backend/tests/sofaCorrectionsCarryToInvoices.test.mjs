import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* WHY THIS TEST READS SOURCE. The property being pinned is that a rule is
   APPLIED AT A CALL SITE, and a call-site population is exactly what a unit
   test cannot see — the same reason docs/bugs/0672's guards are pinned this
   way. The rule itself (which side of a disagreement is stale) is behavioural
   and lives in invoiceSnapshotRepair.test.mjs.

   THE DEFECT. apply-sofa-compartment-corrections.mjs rewrites a sofa line from
   its `-1S` placeholder to the owner-approved compartments and then carries the
   new code down the chain, with a comment that states the reason exactly:
   "All three took a SNAPSHOT of the code and variants when they were created
   (create-migrated-documents.mjs), so correcting the parent alone would leave
   them stating the old build."

   A migrated INVOICE line took the same snapshot from the same rows —
   create-migrated-invoices.mjs copies `l._row.item_code` at :305 and :345 —
   and the carry named purchase_order_items, grn_items and
   delivery_order_items and stopped there. Four invoice lines in production are
   still quoting the pre-correction placeholder because of it. */

const SRC = readFileSync(join(__dirname, '..', 'scripts', 'apply-sofa-compartment-corrections.mjs'), 'utf8');
const CREATE = readFileSync(join(__dirname, '..', 'scripts', 'create-migrated-invoices.mjs'), 'utf8');

describe('the sofa compartment correction carries down to the documents that snapshotted it', () => {
  it('a migrated invoice line really is a snapshot of its parent — that is what licenses the carry', () => {
    expect(CREATE).toMatch(/grn_item_id: l\._row\.id[\s\S]{0,200}item_code: l\._row\.item_code/);
    expect(CREATE).toMatch(/do_item_id: l\._row\.id[\s\S]{0,200}item_code: l\._row\.item_code/);
  });

  it('carries the corrected code onto the purchase invoice raised from the receipt', () => {
    expect(SRC).toMatch(/UPDATE scm\.purchase_invoice_items/);
  });

  it('carries the corrected code onto the sales invoice raised from the delivery order', () => {
    expect(SRC).toMatch(/UPDATE scm\.sales_invoice_items/);
  });

  it('touches an invoice only while it is migrated paperwork, the same assertion the GRN and DO carry rest on', () => {
    const pi = SRC.slice(SRC.indexOf('UPDATE scm.purchase_invoice_items'));
    const si = SRC.slice(SRC.indexOf('UPDATE scm.sales_invoice_items'));
    expect(pi.slice(0, 600)).toMatch(/migrated_no_stock/);
    expect(si.slice(0, 600)).toMatch(/migrated_no_stock/);
  });

  it('reports the invoice lines it carried, so a run that silently carried none is visible', () => {
    expect(SRC).toMatch(/purchase invoice line|PI lines|invoice lines/i);
    expect(SRC).toMatch(/nPi/);
    expect(SRC).toMatch(/nSi/);
  });
});
