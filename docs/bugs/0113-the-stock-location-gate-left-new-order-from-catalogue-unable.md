## The stock-location gate left "New order from catalogue" unable to raise ANY company-1 order [high]

**Symptom** - on company 1 (Houzs Century), every cart built on
`/scm/sales-orders/new/from-products` was refused at Create with
`422 validation_failed` / `so_state_required` - "Pick the delivery State before
creating this order." There is no State field on that screen, and no way to
reach one without abandoning the cart, so the page could not create an order at
all. Company 2 (2990) was unaffected.

**Root cause** - two correct decisions that were never checked against each
other. The page collects no address BY DESIGN (its own header says "Payments and
address are added on the SO detail after save") and lands CONFIRMED. PR #2112
then made a resolved `sales_location` mandatory at CREATE for the companies in
`LOCATION_REQUIRED_COMPANY_CODES`, gated on `asDraft !== true`. A flow that
collects no State and does not draft satisfies neither arm of that gate.

The gate's own DRAFT exemption was the missing piece and was already sitting
there: `SalesOrderNewGuided` collects no address either and was never affected,
because it lands a draft unconditionally. #2112 recognised the collision on the
from-products page and answered it as UI copy - the page told the operator to
"Switch to Full form" - which is a refusal explained, not an order created, and
it arrived only after the cart was built. (The module guide claimed the page
said so "up front"; it never did. That claim is also fixed.)

**Fix** - the page lands a DRAFT for exactly the companies the location rule
covers, read from the ONE shared list via the new
`companyRequiresStockLocation` in `frontend/src/vendor/scm/lib/so-form-validate.ts`
(twin of the backend predicate of the same name). A draft is never written to
AutoCount, so it owes the account book no Location; the operator adds the
address on the SO detail and confirms there, where the `DRAFT -> live`
transition re-runs the same gate. Nothing is bypassed - the gate is deferred to
the only screen that can satisfy it. Company 2 and every uncovered company keep
landing CONFIRMED, and adding a company to the list now moves this page with it
instead of breaking it. The shared `soStockLocationError` call stays, passed
`asDraft: landsDraft`, so the day this flow stops drafting it is gated
automatically rather than silently minting locationless orders - the same wiring
the guided wizard uses. Page copy and the CTA now say "Save draft SO" and
explain the next step.

**Lesson** - **a gate with an exemption must be checked against every surface,
because the surface that needs the exemption is the one that cannot satisfy the
rule.** #2112 correctly listed all four create surfaces and correctly worked out
that this one could never pass; the step it skipped was asking whether the
exemption it had just written applied. A surface that is told to go and use a
different screen is a surface that has been switched off.

**Ref** - 2026-08-13.
