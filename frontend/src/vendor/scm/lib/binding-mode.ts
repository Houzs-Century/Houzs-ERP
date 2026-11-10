/* binding-mode (frontend) — which companies track stock BY VARIANT.

   The browser half of backend/src/scm/lib/binding-mode.ts. Company 1 (Houzs
   Century) binds bedframe / sofa lines to the PO raised for them and keeps
   today's line-card behaviour exactly. Company 2 (2990) pools stock by variant,
   so a saved line opened in the line card or mobile SO is not rewritten (no
   Total Height, no sofa leg "Default" added on open): that rewrite moved the
   line into a stock bucket the received goods were not in (PR #5609).
   An unresolved company keeps the legacy behaviour. */
import { getActiveCompanyId } from '../../../lib/activeCompany';

export const HARD_BOUND_COMPANY_ID = 1;

export function variantTrackedCompany(companyId: number | null | undefined): boolean {
  return companyId != null && companyId !== HARD_BOUND_COMPANY_ID;
}

/** The active company's mode, read where a line card renders. */
export const activeCompanyTracksVariants = (): boolean => variantTrackedCompany(getActiveCompanyId());
