// PR-D — Sales Order audit trail helper.
// Commander 2026-05-27: "要有 audit trail 的 谁 create 了什么 update 了什么
// from 什么 changes to 什么 在几点几分". Single entry point used by every
// mutation in routes/mfg-sales-orders.ts to append one row to mfg_so_audit_log.
//
// Design notes:
//   - Best-effort. Audit logging must NEVER block the main mutation —
//     a failed insert is logged to console but swallowed silently.
//   - Actor name is snapshotted at write time. If the staff row is later
//     renamed (or deleted), the historic display stays stable.
//   - `fieldChanges` is a free-form array of { field, from, to } objects.
//     The render layer maps `field` to a human label.
//   - `paymentId` tags a payment action (ADD / UPDATE / DELETE_PAYMENT, the
//     proof attach) with the payment it concerns — mfg_so_audit_log.payment_id,
//     migration 20260914T1700 — so the Corrections report can name who first
//     recorded the payment a correction touched (docs/bugs/0888). Optional:
//     rows about the order itself carry none, and older rows read NULL.

import type { SupabaseClient } from '@supabase/supabase-js';

export type FieldChange = {
  field: string;
  from?: unknown;
  to?: unknown;
};

export type SoAuditAction =
  | 'CREATE'
  | 'UPDATE_DETAILS'
  | 'UPDATE_STATUS'
  | 'ADD_PAYMENT'
  | 'UPDATE_PAYMENT'
  | 'DELETE_PAYMENT'
  | 'ADD_LINE'
  | 'UPDATE_LINE'
  | 'DELETE_LINE';

export async function recordSoAudit(
  sb: SupabaseClient,
  args: {
    docNo: string;
    action: SoAuditAction | string;
    actorId?: string | null;
    actorName?: string | null;
    fieldChanges?: FieldChange[];
    statusSnapshot?: string | null;
    source?: string;
    note?: string;
    paymentId?: string | null;
  },
): Promise<void> {
  try {
    let actorName = args.actorName ?? null;
    if (!actorName && args.actorId) {
      try {
        const { data } = await sb.from('staff').select('name').eq('id', args.actorId).maybeSingle();
        actorName = (data as { name?: string } | null)?.name ?? null;
      } catch {
      }
    }

    let companyId: number | null = null;
    try {
      const { data: soRow } = await sb.from('mfg_sales_orders')
        .select('company_id').eq('doc_no', args.docNo).maybeSingle();
      companyId = (soRow as { company_id?: number | null } | null)?.company_id ?? null;
    } catch {
    }

    const { error } = await sb.from('mfg_so_audit_log').insert({
      so_doc_no:           args.docNo,
      ...(companyId != null ? { company_id: companyId } : {}),
      action:              args.action,
      actor_id:            args.actorId ?? null,
      actor_name_snapshot: actorName,
      field_changes:       args.fieldChanges ?? [],
      status_snapshot:     args.statusSnapshot ?? null,
      source:              args.source ?? 'web',
      note:                args.note ?? null,
      ...(args.paymentId ? { payment_id: args.paymentId } : {}),
    });
    if (error) {
      if ((sb as unknown as { __atomicCommand?: boolean }).__atomicCommand === true) {
        throw new Error(`SO audit insert failed: ${error.message}`);
      }
      // eslint-disable-next-line no-console
      console.error('[so-audit] insert failed (non-fatal):', args.docNo, args.action, error.message);
    }
  } catch (e) {
    if ((sb as unknown as { __atomicCommand?: boolean }).__atomicCommand === true) throw e;
    // eslint-disable-next-line no-console
    console.error('[so-audit] unexpected error (non-fatal):', args.docNo, args.action, e);
  }
}

export function diffFields(
  before: Record<string, unknown>,
  patchCamel: Record<string, unknown>,
  aliases: Array<[camel: string, snake: string]>,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const [camel, snake] of aliases) {
    if (patchCamel[camel] === undefined) continue;
    const fromVal = before[snake];
    const toVal = patchCamel[camel];
    const a = fromVal == null ? '' : String(fromVal);
    const b = toVal == null ? '' : String(toVal);
    if (a !== b) out.push({ field: camel, from: fromVal ?? null, to: toVal ?? null });
  }
  return out;
}
