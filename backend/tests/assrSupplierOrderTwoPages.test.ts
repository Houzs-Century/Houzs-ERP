/* The Supplier Service Order prints on two pages (client 2026-11-09): page 1
 * carries every fact, page 2 starts with the inspection photos and ends with
 * the sign-off. It used to run to four pages with a blank last one, because
 * the full-height sheet and its filler row pushed out an empty page. No DB in
 * this suite, so the layout is source-anchored. */
import { describe, expect, test } from 'vitest';
import printRaw from '../src/routes/assr_print.ts?raw';

const supplierBlock = printRaw.slice(printRaw.indexOf('// ── Supplier Service Order (design handoff). ──'));

describe('Supplier Service Order layout', () => {
  test('the supplier copy drops the filler row and tfoot that made the blank page', () => {
    expect(printRaw).toMatch(/<body\$\{isSupplier \? ` class="sup"` : ""\}>/);
    expect(printRaw).toMatch(/body\.sup tr\.filler, body\.sup table\.sheet > tfoot \{ display: none; \}/);
    expect(printRaw).toMatch(/body\.sup table\.sheet \{ height: auto; \}/);
  });

  test('page 2 breaks before the inspection photos', () => {
    expect(printRaw).toMatch(/body\.sup \.page-two \{ break-before: page; page-break-before: always; \}/);
    const pageTwo = supplierBlock.indexOf('<div class="page-two">');
    expect(pageTwo).toBeGreaterThan(0);
    expect(supplierBlock.indexOf('Inspection &amp; Evidence')).toBeGreaterThan(pageTwo);
    expect(supplierBlock.indexOf('Acknowledgement &amp; Sign-off')).toBeGreaterThan(pageTwo);
  });

  test('page 1 keeps the facts: dates, supplier, deliver/collect, items, related cases', () => {
    const pageOne = supplierBlock.slice(0, supplierBlock.indexOf('<div class="page-two">'));
    for (const label of [
      'Request Date', 'Reason', 'Previous Return No.', 'Supplier (Creditor)', 'PO Number',
      'Target Completion', 'Deliver / Collect', 'Sent to Supplier', 'Back from Supplier',
      'Delivery Date', '<div class="bar">Items</div>', 'Related Cases',
    ]) {
      expect(pageOne, label).toContain(label);
    }
  });

  test('page 2 shows the inspection summary from the verification step', () => {
    expect(printRaw).toMatch(/getVerificationNotes\(c\.env, id\)/);
    expect(supplierBlock).toMatch(/verified_root_cause/);
    expect(supplierBlock).toMatch(/notes\?\.inspection_findings/);
    expect(supplierBlock).toMatch(/notes\?\.next_action/);
  });
});

describe('Supplier Service Order alignment', () => {
  test('the Next Action row starts its value where the rows above it do', () => {
    expect(printRaw).toMatch(/body\.sup \.mgrid\.cols-2 \{ grid-template-columns: 38mm 1fr; \}/);
    expect(printRaw).toMatch(/body\.sup \.mgrid\.cols-split \{ grid-template-columns: 38mm 1fr 34mm 1fr; \}/);
    expect(printRaw).toMatch(/body\.sup \.mgrid\.cols-4 \{ grid-template-columns: 38mm 1fr 34mm 1fr; \}/);
    expect(supplierBlock).toMatch(/<div class="mgrid cols-split">\s*<div class="lc">Next Action<\/div>/);
  });

  test('NO, SET and CTN are centred in the items table', () => {
    expect(printRaw).toMatch(/\.itable > :nth-child\(1\), \.itable > :nth-child\(3\), \.itable > :nth-child\(4\) \{ text-align: center; \}/);
  });
});

describe('the sign-off box hangs under its bar', () => {
  test('no gap under the Acknowledgement bar and one grey frame', () => {
    expect(printRaw).toMatch(/\.bar \+ \.signoff\.boxed-grid \{ margin-top: 0; \}/);
    expect(printRaw).toMatch(/\.signoff\.boxed-grid \.panel \+ \.panel \{ border-left: 0\.4pt solid #d5d5d5; \}/);
  });
});
