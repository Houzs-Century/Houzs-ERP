// An edit refused only because something it needed was still on its way goes
// out by itself once that has reached AutoCount (docs/bugs/0924).
//
// The production case is HC-SO-011153 on 2026-09-15: line 9 was added and its
// edit queued at 06:14:34; a second save at 06:14:35 was refused because line 9
// had no AutoCount key yet. The first edit was sent at 06:15:13 and stored the key,
// and the refused save sat on the AutoCount Sync page as NOT ACCEPTED until it
// was re-sent by hand.
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { dispatchOne, enqueueEdit, type AcOutboxRow } from './autocount-outbox';
import { resendHeldEdits, isHeldEditRefusal, type HeldEditEnqueue } from './autocount-held-edit-resend';
import { resetWritebackFlagCache } from './autocount-writeback-flag';
import { fakeSb, type Row } from './fake-postgrest';

const SO_DOC = 'HC-SO-011153';
const KEYLESS = 'refused, nothing sent (KeylessLineError): SO SO-011153: 1 of 9 line(s) carry no AutoCount DtlKey — line(s) 9 (HOK- DIVAN ONLY (SS)).';
const BEFORE_COUNTERPART = 'edited before its AutoCount counterpart existed: the IV conversion is still queued and will transfer the source document\'s lines, not this edit. Re-save the document once the conversion has drained.';

const outboxRow = (over: Row): Row => ({
  company_id: 1, op: 'edit', doc_type: 'SO', doc_no: SO_DOC, doc_id: null,
  payload: { body: {} }, attempts: 0, dedupe_key: null, archived_at: null, ...over,
});

const sentRow = { company_id: 1, doc_type: 'SO' as const, doc_no: SO_DOC, doc_id: null, op: 'edit' };

const rows = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox;
const byId = (sb: { tables: Record<string, Row[]> }, id: string) => rows(sb).find((r) => r.id === id);

/* Typed casts at the one seam where the fake meets the real signatures. */
const asSb = (sb: unknown) => sb as Parameters<typeof resendHeldEdits>[0];
const asOutboxSb = (sb: unknown) => sb as Parameters<typeof enqueueEdit>[0];
const asEnv = (env: unknown) => env as Parameters<typeof dispatchOne>[0];
const asFetch = (f: unknown) => f as Parameters<typeof dispatchOne>[3];

beforeEach(() => resetWritebackFlagCache());

describe('which refusals are about timing', () => {
  test('a keyless-line refusal and an edit made before the counterpart existed are; others are not', () => {
    expect(isHeldEditRefusal(KEYLESS)).toBe(true);
    expect(isHeldEditRefusal(BEFORE_COUNTERPART)).toBe(true);
    expect(isHeldEditRefusal('refused, nothing sent (SofaCollapseError): cannot spell the build')).toBe(false);
    expect(isHeldEditRefusal(`[re-queued 2026-09-15T07:00:00.000Z] ${KEYLESS}`)).toBe(false);
    expect(isHeldEditRefusal(null)).toBe(false);
  });
});

describe('resendHeldEdits', () => {
  const world = (outbox: Row[]) => fakeSb({ autocount_outbox: outbox });

  const inFlightAndRefused = () => [
    outboxRow({ id: 'ob-added', status: 'sent', created_at: '2026-09-15T06:14:34.000Z' }),
    outboxRow({ id: 'ob-refused', status: 'skipped', last_error: KEYLESS, created_at: '2026-09-15T06:14:35.000Z' }),
  ];

  test('HC-SO-011153: once the edit that added the line has gone, the refused save is composed again and marked re-queued', async () => {
    const sb = world(inFlightAndRefused());
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    expect(await resendHeldEdits(asSb(sb), sentRow, enqueue)).toBe('queued');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({ companyId: 1, docType: 'SO', docNo: SO_DOC, docId: null, createdBy: null });
    const refused = byId(sb, 'ob-refused')!;
    expect(String(refused.last_error)).toMatch(/^\[re-queued \S+ -> sent again by itself after edit reached AutoCount\] /);
    expect(String(refused.last_error)).toContain(KEYLESS);
    expect(refused.status).toBe('skipped');
  });

  test('CONTROL: an edit of the document still queued goes first, and nothing is composed around it', async () => {
    const sb = world([...inFlightAndRefused(), outboxRow({ id: 'ob-next', status: 'pending', created_at: '2026-09-15T06:14:36.000Z' })]);
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    expect(await resendHeldEdits(asSb(sb), sentRow, enqueue)).toBe('none');
    expect(enqueue).not.toHaveBeenCalled();
    expect(byId(sb, 'ob-refused')!.last_error).toBe(KEYLESS);
  });

  test('CONTROL: an edit that went after the refusal already carried the later state', async () => {
    const sb = world([...inFlightAndRefused(), outboxRow({
      id: 'ob-later', status: 'sent', created_at: '2026-09-15T06:20:00.000Z',
      payload: { body: { DocType: 'SO', Lines: [{ DtlKey: 931773, Qty: 2 }] } },
    })]);
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    expect(await resendHeldEdits(asSb(sb), sentRow, enqueue)).toBe('none');
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('a payment edit sent after the refusal carries only the balance, so the refused save still goes', async () => {
    const sb = world([...inFlightAndRefused(), outboxRow({
      id: 'ob-payment', status: 'sent', created_at: '2026-09-15T06:30:00.000Z',
      payload: { body: { DocType: 'SO', DocNo: 'SO-011153', Header: { UDF: { BALANCE: '0.00' } }, Lines: [] } },
    })]);
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    expect(await resendHeldEdits(asSb(sb), sentRow, enqueue)).toBe('queued');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  test('CONTROL: a refusal about the document itself, or one already re-queued, is left alone', async () => {
    const sb = world([
      outboxRow({ id: 'ob-sofa', status: 'skipped', last_error: 'refused, nothing sent (SofaCollapseError): no spelling', created_at: '2026-09-15T06:14:35.000Z' }),
      outboxRow({ id: 'ob-done', status: 'skipped', last_error: `[re-queued 2026-09-15T06:30:00.000Z] ${KEYLESS}`, created_at: '2026-09-15T06:14:36.000Z' }),
    ]);
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    expect(await resendHeldEdits(asSb(sb), sentRow, enqueue)).toBe('none');
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('CONTROL: a refusal a person cleared, or another company\'s, is not touched', async () => {
    const sb = world([
      outboxRow({ id: 'ob-cleared', status: 'skipped', last_error: KEYLESS, created_at: '2026-09-15T06:14:35.000Z', archived_at: '2026-09-15T06:40:00.000Z' }),
      outboxRow({ id: 'ob-other', company_id: 2, status: 'skipped', last_error: KEYLESS, created_at: '2026-09-15T06:14:35.000Z' }),
    ]);
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    expect(await resendHeldEdits(asSb(sb), sentRow, enqueue)).toBe('none');
    expect(enqueue).not.toHaveBeenCalled();
    expect(byId(sb, 'ob-other')!.last_error).toBe(KEYLESS);
  });

  test('when the composer refuses again, the old refusal is not marked re-queued', async () => {
    const sb = world(inFlightAndRefused());
    const enqueue = vi.fn<HeldEditEnqueue>(async () => false);

    expect(await resendHeldEdits(asSb(sb), sentRow, enqueue)).toBe('not_queued');
    expect(byId(sb, 'ob-refused')!.last_error).toBe(KEYLESS);
  });

  test('an invoice edited before its conversion drained is composed by its row id once the conversion is sent', async () => {
    const sb = world([
      outboxRow({ id: 'ob-conv', op: 'do_to_iv', doc_type: 'IV', doc_no: 'HC-SI-2609-001', doc_id: 'iv-1', status: 'sent', created_at: '2026-09-14T03:00:00.000Z' }),
      outboxRow({ id: 'ob-iv-edit', doc_type: 'IV', doc_no: 'HC-SI-2609-001', doc_id: 'iv-1', status: 'skipped', last_error: BEFORE_COUNTERPART, created_at: '2026-09-14T03:00:05.000Z' }),
    ]);
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    const sent = { company_id: 1, doc_type: 'IV' as const, doc_no: 'HC-SI-2609-001', doc_id: 'iv-1', op: 'do_to_iv' };
    expect(await resendHeldEdits(asSb(sb), sent, enqueue)).toBe('queued');
    expect(enqueue).toHaveBeenCalledWith({ companyId: 1, docType: 'IV', docNo: 'HC-SI-2609-001', docId: 'iv-1', createdBy: null });
  });

  test('a document other than a sales order with no row id cannot be composed, so nothing is queued', async () => {
    const sb = world([outboxRow({ id: 'ob-po', doc_type: 'PO', doc_no: 'HC-PO-1', status: 'skipped', last_error: KEYLESS, created_at: '2026-09-15T06:14:35.000Z' })]);
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    const sent = { company_id: 1, doc_type: 'PO' as const, doc_no: 'HC-PO-1', doc_id: null, op: 'edit' };
    expect(await resendHeldEdits(asSb(sb), sent, enqueue)).toBe('not_queued');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('through the drain: the HC-SO-011153 sequence end to end', () => {
  const env = { AC_SYNC_URL: 'http://ac.local:8900', AC_SYNC_KEY: 'k' } as unknown as Record<string, unknown>;
  const ERP_A = 'AKEMI APEX MATT (SP)';
  const ERP_B = 'AKEMI ARISTOI MATT (SP)';

  const world = () => fakeSb({
    app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
    autocount_outbox: [],
    staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
    mfg_sales_orders: [{
      doc_no: SO_DOC, so_date: '2026-08-28', debtor_name: 'ACME', agent: null, salesperson_id: 'staff-1',
      sales_location: 'KL', branding: null, venue: null, address1: null, address2: null, address3: null,
      address4: null, phone: null, ref: null, po_doc_no: null, internal_expected_dd: null,
      linked_ac_docno: 'SO-011153', company_id: 1,
    }],
    mfg_sales_order_items: [
      { id: 'row-1', doc_no: SO_DOC, item_code: ERP_A, description: 'M', qty: 1, unit_price_sen: 100, cancelled: false, warehouse_id: null, linked_ac_dtlkey: 931769, created_at: '2026-08-28T08:11:19Z' },
      { id: 'row-9', doc_no: SO_DOC, item_code: ERP_B, description: 'M', qty: 2, unit_price_sen: 200, cancelled: false, warehouse_id: null, linked_ac_dtlkey: null, created_at: '2026-09-15T06:14:33Z' },
    ],
    supplier_material_bindings: [],
  });

  /* The office host: it answers an edit with every line the document now holds,
     giving the line it appended a new key, the way AcSyncService's /edit does. */
  const host = vi.fn(async (url: string, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as { Lines?: Array<Record<string, unknown>> };
    if (!String(url).endsWith('/edit')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    let next = 931773;
    const lines = (payload.Lines ?? []).map((l, i) => ({
      Seq: i, DtlKey: l.DtlKey ?? next++, ItemCode: l.ItemCode ?? null,
    }));
    return new Response(JSON.stringify({ ok: true, docNo: 'SO-011153', lines }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  test('the save refused a second after the line was added goes out keyed, with no second copy of the line', async () => {
    const sb = world();

    /* 06:14:34 — the save that added line 9 queues an edit declaring it new. */
    expect(await enqueueEdit(asOutboxSb(sb), { companyId: 1, docType: 'SO', docNo: SO_DOC, newLineIds: ['row-9'] })).toBe(true);
    /* 06:14:35 — the next save, composed while line 9 is still keyless, is refused. */
    expect(await enqueueEdit(asOutboxSb(sb), { companyId: 1, docType: 'SO', docNo: SO_DOC })).toBe(false);
    const refused = rows(sb).find((r) => r.status === 'skipped')!;
    expect(String(refused.last_error)).toMatch(/^refused, nothing sent \(KeylessLineError\)/);
    const added = rows(sb).find((r) => r.status === 'pending')!;
    /* The fake stamps no created_at; give the two rows the order they had. */
    added.created_at = '2026-09-15T06:14:34.000Z';
    refused.created_at = '2026-09-15T06:14:35.000Z';

    /* 06:15:13 — the first edit drains. */
    expect(await dispatchOne(asEnv(env), asOutboxSb(sb), added as unknown as AcOutboxRow, asFetch(host))).toBe('sent');

    expect(sb.tables.mfg_sales_order_items.find((r) => r.id === 'row-9')!.linked_ac_dtlkey).toBe(931773);
    const resent = rows(sb).filter((r) => r.status === 'pending');
    expect(resent, 'the refused save was not composed again').toHaveLength(1);
    const lines = (resent[0].payload as { body: { Lines: Array<Record<string, unknown>> } }).body.Lines;
    expect(lines.map((l) => l.DtlKey)).toEqual([931769, 931773]);
    expect(lines.some((l) => l.IsNewLine === true), 'line 9 would be appended a second time').toBe(false);
    expect(String(refused.last_error)).toMatch(/^\[re-queued /);
  });
});
