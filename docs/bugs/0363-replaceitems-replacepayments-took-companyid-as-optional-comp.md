## replaceItems / replacePayments took companyId as OPTIONAL — company-blind row writes possible [sev: high]

Symptom: The sales_entries item/payment replace helpers accepted `companyId?: number`. Any caller that forgot the argument would DELETE-then-INSERT sales_entry_items / sales_entry_payments with company_id omitted — company-blind rows on tables whose only tenant boundary is the predicate (service-role client bypasses RLS). No compile error, no test, no runtime signal: the optional-param-noop class.

Root cause traced: backend/src/services/salesEntries.ts declared `companyId?: number` on both replaceItems (line 51) and replacePayments (line 107). Per CLAUDE.md a scope-deciding argument must be `T | null` so the compiler enumerates call sites. Confirmed against current code and all 4 call sites (routes/sales.ts:900,901,1048,1052), each passing activeCompanyId(c) = number | undefined; backend tsconfig strict:true.

Fix: Changed both signatures to `companyId: number | null` (required). Updated the 4 call sites to pass `companyId ?? null`. Behaviour-preserving — both functions already branch on `companyId != null`, so null and the prior undefined take the identical (omit-column) path. Added a source-scan test to keep the hole closed. Ref: (this PR / 2026-08-18).
