import { describe, expect, test, vi } from 'vitest';
import {
  hardenSoPoLinks,
  pickPoLineToHarden,
  type PoLineCandidate,
  type SoftMatch,
} from './harden-so-po-link';

/* Turning the SOFT MRP allocation into a HARD so_item_id is a WRITE on somebody
   else's document, so every refusal matters as much as the happy path. */

const SO = 'so-line-1';
const OTHER_SO = 'so-line-2';

const line = (over: Partial<PoLineCandidate> = {}): PoLineCandidate => ({
  id: 'poi-1',
  material_code: 'TRION-(K)',
  qty: 3,
  received_qty: 0,
  so_item_id: null,
  created_at: '2026-07-01T00:00:00Z',
  ...over,
});

describe('pickPoLineToHarden', () => {
  test('one free matching line -> hardened', () => {
    expect(pickPoLineToHarden(SO, 'TRION-(K)', [line()]))
      .toEqual({ poItemId: 'poi-1', reason: 'hardened' });
  });

  test('already pointing at THIS SO line -> idempotent no-op', () => {
    expect(pickPoLineToHarden(SO, 'TRION-(K)', [line({ so_item_id: SO })]))
      .toEqual({ poItemId: 'poi-1', reason: 'already_linked' });
  });

  test('the only matching line belongs to ANOTHER SO -> refused, never stolen', () => {
    expect(pickPoLineToHarden(SO, 'TRION-(K)', [line({ so_item_id: OTHER_SO })]))
      .toEqual({ poItemId: null, reason: 'taken_by_other_so' });
  });

  test('matching line fully received -> nothing incoming to bind', () => {
    expect(pickPoLineToHarden(SO, 'TRION-(K)', [line({ qty: 3, received_qty: 3 })]))
      .toEqual({ poItemId: null, reason: 'no_open_qty' });
  });

  test('PO carries no line for this SKU -> no_matching_line', () => {
    // MRP matches on a pooled (warehouse, code, variant) bucket, so its PO can
    // legitimately turn out to carry a different SKU once you look at the lines.
    expect(pickPoLineToHarden(SO, 'TRION-(K)', [line({ material_code: 'KETTA-(K)' })]))
      .toEqual({ poItemId: null, reason: 'no_matching_line' });
  });

  test('SKU match ignores case and surrounding space, but never matches blank', () => {
    expect(pickPoLineToHarden(SO, ' trion-(k) ', [line()]).reason).toBe('hardened');
    expect(pickPoLineToHarden(SO, '', [line({ material_code: '' })]).reason).toBe('no_matching_line');
  });

  test('two free lines of the same SKU on ONE PO -> deterministic oldest-first, NOT a refusal', () => {
    // The choice that must never be guessed is WHICH PO (the PO number IS the
    // batch number). Within one PO both candidates give the same batch, so the
    // outcome is identical either way and refusing would block a real shape.
    const pick = pickPoLineToHarden(SO, 'TRION-(K)', [
      line({ id: 'newer', created_at: '2026-07-09T00:00:00Z' }),
      line({ id: 'older', created_at: '2026-07-02T00:00:00Z' }),
    ]);
    expect(pick).toEqual({ poItemId: 'older', reason: 'hardened' });
  });

  test('an already-mine line wins over a free one (idempotent re-ship)', () => {
    const pick = pickPoLineToHarden(SO, 'TRION-(K)', [
      line({ id: 'free' }),
      line({ id: 'mine', so_item_id: SO }),
    ]);
    expect(pick).toEqual({ poItemId: 'mine', reason: 'already_linked' });
  });

  test("another SO's line is skipped in favour of a free one", () => {
    const pick = pickPoLineToHarden(SO, 'TRION-(K)', [
      line({ id: 'theirs', so_item_id: OTHER_SO, created_at: '2026-07-01T00:00:00Z' }),
      line({ id: 'free', created_at: '2026-07-05T00:00:00Z' }),
    ]);
    expect(pick).toEqual({ poItemId: 'free', reason: 'hardened' });
  });
});

/* A tiny PostgREST-shaped fake, carrying exactly the calls this module makes. */
function fakeSb(opts: {
  pos: Array<{ id: string; po_number: string; status: string }>;
  lines: Array<PoLineCandidate & { purchase_order_id: string }>;
  onUpdate?: (id: string, soItemId: string) => void;
  updateFails?: boolean;
}) {
  return {
    from(table: string) {
      if (table === 'purchase_orders') {
        return { select: () => ({ in: async () => ({ data: opts.pos, error: null }) }) };
      }
      if (table === 'purchase_order_items') {
        return {
          select: () => ({ in: async () => ({ data: opts.lines, error: null }) }),
          update: (patch: { so_item_id: string }) => ({
            eq: (_c: string, id: string) => ({
              is: async () => {
                if (opts.updateFails) return { error: { message: 'conflict' } };
                const row = opts.lines.find((l) => l.id === id);
                if (row) row.so_item_id = patch.so_item_id;
                opts.onUpdate?.(id, patch.so_item_id);
                return { error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const match = (over: Partial<SoftMatch> = {}): SoftMatch =>
  ({ soItemId: SO, itemCode: 'TRION-(K)', poNumber: '2990-PO-2607-009', ...over });

describe('hardenSoPoLinks', () => {
  test('writes the link, reports it, and audits once', async () => {
    const writes: Array<[string, string]> = [];
    const sb = fakeSb({
      pos: [{ id: 'po-1', po_number: '2990-PO-2607-009', status: 'SUBMITTED' }],
      lines: [{ ...line(), purchase_order_id: 'po-1' }],
      onUpdate: (id, so) => writes.push([id, so]),
    });
    const audit = vi.fn();
    const out = await hardenSoPoLinks(sb, [match()], audit);
    expect(out).toEqual([{ ...match(), hardened: true, poId: 'po-1', poItemId: 'poi-1', reason: 'hardened' }]);
    expect(writes).toEqual([['poi-1', SO]]);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  test('a DEAD PO is never bound — H1, the batch would never arrive', async () => {
    for (const status of ['CANCELLED', 'DRAFT']) {
      const sb = fakeSb({
        pos: [{ id: 'po-1', po_number: '2990-PO-2607-009', status }],
        lines: [{ ...line(), purchase_order_id: 'po-1' }],
      });
      const out = await hardenSoPoLinks(sb, [match()]);
      expect(out[0]).toMatchObject({ hardened: false, reason: 'po_not_live' });
    }
  });

  test('never clobbers another SO line, and writes nothing', async () => {
    const writes: Array<[string, string]> = [];
    const sb = fakeSb({
      pos: [{ id: 'po-1', po_number: '2990-PO-2607-009', status: 'SUBMITTED' }],
      lines: [{ ...line({ so_item_id: OTHER_SO }), purchase_order_id: 'po-1' }],
      onUpdate: (id, so) => writes.push([id, so]),
    });
    const out = await hardenSoPoLinks(sb, [match()]);
    expect(out[0]).toMatchObject({ hardened: false, reason: 'taken_by_other_so' });
    expect(writes).toEqual([]);
  });

  test('idempotent — re-running does not write again and still reports bound', async () => {
    const writes: Array<[string, string]> = [];
    const rows = [{ ...line(), purchase_order_id: 'po-1' }];
    const sb = fakeSb({
      pos: [{ id: 'po-1', po_number: '2990-PO-2607-009', status: 'SUBMITTED' }],
      lines: rows,
      onUpdate: (id, so) => writes.push([id, so]),
    });
    await hardenSoPoLinks(sb, [match()]);
    const second = await hardenSoPoLinks(sb, [match()]);
    expect(second[0]).toMatchObject({ hardened: true, reason: 'already_linked' });
    expect(writes).toHaveLength(1);
  });

  test('two lines of one DO naming the same PO cannot both claim one PO line', async () => {
    const sb = fakeSb({
      pos: [{ id: 'po-1', po_number: '2990-PO-2607-009', status: 'SUBMITTED' }],
      lines: [{ ...line({ id: 'only-one' }), purchase_order_id: 'po-1' }],
    });
    const out = await hardenSoPoLinks(sb, [match(), match({ soItemId: OTHER_SO })]);
    expect(out[0]).toMatchObject({ hardened: true, poItemId: 'only-one' });
    // The second sees the first's stamp, so it is refused rather than stealing it.
    expect(out[1]).toMatchObject({ hardened: false, reason: 'taken_by_other_so' });
  });

  test('a lost write race is reported, never assumed to have succeeded', async () => {
    const sb = fakeSb({
      pos: [{ id: 'po-1', po_number: '2990-PO-2607-009', status: 'SUBMITTED' }],
      lines: [{ ...line(), purchase_order_id: 'po-1' }],
      updateFails: true,
    });
    const out = await hardenSoPoLinks(sb, [match()]);
    expect(out[0]).toMatchObject({ hardened: false, reason: 'taken_by_other_so' });
  });

  test('an audit failure never un-does the binding', async () => {
    const sb = fakeSb({
      pos: [{ id: 'po-1', po_number: '2990-PO-2607-009', status: 'SUBMITTED' }],
      lines: [{ ...line(), purchase_order_id: 'po-1' }],
    });
    const out = await hardenSoPoLinks(sb, [match()], () => { throw new Error('audit down'); });
    expect(out[0]).toMatchObject({ hardened: true, reason: 'hardened' });
  });

  test('no matches -> no reads, no writes', async () => {
    const out = await hardenSoPoLinks({ from() { throw new Error('should not read'); } }, []);
    expect(out).toEqual([]);
  });
});
