## The phone's convert-from-Sales-Order picker listed only delivered orders [high]

<!-- area: Delivery, DO, returns -->

**Symptom.** Found by the 2026-09-14 phone-vs-desktop permission audit. On the
phone, Delivery Orders "+" and a Purchase Order's "convert from Sales Order"
open the convert wizard, whose first step lists the Sales Orders a document may
be raised from. It listed only DELIVERED orders. A CONFIRMED, IN_PRODUCTION or
READY_TO_SHIP order — the ones a delivery or a purchase order is actually for —
never appeared, so on the phone those documents could not be raised from a
Sales Order at all.

**Root cause (traced).** `frontend/src/mobile/MobileConvertWizard.tsx` filtered
BOTH source lists with one predicate built from `SI_TRANSFERABLE_DO_STATES`
(LOADED / DISPATCHED / IN_TRANSIT / SIGNED / DELIVERED). That set is the right
rule for a Delivery Order source (DO → Sales Invoice); PR #2407 (2026-08-20)
replaced a hand-typed `!== DRAFT && !== CANCELLED` with it and applied it to the
Sales Order arm too. A Sales Order shares exactly one word with that set,
DELIVERED. The server's create gates never agreed: `firstUndeliverableSo` refuses
only DRAFT / CANCELLED / ON_HOLD / CLOSED and a held order, and the PO gate's
`SO_UNORDERABLE_STATUSES` is pinned equal to it. The other wizard tests pass
`initialSourceId`, which skips step 1, so nothing exercised the list.

**Fix.** The Sales Order arm now filters with `soCanRaiseDo(status, on_hold)`
from `frontend/src/vendor/shared/so-deliverable-states.ts` — the same rule the
DO create gate enforces; the list response already carries `on_hold`. The
Delivery Order arm keeps `SI_TRANSFERABLE_DO_STATES`. Pinned by
`frontend/src/mobile/mobileConvertWizardSourcePicker.test.tsx`, proved RED on
the unfixed tree (2 of 3 failed: SO → DO and SO → PO; the DO → SI case passed on
both trees) and green on the fix with the four existing wizard suites
(14 of 14).

**Ref.** fix/mobile-convert-so-picker, 2026-09-14.
