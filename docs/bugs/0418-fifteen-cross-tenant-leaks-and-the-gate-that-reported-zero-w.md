## Fifteen cross-tenant leaks, and the gate that reported zero while they existed [critical]

<!-- area: Auth, permissions, sessions -->

**Symptom.** Nothing on screen. Every one of these served a correct-looking
answer to whoever asked; that is the shape of the whole class. The measurable
consequence: 79 of 96 live users hold exactly one company, and each of the reads
below handed them the other one's data.

**Root cause (traced).** The SCM Supabase client is SERVICE-ROLE, so migration
0061's RLS runs no policy on an app request — the predicate a statement carries
IS the tenant boundary. Seven distinct ways of not carrying one:

1. `routes/mail-center.ts` GET `/outbox` + `/outbox/:id` had no predicate at all
   on `email_outbox`, whose `company_code` exists (mig 0094). They return
   `body_html` in full, and `routes/auth.ts:374` / `:448` put the one-time
   `/invite/<token>` and `/reset/<token>` links in that body. Cross-tenant
   ACCOUNT TAKEOVER, not disclosure.
2. `routes/assrFormIntake.ts` GET `/status-export` — PRE-AUTH, one shared secret,
   `SELECT ... FROM assr_cases WHERE archived_at IS NULL` for BOTH companies
   including `customer_name`, `phone`, `addr1-4`, `complaint_issue`. Its write
   sibling POST `/delivery-dates`, found in the same pass, resolved a case by
   `assr_no` — not unique across companies — and UPDATEd it.
3. `routes/projects.ts` — the file header asserted "child tables are ALWAYS read
   through their parent project_id". That sentence is why ~30 handlers were never
   re-read, and it is false: `/finance/lines/:lineId`, `/checklist/:itemId`,
   `/sections/:sectionId`, `/defects/:defectId`, `/team/:teamId`,
   `/attachments/:attId`, `/stock-transfers/:tid` carry no parent in the URL and
   no middleware supplies one. `PATCH`/`DELETE /finance/lines/:lineId` was a bare
   `WHERE id = ?` on a table that HAS `company_id` (mig 0170, which explicitly
   declined a column DEFAULT to avoid exactly this). Migration 0292 repeated the
   false claim back.
4. Six purchase-side handlers put the guard on the HEADER id while the LINE id
   came from the request BODY unchecked — `grns.ts` POST `/` and `/:id/items`,
   `purchase-invoices.ts` and `purchase-returns.ts` `/:id/items`, both
   `purchase-consignment-receives.ts` sites, both
   `purchase-consignment-returns.ts` sites. The rollup writers
   (`recomputePoReceived`, `recomputeGrnInvoiced`, `adjustGrnReturnedQty`,
   `recomputePcoReceived`, `adjustPcReceiveReturnedQty`) all end
   `.eq('id', <bodyId>)`, so `received_qty` / `invoiced_qty` / `returned_qty`
   landed on the other tenant's lines, cascading into their PO/PCO status. The
   CREATE path of two of those same files already applied the rule via a
   `parent!inner(company_id)` embed; the add-line path never got it.
5. `scm/routes/hr.ts` GET `/pickers` listed every active `scm.staff` row
   platform-wide with a comment saying it was "unscoped by design", while its
   four immediate siblings in the same `Promise.all` each carried
   `.eq('company_id', ...)`. The premise was true (scm.staff has no company_id,
   mig 0089) and the conclusion did not follow — `scm/lib/staffCompanyScope.ts`
   exists to DERIVE it and its header names this leak class. Chained with
   `staff.ts` GET `/by-ids`, which returns email and phone, it yielded the other
   company's staff directory.
6. `scm/routes/staff.ts` PATCH `/by-user/:userId/showroom` scoped the WAREHOUSE
   half and keyed the write on `user_id` alone, so a HOUZS admin could re-park a
   2990-only salesperson — moving whose venue, fair P&L and commission their
   orders land in. It was invisible to `check-company-scope.mjs` because the
   words "company-scope:" opened a paragraph about the OTHER table in the same
   handler, and the checker's opt-out is a substring match.
7. NO `assertWarehouseInCompany` / `warehouseInCompany` / `requireWarehouse`
   existed anywhere under `backend/src/scm` — grep, 2026-08-18. So
   `stock-takes.ts`, `inventory-adjustments.ts` and `dp-orders.ts` each took a
   warehouse or trip id from the body and each invented its own half-argument for
   why that was safe. One of those arguments was factually wrong:
   `stock-takes.ts` said `v_inventory_all_skus` "has NO company_id column" while
   migration 0156 rebuilt that view as a CONFIRMED LIVE LEAK and appends
   `w.company_id` to it, saying in its own header that it did so "so the route
   can `.eq('company_id', <active>)` it".

**And the gate reported ZERO.** `check-company-scope.mjs` printed `0 of them
WRITE` over all of the above, because it only matches a row addressed BY ID
inside a handler body — a list with no predicate at all has no id, so
`ID_PREDICATE` never fires. Its `DELEGATION_GUARDS` also trusted
`salesDocOutOfScope`, which has no company logic anywhere in it
(`scm/lib/salesScope.ts:86-95` resolves a SALESPERSON subtree); that one entry
was suppressing two real findings. And 67 `// company-scope:` suppressions were
invisible in its output, so nobody re-read them.

**Fix.** Predicates, and one new primitive each for the two shapes that had none:
`activeCompanyCodePred` in `scm/lib/companyScope.ts` (company CODE columns —
binds, does not interpolate, and handles all three states `email_outbox.company_code`
actually holds); `crossCompanySourceRefusal` widened to accept a source LINE
(`docNoColumn: null`) rather than growing a ninth copy of the conversion rule;
`scm/lib/ref-in-company.ts` `assertWarehouseInCompany` + `assertTripInAllowedCompanies`
(per-company vs cross-company predicates, both fail closed on a read error);
`scopeStaffRowsToActiveCompany` moved out of `scm/routes/staff.ts` into
`scm/lib/staffCompanyScope.ts` so hr.ts can reach it; `refuseForeignChild` /
`refuseForeignProject` in `routes/projects.ts` covering 33 handlers.
Three false comments were CORRECTED in place rather than deleted, because each
is why its leak survived a previous sweep.

The checker now sees three shapes it was blind to — SET-READ (a list with no row
narrowing and no company predicate, judged PER STATEMENT so a scoped sibling
cannot excuse it), GLOBAL NATURAL KEY (including an upsert whose `onConflict`
omits `company_id`), and RPC DELEGATION — prints every suppression with its
reason, and links a raw-SQL fragment variable to its definition so the widened
table list does not drown the report. `salesDocOutOfScope` is gone from
`DELEGATION_GUARDS`, taking the by-id count 19 -> 21 on its own.

Four MORE cross-tenant writes fell straight out of the widened checker and are
fixed here too: `routes/assr.ts` POST `/:id/approve` (one company signing off the
other's quality record and stamping its NCR category), DELETE `/:id/track-link`
and DELETE `/:id/supplier-link` (revoking the other company's customer and
supplier portal tokens), POST `/:id/generate-po` (burning a service-PO number
onto the other company's case) — all four keyed on id alone while every sibling
writer in the same file already used `assrCompanySql`.

`tests/crossTenantLeaksRound2.test.ts` — 30 tests, one REFUSAL per leak plus the
DEGRADE case for each, because a fix that blanks single-company Houzs is not a
fix. Every one was proven to BITE: each fix was reverted in turn and the run
re-executed. mail-center handler -> 1 fail; `activeCompanyCodePred` -> 5;
intake predicates -> 2; projects gates -> 2; line refusal -> 1; staff pass -> 3;
`ref-in-company` -> 4; all restored -> 30 passed.

**Not touched, deliberately.** `rename_sofa_compartment` (needs a migration), the
customer-credit atomic RPC (applied by hand), the background agents'
cross-tenant PII emails (needs a design decision), and the deliberately-shared
masters — lorries/drivers/helpers (migs 0121 / 0202-0204), `my_localities`,
`currencies`, `so_scan_*`, `project_event_types`, `project_organizers`.

**Found and NOT fixed, reported instead.** `scm/lib/do-email.ts:180` and
`scm/routes/mfg-purchase-orders.ts:4288` both pass `String(row.company_id)` —
"1" / "2" — into `sendEmail`'s `companyCode`, which wants a CODE.
`brandingKeyForCompany("1")` misses, so every DO and PO email renders its From
display name as the bare number. Not a tenant leak and not fixed here (it changes
outbound branding); `activeCompanyCodePred` accepts the id-as-text form so those
rows stay visible to the right company rather than vanishing from both.

**One more, found while testing the checker rather than the code.**
`check-company-scope.mjs` ended on `process.exit()`. Node's stdout writes are
ASYNCHRONOUS when stdout is a PIPE, so the process was torn down before the
buffer drained and the report was TRUNCATED — silently, and only when a machine
was reading it. Measured 2026-08-18: 8,647 characters through `execFileSync`
against 33,828 on a terminal, with the entire new-shapes section and the
suppression ledger missing. That is the same class of fault as the leaks above —
a gate reporting less than it found. Now `process.exitCode`, so node exits after
the flush; the exit STATUS is unchanged, and
`tests/companyScopeCheckerShapes.test.mjs` reads the script through a pipe on
purpose so it cannot come back.

Ref: fix/cross-tenant-leaks-round2, 2026-08-18.
