# Houzs ERP — One-Sided Rules COE (Correction of Error)

**Date:** 2026-08-13
**Trigger (owner, verbatim):** "我点了 deactivate 它也是没反应" · "明明是当我有 ProcessingDate 和 DeliveryDate 的时候，它才 compulsory，现在怎么变成就算没有 ProcessingDate，也强制要求我填写了？" · "怎么出现那么多 bug 呢？" · "问了第一次第二次第三次给答案全部不一样"
**Status:** Root causes traced and fixed on `fix/company-scope-sweep` (not merged). Three mechanical checks added. Owner decisions listed in §5.

---

## 1. What this COE is about

Not one bug. A SHAPE of bug that this codebase produces repeatedly, and which is
almost impossible to report:

> **A rule exists on one side and not the other, and when the two disagree the
> loser says nothing.**

Every symptom above is one instance:

| What the owner saw | The two sides |
|---|---|
| "Deactivate does nothing" | the server refused; the UI had no `onError` and dropped the answer |
| "variants are compulsory without a Processing Date" | the UI required them; that document's own route never asked |
| "the payment method can't be deleted" | the UI locked the row; the API would have allowed it |
| the same question answered three different ways | the fact had two homes and they disagreed |

The user cannot report these usefully ("the button does nothing") and the
developer cannot see them either, because **nothing failed loudly enough to go
looking for**. That combination is what makes the bug count feel endless.

---

## 2. Root causes, traced

### 2.1 A default that hides a decision

`SoLineCard` declared `variantsRequired = true`, commented "DEFAULT true so
Consignment + any other consumer is unchanged (owner 2026-07-14)". Eleven render
sites exist. **Two** passed the prop. The other nine silently inherited `true`.

Verified against each document's own route, not against any doc:

- `consignment-orders.ts:687` runs the variant check `procDate ? ... : []`, and
  its PATCH (`:1267`) only collects offenders when `internalExpectedDd` is set —
  **conditional**.
- `consignment-notes.ts`, `consignment-returns.ts`, `delivery-returns.ts`,
  `sales-invoices.ts` — `findIncompleteVariantLines` appears **zero** times. The
  requirement was pure client-side invention.

A default is a decision nobody reviews. `variantsRequired` is now a REQUIRED
prop: forgetting it is a compile error.

### 2.2 A rule with two homes and no referee

The frontend does **not** import the backend's rule modules. It **vendors
copies** — `frontend/src/vendor/shared/*` and `vendor/scm/lib/*` against
`backend/src/scm/shared/*`. One pair carries a byte-identical canonical test
(`phone.ts` / `phone.canonical.test.ts`), and that is precisely why phone
normalisation has never drifted. The rest had no referee.

`backend/scripts/check-shared-mirrors.mjs` now compares every pair — not whole
files (one copy is a superset, another a documented slice, most differ only in a
vendoring header) but **the body of each function both sides define**. Of 41
modules it found one real divergence:

`isCorePaymentMethodRow` was inferred from `PAYMENT_METHOD_VALUE_TO_CODE`, so ONE
constant answered two questions with opposite needs — `paymentMethodCodeForValue`
must EXCLUDE `Installment` (legacy ledger rows persist the code directly),
`isCorePaymentMethodRow` must INCLUDE it (it is wired into order logic). The two
copies landed on opposite answers, and **their comments say so out loud**:
frontend "the FOUR core method rows … the API mirrors this with a 409"; backend
"the THREE locked core rows … 'Installment' is NOT core, so it returns false".

### 2.3 A failure with nowhere to go

`fabric-queries.ts` had nine mutations, nine `onSuccess`, and **zero** `onError`.
`serviceNotify` was already imported in that file — for one SUCCESS toast. Only
the failure half was missing.

`frontend/scripts/check-silent-mutations.mjs` walks all 297 `useMutation` sites
and then does a SECOND pass over each hook's consumers, because "no onError" is
not the same as "nobody catches it": 182 are CAUGHT (a consumer awaits
`mutateAsync`, reads `.isError`, or passes per-call `.mutate(vars, { onError })`),
53 are UNRESOLVED and listed for a human, and **35 were genuinely SILENT**. All
35 fixed.

### 2.4 A column added without changing the key

`scm.pos_carts` arrived from the 2990 import keyed `staff_id uuid PRIMARY KEY`.
Migration 0100 added `company_id` so the merged backend could scope carts per
company — its own header says carts "must be company-scoped … like every other
per-company module" — and left the PRIMARY KEY alone. A column was added; the KEY
was not.

So a salesperson who works both companies: builds a Houzs cart → switches to
2990 (scoped GET correctly finds nothing) → saves one line → the upsert
`onConflict: 'staff_id'` hits **the same row** → switches back → **the Houzs cart
is gone**. No error, and the loss is indistinguishable from "I never saved it".

Migration `0284_scm_pos_cart_company_key.sql` re-keys it `(staff_id, company_id)`.
The same shape is UNFIXED in `model_fabric_tier_overrides` and
`compartment_fabric_tier_overrides` — see §5.

### 2.5 A guard on one sibling and not the other

Repeatedly, and it is worth listing because the pattern is the finding:

| hardened | left open |
|---|---|
| `cancelPaymentVoucherHandler` (audit PR #826 item 4) | `postPaymentVoucherHandler` — writes the GL |
| `GET /trips/active/locations` | `GET /trips/:id/locations/latest` — live driver GPS |
| every stock-take sibling (2026-07-22 audit) | `stock-transfers PATCH /:id/cancel` |
| SO/CO variant rule | consignment + downstream forms |
| mobile SO address rule (owner 2026-07-03) | desktop `SalesOrderNew` has **no** address rule |

---

## 3. Fixes shipped

Branch `fix/company-scope-sweep`, nine commits, **not merged**.

| Commit | What | Effect |
|---|---|---|
| `bbffc6cb` | company dimension on the shared SO guard (18 handlers) + PV PATCH | four SO payment verbs bounded |
| `e3341332` | two real cross-company deletes; unified-fleet exemptions documented | 11 handlers proven exempt, 2 fixed |
| `2c2036be` | every by-id trip read and write bounded | incl. live driver GPS |
| `92b51658` | repaired the scope scanner's dead regex; fixed the PV **post** it was hiding | cross-company GL posting closed |
| `3685086d` | POS cart re-keyed per company (mig 0284); 3 more deletes scoped | silent cart destruction closed |
| `e1fb493b` | 35 silent frontend mutations; DO payment endpoints scoped | a refusal now reaches the user |
| `bbf3e810` | `variantsRequired` on all 11 sites; default removed | UI matches each server |
| `9296dfb9` | `PAYMENT_METHOD_CORE_VALUES` split out on both sides | UI and API agree |
| `c1226df2` | last unscoped write + 9 read leaks + 7 ported `/linked` fixes | scanner WRITE findings = 0 |

**Mechanical checks added** (all dependency-free so they run in a fresh worktree):

- `backend/scripts/check-company-scope.mjs` — 632 SCM handlers. **25 WRITE
  findings → 0.**
- `frontend/scripts/check-silent-mutations.mjs` — 297 mutations. **35 SILENT → 0.**
- `backend/scripts/check-shared-mirrors.mjs` — 41 rule pairs. **1 DIVERGED → 0.**

None is wired as a CI gate yet — see §5.

---

## 4. What the audit RULED OUT

This section is not padding. It is what stops the next person re-chasing a
theory already disproved.

- **The fleet-maintenance module is NOT missing company scope.** Seven by-id
  writers look unguarded and are correct. Migrations 0202/0203/0204/0238 each
  state `company_id` is "STAMPED on insert for provenance but NOT used to scope
  reads"; `scm.lorries` has no `company_id` at all ("one shared lorry fleet
  across ALL companies"); and `GET /dashboard` reads every plan, breakdown and
  work order with no company predicate. **Scoping only the writers would have
  left the dashboard listing rows whose PATCH 404s.** `scm.workshops` inside the
  same file IS per-company and already scoped — the file is not blanket-exempt.
- **`my_localities`, `so_scan_samples`, `scm.staff` are NOT unscoped by mistake.**
  Verified in their CREATE TABLEs: `my_localities` (2990s-full-schema.sql:786) and
  `so_scan_samples` (mig 0023) have no `company_id` column at all; mig 0089 lists
  `staff` explicitly under "Deliberately NOT stamped (shared / per-staff
  reference data)", which is why `hr_salesperson_profiles` is
  `UNIQUE(company_id, staff_id)` — one staff row, one profile per company.
- **RLS is not protecting any SCM route.** Mig 0061 enabled RLS on every `scm`
  table with NO policies, and the SCM client is the SERVICE-ROLE client
  (`db/supabase.ts` `getSupabaseService`), which bypasses RLS by convention and
  by that migration's own stated intent. Several handlers carry an
  `error.code === '42501' → 403` branch that reads like a database permission
  check; **it cannot fire on these paths**. The only boundary is the predicate in
  the route.
- **`so-amendments` is not unscoped.** All six mutation gates share
  `loadAmendmentForWrite` (`:122`), which calls `scopeToCompany`.
- **The `/:id/items/:itemId/...` "belongs to this document" checks are not
  authorisation.** Both values come from the caller, so they prove the pair is
  consistent, never whose document it is.

---

## 5. Deferred — owner decisions

| Item | Why it is yours |
|---|---|
| `model_fabric_tier_overrides` / `compartment_fabric_tier_overrides` PK is the single business column (`2990s-full-schema.sql:770`, mig 0025:11). One company's upsert overwrites the other's. | Making it `(company_id, model_id)` is a migration AND a business question: do you want per-company fabric-tier deltas at all, or is one shared table the intent? |
| The desktop `SalesOrderNew` has no address rule; mobile and the backend both have one. | Adding a required field is your call, not a bug fix. |
| `SalesOrderNew`'s confirm gate (`:1443`, your decision 2026-08-08, HC-SO-2607-008) requires category axes on CONFIRM "date or no date", while the line card shows nothing required without a date. The marker and the gate disagree. | Which side moves is a product decision. |
| Wiring the three checks as PR-gated CI. | They are at zero now, so `--strict` would hold. Gate on the PR, **never** on deploy — `audit:routes` as a deploy gate jammed production twice. |

---

## 6. Lessons

1. **A default is a decision nobody reviews.** `variantsRequired = true` and
   `staff_id PRIMARY KEY` are the same bug in two languages: something was left
   implicit, and nine call sites / two companies inherited it silently. Prefer a
   required parameter over a defaulted one wherever the right answer differs per
   caller.

2. **A failure that reaches nobody is worse than a crash.** Thirty-five write
   paths refused correctly and told no one. Budget an error path per mutation the
   way you budget a success path.

3. **Read the DDL's own words, not its column list.** Counting `company_id`
   columns gave the WRONG answer twice, in opposite directions: first "these
   tables have no company_id" (they did, declared in their own CREATE TABLE
   rather than in 0083's bulk ALTER), then "they have company_id so they must be
   scoped" (their headers say the column is provenance only). Both times the
   authority was the migration header plus the read path.

4. **A checker that cannot match reports a clean run.** This happened TWICE in
   one day. `check-company-scope.mjs` lost a backslash — `"\s"` in a JS string is
   the letter `s`, `"\b"` is byte 0x08 — so its named-handler regex never matched
   and it silently scanned the WRONG function bodies for weeks; repairing it took
   the count from 34 findings **up** to 37, and the extra was a cross-company GL
   posting. `check-shared-mirrors.mjs` extracted only `export function`, missed
   `export const foo = () => {}`, compared **zero** functions in nine of thirteen
   pairs, and printed "every shared function is identical" about an empty set.
   Every checker in this repo now self-tests its patterns at startup and refuses
   to report rather than report from a dead one. **A verdict computed over
   nothing must never read as a pass.**

5. **The size of a finding set is a property of the question, not of the
   system.** Every number in this COE went UP when a tool got more honest. That
   is the tool improving, not the system degrading — and saying so plainly is the
   only way the numbers stay usable.

6. **Two homes, no referee.** `phone.ts` has never drifted because one test
   asserts the two copies are byte-identical. That test is the cheapest thing in
   this document and it is the only reason one of 41 rule pairs is provably safe.
