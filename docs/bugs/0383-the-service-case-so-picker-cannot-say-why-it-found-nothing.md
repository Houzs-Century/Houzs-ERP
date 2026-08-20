## The Service Case SO picker cannot say WHY it found nothing [medium]

**Symptom.** 2026-08-19: a salesperson typed `SO-005263`, the picker answered
"No matching sales orders", and *Create Service Case* stayed disabled. Two
different causes were proposed and both were guesses, because the screen carries
nothing that separates them.

**Root cause (traced).** `GET /api/assr/search-so` can come back empty for three
unrelated reasons and they need three different fixes:

1. `requireServiceCaseAccess()` 403s the caller. The gate is
   `canAccessServiceCases` (`assr.ts:98-106`), which admits the
   `service_cases.read` holder **or** `isSalesUser` **or** `isDirectorUser` —
   and `isSalesUser` (`services/pmsAccess.ts:146-152`) tests the TEXT of
   `position_name` against a regex and `department_name` for the substring
   "sales". So a real salesperson whose position/department field is blank or
   spelled another way is refused, and the RBAC input that decides it is a
   free-text field nobody would think to check.
2. The bare `SO-XXXXXX` mirror block is skipped: `assr.ts:1256-1260` only reads
   `sales_orders` when the caller's allowed companies include HOUZS.
3. The row is genuinely absent, or present with a differently-formatted
   `doc_no`, so the `LIKE` never matches.

**Fix.** `check-so-visible-to-user.mjs` + a `workflow_dispatch` that takes the SO
number and the person, and prints which of the three it is — including the
position/department text and whether it "reads as SALES to the gate", plus a
digits-only re-search that separates *absent* from *spelled differently*.

**Ref.** `chore/tenant-isolation-probe`, 2026-08-19.
