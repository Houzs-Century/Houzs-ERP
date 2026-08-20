## Every company-scoped WRITE in the system was missing its company predicate [high]

**Symptom** - no operator-visible symptom, which is the point. A caller switched
to Houzs could `PATCH` a 2990 work order, delete a 2990 invoice line, cancel a
2990 stock transfer or edit a 2990 payment by id, and the write succeeded
silently against the other company's books. Five instances were found and fixed
by hand on 2026-08-13 (payment-vouchers POST, grns PATCH, assr_print GET); this
entry is the sweep that measured how many more there were.

**Root cause** - a 2026-08-10 audit hardened the READS and stopped there, on the
reasoning that a scoped read gates the write that follows it. It does not. The
SCM supabase client is the SERVICE ROLE, so RLS is bypassed and nothing
re-evaluates ownership between two PostgREST round trips: the read 404s on a
foreign id, and the update that follows still names the row by primary key with
no `company_id` at all. Two more shapes hid in the same blind spot - a
parent-ownership predicate (`so_doc_no`, `purchase_invoice_id`, `trip_id`,
`work_order_id`) reads like a scope check but only proves the row is on that
DOCUMENT, not that the document is in your books; and a cross-company module
(TMS trips / delivery planning) was written with NO predicate rather than the
wider `scopeToAllowedCompanies` one, so a dispatcher granted one company could
edit the other's trips.

Measured 2026-08-13 across `backend/src/scm/routes` + `backend/src/routes`: 634
`.from()` write statements target a table carrying `company_id`; **294 of them
carried no company predicate on their own statement**.

**Fix** - the sweep put the predicate on the statement that writes, at the sites
reachable with a client-supplied id and no other company gate, and named the
deliberately-shared ones in comments so the next sweep does not "fix" them:
`currencies` (one global `code` PK - the master IS shared), the TMS fleet masters
(`lorries` / `lorry_maintenance` - one vehicle, one workshop history), and
`lorry_service_records`. `single()` was replaced with `maybeSingle()` wherever a
new predicate can legitimately match zero rows - `single()` renders that honest
404 as a 500.

**Lesson** - **when RLS is bypassed, "the read is scoped" is not a security
property of the write.** Every statement carries its own boundary or it has none.
Hardening a module's reads and calling the module done is how this survived an
audit that was looking straight at it - the audit asked "can this caller SEE the
other company's row", and the answer was no, while "can this caller CHANGE it"
was never asked. If a sweep fixes one half of a read/write pair, the other half
is not follow-up work, it is the same bug.

**Ref** - `sweep/unscoped-write`, 2026-08-13. Convention now in `CLAUDE.md`
(Coding conventions) and `docs/MULTICOMPANY-MODULE-MAP.md`.
