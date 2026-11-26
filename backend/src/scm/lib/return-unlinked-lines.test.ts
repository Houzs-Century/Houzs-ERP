
import { describe, it, expect } from 'vitest';
import {
  unlinkedReturnResponse, findUnlinkedPiLines, unlinkedInvoiceResponse,
  unlinkedCheckFailedResponse,
  type UnlinkedReturnOffender,
} from './return-unlinked-lines';
import piRouterSrc from '../routes/purchase-invoices.ts?raw';

const off = (itemCode: string, qty = 1, parentNo = '2990-DO-2607-017'): UnlinkedReturnOffender =>
  ({ lineRef: '0', itemCode, qty, parentNo });

describe('unlinkedReturnResponse', () => {
  it('names the Delivery Order and the items, for a delivery return', () => {
    const body = unlinkedReturnResponse([off('NTYR-PILLOW'), off('MATTRESS-Q')], 'delivery');
    expect(body.error).toBe('unlinked_do_lines');
    expect(body.parentNo).toBe('2990-DO-2607-017');
    expect(body.message).toContain('Delivery Order 2990-DO-2607-017');
    expect(body.message).toContain('NTYR-PILLOW, MATTRESS-Q');
    expect(body.message).toContain('2 line(s)');
  });

  it('names the Goods Receipt for a purchase return, with its own error code', () => {
    const body = unlinkedReturnResponse([off('FOAM-A', 3, '2990-GRN-2607-001')], 'purchase');
    expect(body.error).toBe('unlinked_grn_lines');
    expect(body.message).toContain('Goods Receipt 2990-GRN-2607-001');
    expect(body.message).toContain('1 line(s)');
  });

  it('de-duplicates the item list but counts LINES', () => {
    const body = unlinkedReturnResponse(
      [off('NTYR-PILLOW'), off('NTYR-PILLOW'), off('MATTRESS-Q')], 'delivery',
    );
    expect(body.message).toContain('3 line(s)');
    expect(body.message).toContain('NTYR-PILLOW, MATTRESS-Q');
    expect(body.offenders).toHaveLength(3);
  });

  it('explains WHY it is refused, not just that it is', () => {
    const body = unlinkedReturnResponse([off('NTYR-PILLOW')], 'delivery');
    expect(body.message).toContain('the same goods can be returned again');
  });
});

/* ── The SIXTH chain: GRN -> Purchase INVOICE (added 2026-08-17) ──────────────
   Five chains closed this door; the invoicing side of the receiving chain never
   did, and `purchase-invoices.ts` contained the word "unlinked" zero times. This
   one bills MONEY rather than moving stock: an unlinked goods line invoices the
   receipt while `grn_items.invoiced_qty` stays put, so a second PI bills the same
   delivery and the supplier is paid twice.

   Two properties are specific to the money chain and each has its own test below,
   because the first version of this guard shipped without either:

     · A purchase invoice is line-level MULTI-RECEIPT (owner 2026-08-06,
       migration 0267). The header's `grn_id` is the primary ref only, so a guard
       fed just that ref lets an unlinked line billing a SECONDARY note's material
       straight through — the refused shape, one note over.
     · It FAILS CLOSED. An empty code set is an unconditional pass, so a swallowed
       read error opened the door in silence. */
describe('findUnlinkedPiLines — the invoicing side of the receiving chain', () => {
  const fakeSb = (
    receipts: Record<string, { no: string; codes: string[] }>,
    opts: { error?: { message: string } } = {},
  ) => {
    const calls: Array<{ table: string; col: string; val: unknown }> = [];
    return {
      calls,
      from(table: string) {
        return {
          select() { return this; },
          in(col: string, val: unknown) {
            calls.push({ table, col, val });
            if (opts.error) return Promise.resolve({ data: null, error: opts.error });
            const ids = val as string[];
            const rows = ids.flatMap((id) => (receipts[id]?.codes ?? []).map((item_code) => ({
              item_code, grn_id: id, grn: { grn_number: receipts[id]!.no },
            })));
            return Promise.resolve({ data: rows, error: null });
          },
        };
      },
    };
  };

  const one = { 'grn-1': { no: 'GRN-2608-001', codes: ['FOAM-A', 'FABRIC-B'] } };

  const line = (itemCode: string, grnItemId: string | null, qty = 1, lineRef = '0') =>
    ({ lineRef, itemCode, qty, soItemId: grnItemId });

  const offendersOf = (v: Awaited<ReturnType<typeof findUnlinkedPiLines>>) => {
    expect(v.ok).toBe(true);
    return v.ok ? v.offenders : [];
  };

  it('REFUSES an unlinked line billing a material that IS on the named GRN', async () => {
    const sb = fakeSb(one);
    const out = offendersOf(await findUnlinkedPiLines(sb, ['grn-1'], [line('FOAM-A', null, 4)]));
    expect(out).toHaveLength(1);
    expect(out[0]!.itemCode).toBe('FOAM-A');
    expect(out[0]!.parentNo).toBe('GRN-2608-001');
    expect(sb.calls).toEqual([{ table: 'grn_items', col: 'grn_id', val: ['grn-1'] }]);
  });

  it('ALLOWS a PI-native service line — the reason grn_item_id is nullable', async () => {
    const sb = fakeSb(one);
    expect(offendersOf(await findUnlinkedPiLines(sb, ['grn-1'], [line('FREIGHT', null, 1)]))).toEqual([]);
  });

  it('ALLOWS a LINKED line for the same material — the cap already sees it', async () => {
    const sb = fakeSb(one);
    expect(offendersOf(await findUnlinkedPiLines(sb, ['grn-1'], [line('FOAM-A', 'gi-1', 4)]))).toEqual([]);
  });

  it('ALLOWS everything when the invoice names NO receipt — there is nothing to bypass', async () => {
    const sb = fakeSb(one);
    expect(offendersOf(await findUnlinkedPiLines(sb, [], [line('FOAM-A', null, 4)]))).toEqual([]);
    expect(offendersOf(await findUnlinkedPiLines(sb, [null, '', undefined], [line('FOAM-A', null, 4)]))).toEqual([]);
    expect(sb.calls).toEqual([]);
  });

  it('does not read the receipt at all when every line is already linked', async () => {
    const sb = fakeSb(one);
    await findUnlinkedPiLines(sb, ['grn-1'], [line('FOAM-A', 'gi-1')]);
    expect(sb.calls).toEqual([]);
  });

  it('matches item codes case- and whitespace-insensitively', async () => {
    const sb = fakeSb({ 'grn-1': { no: 'GRN-1', codes: ['foam-a'] } });
    expect(offendersOf(await findUnlinkedPiLines(sb, ['grn-1'], [line('  FOAM-A ', null)]))).toHaveLength(1);
  });

  it('REFUSES a line billing a SECONDARY receipt\'s material, and names that receipt', async () => {
    const sb = fakeSb({
      'grn-1': { no: 'GRN-2608-011', codes: ['FABRIC-KN390'] },
      'grn-2': { no: 'GRN-2608-012', codes: ['FOAM-40D'] },
    });
    const out = offendersOf(await findUnlinkedPiLines(sb, ['grn-1', 'grn-2'], [line('FOAM-40D', null, 20)]));
    expect(out).toHaveLength(1);
    expect(out[0]!.parentNo).toBe('GRN-2608-012');
  });

  it('a line on NONE of the covered receipts still passes', async () => {
    const sb = fakeSb({
      'grn-1': { no: 'GRN-2608-011', codes: ['FABRIC-KN390'] },
      'grn-2': { no: 'GRN-2608-012', codes: ['FOAM-40D'] },
    });
    expect(offendersOf(await findUnlinkedPiLines(sb, ['grn-1', 'grn-2'], [line('DELIVERY-CHARGE', null)]))).toEqual([]);
  });

  it('names each offender against the receipt that carries ITS material', async () => {
    const sb = fakeSb({
      'grn-1': { no: 'GRN-2608-011', codes: ['FABRIC-KN390'] },
      'grn-2': { no: 'GRN-2608-012', codes: ['FOAM-40D'] },
    });
    const out = offendersOf(await findUnlinkedPiLines(sb, ['grn-1', 'grn-2'], [
      line('FABRIC-KN390', null, 30, 'L1'),
      line('FOAM-40D', null, 20, 'L2'),
    ]));
    expect(out.map((o) => [o.lineRef, o.parentNo])).toEqual([
      ['L1', 'GRN-2608-011'], ['L2', 'GRN-2608-012'],
    ]);
  });

  it('a duplicate id is read ONCE — the caller unions a header ref with line refs', async () => {
    const sb = fakeSb(one);
    await findUnlinkedPiLines(sb, ['grn-1', 'grn-1', ' grn-1 '], [line('FOAM-A', null)]);
    expect(sb.calls).toEqual([{ table: 'grn_items', col: 'grn_id', val: ['grn-1'] }]);
  });

  it('FAILS CLOSED when the receipt read errors — never reads as "nothing to find"', async () => {
    const sb = fakeSb(one, { error: { message: 'statement timeout' } });
    const v = await findUnlinkedPiLines(sb, ['grn-1'], [line('FOAM-A', null, 4)]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('statement timeout');
  });

  it('the failure body says the invoice was NOT saved, and why that matters', () => {
    const body = unlinkedCheckFailedResponse('statement timeout');
    expect(body.error).toBe('unlinked_check_failed');
    expect(body.message).toContain('NOT saved');
    expect(body.message).toContain('paid for twice');
  });
});

describe('unlinkedInvoiceResponse', () => {
  it('says the goods get PAID FOR twice — the consequence is money, not stock', () => {
    const body = unlinkedInvoiceResponse([off('FOAM-A', 4, 'GRN-2608-001')]);
    expect(body.error).toBe('unlinked_grn_lines');
    expect(body.message).toContain('Goods Receipt GRN-2608-001');
    expect(body.message).toContain('invoiced and paid for a second time');
    expect(body.message).toContain('1 line(s)');
  });

  it('names EVERY receipt involved when the invoice covers several notes', () => {
    const body = unlinkedInvoiceResponse([
      off('FABRIC-KN390', 30, 'GRN-2608-011'), off('FOAM-40D', 20, 'GRN-2608-012'),
    ]);
    expect(body.receipts).toEqual(['GRN-2608-011', 'GRN-2608-012']);
    expect(body.message).toContain('these Goods Receipts: GRN-2608-011, GRN-2608-012');
  });

  it('points at a route that EXISTS on the screen the refusal fires from', () => {
    const m = unlinkedInvoiceResponse([off('FOAM-A', 1, 'GRN-1')]).message;
    expect(m).toContain('Transfer to Purchase Invoice');
    expect(m).toContain('remove the hand-typed line');
    expect(m).not.toContain('instead of adding them by hand');
  });

  it('tells the operator that unaffected charges are unaffected — QUALIFIED', () => {
    const m = unlinkedInvoiceResponse([off('FOAM-A', 1, 'GRN-1')]).message;
    expect(m).toContain('including a freight or service charge they do not carry');
    expect(m).not.toMatch(/A freight or service line, or any item this receipt does not contain, is unaffected/);
  });
});

describe('the invoice guard is wired into ALL THREE paths that can reach the shape', () => {
  const between = (from: string, to: string) => {
    const a = piRouterSrc.indexOf(from);
    const b = to ? piRouterSrc.indexOf(to, a) : piRouterSrc.length;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    const slice = piRouterSrc.slice(a, b);
    expect(slice.length).toBeGreaterThan(500);
    return slice;
  };

  it('POST / (create, including the ?grnId= draft path)', () => {
    const create = between("purchaseInvoices.post('/', async (c)", "purchaseInvoices.post('/from-grn-items'");
    expect(create).toContain('findUnlinkedPiLines');
    expect(create).toContain('unlinkedInvoiceResponse');
    expect(create).toContain('unlinkedCheckFailedResponse');
  });

  it('POST /:id/items (add a line to an existing invoice)', () => {
    const add = between("purchaseInvoices.post('/:id/items'", "purchaseInvoices.patch('/:id/items/:itemId'");
    expect(add).toContain('findUnlinkedPiLines');
    expect(add).toContain('unlinkedInvoiceResponse');
    expect(add).toContain('unlinkedCheckFailedResponse');
  });

  it('PATCH /:id/items/:itemId (retype an existing line onto a receipt material)', () => {
    const patch = between("purchaseInvoices.patch('/:id/items/:itemId'", "purchaseInvoices.delete('/:id/items/:itemId'");
    expect(patch).toContain('findUnlinkedPiLines');
    expect(patch).toContain('unlinkedInvoiceResponse');
    expect(patch).toContain('unlinkedCheckFailedResponse');
    expect(patch).toContain('it.itemCode ?? prev.item_code');
  });

  it('every path derives the receipt set from the LINES, not the header ref alone', () => {
    for (const [from, to] of [
      ["purchaseInvoices.post('/', async (c)", "purchaseInvoices.post('/from-grn-items'"],
      ["purchaseInvoices.post('/:id/items'", "purchaseInvoices.patch('/:id/items/:itemId'"],
      ["purchaseInvoices.patch('/:id/items/:itemId'", "purchaseInvoices.delete('/:id/items/:itemId'"],
    ] as const) {
      expect(between(from, to)).toContain('coveredGrnIds');
    }
  });

  it('the add-line and edit paths read the parent invoice\'s grn_id, or they have no parent to check', () => {
    expect(piRouterSrc).toContain("select('id, grn_id')");
  });

  it('PATCH /:id/post re-checks the over-invoice cap, counting the draft being confirmed', () => {
    const post = between('export const postPurchaseInvoiceHandler', "purchaseInvoices.patch('/:id/payment'");
    expect(post).toContain('verifyGrnLinesNotOverInvoiced(sb, draftGrnItemIds, id)');
    expect(post).toContain('qty_exceeds_remaining');
    expect(post.indexOf('verifyGrnLinesNotOverInvoiced'))
      .toBeLessThan(post.indexOf("status: 'POSTED', posted_at:"));
  });
});
