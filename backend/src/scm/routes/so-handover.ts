// ----------------------------------------------------------------------------
// SALES-ORDER HANDOVER — move a salesperson's orders to their replacement.
//
// Owner 2026-08-17: "如果第一个销售人员 PIC 辞职，销售订单是否可以分配给第二个人
// PIC 来更新销售订单". Until now the answer was "one order at a time, and only
// while it had no Delivery Order or Sales Invoice". Both halves were wrong for a
// resignation:
//   · SO row-level visibility keys off `salesperson_id`, so an order left on a
//     departed rep is invisible to the person now answering the customer.
//   · The identity lock froze `salesperson_id` once a DO / SI existed — see
//     shared/so-identity-lock.ts for why that was collateral, and what changed.
//
// This route is the BULK path. The SO Detail page still moves one order (same
// permission, same audit); this exists because a resignation is fifty of them.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   · It does not touch money. Commission is booked from the DO / SI snapshots,
//     which keep the rep who sold the order — moving the SO does not re-book a
//     single cent, and this route writes no financial column.
//   · It does not move orders the operator did not name. The apply step is fed
//     an explicit doc_no list from the preview, and re-checks each one still
//     belongs to `fromStaffId` before writing (the preview can be minutes old,
//     and someone else may have moved one meanwhile).
//
// Both endpoints require `scm.so.attribute_other` — the same permission that
// governs attributing a NEW order to somebody else. The preview is gated too:
// it enumerates another salesperson's order book.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { requireActiveCompanyId, scopeToCompanyId } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { recordSoAudit, type FieldChange } from '../lib/so-audit';
import { readStaffAgentName } from '../lib/so-agent';
import { enqueueEdit } from '../lib/autocount-outbox';
import type { Env, Variables } from '../env';

export const soHandover = new Hono<{ Bindings: Env; Variables: Variables }>();
soHandover.use('*', supabaseAuth);

/* One apply call = one Cloudflare request, and each order costs a read, a write,
   an audit row and an AutoCount enqueue. Twenty-five keeps that inside the
   worker's budget with room to spare; the UI loops batches and shows progress.
   (A 60-order handover that 524s halfway is worse than four clean batches.) */
export const HANDOVER_BATCH_MAX = 25;

/* The preview is a LIST, not a page: the operator is about to act on all of it,
   so a cap that silently hides orders would be a lie. If a rep somehow has more
   than this, the response says so and the UI tells the operator to run it again
   after the first pass. */
const PREVIEW_MAX = 500;

export type HandoverRequest = {
  fromStaffId: string;
  toStaffId: string;
  docNos: string[];
};

/* Request validation, split out so it can be tested without a Hono context or a
   database. Rejects with the exact payload the handler returns. */
export function parseHandoverBody(
  body: Record<string, unknown>,
): { ok: true; req: HandoverRequest }
  | { ok: false; status: 400; payload: { error: string; reason: string } } {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const fromStaffId = str(body.fromStaffId);
  const toStaffId = str(body.toStaffId);
  if (!fromStaffId || !toStaffId) {
    return { ok: false, status: 400, payload: { error: 'missing_staff', reason: 'Pick who the orders come FROM and who they go TO.' } };
  }
  if (fromStaffId === toStaffId) {
    return { ok: false, status: 400, payload: { error: 'same_staff', reason: 'The two salespeople are the same person.' } };
  }

  const docNos = Array.isArray(body.docNos)
    ? [...new Set(body.docNos.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))]
    : [];
  if (docNos.length === 0) {
    return { ok: false, status: 400, payload: { error: 'no_orders', reason: 'Pick at least one sales order.' } };
  }
  if (docNos.length > HANDOVER_BATCH_MAX) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: 'too_many_orders',
        reason: `Up to ${HANDOVER_BATCH_MAX} sales orders per batch — you sent ${docNos.length}.`,
      },
    };
  }
  return { ok: true, req: { fromStaffId, toStaffId, docNos } };
}

/* GET /preview?from=<staffId> — every order currently attributed to that
   salesperson, in this company. `total` is what the operator is committing to;
   `truncated` says the list is not all of it. */
soHandover.get('/preview', async (c) => {
  if (!hasHouzsPerm(c, 'scm.so.attribute_other')) return c.json({ error: 'forbidden' }, 403);
  const from = (c.req.query('from') ?? '').trim();
  if (!from) return c.json({ error: 'missing_staff', reason: 'Pick a salesperson.' }, 400);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const sb = c.get('supabase');
  const { data, error, count } = await scopeToCompanyId(
    sb.from('mfg_sales_orders')
      .select('doc_no, so_date, debtor_name, status', { count: 'exact' })
      .eq('salesperson_id', from)
      .order('doc_no', { ascending: true })
      .limit(PREVIEW_MAX),
    co.companyId,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return c.json({
    from,
    total: count ?? rows.length,
    truncated: (count ?? rows.length) > rows.length,
    batchMax: HANDOVER_BATCH_MAX,
    orders: rows.map((r) => ({
      docNo: r.doc_no as string,
      soDate: (r.so_date as string | null) ?? null,
      customer: (r.debtor_name as string | null) ?? null,
      status: (r.status as string | null) ?? null,
    })),
  });
});

/* POST /apply — move one batch. Reports per-order, because a handover that
   half-applied in silence is how an order goes missing from both reps' lists. */
soHandover.post('/apply', async (c) => {
  if (!hasHouzsPerm(c, 'scm.so.attribute_other')) return c.json({ error: 'forbidden' }, 403);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const parsed = parseHandoverBody(body);
  if (!parsed.ok) return c.json(parsed.payload, parsed.status);
  const { fromStaffId, toStaffId, docNos } = parsed.req;

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  /* `agent` is the AutoCount rep NAME the account book and the SO list read.
     so-agent.ts makes it follow a reassigned salesperson on the header PATCH;
     this route does the same thing by hand. A name we cannot read leaves
     `agent` alone — a stale name beats an empty one. */
  const toName = await readStaffAgentName(sb as never, toStaffId);

  const user = c.get('user') as { id?: string; user_metadata?: { name?: string } } | undefined;
  const moved: Array<{ docNo: string }> = [];
  const skipped: Array<{ docNo: string; reason: string }> = [];

  for (const docNo of docNos) {
    const { data: beforeRow } = await scopeToCompanyId(
      sb.from('mfg_sales_orders').select('doc_no, salesperson_id, agent, status').eq('doc_no', docNo),
      co.companyId,
    ).maybeSingle();
    if (!beforeRow) { skipped.push({ docNo, reason: 'Not found in this company.' }); continue; }
    const before = beforeRow as unknown as Record<string, unknown>;

    /* The preview may be stale. Only move what still belongs to the person the
       operator chose — never someone else's order that happened to be listed. */
    if ((before.salesperson_id as string | null) !== fromStaffId) {
      skipped.push({ docNo, reason: 'No longer attributed to that salesperson.' });
      continue;
    }

    const updates: Record<string, unknown> = { salesperson_id: toStaffId };
    if (toName) updates.agent = toName;
    const { error } = await scopeToCompanyId(
      sb.from('mfg_sales_orders').update(updates).eq('doc_no', docNo),
      co.companyId,
    );
    if (error) { skipped.push({ docNo, reason: error.message }); continue; }

    const fieldChanges: FieldChange[] = [
      { field: 'salespersonId', from: fromStaffId, to: toStaffId },
      ...(toName && toName !== (before.agent as string | null)
        ? [{ field: 'agent', from: (before.agent as string | null) ?? null, to: toName }]
        : []),
    ];
    await recordSoAudit(sb, {
      docNo,
      action: 'UPDATE_DETAILS',
      actorId: user?.id ?? null,
      actorName: user?.user_metadata?.name ?? null,
      fieldChanges,
      statusSnapshot: (before.status as string | null) ?? null,
      note: 'Salesperson handover',
    });

    /* ERP -> AutoCount, one per order that actually moved — `agent` is a real
       AutoCount field, so an account book left naming the departed rep is the
       same bug one layer down. Inside the loop and after every `continue`, so a
       skipped order queues nothing. */
    await enqueueEdit(sb as never, {
      companyId: co.companyId,
      docType: 'SO',
      docNo,
      touchedFields: ['agent'],
      createdBy: c.get('houzsUser')?.id ?? null,
    });
    moved.push({ docNo });
  }

  return c.json({ fromStaffId, toStaffId, moved, skipped });
});
