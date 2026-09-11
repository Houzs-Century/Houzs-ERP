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
/* The cutover map, per test. Keyed by UPPERCASED ERP code, as bindingsFor is. */
let bindingsMock = new Map<string, string>();

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => currentSb }));
vi.mock('../../services/autocount-host-read', () => ({
  callAcRead: vi.fn(async () => ({ ok: true, body: { lines: bookLines } })),
}));
vi.mock('./autocount-outbox', () => ({
  enqueueEdit: (sb: unknown, opts: Record<string, unknown>) => enqueueEditMock(sb, opts),
  /* The sweep resolves each ERP code to the book's spelling before matching
     (docs/bugs/0816). These fixtures are already written in the book's
     spelling, so an empty binding map is the honest stand-in: it exercises the
     resolver's fallback, which is what a code with no binding really gets. */
  bindingsFor: async () => bindingsMock,
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

beforeEach(() => {
  bindingsMock = new Map<string, string>(); bookLines = []; enqueueEditMock.mockClear(); enqueueEditMock.mockResolvedValue(true); });

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

/* THE RUN HAS TO BE READABLE BY A PERSON (docs/bugs/0815).
 *
 * This sweep reads and writes a LIVE account book and its only output was a
 * console.log in a Worker log this account's token cannot read (`wrangler tail`
 * is DENIED for it). It was run in `apply` three times on 2026-09-11, stamped
 * ZERO keys every time, and the cause could not be established at all — the
 * reason was guessed at twice and the guess was wrong twice. The refusals it
 * already computes are the answer; they just had nowhere to go.
 */
describe('the sweep writes its run down', () => {
  it('records counts AND the per-document refusals', async () => {
    /* The book has none of this document's item codes, so every line refuses —
       exactly the shape that produced an unexplained "stamped 0". */
    bookLines = [{ DtlKey: 9001, ItemCode: 'SOMETHING-ELSE', Desc2: null }];
    const sb = setup('plan', keylessDo());

    await relinkHeldBackSweep(env);

    const saved = (sb.tables.app_config as Row[])
      .find((r) => r.key === 'scm.autocount_relink_sweep_last_run');
    expect(saved, 'the sweep recorded nothing').toBeTruthy();

    const run = JSON.parse(String(saved!.value));
    expect(run.mode).toBe('plan');
    expect(run.scanned).toBe(1);
    expect(run.linesStamped).toBe(0);
    /* The part nobody could see: WHY it was zero. */
    expect(run.docs).toHaveLength(1);
    expect(run.docs[0].keylessBefore).toBeGreaterThan(0);
    expect(run.docs[0].refused.join(' ')).toContain('no unclaimed line with that item code');
  });

  /* A candidate read that fails used to look exactly like a quiet day: both
     returned scanned 0 and said nothing at all. */
  it('a failed candidate read is recorded, not silent', async () => {
    /* `missing` is fakeSb's second argument: asking for a column the table does
       not have fails the WHOLE query with 42703, which is the real edge this
       fake exists to reproduce. The sweep selects last_error. */
    currentSb = fakeSb(
      { app_config: [{ key: 'scm.autocount_relink_sweep', value: 'plan' }], autocount_outbox: [] },
      { autocount_outbox: ['last_error'] },
    );

    await relinkHeldBackSweep(env);

    const saved = ((currentSb as ReturnType<typeof fakeSb>).tables.app_config as Row[])
      .find((r) => r.key === 'scm.autocount_relink_sweep_last_run');
    expect(saved, 'a failed candidate read recorded nothing').toBeTruthy();
    expect(JSON.parse(String(saved!.value)).docs[0].skipped).toContain('candidate read failed');
  });
});

/* THE CAUSE THE FIRST READABLE SWEEP REPORT NAMED (docs/bugs/0816).
 *
 * composeEdit resolves every ERP code through the cutover bindings before
 * sending it, so the book holds `AK-ARMOUR MATT (SK)` where the ERP holds
 * `AKEMI ARMOUR MATT (SK)`. The sweep matched on the RAW code, so it compared
 * our spelling against theirs and refused EVERY line of EVERY document a
 * supplier spells differently — "the account book has no unclaimed line with
 * that item code", on all 13 documents, which is exactly what the sweep said
 * the moment it could say anything at all.
 */
describe('a code the book spells differently', () => {
  it('matches once the ERP code is resolved the way the write-back sends it', async () => {
    bindingsMock = new Map([['AKEMI ARMOUR MATT (SK)', 'AK-ARMOUR MATT (SK)']]);
    bookLines = [{ DtlKey: 4101, ItemCode: 'AK-ARMOUR MATT (SK)', Desc2: null }];
    const sb = setup('plan', keylessDo({
      erpLines: [{
        id: 'l1', company_id: 1, delivery_order_id: 'do-uuid-1',
        item_code: 'AKEMI ARMOUR MATT (SK)', description2: null, linked_ac_dtlkey: null,
      }],
    }));

    await relinkHeldBackSweep(env);

    const run = JSON.parse(String((sb.tables.app_config as Row[])
      .find((r) => r.key === 'scm.autocount_relink_sweep_last_run')!.value));
    expect(run.docs[0].refused, run.docs[0].refused?.join(' ')).toEqual([]);
    expect(run.docs[0].wouldStamp).toBe(1);
  });

  /* FAIL-CLOSED IS KEPT. The resolver has two sources — the live bindings and
     the cutover CSV index — so a missing binding is not the same as an
     unresolvable code (the first draft of this test assumed it was, and the
     code was right). A code NEITHER source knows falls back to the raw one and
     refuses, exactly as before. */
  it('a code neither source knows still refuses rather than guessing', async () => {
    bindingsMock = new Map();
    bookLines = [{ DtlKey: 4101, ItemCode: 'AK-ARMOUR MATT (SK)', Desc2: null }];
    const sb = setup('plan', keylessDo({
      erpLines: [{
        id: 'l1', company_id: 1, delivery_order_id: 'do-uuid-1',
        item_code: 'ZZ-NOTHING-KNOWS-THIS (Q)', description2: null, linked_ac_dtlkey: null,
      }],
    }));

    await relinkHeldBackSweep(env);

    const run = JSON.parse(String((sb.tables.app_config as Row[])
      .find((r) => r.key === 'scm.autocount_relink_sweep_last_run')!.value));
    expect(run.docs[0].wouldStamp).toBe(0);
    expect(run.docs[0].refused.join(' ')).toContain('no unclaimed line with that item code');
  });
});

/* THE LINE THE BOOK NEVER HAD (docs/bugs/0817).
 *
 * Nine goods receipts stood at "1 of 2 matched" and could not move: the mattress
 * matched and the free pillow refused, because the book's copy of the receipt
 * has no pillow line at all. AcSyncService names the exit in its own refusal —
 * "Store the line's AutoCount DtlKey ... or mark the line IsNewLine" — and
 * enqueueEdit has carried newLineIds since 0588; this path never used it.
 *
 * The bar is high on purpose: this SDK gives DeleteDetail to SalesOrder alone,
 * so a duplicate appended to a receipt or a purchase order is permanent.
 */
describe('declaring the line the book never had', () => {
  const twoLines = (pillowCode: string) => keylessDo({
    erpLines: [
      { id: 'matt', company_id: 1, delivery_order_id: 'do-uuid-1', item_code: 'AK-ARMOUR MATT (SK)', description2: null, linked_ac_dtlkey: null },
      { id: 'pillow', company_id: 1, delivery_order_id: 'do-uuid-1', item_code: pillowCode, description2: null, linked_ac_dtlkey: null },
    ],
  });

  it('queues the edit with the absent row named, once everything else is keyed', async () => {
    bookLines = [{ DtlKey: 5001, ItemCode: 'AK-ARMOUR MATT (SK)', Desc2: null }];
    setup('apply', twoLines('AK-SLEEP ESSENTIAL 7 HOLES'));

    await relinkHeldBackSweep(env);

    expect(enqueueEditMock).toHaveBeenCalledTimes(1);
    expect(enqueueEditMock.mock.calls[0][1]).toMatchObject({ newLineIds: ['pillow'] });
  });

  /* THE TRAP. The book HAS a pillow line; the mattress row is what is missing,
     so "everything else keyed" does not hold and nothing may be declared. */
  it('declares nothing while another line is still unmatched for a different reason', async () => {
    bookLines = [
      { DtlKey: 6001, ItemCode: 'AK-SLEEP ESSENTIAL 7 HOLES', Desc2: null },
      { DtlKey: 6002, ItemCode: 'AK-SLEEP ESSENTIAL 7 HOLES', Desc2: null },
    ];
    setup('apply', keylessDo({
      erpLines: [
        { id: 'p1', company_id: 1, delivery_order_id: 'do-uuid-1', item_code: 'AK-SLEEP ESSENTIAL 7 HOLES', description2: null, linked_ac_dtlkey: null },
        { id: 'p2', company_id: 1, delivery_order_id: 'do-uuid-1', item_code: 'AK-SLEEP ESSENTIAL 7 HOLES', description2: null, linked_ac_dtlkey: null },
      ],
    }));

    await relinkHeldBackSweep(env);

    expect(enqueueEditMock).not.toHaveBeenCalled();
  });

  /* A document where NOTHING matched has proved nothing about itself, so its
     unmatched lines are not evidence that the book lacks them. */
  it('declares nothing when this run stamped no key at all', async () => {
    bookLines = [];
    setup('apply', twoLines('AK-SLEEP ESSENTIAL 7 HOLES'));

    await relinkHeldBackSweep(env);

    expect(enqueueEditMock).not.toHaveBeenCalled();
  });
});

/* THE VERDICT, RECORDED (docs/bugs/0819). "1 matched" was the same two words for
   a document about to be released and one still stuck. */
describe('the run says whether each document moves', () => {
  it('records wouldEnqueue in plan when the absent row can be declared', async () => {
    bookLines = [{ DtlKey: 5001, ItemCode: 'AK-ARMOUR MATT (SK)', Desc2: null }];
    const sb = setup('plan', keylessDo({
      erpLines: [
        { id: 'matt', company_id: 1, delivery_order_id: 'do-uuid-1', item_code: 'AK-ARMOUR MATT (SK)', description2: null, linked_ac_dtlkey: null },
        { id: 'pillow', company_id: 1, delivery_order_id: 'do-uuid-1', item_code: 'AK-SLEEP ESSENTIAL 7 HOLES', description2: null, linked_ac_dtlkey: null },
      ],
    }));

    await relinkHeldBackSweep(env);

    const run = JSON.parse(String((sb.tables.app_config as Row[])
      .find((r) => r.key === 'scm.autocount_relink_sweep_last_run')!.value));
    expect(run.docs[0].wouldEnqueue, 'a released document must say so').toBe(true);
    expect(run.docs[0].enqueued).toBe(false);
  });

  it('records wouldEnqueue false for a document that stays held', async () => {
    bookLines = [];
    const sb = setup('plan', keylessDo());

    await relinkHeldBackSweep(env);

    const run = JSON.parse(String((sb.tables.app_config as Row[])
      .find((r) => r.key === 'scm.autocount_relink_sweep_last_run')!.value));
    expect(run.docs[0].wouldEnqueue).toBe(false);
  });
});
