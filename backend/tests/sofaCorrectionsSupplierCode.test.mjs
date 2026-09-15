import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* WHY THIS TEST READS SOURCE. The property is that a rule is APPLIED AT A CALL
   SITE — every place the applier moves a purchase line's item_code — and a
   call-site population is what a unit test cannot see. The rule itself (which
   token moves, and when a column disagrees) is behavioural and lives in
   sofaPieceToken.test.mjs. Same shape as sofaCorrectionsCarryToInvoices.test.mjs.

   THE DEFECT (docs/bugs/0894). docs/bugs/0822 taught the applier to move the
   supplier code with the item code, and it did — on the DOWNSTREAM-document path
   only. The main sales-order / purchase-order path moved `item_code` and the
   printed name and left `supplier_sku` (what the factory builds from) stating
   the old piece; and a purchase piece the applier ADDED was inserted with no
   supplier code at all, which the shown-vs-code sweep cannot repair because an
   empty column is not a disagreement. Found applying the owner's HC-PO-010086
   build (8030-2S -> 1A(LHF)+1A(RHF), supplier_sku "HOK-5540 SOFA 2S"). */

const SRC = readFileSync(join(__dirname, '..', 'scripts', 'apply-sofa-compartment-corrections.mjs'), 'utf8');

/** The main-path INSERT into purchase_order_items, up to its RETURNING. */
const poInsert = () => {
  const m = SRC.match(/INSERT INTO scm\.purchase_order_items[\s\S]*?RETURNING id/);
  expect(m, 'the main-path purchase-line INSERT').toBeTruthy();
  return m[0];
};

describe('apply-sofa-compartment-corrections: the supplier code follows the piece', () => {
  it('an added purchase piece copies the supplier code of the row it is built from', () => {
    const ins = poInsert();
    expect(ins).toMatch(/\bsupplier_sku\b/);
    expect(ins).toMatch(/\bi\.supplier_sku\b/);
  });

  it('the added purchase piece is aligned to its own piece after the insert', () => {
    expect(SRC).toMatch(/RETURNING id`;[\s\S]{0,900}?alignPieceColumns\(tx, "scm\.purchase_order_items", ins\.id/);
  });

  it('an updated purchase line is aligned inside the same transaction', () => {
    expect(SRC).toMatch(/UPDATE scm\.purchase_order_items SET item_code = \$\{p\.to\}[\s\S]{0,800}?alignPieceColumns\(tx, "scm\.purchase_order_items", p\.id/);
  });

  it('a purchase line that follows its sales piece is aligned too', () => {
    expect(SRC).toMatch(/WHERE so_item_id = \$\{t\.id\} RETURNING id`;[\s\S]{0,700}?alignPieceColumns\(sql, "scm\.purchase_order_items", r\.id/);
  });

  it('the fresh-connection verify reads the supplier code on a purchase line', () => {
    expect(SRC).toMatch(/i\.supplier_sku, i\.material_name\s+FROM scm\.purchase_order_items/);
    expect(SRC).toMatch(/disagrees\(r\.code, r\.supplier_sku\)/);
  });
});
