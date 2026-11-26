import { describe, expect, test } from 'vitest';
import {
  capVerdict,
  qtyCapRefusal,
  QTY_CAP_CHECK_FAILED,
  QTY_EXCEEDS_REMAINING,
} from './qty-cap';

function fakeSb(rowsById: Record<string, Record<string, unknown>>) {
  return {
    from() {
      let wanted: string | null = null;
      const b: Record<string, unknown> = {
        select() { return b; },
        eq(_col: string, val: unknown) { wanted = String(val); return b; },
        maybeSingle() {
          return Promise.resolve({ data: wanted !== null ? (rowsById[wanted] ?? null) : null, error: null });
        },
      };
      return b;
    },
  } as never;
}

function brokenSb(message = 'connection reset') {
  return {
    from() {
      const b: Record<string, unknown> = {
        select() { return b; },
        eq() { return b; },
        maybeSingle() { return Promise.resolve({ data: null, error: { message } }); },
      };
      return b;
    },
  } as never;
}

describe('capVerdict — the arithmetic, with no database in it', () => {
  test('a request inside the headroom passes', () => {
    expect(capVerdict({ requested: 3, cap: 10, drawn: 4 })).toBeNull();
  });

  test('an exact fit passes — the cap is a ceiling, not a margin', () => {
    expect(capVerdict({ requested: 6, cap: 10, drawn: 4 })).toBeNull();
  });

  test('one over refuses, and names the remaining the operator can act on', () => {
    expect(capVerdict({ requested: 7, cap: 10, drawn: 4 }))
      .toEqual({ error: QTY_EXCEEDS_REMAINING, requested: 7, remaining: 6 });
  });

  test('a fully drawn line refuses any further request', () => {
    expect(capVerdict({ requested: 1, cap: 10, drawn: 10 })?.remaining).toBe(0);
  });

  test('an edit is compared against what it would become, not against itself twice', () => {
    expect(capVerdict({ requested: 4, cap: 10, drawn: 4, ownPriorDraw: 4 })).toBeNull();
    expect(capVerdict({ requested: 10, cap: 10, drawn: 4, ownPriorDraw: 4 })).toBeNull();
    expect(capVerdict({ requested: 11, cap: 10, drawn: 4, ownPriorDraw: 4 })?.remaining).toBe(10);
  });

  test('several drawn columns sum — the over-invoice cap nets returns too', () => {
    expect(capVerdict({ requested: 5, cap: 10, drawn: 3 + 2 })).toBeNull();
    expect(capVerdict({ requested: 6, cap: 10, drawn: 3 + 2 })?.remaining).toBe(5);
  });
});

describe('qtyCapRefusal — reading the capping row', () => {
  const sb = fakeSb({ 'poi-1': { qty: 10, received_qty: 4 } });

  test('within cap: no refusal', async () => {
    expect(await qtyCapRefusal(sb, {
      table: 'purchase_order_items', id: 'poi-1',
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: 6, what: 'PO line',
    })).toBeNull();
  });

  test('over cap: the existing 409 body, unchanged', async () => {
    expect(await qtyCapRefusal(sb, {
      table: 'purchase_order_items', id: 'poi-1',
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: 7, what: 'PO line',
    })).toEqual({ error: 'qty_exceeds_remaining', requested: 7, remaining: 6 });
  });

  test('a genuinely missing capping row stays uncapped', async () => {
    expect(await qtyCapRefusal(sb, {
      table: 'purchase_order_items', id: 'no-such-line',
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: 9999, what: 'PO line',
    })).toBeNull();
  });

  test('a non-numeric stored value counts as zero rather than poisoning the compare with NaN', async () => {
    const junk = fakeSb({ 'poi-x': { qty: 'ten', received_qty: null } });
    expect(await qtyCapRefusal(junk, {
      table: 'purchase_order_items', id: 'poi-x',
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: 1, what: 'PO line',
    })).toEqual({ error: QTY_EXCEEDS_REMAINING, requested: 1, remaining: 0 });
  });
});

describe('a read that failed is not an absence', () => {
  test('an unreadable cap refuses, with its own code — not qty_exceeds_remaining', async () => {
    const refusal = await qtyCapRefusal(brokenSb(), {
      table: 'purchase_order_items', id: 'poi-1',
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: 3, what: 'PO line',
    });
    expect(refusal).not.toBeNull();
    expect(refusal?.error).toBe(QTY_CAP_CHECK_FAILED);
  });

  test('it names the row it could not read and the reason, and offers the retry', async () => {
    const refusal = await qtyCapRefusal(brokenSb('statement timeout'), {
      table: 'grn_items', id: 'gi-1',
      capColumn: 'qty_accepted', drawnColumns: ['invoiced_qty', 'returned_qty'],
      requested: 3, what: 'GRN line',
    });
    expect(refusal).toMatchObject({ error: QTY_CAP_CHECK_FAILED, requested: 3 });
    const message = (refusal as { message: string }).message;
    expect(message).toContain('GRN line');
    expect(message).toContain('statement timeout');
    expect(message).toContain('try again');
  });

  test('the check-failed refusal carries NO remaining number', async () => {
    const refusal = await qtyCapRefusal(brokenSb(), {
      table: 'grn_items', id: 'gi-1',
      capColumn: 'qty_accepted', drawnColumns: ['returned_qty'],
      requested: 3, what: 'GRN line',
    });
    expect(refusal).not.toHaveProperty('remaining');
  });

  test('an unreadable cap refuses even when the request is trivially small', async () => {
    expect((await qtyCapRefusal(brokenSb(), {
      table: 'purchase_consignment_order_items', id: 'pcoi-1',
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: 1, what: 'PC Order line',
    }))?.error).toBe(QTY_CAP_CHECK_FAILED);
  });
});

describe('qtyCapRefusal — extraDrawn (units outside the drawn columns)', () => {
  const sb = fakeSb({ g1: { qty_accepted: 2, returned_qty: 0 } });
  const args = { table: 'grn_items', id: 'g1', capColumn: 'qty_accepted', drawnColumns: ['returned_qty'], what: 'GRN line' };

  test('extraDrawn shrinks the headroom', async () => {
    expect(await qtyCapRefusal(sb, { ...args, requested: 2, extraDrawn: 1 }))
      .toMatchObject({ error: QTY_EXCEEDS_REMAINING, remaining: 1 });
    expect(await qtyCapRefusal(sb, { ...args, requested: 1, extraDrawn: 1 })).toBeNull();
  });

  test('omitted extraDrawn changes nothing', async () => {
    expect(await qtyCapRefusal(sb, { ...args, requested: 2 })).toBeNull();
  });
});
