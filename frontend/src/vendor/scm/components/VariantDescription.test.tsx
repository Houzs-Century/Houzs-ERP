/* The variant summary is a FIELD, and a field says its name.
 *
 * Owner 2026-08-21, looking at the PO → GRN transfer picker: 「看不到
 * description 2 的?」. The string was there — `PC151-12 / SEAT 28 / LEG DEFAULT`
 * under each line — but it rendered as a bare grey line while every field
 * beside it carried a label, so it read as decoration and the owner could not
 * find the field he was looking for.
 *
 * This is a LABELLING test, not a coverage one: buildVariantSummary and its
 * backend reads are already covered and were not touched. What it pins is that
 * the label exists, that it is the word the rest of the system uses, and that
 * putting it on does not swallow the summary itself.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DESCRIPTION_2_LABEL, VariantDescription } from './VariantDescription';

afterEach(cleanup);

const SOFA = { fabricCode: 'PC151-12', seatHeight: '28"', legHeight: 'DEFAULT' };

describe('the variant summary carries its label', () => {
  test('the label is exactly the word the rest of the system uses', () => {
    /* Not a third name for this string. The desktop SO line editor's own
       column header is the authority; so-audit-labels.ts is the machine-readable
       copy of it that this test can read without mounting an 8,000-line page. */
    const labels = readFileSync(
      resolve(process.cwd(), 'src/pages/scm-v2/so-audit-labels.ts'),
      'utf8',
    );
    expect(labels).toContain(`description2: '${DESCRIPTION_2_LABEL}'`);
    expect(DESCRIPTION_2_LABEL).toBe('Description 2');
  });

  test('a line with variants renders the label AND the summary', () => {
    render(
      <VariantDescription
        itemCode="9028-1A(LHF)"
        itemGroup="sofa"
        variants={SOFA}
        description={null}
      />,
    );
    expect(screen.getByText(DESCRIPTION_2_LABEL)).toBeTruthy();
    /* The summary must stay ONE findable string. Gluing the label into the same
       text node would make this row read as "Description 2PC151-12 / …" to
       anything matching on text — including convertPickerVariants.test.tsx,
       which is the existing referee for these pickers. */
    expect(screen.getByText('PC151-12 / SEAT 28" / LEG DEFAULT')).toBeTruthy();
  });

  test('a line with no variants is still a labelled field, reading Standard', () => {
    render(
      <VariantDescription itemCode="ACC-01" itemGroup="accessory" variants={null} description={null} />,
    );
    expect(screen.getByText(DESCRIPTION_2_LABEL)).toBeTruthy();
    expect(screen.getByText('Standard')).toBeTruthy();
  });

  test('the stored description still renders above it, unlabelled and unchanged', () => {
    render(
      <VariantDescription
        itemCode="9028-1A(LHF)"
        itemGroup="sofa"
        variants={SOFA}
        description="9028 SOFA"
      />,
    );
    expect(screen.getByText('9028 SOFA')).toBeTruthy();
    expect(screen.getByText(DESCRIPTION_2_LABEL)).toBeTruthy();
  });
});

/* ── every transfer picker gets it from here ────────────────────────────────
   The label lives on the shared component precisely so no picker has to
   remember it. These assert the wiring is still shared — remove a picker's
   import and the failure names that file. */
describe('the transfer pickers render through the shared component', () => {
  const PICKERS = [
    'src/pages/scm-v2/ConsignmentNoteFromOrder.tsx',
    'src/pages/scm-v2/ConsignmentReturnFromNote.tsx',
    'src/pages/scm-v2/DeliveryOrderFromSo.tsx',
    'src/pages/scm-v2/DeliveryReturnFromDo.tsx',
    'src/pages/scm-v2/GrnFromPo.tsx',
    'src/pages/scm-v2/PurchaseConsignmentReceiveFromOrder.tsx',
    'src/pages/scm-v2/PurchaseConsignmentReturnFromReceive.tsx',
    'src/pages/scm-v2/PurchaseInvoiceFromGrn.tsx',
    'src/pages/scm-v2/PurchaseOrderFromSo.tsx',
    'src/pages/scm-v2/SalesInvoiceFromDo.tsx',
  ];

  for (const p of PICKERS) {
    test(`${p} uses VariantDescription`, () => {
      const src = readFileSync(resolve(process.cwd(), p), 'utf8');
      expect(src).toContain('VariantDescription');
    });
  }

  test('the mobile convert wizard uses the same WORD, spelled its own way', () => {
    /* Desktop and mobile are one product: the phone's convert wizard renders
       the identical buildVariantSummary string and had the identical bare-line
       problem. It labels fields "Label: value" ("Supplier SKU:" sits two lines
       below), so the presentation differs and the word does not. */
    const src = readFileSync(resolve(process.cwd(), 'src/mobile/MobileConvertWizard.tsx'), 'utf8');
    expect(src).toContain('DESCRIPTION_2_LABEL');
    expect(
      /Description 2['"]/.test(src),
      'MobileConvertWizard has re-grown a hand-typed "Description 2"',
    ).toBe(false);
  });
});
