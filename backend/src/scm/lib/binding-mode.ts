/* binding-mode — which companies track stock BY VARIANT.

   Company 1 (Houzs Century) binds bedframe / sofa / Sofa Accessory / dining /
   (SP) mattress lines to the PO raised for them (owner, ruled 2026-08-10,
   2026-08-29, 2026-08-30, restated 2026-11-10: "Houzs Century does not pick
   stock by spec"). Its readiness reads the bound PO and its stock keys stay
   exactly as they have always been computed. Company 2 (2990) pools by
   variant, so its keys are compared canonically and a new movement joins the
   canonically equal stocked bucket (lib/stock-bucket-key.ts).

   HARD_BOUND_COMPANY_ID lives here (re-exported by so-stock-allocation.ts) so
   the key helpers can read it without an import cycle. When the owner moves
   company 1 to the pooled model, this constant is the switch. */
export const HARD_BOUND_COMPANY_ID = 1;

/** True for a company whose stock is tracked and matched by variant. An
 *  unresolved company (null) keeps the legacy behaviour. */
export function variantTrackedCompany(companyId: number | null | undefined): boolean {
  return companyId != null && companyId !== HARD_BOUND_COMPANY_ID;
}
