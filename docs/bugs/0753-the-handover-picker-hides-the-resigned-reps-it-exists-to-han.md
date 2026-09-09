## The handover picker hides the resigned reps it exists to hand over [high]

**Symptom.** The owner set out to hand five resigned salespeople's Sales Orders
to one person. Three of them — Luke Yang, Shaung, Stephy — were not in the
panel's "Orders currently with" picker at all: 「这三个 resigned sales - 我在
sales maintenance 没有找到」. Asked whether the ERP had ever known them, he
answered 「autocount 是有的 ERP 没有过记录」 — they exist in the account book and
never had an ERP login.

**Root cause (traced).** `SalespersonHandover`'s From picker reads `useStaff` →
`GET /staff`, whose own comment calls it the FULL roster *because* "an
active-only list would hide the exact case this tool exists for". The handler
(`scm/routes/staff.ts`) then runs `scopeStaffRowsToActiveCompany` on the rows
before returning them, and `staffCompanyIds`
(`scm/lib/staffCompanyScope.ts:88`) attributes a row by its LINK, not by its
orders:

| staff row | attributed to |
|---|---|
| linked ERP user, with company grants | those companies |
| linked ERP user, no grants | HOUZS |
| **no linked ERP user** | **the 2990 mirror** |

A rep imported from AutoCount who never had a login falls in the third row, so
under an active company of HOUZS the picker cannot list them — which is exactly
the population the panel was built for. The roster is not wrong; the picker is
asking it the wrong question.

**Refuted along the way, recorded so nobody re-chases it.** The first escalation
was that these reps have no `scm.staff` row at all, so their orders would carry
only the legacy `agent` text with a NULL `salesperson_id` and be unreachable by
any id-keyed tool. Production says otherwise — `check-so-list-empty.mjs`, run
34326349540: `salesperson_id` is NULL on **3 of 2896** orders in company 1 and
**0 of 165** in company 2. Nearly every order is attributed to a real staff id,
so the staff rows exist; only the LOGIN does not.

**Fix.** Diagnostic first, because the repair is a change to what the picker
reads and the owner had an operation to run today.
`backend/scripts/check-so-holders.mjs` + the **SO holders check (read-only)**
workflow print, per company, every `salesperson_id` holding a non-cancelled
Sales Order — name, code, active flag, order count, how many carry
`linked_ac_docno` (the upper bound on what the migrated-SO lock can refuse), and
a `PICKER` column stating whether `scopeStaffRowsToActiveCompany` would let the
panel select that person under that company. Orders with no `salesperson_id` are
counted separately, split by whether the legacy `agent` text names anybody,
because the handover keys on the id and cannot move either kind.

Read-only by construction: SELECTs only, no DDL, no writes, no transaction,
exit 0 for every legitimate answer so a red job never reads as the finding.

**FIXED, and the diagnostic is what proved the fix was needed.** The probe's
first production run (34336422828) settled two things at once. The three named
reps are `ACIMP-*` rows — AutoCount imports with no ERP login — and **their
orders are in HOUZS**, not 2990: `YANG` 75, `STEPHY` 20, `SHUANG` 10. So the
workaround this entry originally offered — switch company and look again — is
**wrong**, and was corrected the moment there was data: under HOUZS you see the
orders and not the person; under 2990 you see the person and not the orders.
Neither company can complete the handover. And it was never three people:
**22 holders / 339 non-cancelled orders** were unselectable.

The picker now lists ORDER HOLDERS — `GET /api/scm/so-handover/holders`, gated
on the same `scm.so.attribute_other` as the rest of that router because it
enumerates the company's order book, counted the same way `/preview` lists so
the two numbers cannot disagree. A list derived from the orders cannot omit
somebody who holds one.

Pinned by `SalespersonHandover.test.tsx`: the mocked holder `alicia` is inactive
AND absent from the pickable roster, so the assertion that she is selectable
with her 30 orders fails against the old data source by construction.

**Ref.** `diag/so-holders` (probe) + `feat/handover-holders` (fix), 2026-09-09.
Evidence: runs 34326349540 (null-rate) and 34336422828 (the holder census).
