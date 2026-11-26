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
import { deferScmAfterCommit, runScmPgCommand } from '../lib/pg-supabase-transaction';
import { supabaseAuth } from '../middleware/auth';
import { requireActiveCompanyId, scopeToCompanyId } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { recordSoAudit, type FieldChange } from '../lib/so-audit';
import { readStaffAgentName } from '../lib/so-agent';
import { migratedSoReadonlyState } from '../lib/migrated-so-readonly';
import { enqueueEdit } from '../lib/autocount-outbox';
import type { Env, Variables } from '../env';

export const soHandover = new Hono<{ Bindings: Env; Variables: Variables }>();
soHandover.use('*', supabaseAuth);

export const HANDOVER_BATCH_MAX = 25;

const PREVIEW_MAX = 500;

export type HandoverRequest = {
  fromStaffId: string;
  toStaffId: string;
  docNos: string[];
};

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

/* ── SHARING, WHICH IS NOT HANDOVER ──────────────────────────────────────────
   Owner 2026-09-09: "接手的 sales person 可以选择 multiple 吗？可以让接手的几位
   sales person 都有权限". Asked who the account book should then name, he ruled
   全部平等，不设主 — equal access, no primary among them.

   So this is a SECOND operation, not a flag on the first, and the split is the
   owner's ruling made structural:

     /apply — moves attribution. One person, writes salesperson_id + agent,
              enqueues the AutoCount edit. Unchanged.
     /share — grants ACCESS. Any number of people, writes collaborator_staff_ids
              and nothing else. No attribution, no agent, no AutoCount: there is
              no column on the AutoCount side a co-owner could map to, and
              commission is booked off the DO / SI snapshots either way.

   Folding sharing into /apply as a "multiple recipients" flag would have had to
   answer "so whose name is on it?" implicitly, by picking the first — which is
   the primary the owner said not to have.                                     */

/** A sane ceiling on people-per-order. Not a technical limit — an array of 50
 *  uuids would query fine. Sharing one order with fifty salespeople is a
 *  mis-click, and a bulk tool should refuse it rather than apply it to 25
 *  orders. */
export const SHARE_STAFF_MAX = 10;

export type ShareRequest = {
  staffIds: string[];
  docNos: string[];
  mode: 'add' | 'remove';
};

export function parseShareBody(
  body: Record<string, unknown>,
): { ok: true; req: ShareRequest }
  | { ok: false; status: 400; payload: { error: string; reason: string } } {
  const list = (v: unknown) => (Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))]
    : []);

  const staffIds = list(body.staffIds);
  if (staffIds.length === 0) {
    return { ok: false, status: 400, payload: { error: 'missing_staff', reason: 'Pick at least one salesperson to share with.' } };
  }
  if (staffIds.length > SHARE_STAFF_MAX) {
    return { ok: false, status: 400, payload: { error: 'too_many_staff', reason: `Up to ${SHARE_STAFF_MAX} salespeople per order — you sent ${staffIds.length}.` } };
  }

  const docNos = list(body.docNos);
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

  const mode = body.mode === 'remove' ? 'remove' : 'add';

  return { ok: true, req: { staffIds, docNos, mode } };
}

soHandover.get('/holders', async (c) => {
  if (!hasHouzsPerm(c, 'scm.so.attribute_other')) return c.json({ error: 'forbidden' }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const { data, error } = await paginateAll<{ salesperson_id: string | null }>(
    (from, to) => scopeToCompanyId(
      sb.from('mfg_sales_orders')
        .select('salesperson_id')
        .not('salesperson_id', 'is', null)
        .order('doc_no', { ascending: true })
        .range(from, to),
      co.companyId,
    ),
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const counts = new Map<string, number>();
  for (const r of data ?? []) {
    const id = r.salesperson_id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ids = [...counts.keys()];
  if (ids.length === 0) return c.json({ holders: [] });

  const { data: staffRows, error: staffError } = await sb
    .from('staff').select('id, name, staff_code, active').in('id', ids);
  if (staffError) return c.json({ error: 'load_failed', reason: staffError.message }, 500);
  const byId = new Map(
    ((staffRows as Array<Record<string, unknown>> | null) ?? []).map((s) => [String(s.id), s]),
  );

  const holders = ids.map((id) => {
    const s = byId.get(id);
    return {
      staffId: id,
      name: (s?.name as string | null) ?? null,
      staffCode: (s?.staff_code as string | null) ?? null,
      active: (s?.active as boolean | null) ?? null,
      orders: counts.get(id) ?? 0,
    };
  });
  holders.sort((a, b) => b.orders - a.orders
    || (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }));

  return c.json({ holders });
});

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

  const toName = await readStaffAgentName(sb as never, toStaffId);

  const user = c.get('user') as { id?: string; user_metadata?: { name?: string } } | undefined;
  return runScmPgCommand(c, async (tx) => {
    const moved: Array<{ docNo: string }> = [];
    const skipped: Array<{ docNo: string; reason: string }> = [];

    for (const docNo of docNos) {
      const { data: beforeRow, error: readError } = await scopeToCompanyId(
        tx.from('mfg_sales_orders').select('doc_no, salesperson_id, agent, status, linked_ac_docno').eq('doc_no', docNo),
        co.companyId,
      ).maybeSingle();
      if (readError) return c.json({ error: 'handover_failed', message: `${docNo} could not be read, so no order in this batch was moved. Please try again.`, reason: readError.message }, 500);
      if (!beforeRow) { skipped.push({ docNo, reason: 'Not found in this company.' }); continue; }
      const before = beforeRow as unknown as Record<string, unknown>;

      const lock = await migratedSoReadonlyState(c, docNo, before.linked_ac_docno != null);
      if (lock.locked) {
        skipped.push({ docNo, reason: lock.reason ?? 'This order came from AutoCount and is view-only for now.' });
        continue;
      }

      if ((before.salesperson_id as string | null) !== fromStaffId) {
        skipped.push({ docNo, reason: 'No longer attributed to that salesperson.' });
        continue;
      }

      const updates: Record<string, unknown> = { salesperson_id: toStaffId };
      if (toName) updates.agent = toName;
      const { data: movedRow, error } = await scopeToCompanyId(
        tx.from('mfg_sales_orders').update(updates).eq('doc_no', docNo),
        co.companyId,
      ).eq('salesperson_id', fromStaffId).select('doc_no').maybeSingle();
      if (error) return c.json({ error: 'handover_failed', message: `${docNo} could not be moved, so no order in this batch was moved. Please try again.`, reason: error.message }, 500);
      if (!movedRow) { skipped.push({ docNo, reason: 'No longer attributed to that salesperson.' }); continue; }

      const fieldChanges: FieldChange[] = [
        { field: 'salespersonId', from: fromStaffId, to: toStaffId },
        ...(toName && toName !== (before.agent as string | null)
          ? [{ field: 'agent', from: (before.agent as string | null) ?? null, to: toName }]
          : []),
      ];
      await recordSoAudit(tx as unknown as Parameters<typeof recordSoAudit>[0], {
        docNo,
        action: 'UPDATE_DETAILS',
        actorId: user?.id ?? null,
        actorName: user?.user_metadata?.name ?? null,
        fieldChanges,
        statusSnapshot: (before.status as string | null) ?? null,
        note: 'Salesperson handover',
      });

      deferScmAfterCommit(c, async () => {
        await enqueueEdit(sb as never, {
          companyId: co.companyId,
          docType: 'SO',
          docNo,
          touchedFields: ['agent'],
          createdBy: c.get('houzsUser')?.id ?? null,
        });
      });
      moved.push({ docNo });
    }

    return c.json({ fromStaffId, toStaffId, moved, skipped });
  });
});

soHandover.post('/share', async (c) => {
  if (!hasHouzsPerm(c, 'scm.so.attribute_other')) return c.json({ error: 'forbidden' }, 403);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const parsed = parseShareBody(body);
  if (!parsed.ok) return c.json(parsed.payload, parsed.status);
  const { staffIds, docNos, mode } = parsed.req;

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const { data: staffRows, error: staffError } = await sb.from('staff').select('id').in('id', staffIds);
  if (staffError) return c.json({ error: 'load_failed', reason: staffError.message }, 500);
  const known = new Set(((staffRows as Array<{ id?: string }> | null) ?? []).map((r) => r.id));
  const unknown = staffIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return c.json({ error: 'unknown_staff', reason: `Not a salesperson in this system: ${unknown.join(', ')}.` }, 400);
  }

  const user = c.get('user') as { id?: string; user_metadata?: { name?: string } } | undefined;
  const changed: Array<{ docNo: string }> = [];
  const skipped: Array<{ docNo: string; reason: string }> = [];

  for (const docNo of docNos) {
    const { data: beforeRow, error: readError } = await scopeToCompanyId(
      sb.from('mfg_sales_orders').select('doc_no, status, collaborator_staff_ids').eq('doc_no', docNo),
      co.companyId,
    ).maybeSingle();
    if (readError) { skipped.push({ docNo, reason: `Could not be read: ${readError.message}` }); continue; }
    if (!beforeRow) { skipped.push({ docNo, reason: 'Not found in this company.' }); continue; }
    const before = beforeRow as unknown as Record<string, unknown>;

    const current = ((before.collaborator_staff_ids as string[] | null) ?? []).filter((x) => !!x);
    const next = mode === 'remove'
      ? current.filter((id) => !staffIds.includes(id))
      : [...new Set([...current, ...staffIds])];

    if (next.length === current.length && next.every((id) => current.includes(id))) {
      skipped.push({ docNo, reason: mode === 'remove' ? 'None of those people had access.' : 'Already shared with all of them.' });
      continue;
    }

    const { error } = await scopeToCompanyId(
      sb.from('mfg_sales_orders').update({ collaborator_staff_ids: next }).eq('doc_no', docNo),
      co.companyId,
    );
    if (error) { skipped.push({ docNo, reason: error.message }); continue; }

    await recordSoAudit(sb, {
      docNo,
      action: 'UPDATE_DETAILS',
      actorId: user?.id ?? null,
      actorName: user?.user_metadata?.name ?? null,
      fieldChanges: [{ field: 'collaboratorStaffIds', from: current.join(', ') || null, to: next.join(', ') || null }],
      statusSnapshot: (before.status as string | null) ?? null,
      note: mode === 'remove' ? 'Sales order sharing withdrawn' : 'Sales order shared',
    });
    changed.push({ docNo });
  }

  return c.json({ staffIds, mode, changed, skipped });
});
