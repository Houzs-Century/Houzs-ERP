// ----------------------------------------------------------------------------
// A DELIVERY DOCUMENT MAY NOT INVENT A SOFA'S LEG HEIGHT.
//
// Nico, 2026-09-08, on HC-SO-012565 after the sofa was repaired, its stock
// opened and its lines flipped READY: 「还是不能转换」. The Delivery Order form
// answered "Stock not enough at the selected warehouse — 8030-2A(LHF) need 1,
// available 0" for a sofa standing at BALAKONG under that order's own batch.
//
// The leg height is part of the STOCK BUCKET. computeVariantKey emits
// `legheight=` for a sofa (shared/variant-key.ts), and SoLineCard's heal effect
// auto-filled a blank one with the maintenance "Default" option (owner
// 2026-07-13, a SALES-ORDER convenience so the field is never empty). On a
// delivery order that turns the line into a different bucket from the goods
// reserved for it:
//
//   lot   fabriccode=bo315-31|seatheight=26|special=...              qty 1
//   line  fabriccode=bo315-31|seatheight=26|legheight=default|...    available 0
//
// It is not only a block. HC-DO-2609-004, -009 and -011 were shipped through
// that dialog on 2026-09-08 and their OUT movements consumed no lot at all
// (inventory_lot_consumptions 0, cost 0) — the sofas are still on the books.
// docs/bugs/0722.
//
// Read from source, like po-line-card-photos.test.ts: the assertion is about
// which SURFACES may seed, which is exactly what went wrong, and a render test
// of one card cannot see what the other ten call sites decided. The compiler
// already enforces that the prop is PASSED (it is mandatory, no default); this
// pins the VALUE each document chose.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
const page = (f: string) => read(`../../../pages/scm-v2/${f}`);

const CARD = read('./SoLineCard.tsx');

/** A document that SPECIFIES the sofa. The key it writes is the one the
 *  purchase order — and then the lot — inherits, so seeding is consistent all
 *  the way down. */
const MAY_SEED = [
  'SalesOrderNew.tsx',
  'SalesOrderDetail.tsx',
  'ConsignmentOrderNew.tsx',
  'ConsignmentOrderDetail.tsx',
];

/** A document that FULFILS one. The goods were keyed when they were bought;
 *  anything added here can only disagree with them. */
const MAY_NOT_SEED = [
  'DeliveryOrderNewV2.tsx',
  'DeliveryReturnNew.tsx',
  'ConsignmentNoteNew.tsx',
  'ConsignmentNoteDetail.tsx',
  'ConsignmentReturnNew.tsx',
  'ConsignmentReturnDetail.tsx',
  'SalesInvoiceNew.tsx',
];

const renderCount = (src: string) => (src.match(/<SoLineCard\b/g) ?? []).length;
const seedProps = (src: string) => src.match(/seedSofaLegDefault=\{(true|false)\}/g) ?? [];

describe('the sofa Leg Height default is a per-document decision', () => {
  test('the card gates the seed on the prop, not on the category alone', () => {
    expect(CARD).toContain('seedSofaLegDefault: boolean;');
    expect(CARD).toMatch(/if \(seedSofaLegDefault && category === 'sofa'/);
    // No default value: a caller that says nothing must not compile.
    expect(CARD).not.toMatch(/seedSofaLegDefault\s*=\s*(true|false)\s*,/);
  });

  test('the seed re-fires when the answer changes', () => {
    // Without it in the dependency list the effect keeps the first answer, which
    // is the shape of a prop that reads as wired and is not.
    expect(CARD).toMatch(/draft\.itemCode, maint, seedSofaLegDefault\]/);
  });

  for (const f of MAY_SEED) {
    test(`${f} seeds — it specifies the sofa`, () => {
      const src = page(f);
      const props = seedProps(src);
      expect(props.length).toBe(renderCount(src));
      expect(new Set(props)).toEqual(new Set(['seedSofaLegDefault={true}']));
    });
  }

  for (const f of MAY_NOT_SEED) {
    test(`${f} does not seed — it fulfils one`, () => {
      const src = page(f);
      const props = seedProps(src);
      expect(props.length).toBe(renderCount(src));
      expect(new Set(props)).toEqual(new Set(['seedSofaLegDefault={false}']));
    });
  }

  test('every render site in the app is one of the two lists', () => {
    // A twelfth page rendering the card must make this decision explicitly
    // rather than inherit whichever list happened to be edited last.
    const listed = new Set([...MAY_SEED, ...MAY_NOT_SEED]);
    for (const f of listed) expect(renderCount(page(f))).toBeGreaterThan(0);
    const total = [...listed].reduce((n, f) => n + renderCount(page(f)), 0);
    expect(total).toBe(15);
  });
});
