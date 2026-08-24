# Fragmentation Map (2026-07-23, re-measured 2026-08-13)

The owner noticed the codebase has "3-4 of the same thing" not integrated. A
read-only audit confirmed it and mapped every instance. This is that map, plus
what has been fixed, what is deferred, and — critically — the duplicates that are
**intentional and must NOT be merged**. Companion to `AI-DEV-VELOCITY.md`
(fragmentation is a top cause of slow AI sessions: every task re-discovers which
of the N versions is the real one).

The recurring shape: a consolidation *was* started, its file even calls itself
"the single source" — and the sweep to convert the old call sites was never
finished. The habit fix: finish the sweep in the SAME PR that creates the
canonical helper, and add a CI parity/grep guard where money is involved.

## Done (2026-08-13) — duplicated CONSTANT LISTS

A narrower sweep than the table below: not duplicated *helpers*, duplicated
*lists of facts* — a set of table names, a status set, an alias chain. Every
count here was measured by grep on 2026-08-13, not carried over.

- **[FIXED] Payment-method vocabulary — 7 copies, not the "1" the table below
  says.** `PAYMENT_METHOD_CODES` (`scm/shared/payment-methods.ts`) was
  re-typed as `z.enum(['merchant','transfer','cash','installment'])` in
  `mfg-sales-orders.ts` (×3), `consignment-orders.ts`, `consignment-notes.ts`,
  `delivery-orders-mfg.ts`, `sales-invoices.ts` — in a **different order**, one
  of them commented "kept in sync with PAYMENT_METHOD_CODES in
  `packages/shared/src/payment-methods.ts`", a path this repo does not have.
  All seven now read the constant; `tests/paymentMethodEnum.test.ts` greps the
  route sources so an eighth cannot appear. Accepted set unchanged.
- **[FIXED] DO status sets — 11 files, two spellings.**
  `DISPATCHED/IN_TRANSIT/SIGNED/DELIVERED/INVOICED` and the same list +
  `COMPLETED` were hand-typed in `delivery-orders-mfg.ts`,
  `consignment-notes.ts`, `lib/reconcile-ledger.ts`, `agents/delivery-agent.ts`
  and seven audit scripts. The two spellings answer different questions (write
  trigger vs "has the OUT already been written"), and the copies had lost that
  distinction: two audits scanned different sets for the same kind of finding,
  and the delivery agent's `DO_STATUSES` had dropped `COMPLETED`, so its DO
  pipeline omitted that bucket. Now `scm/shared/do-shipped-states.ts` +
  `scripts/lib/do-shipped-states.mjs`, pinned by
  `tests/doShippedStatesMirror.test.ts`.
- **[FIXED] SO terminal-status set — 14 copies across ten files, four names.** The six
  statuses that mean "this order no longer demands stock" were hand-typed as
  `SO_DONE` / `ALLOC_EXCLUDED` / `NON_ALLOCATABLE` / `EXCLUDED` in `mrp.ts` and
  eight `.mjs` audits, as a raw PostgREST `not.in` string in
  `so-stock-allocation.ts`, and again as inline SQL `NOT IN (...)` inside four
  of those same scripts (a copy inside a copy). Every one carried a comment
  promising to track another file — "mrp.ts verbatim", "Keep this replica in
  lockstep or its figures lie". SHIPPED had to be *added* to the set on
  2026-08-01 for exactly the reason you would expect. Now
  `scm/shared/so-terminal-states.ts` + `scripts/lib/so-terminal-states.mjs`,
  pinned by `tests/soTerminalStatesMirror.test.ts`; the PostgREST string renders
  byte-identically to the literal it replaced.
- **[FIXED] Fabric arm lists — the census re-declared the repair's tables.**
  `scripts/lib/colour-carriers.mjs` held its own copy of the 15 line tables, the
  8 `variant_key` buckets and the 5-key colour alias chain that
  `scripts/lib/fabric-write.mjs` already declared. It now derives all three, so
  a table added to the repair cannot be missing from the proof that the repair
  worked. `tests/colourCarrierArms.test.ts` pins it.

### Found by the same sweep, deliberately NOT collapsed (measured 2026-08-13)

Each of these is the same shape, and each would change behaviour to merge. They
are listed so the next person does not have to re-find them — and so nobody
merges one thinking it is a formatting difference.

| The list | Where it disagrees | Why it was left |
|---|---|---|
| **"SO no longer demands stock"** | `shared/so-terminal-states.ts` has **6**. `routes/inventory.ts` `GET /products` (`:494`) has **4** (no DRAFT, no SHIPPED); `GET /reservations` (`:1424`) has **5** (adds SHIPPED) — the two halves of one file disagree with each other. ~15 cutover/parity scripts use a fourth spelling (5 statuses, no DRAFT, different members). | Aligning any of them moves committed / available / surplus on the Inventory page. Owner's call; BUG-HISTORY 2026-08-13. Both `inventory.ts` sites now say so in comments. |
| **Fabric colour alias chain** | THREE lengths in use: 5 keys (`fabric-write.mjs`, adds `colourId`), 4 keys (`so-variant-rule.ts` ×2 + its FE mirror ×2, `variant-axes.mjs` ×2, `fabric-supplier-code.ts`, `check-so-noncatalog-lines.mjs` ×2, `check-sofa-bedframe-completeness.mjs` ×2), 3 keys (`supplier-doc-data.ts`, `sales-order-pdf.ts` — no `colourCode`). Plus ~8 inline `a ?? b ?? c` chains. | A 3-key site that starts reading `colourCode` renders a fabric code where it renders none today. Needs a per-site decision, not a sweep. |
| **`variant-axes.mjs` vs `so-variant-rule.ts`** | The axes TABLE is pinned by `variantAxesMirror.test.ts`, but the .mjs has an extra exemption the TS does not (`isSeatlessPiece` — CONSOLE/CT lines skip `seatHeight`). The mirror test's `CODES` fixture contains no CONSOLE code, so it passes while the two genuinely disagree. | Either direction changes a gate: adding it to TS relaxes the app's confirm check, removing it from .mjs re-flags console lines the owner exempted. Widen the fixture only together with that decision. |
| **`EXPLICIT_APPROVAL_KEYS`** | `services/permissions.ts:216` and `auth/projectAccess.ts:158` — identical 4 keys, FE comment says "Mirror of backend". | A permission set across the wire; no shared package. Cheapest real fix is a byte-comparison test, not a merge. |
| **`ASSISTANT_KNOWN_POSITIONS`** | `services/assistant-scope.ts:103` and `auth/assistantAccess.ts:35` — 17 positions each, **verified identical 2026-08-13**. Both are copies of `positionAccessSnapshot.ts`, which is deliberately unwired. | Same as above: a guard test is the fix. Note this one FAILS CLOSED on a miss, so drift denies access rather than granting it. |
| **`payment-methods.ts` FE vs BE** | `PAYMENT_METHOD_VALUE_TO_CODE` has **3** entries in BE, **4** in FE (FE still maps `Installment`), despite the FE header saying "Vendored VERBATIM". | Changes what `isCorePaymentMethodRow` returns on the FE. BE is the authority for the lock, so the FE copy is cosmetic today — but it is drift, not a design. |
| **SO/DO/SI money-column projections** | `mattress_sofa_centi …` appears as a SELECT list in 3 lengths: 11 (`consignment-notes`, `consignment-returns`, `delivery-returns`), 12 (`consignment-orders`, `ConsignmentOrders.tsx`), 13 (`delivery-orders-mfg`, `sales-invoices`). `lib/finance-keys.ts` is canonical for the STRIP list but not for these projections. | A projection and a strip list are different facts. Merging changes what each endpoint returns. |
| **SKU-rename cascade vs `sku-usage.ts`** | `mfg-products.ts:756` lists 21 (table, column) pairs that carry an item code; `lib/sku-usage.ts:15` lists 3 of them; `lib/autocount-outbox.ts:870` maps 6 line tables to their code column. | Three questions (rename everywhere / has-it-been-used / what does AutoCount call it), not one list. Worth a shared table→column map eventually. |

## Done (2026-07-23)

- **[FIXED] Sofa combo pricing UTC drift** (#1116) — the smoking gun. The
  frontend copy of `sofa-combo-pricing.ts` resolved effective-dated pricing
  against the UTC date; before 08:00 MYT it priced sofas differently from the
  backend. Now both use MYT. This is the highest-value item the audit found.
- **[FIXED] Deleted dead `scm/lib/roles.ts`** (#1119) — an orphaned duplicate of
  `canViewAllSales` et al. (live copy is in `houzs-perms.ts`); it only misled
  greps. `tsc` proved nothing imported it.

## VERIFIED SAFE — do NOT "fix" these (they look like the sofa bug but aren't)

These raw-UTC `new Date().toISOString().slice(0,10)` sites were checked and are
**correct as-is**. Changing them to MYT would be a regression:

- `scm/lib/bridge-2990.ts:144` `today2990Iso()` — **deliberately UTC**, with a
  docblock explaining why: it must read dates the way 2990 does, or it breaks the
  byte-for-byte blob preservation the whole 2990 sync rests on. **Do not touch.**
- `routes/sales.ts:462`, `routes/assr.ts:1239` — only build a **CSV export
  filename** (`sales_2026-07-23.csv`). Cosmetic; not a data/money date.

Other intentional duplicates the audit ruled out (leave them):
`passwordStrength.ts` (FE/BE, explicit "KEEP IN SYNC" header, verified in sync),
`canonicalHost.ts` (dep-free copy pinned by a test), the two rate limiters
(KV speed-bump vs PG-atomic security), doc-number minters (different grammars),
the two migration trees (prod vs D1-test), `payment-audit-log.ts` (a read-only
view, not a fourth audit sink). FE/BE mirror pairs across the wire are unavoidable
without a shared package; each documents "backend stays the authority".

## The remaining map — ranked (value minus risk). Deferred: needs the staging net.

Each is a multi-file sweep; the benefit is "less confusion / fewer latent bugs",
not a live outage. Doing them blind-merged to prod (no UI verification) trades a
real risk for a cosmetic gain — do them behind the staging bench (see
`SECURITY-DX-ROADMAP.md` step 2), one PR each, verified.

| Concept | Canonical target | N copies | Value | Risk | Notes |
|---|---|---|---|---|---|
| **MYT date (cosmetic dedup)** | `scm/lib/my-time.ts` / `vendor/scm/lib/dates.ts` | ~10 `+8h` inline + a full parallel kit in `agent-console.ts` | MED | LOW | All correct MYT already; converging is cleanliness, not a bug fix (the only bug was the sofa one, fixed). |
| **`shared/` pure-logic drift guard** | add CI parity check | **18 pairs; 11 have drifted** (measured 2026-08-13 by `cmp`) | HIGH | LOW | Every `frontend/src/vendor/shared/*.ts` compared against `backend/src/scm/shared/*.ts` (5 more FE files have no BE pair and are excluded). **Identical (7):** `mfg-pricing`, `phone`, `service-sku`, `so-line-display`, `sofa-quick-presets`, `sofa-tier`, `variant-summary`. **Drifted (11),** differing lines in brackets: `maintenance-pools` [101], `index` [74], `free-item-campaign` [68], `sofa-build` [54], `format` [49], `so-variant-rule` [34], `sofa-combo-pricing` [11], `variant-key` [9], `adjustment-reasons` [4], `inventory-adjustment` [4], `effective-delivery` [2]. **Only `variant-summary.ts` has a byte-for-byte guard** (`frontend/src/vendor/shared/variant-summary.test.ts`) — and it is the one pair nobody worries about. Add that same guard to the other **6** identical pairs first: free, and it stops them joining the eleven. |
| **Money formatting** | `vendor/shared/format.ts fmtMoneyCenti` | ~20 page-local `fmtMoney` | MED-HIGH | LOW | Each local copy also renders "MYR NaN" on null; converging fixes that too. Display-only. |
| **Hardcoded `VALID_CURRENCIES`** | the `currencies` master | `['MYR','RMB','USD','SGD']` at 5 sites (`mfg-purchase-orders.ts`, `purchase-consignment-orders.ts`, `suppliers.ts`, `SupplierDetail.tsx`, `Suppliers.tsx`), + the `VALID_KINDS` `['mfg_product','fabric','raw']` twin at 3 of them | MED | LOW-MED | The hardcoded currency sets SHADOW the UI-editable master — adding a currency in the UI is silently rejected by PO/PC creation. Behavioural: converging is a real fix, not a tidy-up, so verify carefully. *(Payment methods split out of this row and FIXED 2026-08-13 — see Done above; the "1 payment" copy counted here was actually 7.)* |
| **State lists** | `vendor/scm/components/StatePicker` / lookup | 3 (`Projects.tsx`, `Sales.tsx`, `delivery-planning-queries.ts`) | MED | LOW | Penang vs "Pulau Pinang" spelling split breaks cross-module matching. |
| ~~**`projectScopeWhere(user)`**~~ | RESOLVED 2026-08-19 | ~~5 hand-written SQL predicates~~ | — | — | MOOT — the project PIC/brand row-level ACL (`services/projectAcl.ts` [gone]) was REMOVED by owner decision 2026-08-19, so there is no longer a scope predicate to centralise. See `docs/modules/projects-pms.md` Axis 2. |
| **Upload MIME mechanism** | one `lib/uploads.ts` | ~6 per-route copies | MED | MED | Keep per-surface allow-lists; share the mechanism. Partially touched by the XSS PRs. |
| **Frontend fetch clients** | share retry/timeout into common helpers | 2 clients + `slip.ts`/`verified-save.ts` stragglers | MED | MED-HIGH | Don't merge wholesale (vendor boundary + deliberate behaviour diffs); converge resilience only. |
| **Audit tables** | finish `entity_audit_log` migration | 3 tables (`audit_events`, `mfg_so_audit_log`, `entity_audit_log`) | HIGH | HIGH | The consolidation is half-done (entity_audit_log was created to replace mfg_so_audit_log). Needs a DB migration + UI read-path changes. Highest value, highest risk — do it supervised, with a backup, on staging first. |
| **Permissions** | finish `positionPolicy`/`capabilities` | 7 coexisting vocabularies | HIGH | HIGH | Already an in-flight, documented program; finish it, don't start anew. |

## The one habit that stops this recurring

Almost every finding is a half-finished consolidation. Two cheap guards would end
the pattern:
1. **Finish the sweep in the same PR** that introduces a "single source" helper —
   convert all old call sites then, not "later".
2. **A CI grep/parity guard** for the money-critical duplicates (the FE/BE
   `shared/` pure-logic files), so a drift like the sofa bug fails CI the day it
   happens instead of pricing sofas wrong for months.
