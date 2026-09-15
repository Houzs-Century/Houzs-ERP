// A keyed edit the account book refused because the ERP RE-KEYED the line goes
// out again, composed from the document as it now stands, once. The sibling of
// autocount-held-edit-resend (docs/bugs/0924).
//
// The production case is HC-SO-011654 on 2026-09-15 (handoff, 13:00Z): a Rebuild
// deleted the book's 7 lines and added 6 with fresh DtlKeys 931973–931978; five
// edits composed a second earlier still named the OLD keys 803471–803477 and
// were refused `line 803474 not found on SO-011654` six times each, ending
// `failed` on the AutoCount Sync page.
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { dispatchOne, enqueueEdit, type AcOutboxRow } from './autocount-outbox';
import {
  refusedDtlKey,
  isStaleKeyRefusal,
  recomposeStaleKeyedEdit,
  type LiveLineKeys,
} from './autocount-stale-key-recompose';
import { type HeldEditEnqueue } from './autocount-held-edit-resend';
import { resetWritebackFlagCache } from './autocount-writeback-flag';
import { fakeSb, type Row } from './fake-postgrest';

const SO_DOC = 'HC-SO-011654';
const NOT_FOUND = 'line 803474 not found on SO-011654';
const GAVE_UP = `Gave up after 6 attempts. Last error: ${NOT_FOUND}`;

/* Post-rebuild ERP keys, and the pre-rebuild key the stale edit names. */
const REKEYED = new Set([931973, 931974, 931975, 931976, 931977, 931978]);
const OLD_KEY = 803474;

const asSb = (sb: unknown) => sb as Parameters<typeof recomposeStaleKeyedEdit>[0];
const asOutboxSb = (sb: unknown) => sb as Parameters<typeof enqueueEdit>[0];
const asEnv = (env: unknown) => env as Parameters<typeof dispatchOne>[0];
const asFetch = (f: unknown) => f as Parameters<typeof dispatchOne>[3];

const rows = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox;
const byId = (sb: { tables: Record<string, Row[]> }, id: string) => rows(sb).find((r) => r.id === id);

const failedRow = (over: Row = {}): Row => ({
  id: 'ob-stale', company_id: 1, op: 'edit', doc_type: 'SO', doc_no: SO_DOC, doc_id: null,
  status: 'failed', last_error: GAVE_UP, created_at: '2026-09-15T10:22:05.000Z', archived_at: null, ...over,
});

const failedArg = (r: Row) => ({
  id: String(r.id), company_id: Number(r.company_id), doc_type: r.doc_type as 'SO' | 'PO',
  doc_no: (r.doc_no as string | null) ?? null, doc_id: (r.doc_id as string | null) ?? null,
  op: String(r.op), last_error: (r.last_error as string | null) ?? null,
});

const rekeyedLive: LiveLineKeys = async () => new Set(REKEYED);
const stillLive: LiveLineKeys = async () => new Set([...REKEYED, OLD_KEY]);

beforeEach(() => resetWritebackFlagCache());

describe('reading the refusal', () => {
  test('the DtlKey is pulled from the book\'s line-not-found message, raw or gave-up-wrapped', () => {
    expect(refusedDtlKey(NOT_FOUND)).toBe(803474);
    expect(refusedDtlKey(GAVE_UP)).toBe(803474);
    expect(isStaleKeyRefusal(GAVE_UP)).toBe(true);
  });
  test('anything that is not that refusal, or is already re-queued, reads as none', () => {
    expect(refusedDtlKey('refused, nothing sent (SofaCollapseError): no spelling')).toBeNull();
    expect(refusedDtlKey(`[re-queued 2026-09-15T13:00:00.000Z] ${NOT_FOUND}`)).toBeNull();
    expect(refusedDtlKey(null)).toBeNull();
    expect(isStaleKeyRefusal('Invalid transfer item.')).toBe(false);
  });
});

describe('recomposeStaleKeyedEdit', () => {
  const world = (outbox: Row[]) => fakeSb({ autocount_outbox: outbox });

  test('re-keyed: the ERP no longer carries the refused key, so a fresh edit is composed once', async () => {
    const failed = failedRow();
    const sb = world([failed]);
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    const out = await recomposeStaleKeyedEdit(asSb(sb), failedArg(failed), enqueue, rekeyedLive);
    expect(out).toEqual({ kind: 'queued', key: OLD_KEY });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({ companyId: 1, docType: 'SO', docNo: SO_DOC, docId: null, createdBy: null });
  });

  test('the book lost the line: the ERP STILL carries the key, so it is left for a person', async () => {
    const failed = failedRow();
    const sb = world([failed]);
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    const out = await recomposeStaleKeyedEdit(asSb(sb), failedArg(failed), enqueue, stillLive);
    expect(out).toEqual({ kind: 'office_changed', key: OLD_KEY });
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('CONTROL: a newer edit of the document already queued means this recompose is a duplicate', async () => {
    const failed = failedRow();
    const newer = failedRow({ id: 'ob-newer', status: 'pending', last_error: null, created_at: '2026-09-15T10:25:00.000Z' });
    const sb = world([failed, newer]);
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    const out = await recomposeStaleKeyedEdit(asSb(sb), failedArg(failed), enqueue, rekeyedLive);
    expect(out).toEqual({ kind: 'none' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('CONTROL: an OLDER failed sibling does not block the newest failure from healing', async () => {
    const older = failedRow({ id: 'ob-older', created_at: '2026-09-15T10:21:10.000Z' });
    const failed = failedRow();
    const sb = world([older, failed]);
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    const out = await recomposeStaleKeyedEdit(asSb(sb), failedArg(failed), enqueue, rekeyedLive);
    expect(out).toEqual({ kind: 'queued', key: OLD_KEY });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  test('CONTROL: not an edit, a conversion, or a PO with no row id — nothing is composed', async () => {
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);
    const sb = world([]);
    expect(await recomposeStaleKeyedEdit(asSb(sb), failedArg(failedRow({ op: 'so_to_do' })), enqueue, rekeyedLive)).toEqual({ kind: 'none' });
    expect(await recomposeStaleKeyedEdit(asSb(sb), failedArg(failedRow({ doc_type: 'PO', doc_id: null })), enqueue, rekeyedLive)).toEqual({ kind: 'none' });
    expect(await recomposeStaleKeyedEdit(asSb(sb), failedArg(failedRow({ last_error: 'Invalid transfer item.' })), enqueue, rekeyedLive)).toEqual({ kind: 'none' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('a purchase order recomposes by its row id when its line was re-keyed', async () => {
    const failed = failedRow({ id: 'ob-po', doc_type: 'PO', doc_no: 'HC-PO-2609-006', doc_id: 'po-1' });
    const sb = world([failed]);
    const enqueue = vi.fn<HeldEditEnqueue>(async () => true);

    const out = await recomposeStaleKeyedEdit(asSb(sb), failedArg(failed), enqueue, rekeyedLive);
    expect(out).toEqual({ kind: 'queued', key: OLD_KEY });
    expect(enqueue).toHaveBeenCalledWith({ companyId: 1, docType: 'PO', docNo: 'HC-PO-2609-006', docId: 'po-1', createdBy: null });
  });
});

describe('through the drain: a stale-keyed edit heals itself', () => {
  const env = { AC_SYNC_URL: 'http://ac.local:8900', AC_SYNC_KEY: 'k' } as unknown as Record<string, unknown>;

  const world = () => fakeSb({
    app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
    staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
    mfg_sales_orders: [{
      doc_no: SO_DOC, so_date: '2026-05-04', debtor_name: 'ACME', agent: null, salesperson_id: 'staff-1',
      sales_location: 'KL', branding: null, venue: null, address1: null, address2: null, address3: null,
      address4: null, phone: null, ref: null, po_doc_no: null, internal_expected_dd: null,
      linked_ac_docno: 'SO-011654', company_id: 1,
    }],
    /* The ERP's lines AFTER the rebuild — the fresh keys the office host stored. */
    mfg_sales_order_items: [
      { id: 'row-a', doc_no: SO_DOC, item_code: 'AERO-MP (Q)', description: 'M', qty: 1, unit_price_sen: 100, cancelled: false, warehouse_id: null, linked_ac_dtlkey: 931973 },
      { id: 'row-b', doc_no: SO_DOC, item_code: 'AKEMI ULTIMATE MATT (Q)', description: 'M', qty: 2, unit_price_sen: 200, cancelled: false, warehouse_id: null, linked_ac_dtlkey: 931974 },
    ],
    supplier_material_bindings: [],
    autocount_outbox: [{
      id: 'ob-stale', company_id: 1, op: 'edit', doc_type: 'SO', doc_no: SO_DOC, doc_id: null,
      status: 'pending', attempts: 0, dedupe_key: null, archived_at: null, created_at: '2026-09-15T10:22:05.000Z',
      /* Composed before the rebuild drained — it names the OLD key. */
      payload: { body: { DocType: 'SO', DocNo: 'SO-011654', Lines: [{ DtlKey: OLD_KEY, Qty: 3 }] } },
    }],
  });

  /* The office host refuses any edit that still names a retired key, the way
     AcSyncService.cs:3729 does, and accepts an edit that names only live ones. */
  const host = vi.fn(async (url: string, init?: RequestInit) => {
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (!String(url).endsWith('/edit')) return ok({ ok: true });
    const payload = JSON.parse(String(init?.body ?? '{}')) as { Lines?: Array<{ DtlKey?: number }> };
    const bad = (payload.Lines ?? []).find((l) => l.DtlKey === OLD_KEY);
    if (bad) return ok({ ok: false, retryable: true, error: `line ${bad.DtlKey} not found on SO-011654` });
    const lines = (payload.Lines ?? []).map((l, i) => ({ Seq: i, DtlKey: l.DtlKey }));
    return ok({ ok: true, docNo: 'SO-011654', lines });
  });

  test('the refused save is folded as Replaced and a fresh edit with the current keys is queued', async () => {
    const sb = world();
    const stale = byId(sb, 'ob-stale')! as unknown as AcOutboxRow;

    expect(await dispatchOne(asEnv(env), asOutboxSb(sb), stale, asFetch(host))).toBe('failed');

    /* The stale row is history now, not an open refusal. */
    expect(String(byId(sb, 'ob-stale')!.last_error)).toMatch(/^\[re-queued /);
    /* Exactly one fresh edit was queued, and it names the CURRENT keys. */
    const fresh = rows(sb).filter((r) => r.status === 'pending' && r.id !== 'ob-stale');
    expect(fresh).toHaveLength(1);
    const lines = (fresh[0].payload as { body: { Lines: Array<{ DtlKey: number }> } }).body.Lines;
    expect(lines.map((l) => l.DtlKey).sort()).toEqual([931973, 931974]);
  });
});
