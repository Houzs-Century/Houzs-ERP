/* ----------------------------------------------------------------------------
   so-has-po-assignments — WHERE each PO in a "PO already generated for this
   Sales Order" prompt is actually going now.

   The prompt (so-line-po-duplicate.ts) names the POs a line was RAISED on. But a
   PO is a PO: MRP hands its goods to whichever order needs them first (by
   variant / delivery date), and the raise-link is only provenance. So a line
   could read "already on HC-PO-2611-143, HC-PO-2611-256" while MRP had given
   both to two other orders and the line was short again (HC-SO-003726, owner
   2026-11-19: PO 已经被分配给别的SO 了就代表不是了 ... show 这两个PO assign给什么SO).

   Each line of the 409 body gains `assignedTo` (the SOs MRP assigns that PO's
   SKU to now) and `coversThisSo`. Computed only when the prompt is about to
   show, so the common path pays nothing. A failed read keeps the prompt and
   says the assignment could not be read - never a silent omission.
   -------------------------------------------------------------------------- */
import type { Context } from 'hono';
import { activeCompanyId } from './companyScope';
import { resolvePoSoCoveragePerSkuForPos, type SkuOrigin } from '../routes/po-so-coverage';
import type { soHasPoRefusal, SoLinePoHit } from './so-line-po-duplicate';

type Refusal = NonNullable<ReturnType<typeof soHasPoRefusal>>;
export type AssignedHit = SoLinePoHit & { assignedTo: string[] | null; coversThisSo: boolean | null };

/** Pure: the SOs a PO's SKU is assigned to, and whether one of them is the line's own SO. */
export function assignmentOf(origins: readonly SkuOrigin[] | undefined, hit: SoLinePoHit): { assignedTo: string[]; coversThisSo: boolean } {
  const code = (hit.itemCode ?? '').trim().toUpperCase();
  const origin = (origins ?? []).find((o) => o.itemCode.trim().toUpperCase() === code);
  const assignedTo = [...new Set((origin?.assignments ?? []).map((a) => a.soDocNo))].sort();
  return { assignedTo, coversThisSo: hit.soDocNo != null && assignedTo.includes(hit.soDocNo) };
}

export async function withMrpAssignments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client is untyped
  sb: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Hono route context; only env and the company var are read
  c: Context<any>,
  refusal: Refusal,
): Promise<Refusal & { lines: AssignedHit[]; assignmentError: string | null }> {
  const unread = (why: string) => ({
    ...refusal,
    lines: refusal.lines.map((l) => ({ ...l, assignedTo: null, coversThisSo: null })),
    assignmentError: why,
  });
  try {
    const companyId = activeCompanyId(c);
    if (companyId == null) return unread('no active company');
    const { data, error } = await sb.from('purchase_orders').select('id, po_number')
      .eq('company_id', companyId).in('po_number', refusal.poNumbers);
    if (error) return unread(error.message);
    const idByNo = new Map(((data ?? []) as Array<{ id: string; po_number: string }>).map((r) => [r.po_number, r.id]));
    const perSku = await resolvePoSoCoveragePerSkuForPos(sb, c, [...idByNo.values()], null);
    return {
      ...refusal,
      lines: refusal.lines.map((l) => {
        const id = idByNo.get(l.poNumber);
        return { ...l, ...assignmentOf(id ? perSku.get(id) : undefined, l) };
      }),
      assignmentError: null,
    };
  } catch (e) {
    return unread(e instanceof Error ? e.message : String(e));
  }
}
