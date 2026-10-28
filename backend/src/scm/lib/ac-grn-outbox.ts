import { enqueueEdit, type AcRetiredLine } from './autocount-outbox';
import { activeCompanyId } from './companyScope';

/**
 * Queue an AutoCount EDIT for a GRN.
 *
 * THE CLIENT IS REQUIRED, AND IT IS WHY THIS LIVES IN ITS OWN FILE.
 *
 * Until 2026-08-20 this sat inside `routes/grns.ts` and read
 * `enqueueEdit(c.get('supabase'), ...)` — it reached PAST its caller for the
 * ordinary PostgREST client. Invisible and harmless while every caller was an
 * ordinary route body using that same client.
 *
 * It stops being harmless the moment a caller runs inside `runScmPgCommand`:
 * the GRN row would be written INSIDE the transaction while this outbox row
 * committed OUTSIDE it, so a rollback leaves AutoCount instructed to edit a line
 * that still exists. The two must land together or not at all. That is the same
 * split-write class the durable-allocation work exists to remove, one system
 * over — see docs/ALLOCATION-DURABILITY-PLAN.md, trap 3.
 *
 * Required rather than optional, per CLAUDE.md: "a parameter that DECIDES
 * something is required, never optional". This one decides WHICH TRANSACTION
 * the outbox row belongs to. Optional would let a future transactional caller
 * silently keep the wrong client with no compile error and no failing test —
 * the `optional-param-noop` bug class at the top of BUG-HISTORY.md.
 *
 * @param c   the request context — read only for company + actor
 * @param sb  the client whose TRANSACTION this row must join
 */
export async function queueAcGrnEdit(
  c: any,
  sb: any,
  id: string,
  retire: AcRetiredLine[] = [],
  newLineIds: string[] = [],   // rows THIS request inserted — docs/bugs/0588
): Promise<void> {
  await enqueueEdit(sb, {
    companyId: activeCompanyId(c),
    docType: 'GR',
    docId: id,
    retire, newLineIds,
    createdBy: c.get('houzsUser')?.id ?? null,
  });
}
