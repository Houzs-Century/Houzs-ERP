// ----------------------------------------------------------------------------
// The SO list and the SO detail must emit the SAME two shipping figures.
//
// A WIRING pin. The numbers were already summed on both surfaces — only the
// none/partial/full verdict was ever emitted, so the Delivered column had
// nothing to render. The risk now is one surface being changed and not the
// other, which no unit test over either could see.
//
// It also pins that the fields are NOT named delivery_*: `delivery_state` is
// already two different things in this system (the stored scheduling override
// on mfg_sales_orders, and the computed shipping verdict that shadows it on the
// response), and there are two exported types called `DeliveryState`. A third
// meaning under that prefix is how the next reader picks the wrong one.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import routes from '../src/scm/routes/mfg-sales-orders.ts?raw';

const SRC = routes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the shipping figures are emitted on both surfaces', () => {
  test('the LIST emits both numbers beside its verdict', () => {
    expect(SRC).toMatch(/\.shipped_qty = dDelivered;/);
    expect(SRC).toMatch(/\.deliverable_qty = dDelivered \+ dRemaining;/);
  });

  test('the DETAIL emits both, from its own totals', () => {
    expect(SRC).toMatch(/\.shipped_qty = totalDelivered;/);
    expect(SRC).toMatch(/\.deliverable_qty = totalDelivered \+ totalRemaining;/);
  });

  test('exactly two surfaces set them — a third would need its own totals', () => {
    expect(SRC.match(/\.shipped_qty = /g) ?? []).toHaveLength(2);
    expect(SRC.match(/\.deliverable_qty = /g) ?? []).toHaveLength(2);
  });

  /* `deliverable` is shipped + still owed, so it can only be built from the
     pair. A `qty` summed off the order lines instead would count cancelled
     lines and quietly overstate what the customer is owed. */
  test('deliverable is built from the PAIR, never from a raw line quantity', () => {
    expect(SRC).not.toMatch(/deliverable_qty = [a-zA-Z]*[Qq]ty\b/);
  });

  test('the new fields do NOT reuse the overloaded delivery_ prefix', () => {
    expect(SRC).not.toMatch(/\.delivery_shipped|\.delivery_progress|\.delivery_qty/);
  });
});
