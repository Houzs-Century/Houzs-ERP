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
import { paginateAll } from '../lib/paginate-all';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { recordSoAudit, type FieldChange } from '../lib/so-audit';
import { readStaffAgentName } from '../lib/so-agent';
/* THE THIRD DOOR ONTO A MIGRATED SALES ORDER. `/mfg-sales-orders/*` and
   `/so-amendments/*` are both guarded by the router-level migratedSoReadonly
   factory (scm/index.ts); this route is not, and cannot be — that factory
   reads the document number out of the PATH, and `POST /apply` carries a
   LIST of them in the body. So the same decision is asked here, per order,
   through the SAME function the guard and the SO detail screen both use.
   It writes `salesperson_id` and `agent`, which are two of the fields
   sync-ac-delta's header lane copies back from AutoCount. */
import { migratedSoReadonlyState } from '../lib/migrated-so-readonly';
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

/* Same shape and the same testability as parseHandoverBody. */
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

  /* ADD is the default and REPLACE is deliberately not offered. The operator is
     acting on up to 25 orders they cannot see the current collaborators of, so a
     replace would silently drop a grant somebody else made — the bulk-tool
     version of losing data. Removal is explicit and equally bulk. */
  const mode = body.mode === 'remove' ? 'remove' : 'add';

  return { ok: true, req: { staffIds, docNos, mode } };
}

/* GET /preview?from=<staffId> — every order currently attributed to that
   salesperson, in this company. `total` is what the operator is committing to;
   `truncated` says the list is not all of it. */
/* GET /holders — WHO holds this company's Sales Orders.
 *
 * The panel's "Orders currently with" picker used to read GET /staff, and that
 * is the wrong question. `/staff` is company-scoped by the caller's LINK
 * (scm/lib/staffCompanyScope.ts `staffCompanyIds`): a staff row with no ERP
 * login is bucketed to the 2990 mirror, which is the normal shape for an
 * AutoCount-imported rep who resigned years ago — exactly the person this panel
 * exists to hand over. Measured on production 2026-09-09 (run 34336422828):
 * 22 holders / 339 non-cancelled orders in HOUZS were unselectable, including
 * all three reps the owner came to move. Switching company does not rescue it —
 * their ORDERS are in HOUZS while their staff rows answer to 2990, so neither
 * company can complete the handover.
 *
 * A holder list cannot omit a holder: it is derived from the orders themselves.
 *
 * Counted the SAME way `/preview` lists — company-scoped, no status filter — so
 * the number on the picker and the number on the list that follows it cannot
 * disagree. (A cancelled order is still attributed to somebody; `/apply` is what
 * decides per order whether it may move.)
 *
 * Gated on `scm.so.attribute_other` like the rest of this router: it enumerates
 * the company's order book by salesperson.
 */
soHandover.get('/holders', async (c) => {
  if (!hasHouzsPerm(c, 'scm.so.attribute_other')) return c.json({ error: 'forbidden' }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  /* Every attributed order's salesperson, reduced in JS. The alternative is a
     grouped PostgREST aggregate, which this codebase already keeps a JS
     fallback for (lib/status-counts.ts) because aggregates can be disabled on
     the instance — one path that always works beats two that disagree. */
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

  /* Names by id — deliberately NOT the scoped roster. These ids came out of
     this company's own orders, so resolving them leaks nothing the caller
     cannot already enumerate, and a name that fails to resolve must still be
     selectable (it is somebody's order book). */
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
  /* Most orders first — the person with fifty is the one being handed over, and
     an alphabetical list buries them among people with one. */
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
    const { data: beforeRow, error: readError } = await scopeToCompanyId(
      sb.from('mfg_sales_orders').select('doc_no, salesperson_id, agent, status, linked_ac_docno').eq('doc_no', docNo),
      co.companyId,
    ).maybeSingle();
    /* A FAILED read and an order that is genuinely not here are different
       facts, and only one of them is the operator's to act on. Reporting a
       dropped connection as "Not found in this company" would send them looking
       for a company mix-up that never happened. */
    if (readError) { skipped.push({ docNo, reason: `Could not be read: ${readError.message}` }); continue; }
    if (!beforeRow) { skipped.push({ docNo, reason: 'Not found in this company.' }); continue; }
    const before = beforeRow as unknown as Record<string, unknown>;

    /* MIGRATED ORDERS ARE READ-ONLY WHILE THE LOCK IS ON, here too. The
       `isMigrated` argument is REQUIRED and `boolean | null`: this route has the
       answer for free off the row it just read (`linked_ac_docno` is the
       import's own stamp, and the predicate is soIsMigrated's), so it says so
       rather than letting the decision inherit a default. The refusal goes into
       `skipped` with the lock's own sentence, which is the only reason this is
       safe to add: a handover that silently dropped an order is exactly the
       failure this route's per-order report exists to prevent. */
    /* `docNo` as well, since 2026-09-08: in CORRECTNESS mode the decision is
       per document and the sentence has to name the one it is about, so this
       route hands over the document it is looking at rather than letting the
       refusal speak about the class. Everything else here is unchanged - the
       refusal still lands in `skipped` with the lock's own sentence. */
    const lock = await migratedSoReadonlyState(c, docNo, before.linked_ac_docno != null);
    if (lock.locked) {
      skipped.push({ docNo, reason: lock.reason ?? 'This order came from AutoCount and is view-only for now.' });
      continue;
    }

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

/* POST /share — grant (or withdraw) ACCESS on a batch, without touching who the
   order is attributed to. Per-order reporting for the same reason /apply has it.

   THE MIGRATED-SO LOCK IS DELIBERATELY NOT ASKED HERE, and that is the one
   decision in this handler worth arguing with. The lock exists because an
   order whose ERP copy already differs from the AutoCount book must not be
   edited further in ways that widen the gap (docs/migrated-so-lock.md).
   `collaborator_staff_ids` has no counterpart in the account book at all — it
   is an ERP access-control column, nothing syncs it, and no verdict can ever
   disagree about it. Asking the lock here would instead mean the 2,676 migrated
   open orders could never be shared, which is most of the book and exactly the
   population a resignation leaves stranded. /apply still asks, because /apply
   writes `agent`, which IS an AutoCount field. */
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

  /* Every id must resolve to a real staff row before anything is written. These
     come from a picker, so an id that does not resolve is a bug or a stale tab —
     and a uuid silently written into the array would grant access to nobody
     while reading, on the panel, as though it had worked. */
  const { data: staffRows, error: staffError } = await sb.from('staff').select('id').in('id', staffIds);
  if (staffError) return c.json({ error: 'load_failed', reason: staffError.message }, 500);
  /* Cast BEFORE defaulting, not after: a PostgREST read really can answer
     `data: null`, and `(rows ?? []) as T[]` hides that behind a shape the linter
     then calls a redundant guard. */
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
    /* A failed read and an order that is genuinely not here are different facts,
       and only one of them is the operator's to act on — same rule as /apply. */
    if (readError) { skipped.push({ docNo, reason: `Could not be read: ${readError.message}` }); continue; }
    if (!beforeRow) { skipped.push({ docNo, reason: 'Not found in this company.' }); continue; }
    const before = beforeRow as unknown as Record<string, unknown>;

    const current = ((before.collaborator_staff_ids as string[] | null) ?? []).filter((x) => !!x);
    const next = mode === 'remove'
      ? current.filter((id) => !staffIds.includes(id))
      : [...new Set([...current, ...staffIds])];

    /* Nothing to do is reported, not silently counted as done: an operator who
       ran the same grant twice should see that the second run changed nothing
       rather than believing it re-applied. */
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
