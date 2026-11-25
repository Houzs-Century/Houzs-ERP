/* HC-0258: the Stock Take category picker and the Inventory chips were typed
   lists of 5, so Sofa Accessory / Bedlines / Dining / Diffuser / Carpet could not
   be counted or filtered. Both must read the shared category list instead. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe.each(['StockTakeNew.tsx', 'Inventory.tsx'])('%s category list', (file) => {
  const src = read(file);

  it('is built from MFG_PRODUCT_CATEGORIES', () => {
    expect(src).toMatch(/MFG_PRODUCT_CATEGORIES\.map\(/);
  });

  it('types no category option by hand', () => {
    expect(src).not.toMatch(/\{\s*value:\s*'(SOFA|BEDFRAME|MATTRESS|ACCESSORY|SERVICE)'/);
  });
});
