/* Owner decision 2026-11-10: a shipped DO line keeps the product and spec it
 * shipped as. 2990-DO-2611-016 shipped as BF-01 Gap 12 Divan 8 Leg 4; opening the
 * edit form added Total 24 (the card computes it), the save moved the line into a
 * bucket no stock carries, and the line then traced to no PO. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { shippedDoSpecRefusal } from '../src/scm/lib/do-spec-lock-check';
import { DO_SPEC_LOCKED_ERROR, doSpecLocked } from '../src/scm/shared/do-spec-lock';

const SHIPPED_LINE = {
  item_code: 'CODY-(K)', item_group: 'bedframe',
  variants: { fabricCode: 'BF-01', gap: '12"', divanHeight: '8"', legHeight: '4"' },
};

describe('shippedDoSpecRefusal', () => {
  test('DO-016: adding Total 24 to a shipped bedframe line is refused with what to do instead', () => {
    const r = shippedDoSpecRefusal('LOADED', SHIPPED_LINE, { qty: 1, variants: { ...SHIPPED_LINE.variants, totalHeight: '24"' } });
    expect(r?.error).toBe(DO_SPEC_LOCKED_ERROR);
    expect(r?.message).toMatch(/Delivery Return/);
    expect(r?.message).toMatch(/Quantity and remarks can still be edited/);
  });

  test('a fabric change or a product change is refused', () => {
    expect(shippedDoSpecRefusal('DELIVERED', SHIPPED_LINE, { variants: { ...SHIPPED_LINE.variants, fabricCode: 'BF-14' } })).not.toBeNull();
    expect(shippedDoSpecRefusal('DISPATCHED', SHIPPED_LINE, { itemCode: 'CODY-(Q)' })).not.toBeNull();
  });

  test('a qty or remark edit, or the same spec re-sent, is allowed', () => {
    expect(shippedDoSpecRefusal('LOADED', SHIPPED_LINE, { qty: 2, remark: 'call first' })).toBeNull();
    expect(shippedDoSpecRefusal('LOADED', SHIPPED_LINE, {
      itemCode: 'CODY-(K)', itemGroup: 'BEDFRAME', variants: { ...SHIPPED_LINE.variants, summary: 'King · BF-01' },
    })).toBeNull();
  });

  test('a draft or cancelled DO is not locked', () => {
    expect(shippedDoSpecRefusal('DRAFT', SHIPPED_LINE, { variants: { fabricCode: 'BF-14' } })).toBeNull();
    expect(doSpecLocked('CANCELLED')).toBe(false);
    expect(doSpecLocked('loaded')).toBe(true);
  });
});

describe('the line PATCH asks before it touches anything', () => {
  const route = readFileSync(join(__dirname, '../src/scm/routes/delivery-orders-mfg.ts'), 'utf8');
  const handler = route.slice(route.indexOf("deliveryOrdersMfg.patch('/:id/items/:itemId'"));
  test('the refusal runs right after the line is read, before the SKU group is rewritten', () => {
    const at = handler.indexOf('shippedDoSpecRefusal(');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(handler.indexOf('resolveItemGroups('));
    expect(handler.slice(at, at + 200)).toMatch(/if \(specLock\) return c\.json\(specLock, 409\)/);
  });
});

describe('the rule is one file on both sides', () => {
  test('backend and frontend copies are byte-identical', () => {
    const norm = (p: string) => readFileSync(join(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
    expect(norm('../../frontend/src/vendor/shared/do-spec-lock.ts')).toBe(norm('../src/scm/shared/do-spec-lock.ts'));
  });
});
