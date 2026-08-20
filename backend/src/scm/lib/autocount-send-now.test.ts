// SEND NOW: pushing a WAITING row to AutoCount without waiting for the sweep.
//
// The owner asked for this by name — 「自动的 可是我要可以manual push」 — and the
// property under test is not "a button exists". It is the pair of promises that
// make a manual dispatcher safe to add beside an automatic one:
//
//   it really sends       a pending row goes to the account book on the press,
//                         not on the next five-minute tick.
//   it sends ONCE         two presses, or a press inside a sweep, put ONE
//                         document in a licensed book. Before migration 0315
//                         nothing in the table could express "somebody is
//                         sending this", and the drain was safe only because it
//                         was the sole dispatcher.
//
// The second is the one worth writing tests for: the first fails loudly the day
// it breaks, and the second fails silently into an accounting system.
import { describe, expect, test, beforeEach, vi } from 'vitest';
import {
  claimOutboxRow,
  releaseExpiredClaims,
  AC_CLAIM_LEASE_MS,
  MAX_ATTEMPTS,
} from './autocount-outbox';
import { acRequeueAccepted, sendOutboxRowNow } from './autocount-requeue';
import { acRowCanSendNow, acRowIsRequeueable } from './autocount-outbox-status';
import { resetWritebackFlagCache } from './autocount-writeback-flag';
import { fakeSb, type Row } from './fake-postgrest';

const env = { AC_SYNC_URL: 'http://ac.local:8900', AC_SYNC_KEY: 'k' } as unknown as Record<string, unknown>;

const DOC = 'HC-SO-2608-002';

const waitingRow = (over: Row = {}): Row => ({
  id: 'ob-1',
  company_id: 1,
  op: 'create_so',
  doc_type: 'SO',
  doc_no: DOC,
  doc_id: null,
  payload: {
    body: { DocNo: DOC },
    writeback: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: DOC },
  },
  status: 'pending',
  attempts: 0,
  dedupe_key: `create_so:${DOC}`,
  last_error: null,
  claimed_at: null,
  created_at: '2026-08-20T14:27:00Z',
  ...over,
});

const world = (rows: Row[] = [waitingRow()], flag = '1') => fakeSb({
  app_config: flag == null ? [] : [{ key: 'scm.autocount_writeback', value: flag }],
  autocount_outbox: rows,
  mfg_sales_orders: [{ doc_no: DOC, linked_ac_docno: null }],
  staff: [],
});

const outbox = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox ?? [];

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** AutoCount takes it. */
const accepts = () => vi.fn(async () => jsonRes(200, { ok: true, docNo: 'SO-000123' })) as never;
/** AutoCount throws — the shape production is in right now (`Primary Key Error`). */
const refuses = () => vi.fn(async () => jsonRes(500, { ok: false, error: 'Primary Key Error' })) as never;

beforeEach(() => resetWritebackFlagCache());

describe('a waiting row can be pushed now', () => {
  test('the document reaches the account book on the press, not on the sweep', async () => {
    const sb = world();
    const r = await sendOutboxRowNow(env as never, sb as never, { rowId: 'ob-1', companyId: 1 }, accepts());

    expect(r.outcome).toBe('sent-now');
    expect(outbox(sb)[0].status).toBe('sent');
    /* The write-back half of the map, exactly as the sweep would have written
       it — this is the same dispatchOne, not a second sender. */
    expect(sb.tables.mfg_sales_orders[0].linked_ac_docno).toBe('SO-000123');
  });

  /* THE SHAPE PRODUCTION IS IN, and it is not the obvious one. AcSyncService
     turns every exception into a 500 and `callAcService` calls a 500 RETRYABLE,
     so AutoCount REFUSING a document does not fail the row — it keeps it pending
     and retrying until the attempt cap. That is why HC-SO-2608-002 sat at
     `pending` with `Primary Key Error` while HC-SO-2608-001 next to it read
     `failed` with the same words: the second had simply spent its six.

     This test exists because the first version of the copy for this outcome
     said "AutoCount could not be reached", which would have sent an operator to
     check a tunnel that was working perfectly and refusing him on purpose. */
  test("AutoCount's refusal comes back as the answer, and the row keeps retrying under the cap", async () => {
    const sb = world();
    const r = await sendOutboxRowNow(env as never, sb as never, { rowId: 'ob-1', companyId: 1 }, refuses());

    /* NOT accepted — a refusal must never read as success, because the document
       is then in the ERP and not in the book. */
    expect(acRequeueAccepted(r.outcome)).toBe(false);
    expect(r.outcome).toBe('send-now-retrying');
    /* The account book's own words reach the operator either way. */
    expect(r.detail).toContain('Primary Key Error');
    expect(outbox(sb)[0].status).toBe('pending');
  });

  test('the send that spends the LAST attempt reports the refusal as final', async () => {
    const sb = world([waitingRow({ attempts: MAX_ATTEMPTS - 1 })]);
    const r = await sendOutboxRowNow(env as never, sb as never, { rowId: 'ob-1', companyId: 1 }, refuses());

    expect(r.outcome).toBe('send-now-refused');
    expect(r.detail).toContain('Primary Key Error');
    expect(outbox(sb)[0].status).toBe('failed');
    expect(acRequeueAccepted(r.outcome)).toBe(false);
  });

  test('a manual push spends an attempt, like every other call on the account book', async () => {
    const sb = world([waitingRow({ attempts: 2 })]);
    await sendOutboxRowNow(env as never, sb as never, { rowId: 'ob-1', companyId: 1 }, refuses());

    /* The counter means "times we asked AutoCount" to the page, the health check
       and the dead-lettering rule. A manual call that did not count would make
       all three false. */
    expect(outbox(sb)[0].attempts).toBe(3);
  });

  test('a row with no attempts left is refused rather than pushed', async () => {
    const sb = world([waitingRow({ attempts: MAX_ATTEMPTS })]);
    const fetchImpl = accepts();
    const r = await sendOutboxRowNow(env as never, sb as never, { rowId: 'ob-1', companyId: 1 }, fetchImpl);

    expect(r.outcome).toBe('attempts-spent');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('only a WAITING row — a failed one is sent again, never pushed', async () => {
    const sb = world([waitingRow({ status: 'failed', attempts: MAX_ATTEMPTS, last_error: 'Primary Key Error' })]);
    const fetchImpl = accepts();
    const r = await sendOutboxRowNow(env as never, sb as never, { rowId: 'ob-1', companyId: 1 }, fetchImpl);

    expect(r.outcome).toBe('not-waiting');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("another company's row is not found, and nothing is sent", async () => {
    const sb = world();
    const fetchImpl = accepts();
    const r = await sendOutboxRowNow(env as never, sb as never, { rowId: 'ob-1', companyId: 2 }, fetchImpl);

    expect(r.outcome).toBe('row-not-found');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outbox(sb)[0].status).toBe('pending');
  });

  test('the write-back switch is honoured — off means nothing is sent', async () => {
    const sb = world([waitingRow()], 'off');
    const fetchImpl = accepts();
    const r = await sendOutboxRowNow(env as never, sb as never, { rowId: 'ob-1', companyId: 1 }, fetchImpl);

    expect(r.outcome).toBe('switch-off');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('it cannot send the same document twice', () => {
  test('a second press while the first is in flight sends nothing', async () => {
    const sb = world();
    /* The first press has taken the row and is still talking to the host. */
    expect(await claimOutboxRow(sb as never, 'ob-1')).toBe(true);

    const fetchImpl = accepts();
    const r = await sendOutboxRowNow(env as never, sb as never, { rowId: 'ob-1', companyId: 1 }, fetchImpl);

    expect(r.outcome).toBe('already-in-flight');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outbox(sb)[0].status).toBe('pending');
  });

  test('the claim is exclusive: the second taker gets nothing', async () => {
    const sb = world();
    expect(await claimOutboxRow(sb as never, 'ob-1')).toBe(true);
    expect(await claimOutboxRow(sb as never, 'ob-1')).toBe(false);
  });

  /* THE SWEEP IS GUARDED BY THE SAME GATE, and it is asserted here rather than
     by running the drain: `drainAutoCountOutbox` builds its own Supabase client
     out of `env` and there is no seam to hand it the fake, so a test of the
     sweep would have to catch its own failure to construct a client and could
     then never fail for the reason it claims to test. What IS testable is the
     gate itself — the sweep calls `claimOutboxRow` on every row before
     `dispatchOne`, and a claim it cannot take is a row it skips. That call is
     one line in the drain loop; this is the behaviour behind it. */
  test('a claim is released when the send finishes, so the next sweep can have it', async () => {
    const sb = world();
    await sendOutboxRowNow(env as never, sb as never, { rowId: 'ob-1', companyId: 1 }, refuses());

    /* mark() clears it on every outcome — including the refusals, which stay
       pending and must remain sendable. */
    expect(outbox(sb)[0].claimed_at).toBe(null);
  });

  test('a claim whose holder died is released by the lease, never held forever', async () => {
    const dead = new Date(Date.now() - AC_CLAIM_LEASE_MS - 60_000).toISOString();
    const sb = world([waitingRow({ claimed_at: dead })]);

    /* Before the sweep releases it, the row is untouchable — that is the claim
       working, not a bug. */
    expect(await claimOutboxRow(sb as never, 'ob-1')).toBe(false);

    await releaseExpiredClaims(sb as never);

    expect(outbox(sb)[0].claimed_at).toBe(null);
    expect(await claimOutboxRow(sb as never, 'ob-1')).toBe(true);
  });

  test('a LIVE claim is never stolen by the lease sweep', async () => {
    const sb = world();
    expect(await claimOutboxRow(sb as never, 'ob-1')).toBe(true);
    const held = outbox(sb)[0].claimed_at;

    await releaseExpiredClaims(sb as never);

    expect(outbox(sb)[0].claimed_at).toBe(held);
  });
});

describe('which button a row is offered', () => {
  /* THE TWO ARE DISJOINT BY CONSTRUCTION, and that is the property that keeps
     "Send again" and "Send now" from meaning the same thing on screen. */
  const cases: Array<{ status: string; attempts: number; err: string | null }> = [
    { status: 'pending', attempts: 0, err: null },
    { status: 'pending', attempts: 3, err: 'Primary Key Error' },
    { status: 'pending', attempts: MAX_ATTEMPTS, err: null },
    { status: 'failed', attempts: MAX_ATTEMPTS, err: 'Primary Key Error' },
    { status: 'skipped', attempts: 0, err: 'refused, nothing sent (ItemCodeError): x' },
    { status: 'sent', attempts: 1, err: null },
  ];

  test('no row is ever offered both', () => {
    for (const c of cases) {
      const both = acRowIsRequeueable('create_so', c.status, c.err)
        && acRowCanSendNow(c.status, c.err, c.attempts);
      expect(both).toBe(false);
    }
  });

  test('a waiting row with attempts left is offered Send now', () => {
    expect(acRowCanSendNow('pending', null, 0)).toBe(true);
    expect(acRowCanSendNow('pending', 'Primary Key Error', 3)).toBe(true);
  });

  test('a waiting row with no attempts left is not — the sweep will not take it either', () => {
    expect(acRowCanSendNow('pending', null, MAX_ATTEMPTS)).toBe(false);
  });

  test('a stopped row is never offered Send now, whatever stopped it', () => {
    expect(acRowCanSendNow('failed', 'Primary Key Error', 6)).toBe(false);
    expect(acRowCanSendNow('skipped', 'refused, nothing sent (ItemCodeError): x', 0)).toBe(false);
    expect(acRowCanSendNow('sent', null, 1)).toBe(false);
  });
});
