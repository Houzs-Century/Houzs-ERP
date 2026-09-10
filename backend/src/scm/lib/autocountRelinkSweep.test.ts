// The hands-free sweep that clears the keyless CONVERSION backlog. These tests
// pin the two things a live account book cannot take back:
//   • it writes NOTHING in 'plan' — no key stamped, no edit queued;
//   • in 'apply' it queues a keyed edit ONLY when the run finished the keying,
//     and NEVER for a document a line of which it could not match.
// The book read and enqueueEdit are mocked at the module boundary: the point
// here is the WIRING and the guards, not the host transport or the composer.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let bookLines: Array<{ DtlKey: number; ItemCode: string; Desc2?: string | null }> = [];
let currentSb: unknown;
const enqueueEditMock = vi.fn(async (_sb: unknown, _opts: Record<string, unknown>) => true);

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => currentSb }));
vi.mock('../../services/autocount-host-read', () => ({
  callAcRead: vi.fn(async () => ({ ok: true, body: { lines: bookLines } })),
}));
vi.mock('./autocount-outbox', () => ({
  enqueueEdit: (sb: unknown, opts: Record<string, unknown>) => enqueueEditMock(sb, opts),
}));

const { fakeSb } = await import('./fake-postgrest');
const { relinkHeldBackSweep } = await import('./autocount-relink-sweep');

type Row = Record<string, unknown>;
const env = {} as Parameters<typeof relinkHeldBackSweep>[0];

function setup(flag: string, tables: Record<string, Row[]>) {
  currentSb = fakeSb({
    app_config: flag ? [{ key: 'scm.autocount_relink_sweep', value: flag }] : [],
    ...tables,
  }, {});
  return currentSb as ReturnType<typeof fakeSb>;
}

/* A keyless delivery order the book holds under HC-DO-2609-020, three lines. */
function keylessDo(overrides: { erpLines?: Row[] } = {}) {
  return {
    autocount_outbox: [{
      id: 'ob-1', company_id: 1, op: 'edit', doc_type: 'DO',
      doc_no: 'do-uuid-1', doc_id: 'do-uuid-1', status: 'skipped', archived_at: null,
      last_error: 'refused, nothing sent (KeylessLineError): DO HC-DO-2609-020: 3 of 3 line(s) carry no AutoCount DtlKey',
      created_at: '2026-09-10T00:00:00.000Z',
    }],
    delivery_orders: [{ id: 'do-uuid-1', company_id: 1, linked_ac_docno: 'HC-DO-2609-020' }],
    delivery_order_items: overrides.erpLines ?? [
      { id: 'l1', company_id: 1, delivery_order_id: 'do-uuid-1', item_code: '9028-2A(LHF)', description2: null, linked_ac_dtlkey: null },
      { id: 'l2', company_id: 1, delivery_order_id: 'do-uuid-1', item_code: '9028-L(RHF)', description2: null, linked_ac_dtlkey: null },
      { id: 'l3', company_id: 1, delivery_order_id: 'do-uuid-1', item_code: '9028-1NA', description2: null, linked_ac_dtlkey: null },
    ],
  };
}

beforeEach(() => { bookLines = []; enqueueEditMock.mockClear(); enqueueEditMock.mockResolvedValue(true); });

describe('relink sweep — the switch', () => {
  it('is a NO-OP when the flag is absent: nothing read, nothing queued', async () => {
    setup('', keylessDo());
    const r = await relinkHeldBackSweep(env);
    expect(r.mode).toBe('off');
    expect(r.scanned).toBe(0);
    expect(enqueueEditMock).not.toHaveBeenCalled();
  });

  it("only picks the 'keyless-line' class, not other skips", async () => {
    const t = keylessDo();
    t.autocount_outbox[0].last_error = "refused, nothing sent (Desc2TooLongError): a line's Further Description is over 100";
    setup('apply', t);
    const r = await relinkHeldBackSweep(env);
    expect(r.scanned).toBe(0);
    expect(enqueueEditMock).not.toHaveBeenCalled();
  });
});

describe('relink sweep — plan mode writes nothing', () => {
  it('reports would-stamp and would-enqueue but stamps no key and queues no edit', async () => {
    bookLines = [
      { DtlKey: 5001, ItemCode: '9028-2A(LHF)', Desc2: null },
      { DtlKey: 5002, ItemCode: '9028-L(RHF)', Desc2: null },
      { DtlKey: 5003, ItemCode: '9028-1NA', Desc2: null },
    ];
    const app = setup('plan', keylessDo());
    const r = await relinkHeldBackSweep(env);

    expect(r.mode).toBe('plan');
    expect(r.docs[0].wouldStamp).toBe(3);
    expect(r.docs[0].wouldEnqueue).toBe(true);
    expect(r.linesStamped).toBe(0);
    expect(enqueueEditMock).not.toHaveBeenCalled();
    // the rows are untouched
    const after = await app.from('delivery_order_items').select('linked_ac_dtlkey').eq('id', 'l1').maybeSingle();
    expect(after.data.linked_ac_dtlkey).toBeNull();
  });
});

describe('relink sweep — apply mode', () => {
  it('stamps every key and queues ONE keyed edit when the run finishes the keying', async () => {
    bookLines = [
      { DtlKey: 5001, ItemCode: '9028-2A(LHF)', Desc2: null },
      { DtlKey: 5002, ItemCode: '9028-L(RHF)', Desc2: null },
      { DtlKey: 5003, ItemCode: '9028-1NA', Desc2: null },
    ];
    const app = setup('apply', keylessDo());
    const r = await relinkHeldBackSweep(env);

    expect(r.linesStamped).toBe(3);
    expect(r.docsEnqueued).toBe(1);
    expect(enqueueEditMock).toHaveBeenCalledTimes(1);
    expect(enqueueEditMock.mock.calls[0][1]).toMatchObject({ companyId: 1, docType: 'DO', docId: 'do-uuid-1' });
    const l1 = await app.from('delivery_order_items').select('linked_ac_dtlkey').eq('id', 'l1').maybeSingle();
    expect(Number(l1.data.linked_ac_dtlkey)).toBe(5001);
  });

  it('does NOT queue an edit when a line cannot be matched — refuses, leaves it keyless', async () => {
    /* Two book lines share a code with no Desc2 to separate them, and two ERP
       lines share it too: planLineRelink refuses both, so a key is left blank
       and the document is never handed to enqueueEdit. */
    bookLines = [
      { DtlKey: 6001, ItemCode: 'HOK-2008(A) (K)', Desc2: null },
      { DtlKey: 6002, ItemCode: 'HOK-2008(A) (K)', Desc2: null },
    ];
    const app = setup('apply', keylessDo({ erpLines: [
      { id: 'l1', company_id: 1, delivery_order_id: 'do-uuid-1', item_code: 'HOK-2008(A) (K)', description2: null, linked_ac_dtlkey: null },
      { id: 'l2', company_id: 1, delivery_order_id: 'do-uuid-1', item_code: 'HOK-2008(A) (K)', description2: null, linked_ac_dtlkey: null },
    ] }));
    const r = await relinkHeldBackSweep(env);

    expect(r.docsEnqueued).toBe(0);
    expect(enqueueEditMock).not.toHaveBeenCalled();
    expect(r.docs[0].refused.length).toBe(2);
    const l1 = await app.from('delivery_order_items').select('linked_ac_dtlkey').eq('id', 'l1').maybeSingle();
    expect(l1.data.linked_ac_dtlkey).toBeNull();
  });

  it('does NOT re-queue a document already fully keyed (stamped 0 this run)', async () => {
    bookLines = [{ DtlKey: 7001, ItemCode: 'NK-1046 (Q)', Desc2: null }];
    setup('apply', keylessDo({ erpLines: [
      { id: 'l1', company_id: 1, delivery_order_id: 'do-uuid-1', item_code: 'NK-1046 (Q)', description2: null, linked_ac_dtlkey: 7001 },
    ] }));
    const r = await relinkHeldBackSweep(env);
    expect(r.linesStamped).toBe(0);
    expect(r.docsEnqueued).toBe(0);
    expect(enqueueEditMock).not.toHaveBeenCalled();
  });
});
