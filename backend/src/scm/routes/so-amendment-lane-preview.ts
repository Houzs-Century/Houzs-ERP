// so-amendment-lane-preview — tells the requester which desk a Sales Order
// amendment WILL go to, before they submit it.
//
// Owner 2026-09-15, option B of 「后期再发生可以给我选项选择approver?」: the
// approver is not the requester's to choose (the lane table in
// shared/amendment-lane.ts is the single source of truth, and twice this month
// the rule was what needed fixing — docs/bugs/0816, 0895), but the requester
// should SEE the answer before the row exists, and be able to flag it when it
// looks wrong. This route is the "see" half; the flag rides the submit body
// (laneFlagNote) and lands on scm.so_amendments.lane_flag_note.
//
// It answers with the SAME function the submit route stores from
// (lib/amendment-lane-resolve), so the desk shown is the desk the row lands on.
// Read-only: it writes nothing and mints no number. In its own file because
// routes/mfg-sales-orders.ts is at its file-size ceiling; mounted on the
// /mfg-sales-orders prefix ahead of the main router (scm/index.ts), so it sits
// behind the same area guard and migrated-SO lock.

import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { hasHouzsPerm, isSalesCaller } from '../lib/houzs-perms';
import { activeCompanyId } from '../lib/companyScope';
import { soAmendableHeaderFields } from '../shared/so-field-policy';
import { resolveAmendmentLaneSplit, summarizeLaneSplit } from '../lib/amendment-lane-resolve';
import { dropNoopAmendmentLines, type NoopCheckLine } from '../lib/amendment-noop-lines';
import { LINE_BUILD_ERRORS } from '../lib/amendment-lines';

const AMENDABLE_HEADER_FIELDS: Record<string, string> = soAmendableHeaderFields();

export const soAmendmentLanePreview = new Hono<{ Bindings: Env; Variables: Variables }>();

// Every SCM sub-router mounts its own auth bridge (scmRouterBridge.test.ts); the
// route reads c.get('supabase'), which this middleware sets.
soAmendmentLanePreview.use('*', supabaseAuth);

soAmendmentLanePreview.post('/:docNo/amendments/lane-preview', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');

  /* Same submit gate as POST /:docNo/amendments — whoever may raise may ask. */
  const isLaneApprover =
    hasHouzsPerm(c, 'scm.amendment.approve_lines') || hasHouzsPerm(c, 'scm.amendment.approve_delivery');
  if (!hasHouzsPerm(c, 'scm.amendment.create') && !isSalesCaller(c) && !isLaneApprover) {
    return c.json({ error: 'amendment_create_forbidden' }, 403);
  }

  let body: {
    headerChanges?: Record<string, unknown> | null;
    lines?: Array<NoopCheckLine>;
  };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }

  /* Own keys only, same trust boundary as the submit route: an unknown key is
     refused, not classified — classifyHeaderKey throws on one. */
  const headerChanges: Record<string, string | null> = {};
  const raw = body.headerChanges;
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (!Object.prototype.hasOwnProperty.call(AMENDABLE_HEADER_FIELDS, k)) {
        return c.json({ error: 'header_field_not_amendable', reason: `These fields cannot be changed by an amendment: ${k}.` }, 400);
      }
      if (v !== null && typeof v !== 'string') return c.json({ error: 'header_field_invalid' }, 400);
      headerChanges[k] = v;
    }
  }
  const rawLines = (Array.isArray(body.lines) ? body.lines : []).map((l) => ({
    salesOrderItemId: typeof l?.salesOrderItemId === 'string' ? l.salesOrderItemId : null,
    changeType: typeof l?.changeType === 'string' ? l.changeType : undefined,
    newItemCode: typeof l?.newItemCode === 'string' ? l.newItemCode : null,
    newVariants: l?.newVariants ?? null,
    newQty: typeof l?.newQty === 'number' ? l.newQty : null,
    newUnitPriceSen: typeof l?.newUnitPriceSen === 'number' ? l.newUnitPriceSen : null,
    newRemark: typeof l?.newRemark === 'string' ? l.newRemark : null,
    newDiscountSen: typeof l?.newDiscountSen === 'number' ? l.newDiscountSen : null,
  }));

  /* Same two steps as the submit route, in the same order: drop the lines that
     ask for nothing, then split what is left. A no-op line must not be shown as
     a desk the submit will never ask. */
  const noopSplit = await dropNoopAmendmentLines(sb, docNo, rawLines);
  if (!noopSplit) return c.json(LINE_BUILD_ERRORS.unreadable, 500);
  const split = await resolveAmendmentLaneSplit(sb, docNo, activeCompanyId(c), headerChanges, noopSplit.kept);
  if (!split) return c.json(LINE_BUILD_ERRORS.unreadable, 500);
  return c.json({ ...summarizeLaneSplit(split), droppedNoopLines: noopSplit.dropped.length });
});
