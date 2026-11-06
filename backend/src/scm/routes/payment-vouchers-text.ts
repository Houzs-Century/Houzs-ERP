// ----------------------------------------------------------------------------
// PATCH /payment-vouchers/:id/text { notes?, lines?: [{ id, description }] } — a
// voucher's words alone (owner 2026-11-06: 有时我要改 description), until it is
// approved, a checked voucher included (pvCanEditText). Everything else the body
// carries is ignored: no amount, account, payee or stage mark moves, so the voucher
// stays where it is, and the change is on its trail.
// ----------------------------------------------------------------------------

import { requireActiveCompanyId, scopeToCompanyId } from '../lib/companyScope';
import { assertAuditWritable, auditUnavailableBody, compactChanges, fieldChange, recordEntityAudit } from '../lib/entity-audit';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { pvCanEditText, type PvApprovalShape } from '../lib/pv-approval';
import { HEADER } from './payment-vouchers-list';

/* eslint-disable @typescript-eslint/no-explicit-any -- Hono context and PostgREST client, untyped in this router family */
export const updatePaymentVoucherTextHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const id = c.req.param('id');

  const { data: cur, error: curErr } = await scopeToCompanyId(
    sb.from('payment_vouchers').select(HEADER).eq('id', id), co.companyId,
  ).maybeSingle();
  if (curErr) return c.json({ error: 'load_failed', reason: curErr.message }, 500);
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const before = cur as unknown as Record<string, unknown>;
  const allowed = pvCanEditText(before as PvApprovalShape);
  if (!allowed.ok) return c.json({ error: allowed.error, message: allowed.message }, 409);

  /* Every named line is read and checked before anything is written. */
  const { data: lineRows, error: lineErr } = await sb.from('payment_voucher_lines').select('id, description').eq('pv_id', id);
  if (lineErr) return c.json({ error: 'load_failed', reason: lineErr.message }, 500);
  const stored = new Map(((lineRows ?? []) as Array<{ id: string; description: string | null }>).map((l) => [String(l.id), l]));
  const words = (v: unknown): string | null => (typeof v === 'string' ? v.trim() : '') || null;
  const lineChanges: Array<{ id: string; from: string | null; to: string | null }> = [];
  for (const want of (Array.isArray(body.lines) ? body.lines : []) as Array<{ id?: unknown; description?: unknown }>) {
    const line = stored.get(String(want.id));
    if (!line) return c.json({ error: 'line_not_on_voucher', message: 'That line is not on this voucher — open it again.' }, 400);
    const to = words(want.description);
    if (to !== (line.description ?? null)) lineChanges.push({ id: String(line.id), from: line.description ?? null, to });
  }
  const notesTo = body.notes === undefined ? undefined : words(body.notes);
  const notesChange = notesTo === undefined ? null : fieldChange('notes', (before.notes as string | null) ?? null, notesTo);
  if (!notesChange && lineChanges.length === 0) return c.json({ paymentVoucher: cur });

  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_VOUCHER', entityId: id, action: 'UPDATE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  /* Guarded on the row itself: an approval landing in between has written the
     journal with the old words, and then the words stay. */
  const { data: saved, error: saveErr } = await scopeToCompanyId(sb.from('payment_vouchers')
    .update({ ...(notesChange ? { notes: notesTo } : {}), updated_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'DRAFT').is('approved_at', null), co.companyId).select(HEADER).maybeSingle();
  if (saveErr) return c.json({ error: 'save_failed', reason: saveErr.message }, 500);
  if (!saved) return c.json({ error: 'voucher_moved', message: 'This voucher changed a moment ago — open it again.' }, 409);
  for (const l of lineChanges) {
    const { error } = await sb.from('payment_voucher_lines').update({ description: l.to }).eq('id', l.id).eq('pv_id', id);
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  }

  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER', entityId: id, entityDocNo: (before.pv_number as string | null) ?? null,
    action: 'UPDATE', actor: c.get('houzsUser'), companyId: co.companyId,
    statusSnapshot: (before.status as string | null) ?? null,
    fieldChanges: compactChanges([notesChange, ...lineChanges.map((l) => fieldChange('lineDescription', l.from, l.to))]),
  });
  return c.json({ paymentVoucher: saved });
};
