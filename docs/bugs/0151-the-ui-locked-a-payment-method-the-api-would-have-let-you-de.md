## The UI locked a payment method the API would have let you delete [medium]

**Symptom.** SO Maintenance renders the `Installment` payment-method row locked
— value / active / delete disabled, tooltip "it can't be removed or turned off"
— while the API would have accepted deleting it.

**Root cause.** `isCorePaymentMethodRow` was inferred from
`PAYMENT_METHOD_VALUE_TO_CODE`, so ONE constant answered two questions with
opposite needs: `paymentMethodCodeForValue` deliberately EXCLUDES `Installment`
(legacy installment ledger rows persist the code directly), while the lock check
must INCLUDE it (it is wired into order logic — the DO payment schema is
`z.enum([...,'installment'])`). The frontend and backend copies landed on
opposite answers, and their comments said so out loud: frontend "the FOUR core
method rows … the API mirrors this with a 409"; backend "the THREE locked core
rows … 'Installment' is NOT core".

**Fix.** `PAYMENT_METHOD_CORE_VALUES` declared explicitly on both sides, four
entries. `VALUE_TO_CODE` keeps its documented three.

**How it was found, and the general lesson.** New
`backend/scripts/check-shared-mirrors.mjs`. The frontend does NOT import the
backend's rule modules — it VENDORS COPIES. Only `phone.ts` has a byte-identical
canonical test, which is exactly why phone normalisation has never drifted. Of 41
rule modules, this was the one real divergence.

**Ref** - `fix/company-scope-sweep`, 2026-08-13.
