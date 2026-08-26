/* THE PRINTED DOCUMENT MUST SAY WHAT THE SCREEN SAYS.
 *
 * Every one of these nine generators printed the RAW STORED VALUE, title-cased
 * by its own hand-rolled copy of `replace(/_/g,' ').toLowerCase()…`, into the
 * Status field of a document that goes to a customer, a supplier or a
 * storekeeper. The screen has read those states through
 * `status-pill.ts` since 2026-08-21, so paper and screen disagreed on the same
 * document: a delivery order stored `LOADED` printed "Loaded" while every
 * screen called it Confirmed.
 *
 * The 2026-08-26 relabel turned that from an inconsistency into a TRAP.
 * `DISPATCHED` now READS "Loaded", so the word *Loaded* named one state on
 * paper (stored LOADED, screen Confirmed) and a different one on screen
 * (stored DISPATCHED) — a storekeeper holding the sheet against the list would
 * match the wrong row. Pinned by name in the last test below.
 *
 * WHY IT IS SHAPED LIKE THIS. The assertion is on what the generator DREW —
 * `doc.text`, which jspdf-autotable and the DO's status chip both paint
 * through — not on whether it imported a particular helper. A generator that
 * hand-rolls a caser again fails here even if it never touches `status-pill`.
 * Same technique as `pdf-money-layout.test.ts` and `stock-movement-pdf.test.ts`.
 *
 * The vocabulary is ENUMERATED from `statusVocabulary(docType)`, never typed
 * out here: a status added to `status-pill.ts` is covered the day it lands, and
 * a hand-copied list is the exact drift this file exists to stop.
 *
 * Same root as `docs/bugs/0519-the-sales-order-list-printed-a-raw-enum-key-where-a-status-l.md`,
 * whose own entry names the durable fix — "those pages reading their LABEL from
 * status-pill.ts". 0519 did the Sales Order LIST; this is the PRINTED half.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_BRANDING,
  clearBrandingLogoCache,
  setBrandingCache,
} from '../../../lib/branding';

import { statusLabel, statusVocabulary, type StatusDocType } from './status-pill';

type JsPdf = import('jspdf').jsPDF;

/* Every text draw, with the x/y it landed on. x is what tells the right-hand
   detail rail's value apart from a left-column row that happens to share a
   baseline — drawInfoColumns advances both columns by the same 4mm step, so
   sharing a y is normal and reading the wrong one would be silent. */
type TextDraw = { text: string; x: number; y: number };

function captureTextDraws(doc: JsPdf): TextDraw[] {
  const draws: TextDraw[] = [];
  const original = doc.text.bind(doc);
  vi.spyOn(doc, 'text').mockImplementation(((...args: Parameters<typeof doc.text>) => {
    const [value, x, y] = args;
    if (typeof x === 'number' && typeof y === 'number') {
      const lines = Array.isArray(value) ? value.map(String) : [String(value)];
      for (const line of lines) draws.push({ text: line.trim(), x, y });
    }
    return original(...args);
  }) as typeof doc.text);
  return draws;
}

/* The status word this document actually PUT ON PAPER.
 *
 * Both shapes are read here and neither is guessed at: eight generators put the
 * status in drawInfoColumns' right-hand rail, which paints the label at midX
 * and the value as ": <value>" at midX+33 on the SAME baseline; the delivery
 * order paints a chip instead, label then UPPERCASED chip text, also on one
 * baseline. So: find the one "Status" label, take the one draw to its right on
 * that baseline.
 *
 * It THROWS rather than returns a miss. An assertion built on "no status was
 * found" would pass a document that stopped printing its status at all, which
 * is CLAUDE.md's "a verdict computed over nothing must never read as a pass". */
function printedStatus(draws: TextDraw[]): string {
  const labels = draws.filter((d) => d.text === 'Status');
  if (labels.length !== 1) {
    throw new Error(
      `expected exactly ONE "Status" label to be drawn, saw ${labels.length}. `
      + `Drawn: ${draws.map((d) => d.text).join(' | ')}`,
    );
  }
  const label = labels[0];
  const right = draws.filter((d) => d.y === label.y && d.x > label.x && d.text.length > 0);
  if (right.length !== 1) {
    throw new Error(
      `expected exactly ONE value drawn to the right of "Status" on its baseline, saw `
      + `${right.length}: ${right.map((d) => `${d.text}@${d.x}`).join(' | ')}`,
    );
  }
  const raw = right[0].text;
  return raw.startsWith(':') ? raw.slice(1).trim() : raw;
}

/* Ordinary ASCII, no variants, no supplier id: no CJK font fetch, no logo
   fetch, and every fabric / supplier-binding loader early-returns an empty map
   without a request. These renders touch no network. */
const setUpBranding = () => setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* One entry per PRINTED document that states a status. `render` takes the
   stored value and returns what the generator drew for it.

   NOT in this table, each for a reason: `po` — purchase-order-pdf.ts accepts
   header.status and draws no Status row at all, a supplier's order sheet states
   no internal state; `pv`, `dpOrder`, `soAmendment*`, `poAmendment` — no
   generator of their own. All of them are still covered by the source scan at
   the bottom of this file. */
type PrintedDoc = {
  docType: StatusDocType;
  title: string;
  /** The delivery order paints its status into an UPPERCASE pill; every other
   *  document prints the label as written. Set here so the comparison stays
   *  EXACT for the eight — an .toUpperCase() on both sides to accommodate the
   *  one chip would have hidden `Ready To Ship` against the screen's
   *  `Ready to Ship`, which is a real mismatch of this same class. */
  uppercaseChip?: true;
  render: (status: string) => Promise<string>;
};

async function newDoc() {
  setUpBranding();
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  return { doc, autoTable, draws: captureTextDraws(doc) };
}

const PRINTED_DOCS: PrintedDoc[] = [
  {
    docType: 'do',
    title: 'Delivery Order',
    uppercaseChip: true,
    render: async (status) => {
      const { doc, autoTable, draws } = await newDoc();
      const { renderDeliveryOrderInto } = await import('./delivery-order-pdf');
      await renderDeliveryOrderInto(doc, autoTable, {
        do_number: 'HC-DO-2608-001', status, do_date: '2026-08-20',
        so_doc_no: 'HC-SO-2608-001', debtor_code: 'C-1', debtor_name: 'Test Sdn Bhd',
        expected_delivery_at: '2026-08-22', dispatched_at: null, signed_at: null,
        delivered_at: null, driver_name: null, vehicle: null,
        address1: '1 Jalan Test', address2: null, city: 'Seri Kembangan',
        state: 'Selangor', postcode: '43300', phone: null, notes: null,
        m3_total_milli: null,
      }, [
        { item_code: 'DO-A', description: 'Bedframe', qty: 1, m3_milli: null, unit_price_sen: 0 },
      ]);
      return printedStatus(draws);
    },
  },
  {
    docType: 'dr',
    title: 'Delivery Return',
    render: async (status) => {
      const { doc, autoTable, draws } = await newDoc();
      const { renderDeliveryReturnInto } = await import('./delivery-return-pdf');
      await renderDeliveryReturnInto(doc, autoTable, {
        return_number: 'HC-DR-2608-001', status, return_date: '2026-08-20',
        debtor_code: 'C-1', debtor_name: 'Test Sdn Bhd', reason: null,
        refund_sen: 0, notes: null, delivery_order_id: null, sales_invoice_id: null,
      }, [
        { item_code: 'DR-A', description: 'Bedframe', qty_returned: 1, condition: null, unit_price_sen: 0, refund_sen: 0 },
      ]);
      return printedStatus(draws);
    },
  },
  {
    docType: 'grn',
    title: 'Goods Received Note',
    render: async (status) => {
      const { doc, autoTable, draws } = await newDoc();
      const { renderGrnInto } = await import('./grn-pdf');
      await renderGrnInto(doc, autoTable, {
        grn_number: 'HC-GRN-2608-001', status, received_at: '2026-08-20',
        delivery_note_ref: null, notes: null, posted_at: null, supplier_id: null,
        supplier: { code: 'S-1', name: 'Supplier Sdn Bhd' },
      }, [
        { item_code: 'GR-A', material_name: 'Foam', qty_received: 1, qty_accepted: 1, qty_rejected: 0, rejection_reason: null, unit_price_sen: 0, supplier_sku: 'S-A' },
      ]);
      return printedStatus(draws);
    },
  },
  {
    docType: 'pi',
    title: 'Purchase Invoice',
    render: async (status) => {
      const { doc, autoTable, draws } = await newDoc();
      const { renderPurchaseInvoiceInto } = await import('./purchase-invoice-pdf');
      await renderPurchaseInvoiceInto(doc, autoTable, {
        invoice_number: 'HC-PI-2608-001', supplier_invoice_ref: null, status,
        invoice_date: '2026-08-20', due_date: null, currency: 'MYR',
        subtotal_sen: 0, tax_sen: 0, total_sen: 0, paid_sen: 0, notes: null,
        supplier_id: null, supplier: { code: 'S-1', name: 'Supplier Sdn Bhd' },
      }, [
        { item_code: 'PI-A', material_name: 'Foam', qty: 1, unit_price_sen: 0, line_total_sen: 0, supplier_sku: 'S-A' },
      ]);
      return printedStatus(draws);
    },
  },
  {
    docType: 'pr',
    title: 'Purchase Return',
    render: async (status) => {
      const { doc, autoTable, draws } = await newDoc();
      const { renderPurchaseReturnInto } = await import('./purchase-return-pdf');
      await renderPurchaseReturnInto(doc, autoTable, {
        return_number: 'HC-PR-2608-001', status, return_date: '2026-08-20',
        reason: null, refund_sen: 0, credit_note_ref: null, notes: null,
        supplier_id: null, supplier: { code: 'S-1', name: 'Supplier Sdn Bhd' },
      }, [
        { item_code: 'PR-A', material_name: 'Foam', qty_returned: 1, unit_price_sen: 0, line_refund_sen: 0, reason: null, supplier_sku: 'S-A' },
      ]);
      return printedStatus(draws);
    },
  },
  {
    docType: 'si',
    title: 'Sales Invoice',
    render: async (status) => {
      const { doc, autoTable, draws } = await newDoc();
      const { renderSalesInvoiceInto } = await import('./sales-invoice-pdf');
      await renderSalesInvoiceInto(doc, autoTable, {
        invoice_number: 'HC-SI-2608-001', status, so_doc_no: 'HC-SO-2608-001',
        debtor_code: 'C-1', debtor_name: 'Test Sdn Bhd', invoice_date: '2026-08-20',
        due_date: null, currency: 'MYR', subtotal_sen: 0, discount_sen: 0,
        tax_sen: 0, total_sen: 0, paid_sen: 0, notes: null,
        address1: '1 Jalan Test', city: 'Seri Kembangan', state: 'Selangor', postcode: '43300',
      }, [
        { item_code: 'SI-A', description: 'Bedframe', qty: 1, unit_price_sen: 0, line_total_sen: 0 },
      ]);
      return printedStatus(draws);
    },
  },
  {
    docType: 'so',
    title: 'Sales Order',
    render: async (status) => {
      const { doc, autoTable, draws } = await newDoc();
      const { renderSalesOrderInto } = await import('./sales-order-pdf');
      await renderSalesOrderInto(doc, autoTable, {
        doc_no: 'HC-SO-2608-001', so_date: '2026-08-20', status,
        debtor_code: 'C-1', debtor_name: 'Test Sdn Bhd', agent: null,
        branding: null, venue: null, ref: null, po_doc_no: null, phone: null,
        address1: '1 Jalan Test', address2: null, address3: null, address4: null,
        mattress_sofa_sen: 0, bedframe_sen: 0, accessories_sen: 0, others_sen: 0,
        local_total_sen: 0, line_count: 1, currency: 'MYR', note: null, paid_sen_total: 0,
      }, [
        { id: 'i-1', item_group: 'BEDFRAME', item_code: 'SO-A', description: 'Bedframe', uom: 'UNIT', qty: 1, unit_price_sen: 0, discount_sen: 0, total_sen: 0, variants: null },
      ]);
      return printedStatus(draws);
    },
  },
  {
    docType: 'stockTake',
    title: 'Stock Take',
    render: async (status) => {
      const { doc, autoTable, draws } = await newDoc();
      const { renderStockTakeInto } = await import('./stock-take-pdf');
      await renderStockTakeInto(doc, autoTable, {
        take_no: 'HC-STK-2608-001', status, take_date: '2026-08-20',
        scope_type: 'WAREHOUSE', scope_value: null, notes: null,
        posted_at: null, cancelled_at: null,
      }, [
        { item_code: 'STK-A', product_name: 'Bedframe', system_qty: 1, counted_qty: 1, variance: 0 },
      ]);
      return printedStatus(draws);
    },
  },
  {
    docType: 'stockTransfer',
    title: 'Stock Transfer',
    render: async (status) => {
      const { doc, autoTable, draws } = await newDoc();
      const { renderStockTransferInto } = await import('./stock-transfer-pdf');
      await renderStockTransferInto(doc, autoTable, {
        transfer_no: 'HC-ST-2608-001', status, transfer_date: '2026-08-20',
        notes: null, posted_at: null, cancelled_at: null,
        from_warehouse_id: null, to_warehouse_id: null,
        from_warehouse: { code: 'WH-BLK', name: 'Balakong' },
        to_warehouse: { code: 'WH-KL', name: 'KL' },
      }, [
        { item_code: 'ST-A', product_name: 'Bedframe', qty: 1, notes: null, variant_key: '' },
      ]);
      return printedStatus(draws);
    },
  },
];

describe('the harness itself', () => {
  /* THE ENUMERATION MUST NOT BE EMPTY. Every assertion below is a for-loop over
     statusVocabulary(); if that ever returned [] the whole file would pass
     having compared nothing. */
  test('every printed document has a non-empty vocabulary to check', () => {
    expect(PRINTED_DOCS.length).toBe(9);
    for (const d of PRINTED_DOCS) {
      expect(statusVocabulary(d.docType).length, d.title).toBeGreaterThan(1);
    }
  });

  /* The reader must be able to FAIL. If printedStatus() silently returned the
     label instead of the drawn value, every assertion here would be
     tautological. Feeding it a status the maps do not carry proves it is
     reading paper: an unmapped key prints humanised, and the check below sees
     that humanised word rather than anything statusLabel decided in advance. */
  test('printedStatus reads the drawn word, not the expected one', async () => {
    const printed = await PRINTED_DOCS[0].render('SOME_LEGACY_VALUE');
    expect(printed).toBe('SOME LEGACY VALUE');
  });
});

describe('a printed document states the status the screen states', () => {
  /* `do` is skipped while the owner's 2026-08-26 revert stands — the Delivery
     Order sheet prints its STORED value again, at his request, and the test
     that pins that is above. Skipping it HERE rather than deleting this loop
     keeps every other document held to the rule, so the revert cannot quietly
     become the new normal. Undo the revert and delete this filter together. */
  for (const d of PRINTED_DOCS.filter((x) => x.docType !== 'do')) {
    for (const status of statusVocabulary(d.docType)) {
      test(`${d.title}: stored ${status}`, async () => {
        const printed = await d.render(status);
        const canonical = statusLabel(d.docType, status);
        const expected = d.uppercaseChip ? canonical.toUpperCase() : canonical;
        expect(printed).toBe(expected);
      });
    }
  }
});

describe('the delivery order trap the owner was holding', () => {
  /* THE WHOLE POINT, by name. Since 2026-08-26 stored DISPATCHED READS "Loaded"
     (docs/modules/document-status-vocabulary.md §1). Before this fix the sheet
     printed LOADED for stored LOADED — the state every screen calls Confirmed —
     so the word "Loaded" named two different rungs at once. */
  /* REVERTED 2026-08-26, DELIBERATELY, at the owner's request: he asked to see
     the previous printed Delivery Order again before deciding, so this ONE
     generator went back to title-casing its stored value.

     THE TRAP IS THEREFORE BACK, and this test now pins it so nobody mistakes it
     for an oversight: the sheet prints LOADED for the state every screen calls
     "Confirmed", while "Loaded" is what the screen calls stored DISPATCHED. One
     word, two rungs, depending on whether you are reading paper or a screen.

     The other eight documents keep the fix. Undoing the revert is one import
     and one expression in delivery-order-pdf.ts. */
  test('the DO sheet prints its STORED value again — the trap is back on purpose', async () => {
    const doPdf = PRINTED_DOCS.find((d) => d.docType === 'do')!;
    expect(await doPdf.render('LOADED')).toBe('LOADED');
    expect(await doPdf.render('DISPATCHED')).toBe('DISPATCHED');
  });

  /* The confirm step reads Confirmed on ALL of them (owner 2026-08-21, 「那就
     A」). Five stored words, one printed word — the sweep that reached every
     screen and stopped at the paper. */
  test('every document\'s confirm step prints Confirmed', async () => {
    /* `do` is ABSENT on purpose — reverted 2026-08-26 at the owner's request;
       see the test above. Every other printed document still reads Confirmed. */
    const CONFIRM_STEP: Array<[StatusDocType, string]> = [
      ['grn', 'POSTED'], ['pi', 'POSTED'], ['pr', 'POSTED'],
      ['si', 'SENT'], ['so', 'CONFIRMED'],
      ['stockTake', 'POSTED'], ['stockTransfer', 'POSTED'],
    ];
    for (const [docType, stored] of CONFIRM_STEP) {
      const d = PRINTED_DOCS.find((x) => x.docType === docType)!;
      expect((await d.render(stored)).toUpperCase(), `${d.title} ${stored}`).toBe('CONFIRMED');
    }
  });
});

/* The nine renders above cover the nine documents that exist TODAY. The scan
   below covers the tenth, which is the one that will drift: a generator written
   next month, for a document type nobody has added to the table, hand-rolling
   the caser again because that is what every neighbour file did. It reads the
   sources, so it fails on a file that has no test of its own yet. */
describe('no PDF generator hand-rolls a status label', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const GENERATORS = readdirSync(HERE)
    .filter((f) => f.endsWith('-pdf.ts') && !f.endsWith('.test.ts'))
    .sort();

  /* A `.status` fed through `replace(/_/g,' ')…`, or through a file-local
     titleCase(), on one line or spread over several. */
  const HAND_ROLLED = [
    /\.status[^;]{0,80}?replace\(\/_\/g/s,
    /titleCase\(\s*[A-Za-z_$][\w$]*\.status/s,
  ];

  /* THE MATCHER SELF-TESTS. This is an assertion of ABSENCE across nine files:
     a pattern that had quietly stopped matching would report every generator
     clean for ever and nobody would know. The positives are the exact lines
     this change removed; the negatives are what a fixed generator legitimately
     contains. CLAUDE.md: "a checker that cannot match reports a clean run". */
  test('the matcher fires on the code this change removed', () => {
    const REMOVED = [
      `  const statusText = header.status.replace(/_/g, ' ').toLowerCase().replace(/\\b\\w/g, (c) => c.toUpperCase());`,
      `      value: header.status\n        ? header.status.replace(/_/g, ' ').toLowerCase().replace(/\\b\\w/g, (c) => c.toUpperCase())\n        : null,`,
      `        ['Status', titleCase(header.status)],`,
    ];
    for (const line of REMOVED) {
      expect(HAND_ROLLED.some((re) => re.test(line)), line).toBe(true);
    }
  });

  test('the matcher does not fire on what a fixed generator contains', () => {
    for (const line of [
      `  const statusText = statusLabel('grn', header.status);`,
      `        ['Status', statusLabel('stockTake', header.status)],`,
      `  const label = (f: string) => f.replace(/_/g, ' ');`,
    ]) {
      expect(HAND_ROLLED.some((re) => re.test(line)), line).toBe(false);
    }
  });

  /* `delivery-order-pdf.ts` is EXEMPT while the owner's revert stands — it is
     the one generator that hand-rolls again, on purpose. Every other one must
     stay clean, so a tenth generator written tomorrow is still caught. */
  test('every other generator in this directory is clean', () => {
    expect(GENERATORS.length).toBeGreaterThan(9);
    for (const file of GENERATORS.filter((f) => f !== 'delivery-order-pdf.ts')) {
      const src = readFileSync(join(HERE, file), 'utf8');
      for (const re of HAND_ROLLED) {
        expect(re.test(src), `${file} hand-rolls a status label — use statusLabel(docType, status)`).toBe(false);
      }
    }
  });
});
