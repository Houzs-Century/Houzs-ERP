# Module-guide verification ledger

Which of the module guides have had their **behavioural claims** checked against
the source, by whom, and what was found.

**This file is the handover.** The work it tracks is a long grind that will
outlive any one session, so the state lives here rather than in someone's head.
If you are picking this up cold: read the method, take the top unverified guide,
and update its row in the SAME PR that fixes the guide.

---

## Why this exists, and what it is NOT

`check-docs-drift` resolves every **mechanically checkable** claim a doc makes —
a path, a `mig NNNN`, a permission key, an `npm run`. It gates PRs on the CERTAIN
half and it is good at that job.

It cannot check a sentence like *"the confirm gate requires a venue"*. That is
most of what a module guide says, and **no script will ever settle it**. Measured
2026-08-15: 2,138 mechanically checkable claims across 154 markdown files, against
roughly 60,000 lines of documentation. The gap is not a tooling gap that better
tooling closes — it is prose about behaviour, and it needs a reader.

A guide that lies is worse than no guide. `CLAUDE.md` makes reading the guide
MANDATORY before touching a module, so a wrong sentence in one is a wrong belief
installed in whoever reads it, right before they change the code it describes.

**Not verified is the honest default.** A row that says `not verified` is not a
failure; it is the truth, and it is the only thing that makes a `verified` row
mean anything.

---

## Method — what "verified" has to mean

A guide is `verified` when someone has done all four:

1. **Read the guide's behavioural claims** — the sentences a reader would ACT on:
   what is required, what is refused, what a status transition allows, who is
   allowed, what happens on cancel, which surface owns a rule.
2. **Read the source that decides each one**, and named it in the ledger row.
   The route handler, the guard module, the migration's own words. Not the file's
   comments — `CLAUDE.md` is explicit that comments describe intent and the code
   is the fact.
3. **Corrected what was wrong, in the same PR**, with a dated note saying what
   the guide used to say. Deleting an error silently leaves the next reader
   unable to tell which version they are remembering.
4. **Recorded the verdict here**, including what was found. A verification that
   found nothing wrong still says so — "checked, nothing wrong" is a result, and
   the next person needs to know it was checked.

**Not verified by:** re-reading the guide and finding it plausible; a green
`check-docs-drift`; the fact that the module works. None of those look at whether
the sentence matches the code.

**If a claim cannot be settled from source** — it depends on production data, or
on a decision only the owner can state — write it in the row as UNKNOWN and leave
the guide's sentence alone. Do not guess, and do not delete a claim because it is
hard to check.

---

## Ledger

<!-- Keep this table sorted by status then name. One PR per guide. -->

| guide | status | verified by / PR | what was found |
|---|---|---|---|
| `accounting.md` | not verified | — | — |
| `address-cascade.md` | not verified | — | — |
| `announcements.md` | not verified | — | — |
| `autocount-writeback.md` | not verified | — | — |
| `combo-pricing.md` | not verified | — | — |
| `delivery-order.md` | not verified | — | — |
| `delivery-rate-card.md` | not verified | — | — |
| `delivery-return.md` | not verified | — | — |
| `dates.md` | verified (whole guide, at birth) | Claude, #2386 | NEW guide, 2026-08-18 — a census of every date fact in the system, written by reading source on `origin/main` `12322f31b`, never from another doc. Counted: 13 date columns on the SO (8 real facts, 2 with ZERO writers). FIVE LIVE CONTRADICTIONS found and recorded in §5, all reported NOT fixed (this was a docs-only PR): (a) `so-stock-allocation.ts:219` gates allocation on `proceeded_at` under a comment quoting the owner's `processing_date` rule, and no shipped client writes `proceeded_at` after create — the reader flip `unify-processing-date.mjs` says is pending; (b) `amended_delivery_date` is absent from `SO_HEADER_FIELD_POLICY` so it is FREE, yet it is the date Days-Left counts against and one board click moves it past a lock that freezes `customer_delivery_date`; (c) two lanes compute the effective due date from different columns — MRP and the allocator contain ZERO references to `amended_delivery_date`, so a rescheduled order is planned on the new date and built on the old; (d) `delivery_orders.expected_delivery_at` and `.customer_delivery_date` are written from the same value in the same INSERT (`:4071`) and are separately editable; (e) the board's synthetic ASSR/DP/project rows write one leg date into four keys including `processing_date`. Also confirmed: `sales_exemption_expiry` has zero writers and is still rendered with a date filter, AND that same name on AutoCount's side carries the ERP's `customer_delivery_date` — two meanings, one word, across the integration. Four doc lies in `sales-order.md` corrected in the same PR. NOT DONE: no production database was queried, so every count is a count of SOURCE; company 2 was not audited (the mirror deliberately skips the pair rule); the ~20 source comments still naming `internal_expected_dd` were left alone as out-of-scope. |
| `delivery-tms.md` | not verified | — | — |
| `document-conversion.md` | verified (whole guide, at birth) | Claude, #2325 | NEW guide, 2026-08-16 — written from source, so every claim in it was read out of the tree rather than inherited. The conversion grid (13 pairs), the ten picker pages and their multi-select behaviour, the source-side "Convert to" entries and the mobile wizard's four pairs were each read at their file. FOUR DEFECTS found and recorded in §4, all reported not fixed: (a) 8 of the 10 picker pages contain ZERO `useSearchParams`/`useLocation`/`useParams`, so `Convert to PI` / `Convert to SI` / `Deliver` navigate with a scope param that is silently discarded and open the global picker — counted per file, only `PurchaseOrderFromSo` (3) and `GrnFromPo` (17) read params; (b) GRN→PR navigates `?fromGrn=` while `PurchaseReturnNew` reads `grnId`; (c) `/scm/sales-invoices/from-so` is navigated to and is not a registered route; (d) "New from quotation" routes to the sofa configurator, and no QT→SO conversion exists anywhere. The owner's Consignment Note claim was CONFIRMED with one correction: the line picker is CN-screen-only, but a whole-order `Create Consignment Note` does exist on the Consignment Order side and its `?fromConsignmentOrder=` IS read. UNKNOWN: whether the absent Quotation→SO step is deliberate — nothing in source says. |
| `document-traceability.md` | not verified | — | — |
| `fleet-maintenance.md` | not verified | — | — |
| `global-search.md` | not verified | — | — |
| `grn.md` | not verified | — | — |
| `mail-center.md` | not verified | — | — |
| `mrp.md` | not verified | — | — |
| `payment-voucher.md` | not verified | — | — |
| `projects-pms.md` | not verified | — | — |
| `purchase-consignment-order.md` | not verified | — | — |
| `purchase-order-amendment.md` | not verified | — | — |
| `purchase-order.md` | not verified | — | — |
| `purchase-return.md` | not verified | — | — |
| `quote.md` | not verified | — | — |
| `sales-invoice.md` | not verified | — | — |
| `roles-permissions.md` | written with the code (2026-08-20) | Claude, `fix/permission-catalogue-silent-drop` | NEW guide, 2026-08-20 — written from source while classifying the 22 undeclared role keys, so every claim was read at its file: the three consumers of `isValidPermission` (`parsePermissions`, the roles POST/PATCH filter, `GET /api/roles/permissions`), the five live udf gates (`routes/udf.ts:26-32`), and the absence of any `/api/trips` / `/api/planner` / top-level `/api/reports` mount in `src/index.ts`. The 17 `retired` verdicts are each a `grep -rF '"<key>"'` over `backend/src` + `frontend/src` returning zero, and `permissionCatalogueDrift.test.ts` re-derives that same set on every run — so the guide's central table is machine-checked rather than asserted. NOT independently verified: the `page access` half of section 1, which is summarised from `docs/PERMISSION-MATRIX.md` rather than read at `pageAccess.ts`. |
| `sales-order.md` | partial (13 of ~24 sections) | Claude, #2231 #2233 #2246 #2250 | 11 correct in full; 4 findings. NEW: the SO-amendment section — (a) a SOURCE COMMENT in `so-amendment-header.ts` said the Processing Date signs with Purchasing; `soHeaderFieldKind` returns `DELIVERY` for every key and `amendment-routing.ts` maps that to Logistics. The routing table and BOTH guides agreed with the code; only the comment did not, and a comment is where a reader looks first for who signs. (b) The guide named 5 amendable header keys; there are 13 — the whole delivery-address block plus `replacementDisposal` joined in the two-lane rework and the prose did not follow, so a reader would have concluded ship-to could not be amended. Fixed by REMOVING the hand-written list and pointing at `AMENDABLE_HEADER_KEYS` + `so-field-policy.test.ts`, which already pins it (proven red: delete one key, 1 of 12 fails). CORRECT: the 5 line atoms, all three surfaces sharing one diff, the routing table. NOT READ: address block, list handler, line photos, caching, the Processing-Date column registry. |
| `scan-to-so.md` | not verified | — | — |
| `system-health.md` | verified (whole guide, at birth) | Claude, #2465 | NEW guide, 2026-08-19 — written from source while adding `POST /autocount/so-pull`, so every claim was read at its file: the three refresh routes and their `requirePermission("*")` gate (`systemHealth.ts`), `getSince(checkpoint)` vs `getAll` and the fact that `all` does not touch the checkpoint (`services/pull.ts:29`), and the `failed === 0` advance guard (`pull.ts:78`). The worked example is production output, not an illustration: the read-only check reported checkpoint CURRENT, 3281 rows, newest SO-013275, and zero rows for SO-005263 or its digits. |
| `so-handover.md` | written with the code (#2354) | Claude, #2354 | Written in the same PR as the feature it describes, from the source it describes — not a later read of somebody else's code, so it carries no independent verification. The `agent` carve-out and both refusal paths are pinned by `so-identity-lock.test.ts` + `so-handover.test.ts`; the prose about WHY the lock let salesperson_id go is the owner's 2026-08-17 ruling and cannot be checked against code at all. |
| `service-case.md` | not verified | — | — |
| `stock-take.md` | not verified | — | — |
| `team-members.md` | not verified | — | — |
| `warehouses.md` | not verified | — | — |

**28 guides, 0 verified, 1 partial** as of 2026-08-15 — `address-cascade.md` landed on `main` while this PR was in flight, and the guard below is what noticed. Do not type this pair either; the commands under it are the answer. Re-count rather than trust that line:

```bash
grep -c '| not verified |' docs/MODULE-GUIDE-VERIFICATION.md
ls docs/modules/*.md | wc -l
```

---

## Order of work, and why

Money and stock first, because a wrong sentence there is the expensive kind, and
because those modules are the ones people actually open:

1. `sales-order.md` — the largest surface, and the guide `CLAUDE.md` names as the
   shape to copy
2. `delivery-order.md`, `grn.md` — stock movement
3. `sales-invoice.md`, `payment-voucher.md`, `purchase-order.md` — money
4. everything else

---

## The gap this ledger does NOT cover

**70 of 135 route modules are named in no guide at all** (re-measure: the loop is
in `docs/HANDOFF-2026-08-15.md`). Verifying the 27 that exist does not touch
those 70. Writing a guide for a module is a bigger job than checking one, and it
is a separate line of work — do not let a verified-27 count read as "the modules
are documented".
