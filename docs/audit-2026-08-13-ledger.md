# Full-system audit — 2026-08-13 ledger

**Branch:** `fix/company-scope-sweep` (worktree `hz-baseline-worktrees/company-scope`). NOT merged.

**Why this file exists.** The owner asked for a whole-body checkup and, reasonably,
for proof that nothing gets dropped between sessions. A list held in a session is
lost when the session ends. This is the list.

**The rule every row obeys:** an agent's finding is a LEAD, never a verdict. Each
one is re-read against the source by hand before it is fixed or dismissed. That is
not ceremony — of the first 11 leads in the cross-company sweep, **11 were false
positives** whose "fix" would have broken a deliberate design (the unified fleet),
and one lead was reported against the wrong function entirely because the scanner's
own regex was dead.

Status: **DONE** = fixed + typechecked (+ test where the logic allows) ·
**VERIFIED-NOT-A-BUG** = read the source, it is correct or deliberate ·
**OPEN** = lead recorded, not yet re-read by hand · **OWNER** = needs a decision.

---

## A. The 2026-08-13 artifact (133 confirmed, 39 high)

Its six labels total 188, so items carry more than one label — the counts below
are its labels, not disjoint sets.

| cluster | artifact count | status |
|---|---|---|
| cross-company scope | 56 (27 high) | **CLOSED** — reopened once when the scanner turned out too loose (§I), then finished: every WRITE finding either fixed or opened and annotated. Four of the last eleven were false positives for four DIFFERENT reasons, one of which would have become a bug if "fixed" |
| permission / access gate | 11 (4 high) | **CLOSED** (§C) — 6 gated, 1 left open by owner decision |
| money / quantity arithmetic | 47 (12 high) | B1/B2/B3/B5/B6 **DONE** — B6 by mig 0286 in the direction the owner chose. B4 **DONE** — the workflow was clicked on 2026-08-14, the data answered it, and the engine now carries sen |
| silent failure | 33 (5 high) | **CLOSED** — frontend 39 → 0 across two passes; backend all 9 §D items done |
| old/new competing implementations | 29 | ASSR company-pin divergence fixed (search.ts kept a stale copy of a rule the owner changed on 2026-07-20); the rest are duplicated-but-agreeing and now refereed by `check-shared-mirrors` |
| dead code | 12 claimed — **at least 184 actual** | **SWEPT — the list is §K.** The "12" was never written down and never verified; this row used to be a count with no list, which is unusable and uncheckable. The real sweep found 74 dead `42501 -> 403` branches, 1 duplicate route handler (`users.ts:2291`, and the dead half is the newer design — owner decision), 108 exported symbols with zero references repo-wide, and 1 unmounted page file. **Acted on:** 28 files annotated, 4 orphans deleted, everything else LEFT with a written reason — including two the repo had already recorded as deliberate keeps |

---

## B. Money / quantity

| # | finding | status |
|---|---|---|
| B1 | **A discounted sofa build was invoiced for MORE than it was ordered.** Discount validated against the whole build, then dumped on module 0 whose price is one share; `senOrZero` guards NaN not sign; DO/SI clamp the negative away. RM8,000 build − RM3,000 → ordered RM5,000, invoiced RM6,000. | **DONE** — `distributeBuildDiscount` at all 3 split sites + 6 tests |
| B2 | `POST /purchase-invoices/from-grn` summed line totals UNCLAMPED while writing them CLAMPED, so `total_centi` ≠ Σ lines. Its sibling `/from-grn-items` already clamps inside the reduce and says why. GRN stores an unbounded `discount_centi` (grns.ts:1695), so the premise is real. | **DONE** |
| B3 | Three SO paths lower the unit price and keep the stored discount: variant edit, product swap, sofa exchange. Negative total → clamped downstream → over-billing again. | **DONE** — all three now 422 `discount_exceeds_new_price`, following this file's own "reject-don't-normalize" rule (`:6199`, audit 2026-06-11 C-2) |
| B4 | The **persisted** sofa selling price is quantised to whole ringgit per module and per combo (`sofa-build.ts:503/533/1260`), so RM1,299.50 × 4 bills RM5,200 instead of RM5,198. Only bites when a module price is not a whole ringgit; every writer of those columns is operator-entered. | **CHECK BUILT** — `check-sofa-price-rounding.mjs` + `sofa-price-rounding-check.yml` (Actions → Run workflow). Counts the part-ringgit values in the THREE inputs the engine actually reads, traced in source because the column names mislead: `seat_height_prices` carries both a cost (`priceSen`) and a selling (`sellingPriceSen`) figure, and the combo charged price is neither column alone but `comboChargedPrices`' merge of `selling_prices_by_height` over `prices_by_height`. Zero ⇒ a guard at data entry; non-zero ⇒ the engine has to carry sen. Nobody has to open a SQL console to find out |
| B5 | Landed-freight per-unit rounding doubled a sub-sen allocation: 50 sen over 100 units → `round(0.5)` = 1 sen/unit → 100 sen capitalised, once per source. | **DONE** — the charge is added as a TOTAL and the aggregate divides once, so `allocateLandedCharges`' exactness survives to the lot |
| B6 | A shipped-DO line reduction returns stock at a cost blended over costed and uncosted units, and mints a lot at that invented figure. | **DONE** — owner chose "按原成本退回". Mig 0286 `fn_return_do_units_at_cost` is the PARTIAL form of `fn_reverse_do_out` (0198): it unwinds `inventory_lot_consumptions` newest-first, returns each unit to the lot that paid for it at that lot's cost, restamps the OUT's COGS from what survives, and writes one balancing IN at cost 0 with its minted lot closed. Uncosted units return at nothing and are REPORTED, never smeared. LIFO is stated as a choice in the migration header because nothing in the data implies it. 9 pg tests, the first asserting the OLD arithmetic is wrong so the suite cannot pass vacuously |

## C. Permission gates

| # | finding | status |
|---|---|---|
| C1 | `POST /maintenance-config/sofa-compartments/rename` — **no gate at all**, and two comments each said the other layer had it. Renames a compartment code across the SKU master, every historical doc-line snapshot, combos, quick picks and in-flight carts. | **DONE** |
| C2 | `/localities` POST/PATCH/DELETE — no gate; shared 5,870-row postcode master + city-level routing; no `company_id`, so a change hits both companies. | **DONE** |
| C3 | `/state-warehouse-mappings` PUT/DELETE — no gate; repoints which warehouse an entire state ships from. | **DONE** |
| C4 | `inventory.ts` cost/valuation/supplier reads had no finance gate; Storekeeper holds `scm.warehouse.inventory = view` and `canSeeMargin: false` was written and never enforced. | **DONE** (owner: gate it) — `/value` and `/cogs` 403; `/movements` and `/lots` STRIP the cost columns so quantity, location and batch stay visible |
| C5 | `/ar/reconciliation` — whole-book receivables, no area guard, no finance gate, no row scope, while both its siblings have all three. | **DONE** (owner: gate it like the siblings) — `scm.finance.outstanding` at the mount + the per-salesperson row scope `unbilled-deliveries` uses |
| C6 | Quotes: the list is row-scoped to own+downline, `PATCH /:id` and `/:id/cancel` are not. | **OWNER: LEAVE AS IS** — reps do amend each other's quotes; that is how the shop works. Recorded in the code so the next audit does not re-open it |
| C7 | `accounting.ts` — zero in-route checks on 4 GL verbs; its only gate (`moneyWriteDenial`) fails open for a positionless caller. Payment vouchers are double-gated; the GL is not. | **DONE** (owner: reuse the existing key) — gated on `scm.payment_voucher.post`; a new key would have taken effect with nobody holding it and stopped GL posting |

## D. Silent failure — backend

| # | finding | status |
|---|---|---|
| D1 | DO cancel discarded `writeMovements`' result — stock left permanently deducted, 200 returned. The sibling `resyncInventoryForDo` was given a failure trace on 2026-08-05; the cancel twin was not. | **DONE** |
| D2 | DR line add/edit/delete/cancel — same shape, four callers. The CREATE path reports; the mutations did not. | **DONE** |
| D3 | GRN cancel — the reversing OUT's result was dropped, so a failed reversal left phantom received stock and returned 200. | **DONE** — surfaced as `cancelErrors` |
| D4 | GRN cancel — the 2026-07-31 `RecountResult` fix reached the POST caller and not the CANCEL caller. Its own header records the eleven POs that cost. | **DONE** |
| D5 | `recomputePoReceived` returned `{ok:true}` after two UNCHECKED writes — the reporting channel existed and actively lied. Same shape in `purchase-consignment-receives`. | **DONE** — both writes checked; the PC twin now returns a result at all, and `postPcReceiveAndRollup` carries `recountError` through |
| D6 | `purchase-returns` cancel — `reverseMovements` computes a partial-failure count; the caller read only `reversed > 0`, so reversed:3 / failed:2 returned a clean 200. | **DONE** — `reversalErrors` |
| D7 | Consignment note/return mutations discarded the `string[]` their own create path returns — 8 call sites. | **DONE** |
| D8 | Purchase-consignment — `recomputePcoReceived` never got the `RecountResult` upgrade. | **DONE** |
| D9 | `returnLineLock` never destructured `error`, so a failed read made the terminal-state guard PASS. | **DONE** — fails closed with a retry message |

**Section D is closed.** Every one had its reporting version already present in
the same file — the fix had been applied to the create/post path and not to its
cancel/mutation twin. That asymmetry, not the swallow itself, is the pattern.

## E. Frontend / rules

| # | finding | status |
|---|---|---|
| E1 | 35 mutations where a server refusal reached nobody. The owner's "Deactivate does nothing". | **DONE** — `writeFailed` wired; checker at 0 |
| E2 | `variantsRequired = true` default made 9 forms demand a field their own server never asked for. | **DONE** — default removed, prop now required |
| E3 | `isCorePaymentMethodRow` — UI locked a payment method the API would have let you delete; the two comments said FOUR and THREE. | **DONE** |
| E4 | Desktop `SalesOrderNew` has no address rule; mobile and backend both do — and mobile's is a THIRD rule again. | **DONE** — owner: "只要是 proceed 的单，它都必须填…就是 processing date。电话、电脑都一样的". All three now gate on the Processing Date alone. Desktop was the worse half: its "Fill in address later" toggle blanks the address out of the payload and gated nothing, so the server's refusal arrived as a bare `validation_failed`. Mobile required `procDate AND delivDate`, so a procDate with no delivDate showed no marks and was then refused |
| E5 | `SalesOrderNew`'s confirm gate requires variants "date or no date" (owner 2026-08-08) while the line card shows nothing required without a date. | **NOT A DEFECT — this row was stale.** Re-read on 2026-08-13: the gate is already `if (processingDate)` and the card is fed `variantsRequired={!!processingDate}`. They agree, and they agree with what the owner confirmed ("以行卡为准:没日期就不必填"). An earlier pass in this same session had already fixed it and the row was never updated — the exact failure mode this ledger exists to prevent |

## F. Schema / keys

| # | finding | status |
|---|---|---|
| F1 | `scm.pos_carts` keyed `staff_id` alone — switching company destroyed the other company's cart, silently. | **DONE** — mig 0284 re-keys `(staff_id, company_id)`; 9 pg tests **written but NOT RUN** (no Docker, no `TEST_DATABASE_URL` here — CI is the gate) |
| F2 | `model_fabric_tier_overrides` / `compartment_fabric_tier_overrides` have the same single-column-PK defect; one company's upsert overwrites the other's. | **SPLIT — one real, one refuted.** `compartment_fabric_tier_overrides` is REAL and fixed by mig 0293: `compartment_library` carries no `company_id`, so the catalogue is SHARED and both companies reference the same ids; the PUT's `onConflict: 'compartment_id'` landed on the other company's row and, because a tier delta is a PRICE (`mfg-pricing-recompute.ts:997`), silently repriced their sofa builds. `model_fabric_tier_overrides` is REFUTED: `product_models` rows are created with `company_id` (`product-models.ts:445`) and listed via `scopeToCompany` (:181), so two companies can never contend for one `model_id`. **Same DDL shape, opposite verdict — the only way to tell them apart is to open the PARENT table.** Not an owner decision after all: the same file's GET already filtered by company while its PK permitted one row globally, so the two halves contradicted each other and the key was simply the leftover |
| F3 | `model_default_free_gifts` and `model_special_delivery_fees`, both `model_id PRIMARY KEY` + `company_id` (mig 0083:267/273) — the F2 shape again. | **REFUTED, both — same parent test as F2's refuted half.** `product_models` carries `company_id NOT NULL` (0083:216), rows are created with `company_id: activeCompanyId(c)` and listed through `scopeToCompany`, its `id` is per-row `gen_random_uuid()`, and mig 0188:36-38 swapped its natural unique to `(company_id, model_code, category)` **precisely so each company keeps its own model rows**. A `model_id` therefore belongs to exactly one company and `(model_id)` already implies one. `model_special_delivery_fees` is refuted a second way: it has **no live read or write path at all** — superseded by `special_delivery_fee_rules` (mig 0024, which copied its rows), so nothing in `backend/src` or `frontend/src` references it. Refutation recorded in `model-free-gifts.ts` at the `onConflict: 'model_id'` upsert so the next reader does not re-chase it |
| F4 | `product_dept_configs` (`PK(product_code)`) and `pwp_codes` (`PK(code)`) — single natural-key PK + `company_id`, and two companies genuinely CAN hold one product code (mig 0233 found **17** codes live under both, 12 disagreeing on `pwp_price_sen`). | **REAL — but ALREADY CLOSED, by mig `0188_percompany_natural_key_masters.sql` (PR #1165, merged).** 0188:43-60 recomposes both PKs to `(company_id, product_code)` / `(company_id, code)`. **The trap here is the DDL source:** `scripts/scm-schema/2990s-full-schema.sql` is the 2990 IMPORT SNAPSHOT and still shows the single-column PKs — reading it alone re-opens a defect that was fixed 99 migrations ago. Neither table has a live `onConflict` to correct: `product_dept_configs` has exactly ONE backend reference, an already-scoped read (`mfg-products.ts:521-524`) plus the rename cascade (:770, `scopeToCompanyId`), and `pwp_codes` is written by `insert` + regenerate-on-collision (`pwp-codes.ts:312`), never `upsert`, so no overwrite path exists. **Still open (pre-existing, recorded in `MULTICOMPANY-SCALING.md:73`):** `pwp_codes` claim/redeem addresses rows by `.eq('code', ...)` with no company predicate (`pwp-claim-single.ts:246/338/389`, ~20 more in `mfg-sales-orders.ts`). Harmless while codes stay globally unique — all pre-0188 rows are, and `genCode()` draws from ~4.6e9 — but 0188 removed the constraint that GUARANTEED it. Left for an owner-scoped pass, not swept into this PR |
| F5 | `mfg_sales_orders` is `doc_no text PRIMARY KEY` with `company_id` (mig 0083:42) — can two companies mint the same SO number? | **REFUTED.** `doc_no` is never client-supplied (no `docNo` in the create schema); the only two writers are `mfg-sales-orders.ts:5104` (mint via `nextDocNo` -> `companyDocPrefix`) and `so-mirror.ts:77` (upsert by `doc_no`, `prefixDoc` stamps `2990-` unconditionally, `mirror-map.ts:39`). `companyDocPrefix` partitions the namespace — HOUZS `HC-`, everyone else `<CODE>-` — so the two companies mint into disjoint sets. It is safe TWICE over: `fetchMonthlyDocNos` (`doc-no.ts:65`) runs `.like('<prefix>SO-YYMM-%')` with **no** company predicate, so even a shared prefix would make max+1 interleave the two sequences rather than collide, and `insertWithDocNoRetry` re-mints 8× on 23505 for the concurrent-create race. Residual, noted not fixed: a future company whose `code` is literally `HC` would map to HOUZS's prefix (`docPrefixForCode`) and SHARE its monthly sequence — a provenance oddity, not data loss. Fixed in passing: `companyScope.ts` claimed the unresolved-context fallback was "BARE numbering"; it has been `HC-` since 2026-08-07 and `companyScope.test.ts:33` asserts so — the conclusion survives, the stated mechanism did not |
| F6 | **`uq_inv_mov_do_source_v2` omits `warehouse_id` AND `batch_no`, but the ship path buckets by BOTH.** `deductInventoryForDo` groups OUT rows by `(warehouse_id, product_code, variant_key, batch_no)` — its own comment says bucketing across two warehouses is deliberate — while the index is keyed `(source_doc_type, source_doc_id, product_code, variant_key, COALESCE(correction_seq,0))`. So one DO shipping the same SKU from two warehouses, or in two dye-lot batches, writes two rows that fold to ONE index slot. `writeMovements` inserts the whole set in a single statement, so the second row's rejection fails the batch and the DO ships with **no stock deducted at all** — surfaced as a cryptic `RECOUNT_FAILED`, not silently, but not legibly either. | **LATENT, RECORDED, NOT FIXED — owner decision.** The hazard is real in the code and has **never fired**: mig 0279's own header records that production has **0 duplicate DO buckets**. A DO is normally one delivery from one warehouse, and a sofa's batch is bound per SO item, so the two-bucket case has not arisen. Not fixed unilaterally because widening a UNIQUE index on the money-critical inventory ledger is precisely the class this repo already rules must be owner-approved and staging-first (BUG-HISTORY, 2026-07: "DETECTION ONLY — the guard is DEFERRED... it touches the money-critical scm inventory layer"). The fix, when taken, is to add `warehouse_id` and `batch_no` to the index — a widening, so it cannot fail to build over existing data |

## G. Running

Desktop/mobile parity · frontend↔backend API contract · docs-vs-code (incl. every
COE's "fixes shipped" table) · old/new competing implementations + dead code ·
business-logic self-contradiction (state machines, create-vs-edit, cancel symmetry,
quantity invariants, lock predicates).

---

## H. Measured, for context

On `origin/main` **today**: 33 unscoped cross-company WRITES, 41 silent mutations.
On this branch: 0 and 0. The three checkers are now PR-gated in `ci.yml`; before
this branch they existed nowhere and were wired into nothing.

---

## I. The checker was wrong, twice over — corrected 2026-08-13

**What it did.** A handler counted as scoped when a helper NAME appeared
anywhere in its body — `joined.includes("activeCompanyId")`. That is a substring
match, not a proof.

**What it let through.** `delivery-orders-mfg.ts PATCH /:id` (`:4296`) writes
`update(updates).eq('id', id)` at `:4411` with no company predicate. Its only
`activeCompanyId(c)` is at `:4432` — AFTER the write, as a fallback for an audit
row's companyId field. Two independent readers found the handler while this
script reported **0 WRITE findings**.

**The correction, and why it took three attempts.**

1. Per-statement testing → **161 writes flagged**. Too strict: the repo's normal
   and correct pattern is to resolve a row through one scoped read and then act
   on the id it returned.
2. Statement + "a scoped query appears earlier" → **118**. Still flagged six
   handlers already verified correct by hand, because the statement window
   anchored on `.from(` and this codebase wraps builders across lines —
   `scopeToCompanyId(` sits on the line BEFORE.
3. Final: DELEGATION guards (named functions whose body does the scoped read)
   count wherever they appear; scope PRIMITIVES only count inside a real `.from(`
   query; the statement window anchors on the statement opener, not on `.from(`.
   **38 findings, 20 writes**, every hand-verified handler excused, the real leak
   caught.

**Honest count: 20 unscoped writes remain, not 0.** The CI step is report-only
until they reach zero — gating on a backlog fails every PR and gets the gate
deleted, which is how the previous generation of checks died.

**The lesson, now in CLAUDE.md.** Three of this repo's checkers were wrong in
one day: a lost `\s`/`\b` made one scan the wrong function bodies; a missing
`\s*` made another compare zero functions and print "identical" about an empty
set; and this one accepted a mention as a predicate. Each looked like a clean
run. **A checker's failure mode is silence, so the only trustworthy number is
one you re-derive after reading its logic.**

---

## J. Status at 2026-08-13 end of sweep

Re-derive these; do not quote them. 32,
and the three checkers print their own buckets.

| area | state |
|---|---|
| cross-company WRITE findings | **0** — all 25 fixed or read-and-annotated; the 11 that remained at the end were each opened and are false positives for four different reasons, one of which would have become a bug if fixed |
| silent failure, backend (§D) | **closed**, all nine |
| silent failure, frontend | **0 SILENT**; 41 UNRESOLVED reported as unresolved, not as a pass |
| permission gates (§C) | **closed** — GL, inventory cost, AR reconciliation gated. Quotes (C6) were left UNGATED *because the owner decided that*, not while waiting for him to: reps amend each other's quotes and that is how the shop works. The old wording here read "left open by owner decision", which a later reader took to mean an open question and re-raised it |
| money (§B) | **all six done.** B6 by mig 0286 in the direction the owner chose; B4 closed 2026-08-14 — the workflow was clicked, production returned 23 part-ringgit combo prices of 163, and the engine now carries sen end to end. What read as a business judgement was a defect |
| COEs | 8 corrected — several described code that no longer exists |
| module guides | all 27 now say their line numbers are indicative and point at the generated locator; one UNDECLARED permission key found and declared |
| rule mirrors | 0 DIVERGED |
| dead code (§K) | **listed at last** — at least 184 sites, not the 12 that were claimed and never enumerated. 28 files annotated, 4 orphans deleted, the rest LEFT with a stated reason; 2 of those were already on record as deliberate keeps, so a naive sweep would have reversed two written decisions |

**Still owner decisions — NONE in this table.** B4 was the last, and it closed
on 2026-08-14 the way it was designed to: the check ran, the data answered the
question, and what looked like a business judgement turned out to be a defect.
Production carries **23 part-ringgit combo prices out of 163**, so the business
already prices in cents; the engine was rounding it away. Fixed by carrying sen
end to end. The row below is kept for the reasoning, not as an open item.

**What is NOT closed by that fix:** documents already priced from those 23 rows
carry the rounded figure. Sizing that impact is a separate pass, deliberately not
folded into the code change.

**The original wording follows.**
Each is a question about how the business should work, which is not this
audit's to answer:

| # | question | what it costs to get wrong |
|---|---|---|
| B4 | Should a sofa module ever be priced in cents? | Run **Actions → Sofa price rounding check (read-only)**. Zero part-ringgit rows ⇒ add a guard at data entry; non-zero ⇒ the pricing engine has to carry sen and past documents need an impact pass |

**That is the only one left, and it is a button, not a paragraph.** The other
four closed on 2026-08-13:

- **E4 / E5** — the owner's answer turned out to be ONE rule, not two: a
  Processing Date is the proceed signal, and proceed is what makes a field
  required. Both the address and the variant list now hang off it, on desktop,
  on mobile, and on the server. E5 needed no change at all; that row was stale.
- **F2** — split into a real half and a refuted half by opening the PARENT
  table. `compartment_fabric_tier_overrides` re-keyed by mig 0293;
  `model_fabric_tier_overrides` cannot collide and the comment claiming it could
  is corrected in place.
- **The consignment LOADED-reopen question** — resolved by §J, which caps
  returns at the sibling documents' rule.

**Owner-only, unchanged:** a new Staging `CLOUDFLARE_API_TOKEN`, entered
directly into GitHub → Settings → Environments → Staging. Never through chat.

---

## K. Dead code — the list the count never had (swept 2026-08-13)

**Why this section exists.** §A said `dead code | 12` and the twelve were never
written down anywhere. A count with no list cannot be acted on and cannot be
checked — it is the same failure this ledger exists to stop. The sweep below
replaces it. **The real number is not 12: it is at least 184 sites.** Nobody had
counted; "12" was an impression.

**"At least", said precisely.** 184 is what this sweep can *name*, and it is a
floor for one structural reason: the scan counts a symbol only when its own file
mentions it exactly once, so a helper that is called by its dead neighbour inside
an unreachable module is not counted. K5.1's `createDbPinRateLimiter` and K5.2's
`transferLoaner`/`reverseLoaner` are each dead — their whole module has no
importer — yet none of the three is in the 108. Quote 184 as a floor, or better,
re-derive it.

| bucket | count | disposition |
|---|---|---|
| dead `42501 -> 403` branches | **74** across 28 files | ANNOTATED (28 file-level notes) |
| dead duplicate route handler | **1** | ANNOTATED + owner decision (K2) |
| exported symbols, zero references repo-wide | **108** (29 native, 79 vendored) | 4 DELETED, rest LEFT with reasons |
| whole page file with no importer and no mounted route | **1** | LEFT (already documented in the map) |

**How the 108 was derived, so it can be re-derived.** Every
`export (function|const|let|var|class|type|interface|enum) NAME` across
`backend/src`, `frontend/src`, `backend/scripts`, `backend/tests`,
`backend/tests-pg`, `frontend/scripts`, `e2e`, `scripts`, `mail-sync`, `native`
(5,399 symbols), then a word-bounded search for each NAME in every *other* file.
Kept only value declarations whose own file mentions them exactly once — i.e.
the declaration itself, so nothing anywhere calls them. The regex self-tests
against an 8-form fixture and exits non-zero rather than reporting from a dead
pattern (CLAUDE.md: *a verdict computed over nothing must never read as a pass*).

### The two traps that make an import-graph verdict wrong HERE

Both bit during this sweep. Anyone repeating it will hit them again.

**Trap 1 — everything in `frontend/src/components/` is re-exported wholesale, so
it can never be judged dead by imports alone.** `frontend/package.json` is named
`autocount-sync-frontend`; `frontend/.design-sync/config.json` sets
`"srcDir": "src/components"` and names each component's file; and
`frontend/.design-sync/entry.tsx` carries a literal
`export * from '../src/components/<Name>'` per component, with a matching
preview under `.design-sync/previews/` that imports it back from the package
name. Three separate leads were refuted by this one mechanism:

| lead | verdict | proof |
|---|---|---|
| `components/DetailLayout.tsx:326` `DefinitionList` | **NOT DEAD** | 5 preview files import it; `config.json:71`-style entry maps it |
| `components/Breadcrumbs.tsx` `Breadcrumbs`, `BreadcrumbItem` | **NOT DEAD** | `entry.tsx:33` `export * from '../src/components/Breadcrumbs'`; `config.json` maps `"Breadcrumbs": "src/components/Breadcrumbs.tsx"`; `previews/Breadcrumbs.tsx` exists |
| `components/Gate.tsx:25` `Gate` | **NOT DEAD** | `entry.tsx:45` `export * from '../src/components/Gate'`; `config.json` maps `"Gate": "src/components/Gate.tsx"`; `previews/Gate.tsx` exists |

My scan reported 109 and `DefinitionList` was the one false positive, so the true
figure is **108**. The other two were reported by a second, independent sweep and
refuted here. **Any dead-code check on this repo must include
`frontend/.design-sync`, or it will propose deleting live design-system exports.**

**Trap 2 — `grep`/`ripgrep` silently skip six files in this tree.** Six source
files contain NUL bytes and are treated as binary, so they are excluded from
ordinary grep output with no warning: `frontend/src/pages/scm-v2/SalesOrderMaintenance.tsx`,
`backend/src/scm/lib/size-variant-description.ts`,
`frontend/src/vendor/scm/lib/propose-days.ts`, and three `backend/scripts/*.mjs`.
That is enough to manufacture a false "zero references" — the second sweep
initially called `vendor/scm/components/Toast.tsx` dead purely because its only
importer (`SalesOrderMaintenance.tsx`) was skipped. **Use `grep -a`, or read the
files in Node as the scan here does.** Every deletion in K3 was re-verified with
a Node reader over 2,036 files (6 of them NUL-bearing) and came back at exactly
zero references.

**Depth of verification, stated plainly.** All **29 native** orphans were
re-checked by hand with a repo-wide word-bounded search including
`frontend/.design-sync`, and each was read in source before being deleted or
left; the four actually deleted were re-verified a second time with the
NUL-safe Node reader (Trap 2). The **79 vendored** ones were NOT individually
re-read: they are
left untouched as a class for the reason in K4.14, so nothing turns on any one of
them. If that class is ever pruned, re-verify each first — do not trust this row.

### K1 — the 74 dead `42501 -> 403` branches

**Evidence they cannot fire**, all read in source rather than inferred:

1. `backend/src/db/migrations-pg/0061_enable_rls_scm.sql` enables RLS on every
   `scm.*` table and creates **no policies** — and says so in its own header.
2. `grep -rn "CREATE POLICY" backend/src/db/migrations-pg/` returns **nothing**,
   so no policy has been added since.
3. Every one of the 74 sits in `backend/src/scm/routes/*.ts`, and that subtree's
   client is set once — `scm/middleware/auth.ts:93` calls
   `getSupabaseService(c.env)`, which `db/supabase.ts:68` builds with
   `SUPABASE_SERVICE_ROLE_KEY`. service_role bypasses RLS. The handful of routes
   that build their own client (`categories.ts:145`, `mfg-products.ts:896`,
   `product-models.ts:61/116/574`, `mfg-sales-orders.ts:2158/5445`,
   `sofa-compartment-photos.ts:108`) all pass the **same service-role key**.
4. 42501 could also arrive from a `RAISE ... USING ERRCODE`. Searched every
   `.sql` under `backend/` and `scripts/`: the live tree's only ERRCODE is
   `22023`, and **no** function raises `forbidden`/`permission denied`/`denied`
   as a message either — so the `|| /permission denied/i.test(error.message)`
   half that 20 of them carry is equally dead.

The only residual way to reach one is a missing table GRANT, which is a
deployment fault mislabelled as `403 forbidden` instead of a 500 — not
authorization, and not scoping.

**Not deleted, deliberately.** The tree's own established idiom is to KEEP the
branch and annotate it: `trips.ts:538` and `maintenance-config.ts:327` both
already did exactly that, and both left the `if` in place. `backend/src/scm` is
also VENDORED (`docs/CODEBASE-MAP.md:121`) — "fix bugs in place, narrowly", the
value being that a 2990 file and its Houzs copy still look alike. So each of the
28 files got ONE note above its first 42501 site, worded to cover every site in
that file. A per-branch comment would have been 74 edits into vendored code for
the same information.

| file (`backend/src/scm/routes/`) | 42501 lines | annotated at |
|---|---|---|
| `delivery-orders-mfg.ts` | 4335 | 4327 |
| `delivery-planning-regions.ts` | 127, 167, 200, 342, 350 | 119 |
| `delivery-planning.ts` | 2183, 2405 | 2175 |
| `delivery-rate-cards.ts` | 269, 312, 327, 380, 415, 433 | 261 |
| `delivery-residence-rules.ts` | 151, 201, 222 | 143 |
| `delivery-zones.ts` | 165, 218, 236, 765, 782 | 157 |
| `driver-leave.ts` | 134, 149 | 126 |
| `drivers.ts` | 116 | 108 |
| `fabric-library.ts` | 92 | 84 |
| `fabric-tracking.ts` | 144, 234, 272, 336, 368, 405, 462, 520 | 136 |
| `helpers.ts` | 101 | 93 |
| `lorries.ts` | 215 | 207 |
| `lorry-capacity.ts` | 391, 458 | 383 |
| `maintenance-config.ts` | 288, 358, 401 | 280 (prose note already at 327) |
| `mfg-products.ts` | 284, 462, 473, 813, 1120 | 276 |
| `mfg-purchase-orders.ts` | 1336 | 1328 |
| `personal-quick-picks.ts` | 168, 193 | 160 |
| `pos-cart.ts` | 138 | 130 |
| `products.ts` | 79 | 71 |
| `purchase-consignment-orders.ts` | 394 | 386 |
| `sofa-combos.ts` | 463, 471, 620, 777 | 455 |
| `sofa-quick-picks.ts` | 165, 194 | 157 |
| `special-addons.ts` | 388 | 380 |
| `stock-takes.ts` | 420 | 412 |
| `stock-transfers.ts` | 313 | 305 |
| `suppliers.ts` | 444, 511, 596, 675, 751, 809 | 436 |
| `threepl-companies.ts` | 240, 291, 312 | 232 |
| `trips.ts` | 485, 559, 707, 1124 | 477 (prose note already at 538) |

### K2 — a dead route handler, and it is not only dead

| # | site | what it is | evidence | disposition |
|---|---|---|---|---|
| K2 | `backend/src/routes/users.ts:2291` | `POST /:id/impersonate` registered a **second** time | One `new Hono` in the file (`:377`), one `export default app`. The same method+path is already registered at `:2031`. Hono composes both chains in registration order and the `:2031` handler returns on every branch — **no handler in this file ever continues the chain** — so the second registration is never entered. | **ANNOTATED, left in place — OWNER** |

**This one is worth the owner's attention, because the dead half is the newer
design.** What runs (`:2031`) is wildcard-`*`-only with a 1-hour session. What is
dead (`:2291`) is the two-door design the comment block above it describes:
staging flag OR wildcard. Consequences today:

- `wrangler.toml:329` sets `IMPERSONATION_ENABLED = "true"` for
  `[env.staging.vars]`, and that flag now changes **nothing** about who may mint.
- `GET /impersonation-enabled` (`:2285`) is *not* shadowed (it is the only
  1-segment GET besides `/`), so on staging it answers `enabled: true` to any
  `users.manage` admin — whose mint call then 403s `"Owner only"`. **The probe
  and the mint disagree.**

Left as is on purpose: deleting `:2291` hides the intent, and deleting `:2031`
would silently grant every `users.manage` admin a 7-day impersonation session on
staging. Which door is correct is a security decision, not a cleanup.

### K3 — orphaned exports: what was DELETED

Four, each proved by a repo-wide word-bounded grep returning exactly one hit
(the declaration). Each is an alias or a shim whose live successor is heavily
used, so removing it removes duplication, not capability. Backend and frontend
`tsc --noEmit` both clean afterwards; `backend` vitest re-run.

| # | site (pre-delete) | what it was | evidence it was dead | why safe |
|---|---|---|---|---|
| K3.1 | `backend/src/services/projectAcl.ts:70` | `getProjectPicScope` — "back-compat shim" for callers that only want the PIC dimension | 1 hit repo-wide. Its successor `getProjectScope` has 16. | Pure delegation to `getProjectScope(user).pic_ids`; the shim had no caller to be back-compatible *with* |
| K3.2 | `backend/src/services/agent-brain.ts:114` | `ANTHROPIC_MESSAGES_URL` | 1 hit. It was `= ANTHROPIC_URL`, which has 12. | Exported alias of a live constant, nothing imported it |
| K3.3 | `backend/src/services/pageAccess.ts:679` | `getChildrenOf(parentKey)` | 1 hit. Sibling `getPageDef` has 2. | One-line `PAGES.filter(p => p.parent === parentKey)`; no permission logic |
| K3.4 | `frontend/src/auth/capabilities.ts:131` | `useCapabilitiesUnresolved` | 1 hit. Non-hook twin `capabilitiesUnresolved` has 13. | Hook wrapper only. Its doc comment claimed "the one or two places that render the message" — there were **zero**; the comment was already lying |

### K4 — orphaned exports LEFT ALONE, and why

Deleting code is cheap to get wrong. Every row below is genuinely unreferenced;
none is deleted, and the reason is stated so the next sweep does not re-litigate
it.

| # | site | what it is | why LEFT |
|---|---|---|---|
| K4.1 | `backend/src/services/salesTeam.ts:29` `wouldCreateUplineCycle` | upline loop guard | **The source already says so:** ":29 — its POST/PATCH sales-team admin routes are stranded on `ux/tier3-polish` and the module is slated to return (owner call, 2026-07-29). Kept deliberately — don't sweep as dead code." |
| K4.2 | `backend/src/services/salesTeam.ts:228` `autoBackfillSalesReps` | self-heal for missing `sales_reps` rows | `BUG-HISTORY.md:7948` already records it as never called. The open question is whether to **wire** it, not whether to delete it — deleting removes the recovery tool the bug entry points at. Owner call |
| K4.3 | `backend/src/services/printTracker.ts` (whole file, 189 lines; `renderStageTrackerHtml`, `STAGE_TRACKER_CSS`) | print stage tracker | **A deliberate keep is already on record.** `BUG-HISTORY.md:6337`: "Deliberately NOT done ... it has no importer at this commit ... rewriting a print artifact's stage derivation is a behaviour change that does not belong in a delete-dead-code commit." Also labelled in `docs/modules/service-case.md:101`. Deleting it would silently reverse a written decision |
| K4.4 | `backend/src/services/printQr.ts` (whole file; `qrSvg`, `getOrIssueCustomerPortalToken`, `customerPortalUrlFor`) | QR helpers for the ASSR print routes | Zero importers, but the same ASSR-print family as K4.3 and covered by the same reasoning. It also owns the only use of the `qrcode-generator` dependency, so deleting it drags a package removal into a dead-code pass |
| K4.5 | `backend/src/services/agents/decision-outcomes.ts:34` `recordOutcome` | writes `agent_decision_outcomes` | Half-built agent platform: the reader side (`PromotionEvidence` and friends) is present. This is a reporting channel nothing feeds yet — deleting the writer entrenches that. Roadmap item, not litter |
| K4.6 | `backend/src/services/autocount.ts:275` `isAutoCountWritesDisabled` | kill-switch accessor | Deliberate public surface ("exposed so other modules ... can detect the kill switch state without poking at the private constant"). Its twin `isAutoCountSyncDisabled` is live. The two AutoCount directions have separate switches and must not be conflated |
| K4.7 | `backend/src/services/pageAccess.ts:35/37` `ACCESS_LEVELS`, `POSITION_ACCESS_LEVELS` | the writable level sets for the ROLE (3-level) and POSITION (4-level) editors | The only place the two vocabularies are written down, next to the `AccessLevel` union they explain. Removing them deletes documentation, not code |
| K4.8 | `backend/src/services/fleet-status.ts:524` `BREAKDOWN_STATUS_LABELS` | label map | Sits in a coherent vocabulary block whose siblings `BREAKDOWN_SEVERITIES` / `BREAKDOWN_STATUSES` are live. Splitting the block for one unused member is churn |
| K4.9 | `backend/src/services/agents/of-agent.ts:26`, `si-agent.ts:27` | `OF_AGENT_SETTING_KEY`, `SI_AGENT_SETTING_KEY` | Canonical names for settings rows that may already exist in the database. Cheap to keep, and a name is the wrong thing to delete on a grep |
| K4.10 | `frontend/src/lib/nativeSession.ts:109` `biometricAvailable` | "in the app, flag on, plugin present, biometric enrolled" | **Possible gap, not just litter.** Its narrower sibling `nativeBiometricSupported` (:97) is live and deliberately IGNORES the opt-in flag. Nothing performs the full check. Whether that is a missing gate is a question for the owner, so the function stays until it is answered |
| K4.11 | `frontend/src/pwa.ts:138` `onUpdateAvailable` | "a newer build is live" subscription | Part of the `onOnline`/`onUpdateAvailable` subscribe pair; `onOnline` is live. Its comment claims "the banner reads this" and no banner does — noted as another comment that lies, but the API pair is coherent |
| K4.12 | `frontend/src/lib/utils.ts:14/214`, `lib/scm.ts:60`, `lib/csv.ts:123`, `lib/holidays.ts:101`, `components/StatusDot.tsx:39`, `mobile/source-chips.tsx:176` | `formatNumber`, `isExpiringSoon`, `scmStatusClasses`, `parseCSVFile`, `isHoliday`, `statusVariantForAssr`, `DeliveredRowMobile` | Small shared-utility surface in live modules. Each is genuinely unreferenced, but they are the kind of helper a page adds back next week, and `StatusDot.tsx` sits under `src/components` where `.design-sync` resolves — the exact trap that produced this section's one false positive |
| K4.13 | `frontend/src/pages/ServiceLogistics.tsx:60`, `frontend/src/pages/MailCenter/Compose.tsx:647` | whole page components | No importer **and** no lazy import by path (`grep` for the path strings returns nothing). Genuinely unreachable, but a page is a feature; retiring one is a product call. Same class as the already-documented `pages/scm-v2/Drivers.tsx` |
| K4.14 | 79 exported symbols under `frontend/src/vendor/**`, `frontend/src/pages/scm-v2/**`, `backend/src/scm/**` | mostly unused `use*` React-Query hooks in `vendor/scm/lib/*-queries.ts` | **VENDORED.** `docs/CODEBASE-MAP.md:121-125`: copied from 2990 to stay diffable, "do not casually rename, reformat or modernise them, and do not fold their helpers into the native tree". Pruning the unused half of a vendored API surface destroys exactly the property the vendoring exists for |
| K4.15 | `backend/scripts/lib/sqlite-default-to-pg.mjs:281` `__internals`, `e2e/lib/helpers.ts:111` `reloadAndSettle` | test/tooling seams | `__internals` is the conventional test-seam export; both are tooling, not product code |

### K5 — superseded implementations still on disk (all VENDORED, all LEFT)

These are the "old/new competing implementations" half of the sweep. Each is a
whole module with zero importers whose job is now done by something else. All sit
under `backend/src/scm/**`, so K4.14's vendoring rule governs them — but unlike a
merely-unused hook, each one has a NAMED successor, which is what makes it worth
recording rather than just counting.

| # | dead module | superseded by | evidence |
|---|---|---|---|
| K5.1 | `backend/src/scm/lib/pin-rate-limit.ts` (`pinRateLimiter`, `createPinRateLimiter`, `createDbPinRateLimiter`) | `backend/src/routes/pos.ts:53,75,97` | `pos.ts` calls the same three RPCs directly (`scm.pin_attempt_check` etc.) and never imports the lib. The only other hits for the module name are two SQL *comments* (`migrations-pg/0099_pos_auth.sql:17`, `scripts/scm-schema/port-missing-functions-triggers.sql:414`) |
| K5.2 | `backend/src/scm/lib/consignment-loaner.ts` (`consignmentWarehouseId`, `transferLoaner`, `reverseLoaner`) | a local reimplementation — `resyncNoteInventory` defined at `backend/src/scm/routes/consignment-notes.ts:273`, called at `:755` and `:848` | `consignment-notes.ts` imports `writeMovements` from `../lib/inventory-movements` (`:31`) and never imports `consignment-loaner` |
| K5.3 | `backend/src/scm/lib/po.ts` (`validatePoLineItemsShape`, `renderPoPrintHtml`) | nothing — the print path moved | Zero importers. Its header claims "this file is for pure logic + tests", but there is **no `po.test.ts`** in `backend/src/scm/lib/` (only `po-allocations.test.ts` and the `po-revision.*` suites). The stated justification for the file no longer holds |
| K5.4 | `backend/src/scm/lib/staff-code.ts` (`nextStaffCode`, `extractInitials`) | nothing | Zero importers; the only other mention is the file's own line-2 header |

**Why K4.3/K4.4 (`printTracker.ts`, `printQr.ts`) are dead has a named cause.**
`backend/src/routes/assr_print.ts:337` states that the tracker, QR panel and
notice layout were removed from print. Both modules are the leftovers of that
removal — which is also why `printTracker.ts:18` says "Nothing imports this
module at present" and, unusually for this repo, that comment is **accurate**.

### K6 — read this before the next sweep: things that LOOK dead and are not

Recorded because each would be a damaging delete, and a future pass will meet
them again.

| what | why it looks dead | why it is NOT |
|---|---|---|
| `frontend/src/pages/scm-v2/{SalesOrderDetail,PurchaseOrderDetail,PurchaseInvoiceDetail,GoodsReceivedDetail}.tsx` | each is headed "Legacy inline editor" and no page imports them by name | each is `lazy(() => import(...))`-ed by its own `*V2` successor (`SalesOrderDetailV2.tsx:496`, `PurchaseOrderDetailV2.tsx:365`, `PurchaseInvoiceDetailV2.tsx:335`, `GoodsReceivedDetailV2.tsx:263`) behind `params.get("edit") === "1"`. The V2 pages are read-only by design, so **these "legacy" files are the only editable path in the app** — deleting them breaks every Edit button |
| `applyCustomerCreditToSiLegacy` (`scm/lib/customer-credits.ts:149`), `settlePiPaidCentiLegacy` (`scm/lib/pi-settlement.ts:145`) | named `*Legacy` | runtime fallbacks when the atomic RPC is absent (`customer-credits.ts:141`, `pi-settlement.ts:137`), and both are exercised by `customer-credits.test.ts:159/:382` |
| `frontend/src/vendor/scm/components/SpecialAddonsTab.tsx` | nothing imports it and nothing renders it | `frontend/src/auth/permissionDivergence.test.ts:35` pins the path and asserts on its **source text** via `readFileSync`. A test consumer means not dead — but note the dependency is a source scan, not an import, so the component may be unrendered in production while the test still passes. Worth a look, separately |
| `vendor/scm/lib/react-virtual-shim.ts`, `frontend/src/main.tsx`, `frontend/src/test-setup.ts` | no import edges | reached via config: a Vite alias (`vite.config.ts:127` + `tsconfig.app.json:30`), `index.html:57`, and `vitest.config.ts:19` |
| `frontend/src/pages/scm-v2/Drivers.tsx` | no importer, no route | deliberate and documented at `frontend/src/App.tsx:683-689`: "/scm/drivers is RETIRED... The file is KEPT on disk (vendored 2990 tree shape)... Do not re-add this route" |
| `filterable?: boolean` (`components/DataTable.tsx:107`) | marked `@deprecated` | dozens of live call sites; the note itself says it is kept so they compile |

**Not dead, do not report it again:** `backend/src/db/migrations/` is the D1 test
tree. `vitest.config.ts` builds an in-process D1 from it with `readD1Migrations`
(`docs/CODEBASE-MAP.md:106-113`). It is unreachable from production and reachable
from the tests, which is the definition of *used*.

---

## L. Docs vs source — the theme that had no section (added 2026-08-13)

**The owner asked why this was missing, and he was right to.** It existed only
as four words inside §G's running list — "docs-vs-code (incl. every COE's fixes
shipped table)" — with no count, no evidence and no check. Work HAD been done
(8 COEs corrected, 27 module guides re-pointed at the generated locator), but
"we fixed some docs" is exactly the unfalsifiable claim this ledger exists to
replace. A theme with no number is not a theme.

**Why it is the highest-leverage one.** `CLAUDE.md` is AUTO-LOADED into every
session. When it said the database was D1 SQLite for a month after the Postgres
cutover, every session believed it. A wrong doc does not fail a test — it
recruits the next reader into repeating the mistake.

### L1. The mechanical half is now a gate

`backend/scripts/check-docs-drift.mjs`, wired `--strict` into `ci.yml`. It
resolves every claim a script can settle across 138 markdown files:

| checked | result |
|---|---|
| 2,925 mechanically checkable claims | **0 CERTAIN** findings |
| file + directory paths | resolved from repo root, `backend/`, or `frontend/` |
| `mig NNNN` / `migration NNNN` | resolved against BOTH migration trees |
| permission + area keys | resolved against `permissions.ts` AND `scm-areas.ts` |
| `npm run X` | resolved against all three `package.json` files |

**22 real broken references were found and fixed** — the backend vitest config
cited with a `.ts` extension when it is `.mts` (CI's own comment named it
wrongly), `BUG-HISTORY.md` cited under a `docs/` prefix when it lives at the
repo ROOT, from five separate places, a vitest config cited as `.conf`, three
files that had MOVED (`slip.ts` into `scm/lib`, `PhoneInput.tsx` into
`vendor/scm/components`, `scaleTargetGuard` from a `.test.mjs` to a `.node.mjs`
suffix),

*(Those two are described in prose rather than written out, deliberately: this
section was the checker's LAST finding, because quoting a broken path as an
example puts a copyable trap back in the tree. The right fix was clearer
writing, not a fourth marker.)*

and eleven historical or planned references that now carry a marker.

**The checker was wrong four times before it was right**, and the count moved
in both directions each time — recorded here because the pattern is the point:

| what it did | count | the lesson |
|---|---|---|
| knew only `permissions.ts` | 426 false | there are TWO key namespaces; area keys live in `scm-areas.ts` |
| resolved paths only from the repo root | +11 false | docs write `scripts/pg-migrate.mjs`, which is under `backend/` |
| `\.[a-z]{2,4}` for extensions | +1 false | matched `costing-enabled.is` out of "costing-enabled.ts is" |
| `(?:ts\|tsx)` in that order | **+72 false** | alternation is first-match-wins, so `App.tsx` matched as `App.ts` and 72 PRESENT files were reported missing |

Every one of those would have produced a confident report telling a reader to
"fix" documentation that was already correct. **A checker's first run is a draft.**

### L2. The half a script cannot settle

Whether a documented BEHAVIOUR matches the code needs a reader, and that sweep
is running separately over `CLAUDE.md`, `CODEBASE-MAP.md`, every COE's
fixes-shipped table, all 27 module guides and the most recent `BUG-HISTORY.md`
entries. Prioritised by blast radius: auto-loaded first.

Already corrected by hand in this pass, as samples of the class:

- `fabric-tier-addon.ts` asserted a cross-company overwrite on
  `model_fabric_tier_overrides` that **provably cannot happen** — the parent
  `product_models` is per-company. The comment is replaced by the refutation,
  not deleted, because the claim was plausible enough to be believed twice.
- `companyScope.ts` described its unresolved-context fallback as BARE numbering;
  it has been `HC-` since 2026-08-07 and its own test asserts that. The
  conclusion survived; the stated mechanism did not.
- `ci.yml` said company-scope was report-only "until that reaches 0". It had
  reached 0. It is `--strict` now.
- `grn-queries.ts` builds an argument on a caller file, `GoodsReceived.tsx`,
  that does not exist. **Left alone deliberately** — whether that hook is dead
  or unfinished is the owner's call, not a doc fix.

### L3. What is NOT claimed

The mechanical checker cannot see a reference that is well-formed but wrong for
its purpose: a doc naming a real file for the wrong reason passes. And §L1's
"0 CERTAIN" means every *checkable* claim resolves — it does not mean the docs
are true. Those are different sentences and this file will not merge them.

---

## M. The module sweeps — what four parallel audits found that the checkers could not

**Why this section exists.** §A tracked the artifact's six CLUSTERS and §I recorded
the checker's own failures. Neither covers the thing that actually produced the
biggest yield: reading whole modules, by hand, against the five defect classes
this audit had already PROVEN real. The checkers found none of what follows.

### M1. The score

| slice | confirmed | refuted | judgement calls raised |
|---|---|---|---|
| sales + inventory | 7 | 2 | 2 |
| procurement + finance + consignment | 11 | 5 | 3 |
| native tree + fleet + ASSR | 5 | 13 fleet + 8 native | 4 |

**Twenty-three confirmed defects. Twenty-eight refutations.** More than half of
every lead was wrong, which is the number that justifies the rule: *a finding is
a LEAD, not a verdict.*

### M2. The pattern that made the yield — CONVERTERS

`companyScope.ts` names FOUR conversions that each refuse a cross-company source
(SO→DO, SO→SI, DO→SI, PO→GRN). The sweeps found **seven more that refused
nothing**:

| conversion | what it did |
|---|---|
| DO→SI, the PARTIAL form (`/:id/items/from-do/:doId`) | folded a 2990 delivery into a Houzs invoice; `postSiRevenue` then posted 2990's revenue to Houzs' books |
| DO→DR (`/from-do`, `/from-dos`) | returned a 2990 delivery as a HOUZS return, Houzs doc number, writing the stock back in against the wrong ledger |
| SO→PO (`convertSosToPosCore`) | minted a HOUZS purchase order + supplier commitment from a 2990 SO line, and advanced that line's `po_qty_picked` |
| GRN→PI | re-companied a receipt into this company's AP and re-cost |
| GRN→PR | drew stock OUT of the other company's warehouse under this company's refund |
| PCO→PC-receive | received the other company's consignment order |
| PC-receive→PC-return | returned the other company's consigned goods |

**Four guarded, seven unguarded, and nothing in the code said which was which.**
A converter reads a source document BY ID; if it does not compare that
document's company, the conversion silently re-parents money.

### M3. A STAMP IS NOT A PREDICATE — the shape that hid the most

```ts
.from('sales_invoices').select(...).eq('id', id)               // unscoped LOAD
.from('sales_invoice_payments').insert({ company_id: activeCompanyId(c) })
                                                               // a STAMP
```

Stamping the ACTIVE company onto a row you WRITE says nothing about whose row
you LOADED — and when the two disagree, **the stamp is what makes the damage
silent**, because the row looks correctly attributed while sitting on the wrong
parent. `sales-invoices.ts:2068` carried a comment reading *"multi-company: match
the SI's company"* directly above a line that never compared anything.

It also fooled `check-company-scope.mjs`, which counted the statement as scoped
because it contains a real `.from(` query and the helper's name. **That was the
FIFTH blind spot in that script in one day**, and like the other four it made the
number too small: 0 WRITE findings while seven money writes existed. Fixed by
stripping insert payloads before the scoped-ness test; the honest count went
0 WRITE → 11 WRITE → 0 WRITE again once the sweeps closed them.

### M4. The refutations worth keeping

A refutation is a result. These are the ones that would otherwise be re-chased:

- **13 of 13 fleet leads.** The unified fleet is deliberate — migs
  0202/0203/0204/0238 each say `company_id` is stamped for PROVENANCE and NOT
  used to scope reads. The two the checker newly surfaced stamp a company onto a
  child of a lorry that carries its own, so the stamps genuinely CAN disagree —
  but nothing reads either: all seven read sites of each table key on `lorry_id`
  and none selects, filters or groups on `company_id`. Scoping them would HIDE a
  HOUZS lorry's road tax from the 2990 dispatcher driving it.
- **`delivery_order_crew`'s `onConflict: 'do_id'`** looked like the
  single-column-key defect. `delivery_orders` carries `company_id`, so a `do_id`
  already implies one company — and the row inherits the DO's company
  deliberately, because TMS is a cross-company queue.
- **`postPiAccounting`'s unscoped `source_doc_no` lookups.** `companyDocPrefix`
  gives each company a distinct document-number namespace, so a doc_no names one
  company by construction.
- **ASSR `PATCH /:id` and friends** — flagged by a sweep, which then found them
  covered by `enforceCaseScope` mounted at the ROUTER on `/:id{[0-9]+}`,
  invisible to a per-handler read. It **reverted its own four edits** rather than
  leave a partial duplicate of a rule the guard owns, and pinned the fact its
  remaining fix depends on: `/bulk/*` is genuinely NOT matched by those patterns.

### M5. Two tests that could not have failed

- `tests/assrCaseScopeGuard.node.mjs` was written and **would never have run**:
  `.node.mjs` files match neither vitest config and execute only through
  `test:scale-contract`, which lists its files explicitly. Added there.
- `tests/autocountWritebackCells.test.ts` broke on a RENAME, not a regression:
  extracting a handler to a named export moved its route registration BELOW the
  body, and the test anchored on the registration, so `between()` returned -1.
  Re-anchored on the declaration, which is where the body is.

Both are the same class as a checker whose regex cannot match: **a verdict
computed over nothing must never read as a pass.**

## N. The gates themselves lied on Windows — found 2026-08-14

Three gates in the REQUIRED `backend-typecheck` job returned a different verdict
on a Windows checkout than on Linux CI. All three compare something built at
runtime against something committed, and all three were written where the two
forms coincide.

| gate | what it compared | what Windows gave it |
| --- | --- | --- |
| `check-jsonb-binds.mjs:80` | `relative()` path vs an ALLOWLIST of posix keys | `backend\scripts\...` — no key ever matched |
| `check-swallowed-reads.mjs:55` | `relative()` path vs 126 posix keys in the baseline JSON | every per-file ceiling lookup missed |
| `gen-test-schema-snapshot.mjs:324` | file text vs generated text, with `!==` | CRLF from git's checkout vs the generator's LF |

The third was the most expensive to believe. It said "regenerate"; regenerating
produced a byte-identical file; `git diff` reported nothing changed. Nothing
under `src/db/migrations/` had changed at all — this branch's five migrations are
in `migrations-pg/`, which does not feed that snapshot (148 collapsed = exactly
the D1 tree's file count).

**The second one is why this section exists.** A ratchet whose lookups all miss
reports the entire tree as new — 153 sites — and a gate that unreadable gets
waved past. Underneath those phantoms sat a real defect this branch had
introduced: **21 reads of the form `const { data: own } = await <query>` with no
`error` bound, inside the company-scope guards the branch was adding.**
supabase-js does not throw, so on a database failure `own` is undefined and the
guard answers `404 not_found` — an outage reported to the caller as "this
document does not exist". Repairing the path bug is what made them visible.

One of the 21 was not a status-code problem at all. `grns.ts` re-reads the
receipt's own `inventory_movements` to price a warehouse relocation at the LANDED
cost the units actually entered at; a discarded failure leaves that map empty and
the relocation re-opens at BASE cost, so capitalised freight leaves inventory
value permanently — on a container GRN, the whole freight bill.

**Fixed** by normalising before comparing (`.split(sep).join('/')`, and an
`eol()` that strips `\r\n`), then binding `error` at every site and returning
`500 lookup_failed`. The lesson is the one already in `CLAUDE.md` about the `#!`
shebang and the CRLF test anchors, and it keeps costing: **a gate that only runs
green on CI's platform is a gate the person doing the work cannot use — and an
unusable gate hides real findings rather than merely annoying people.**
