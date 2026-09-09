## AP Invoices answered 403 to every read and could not save — the router never mounted the SCM bridge [high]

<!-- area: Accounting + GL -->

**Symptom.** The owner (2026-09-06, screenshot): the new Finance → AP
Invoices page showed "No supplier invoices here yet" for company 2990,
which holds 52 posted purchase invoices the list is meant to mirror. The
same afternoon's probes from his own session: `GET /api/scm/ap-invoices`
→ 403 "You don't have permission to see supplier invoices"; `GET
/api/scm/receipts` → 500; `GET /api/scm/other-debtors` → 500; `POST
/api/scm/other-debtors` → 403. So the Receipts money-in list (2026-09-03)
and the whole Other Debtors module (2026-09-03) had been dead in
production since they shipped, and nobody had opened them yet.

**Root cause (traced).** `backend/src/scm/index.ts` mounts NO global
`supabaseAuth`; each sub-router must declare `<router>.use('*',
supabaseAuth)` itself (96 of 100 did). That bridge is what stashes the
real caller as `houzsUser` — the only thing `hasHouzsPerm`
(`lib/houzs-perms.ts`) reads — and sets `c.get('supabase')`. Three routers
were written without the line: `routes/ap-invoices.ts` (its `canSee`
read `houzsUser` = undefined → granted `[]` → 403 on every read;
`c.get('supabase')` undefined → a write would have thrown),
`routes/receipts.ts` and `routes/other-debtors.ts` (their list handlers
call `sb.from` on an undefined client → 500; their writes gate on
`hasHouzsPerm` → 403). Observed, not guessed: the Supabase edge logs for
the afternoon carried the page's `accounts` and `suppliers` reads but no
`ap_invoices` / `purchase_invoices` request at all — the handler was
answering before it ever reached the database — and the 403 body matched
`canSee`'s wording exactly. Every test passed because the route harnesses
set `supabase` and `houzsUser` by hand.

**Fix.** The bridge line on all three routers (`ap-invoices.ts`,
`receipts.ts`, `other-debtors.ts`), and the AP list now prints a failed
read instead of the empty sentence. Pinned by
`backend/tests/scmRouterBridge.test.ts`: it parses `scm/index.ts` the way
`tests/writeFreezeAreas.test.ts` does, follows every `scm.route("/prefix",
router)` to its file and asserts the bridge line is there, with a
by-design list (only `/write-freeze`) that must carry a reason. Proved RED
on the unfixed tree — it named exactly `/other-debtors`, `/receipts`,
`/ap-invoices` — and green after.

**Ref.** fix/ap-invoices-bridge, 2026-09-06.
