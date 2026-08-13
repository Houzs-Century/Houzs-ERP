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
| cross-company scope | 56 (27 high) | **REOPENED 2026-08-13** — the scanner was too loose (see §I). Honest count is now **20 unscoped WRITES, 18 reads**, not 0. 13 handlers fixed and verified so far; the rest are listed by the script |
| permission / access gate | 11 (4 high) | 3 HIGH **DONE**, 4 **OPEN** (§C) |
| money / quantity arithmetic | 47 (12 high) | 3 **DONE** incl. the top HIGH, 3 **OPEN** (§B) |
| silent failure | 33 (5 high) | frontend 35 → 0 **DONE**; backend 2 CRITICAL **DONE**, 7 **OPEN** (§D) |
| old/new competing implementations | 29 | agent running |
| dead code | 12 | agent running |

---

## B. Money / quantity

| # | finding | status |
|---|---|---|
| B1 | **A discounted sofa build was invoiced for MORE than it was ordered.** Discount validated against the whole build, then dumped on module 0 whose price is one share; `senOrZero` guards NaN not sign; DO/SI clamp the negative away. RM8,000 build − RM3,000 → ordered RM5,000, invoiced RM6,000. | **DONE** — `distributeBuildDiscount` at all 3 split sites + 6 tests |
| B2 | `POST /purchase-invoices/from-grn` summed line totals UNCLAMPED while writing them CLAMPED, so `total_centi` ≠ Σ lines. Its sibling `/from-grn-items` already clamps inside the reduce and says why. GRN stores an unbounded `discount_centi` (grns.ts:1695), so the premise is real. | **DONE** |
| B3 | Three SO paths lower the unit price and keep the stored discount: variant edit, product swap, sofa exchange. Negative total → clamped downstream → over-billing again. | **DONE** — all three now 422 `discount_exceeds_new_price`, following this file's own "reject-don't-normalize" rule (`:6199`, audit 2026-06-11 C-2) |
| B4 | The **persisted** sofa selling price is quantised to whole ringgit per module and per combo (`sofa-build.ts:503/533/1260`), so RM1,299.50 × 4 bills RM5,200 instead of RM5,198. Only bites when a module price is not a whole ringgit; every writer of those columns is operator-entered. | **OPEN** — needs a data check before changing a pricing engine |
| B5 | Landed-freight per-unit rounding (`recost.ts:383`) can double a sub-sen allocation: 50 sen over 100 units → 1 sen/unit → 100 sen capitalised. Bounded by ~0.5 sen/unit. | **OPEN** |
| B6 | A shipped-DO line reduction returns stock at a cost blended over costed and uncosted units (`delivery-orders-mfg.ts:1768`), creating value from nothing in the MIXED case. | **OPEN** — the symmetric argument is defensible for a fully-uncosted OUT |

## C. Permission gates

| # | finding | status |
|---|---|---|
| C1 | `POST /maintenance-config/sofa-compartments/rename` — **no gate at all**, and two comments each said the other layer had it. Renames a compartment code across the SKU master, every historical doc-line snapshot, combos, quick picks and in-flight carts. | **DONE** |
| C2 | `/localities` POST/PATCH/DELETE — no gate; shared 5,870-row postcode master + city-level routing; no `company_id`, so a change hits both companies. | **DONE** |
| C3 | `/state-warehouse-mappings` PUT/DELETE — no gate; repoints which warehouse an entire state ships from. | **DONE** |
| C4 | `inventory.ts` cost/valuation/supplier reads have no finance gate; Storekeeper holds `scm.warehouse.inventory = view` and `canSeeMargin: false` is written and never enforced. | **OPEN** |
| C5 | `/ar/reconciliation` — whole-book receivables, no area guard, no finance gate, no row scope. Its own header records the choice. | **OPEN** |
| C6 | Quotes: the list is row-scoped to own+downline, `PATCH /:id` and `/:id/cancel` are not. | **OPEN** |
| C7 | `accounting.ts` — zero in-route checks on 4 GL verbs; its only gate (`moneyWriteDenial`) fails open for a positionless caller. Payment vouchers are double-gated; the GL is not. | **OPEN** |

## D. Silent failure — backend

| # | finding | status |
|---|---|---|
| D1 | DO cancel discarded `writeMovements`' result — stock left permanently deducted, 200 returned. The sibling `resyncInventoryForDo` was given a failure trace on 2026-08-05; the cancel twin was not. | **DONE** |
| D2 | DR line add/edit/delete/cancel — same shape, four callers. The CREATE path reports; the mutations did not. | **DONE** |
| D3 | `grns.ts:2553` GRN cancel — reversal failure logged only. | **OPEN** |
| D4 | `grns.ts:2575` — the 2026-07-31 `RecountResult` fix reached the POST caller and not the CANCEL caller. Its own header documents the incident it caused. | **OPEN** |
| D5 | `recomputePoReceived` (`grns.ts:839/862`) returns `{ok:true}` after an unchecked write — the reporting channel exists and actively lies. Same in `purchase-consignment-receives.ts:354`. | **OPEN — rank first of the remainder** |
| D6 | `purchase-returns.ts:1049` — `reverseMovements` computes a partial-failure count; the caller reads only `reversed > 0`. | **OPEN** |
| D7 | Consignment note/return mutations discard the `string[]` their own create path returns. | **OPEN** |
| D8 | Purchase-consignment family — same discard; `recomputePcoReceived` never got the `RecountResult` upgrade. | **OPEN** |
| D9 | `consignment-returns.ts:779` `returnLineLock` never destructures `error`, so a failed read makes the terminal-state guard PASS. | **OPEN** |

## E. Frontend / rules

| # | finding | status |
|---|---|---|
| E1 | 35 mutations where a server refusal reached nobody. The owner's "Deactivate does nothing". | **DONE** — `writeFailed` wired; checker at 0 |
| E2 | `variantsRequired = true` default made 9 forms demand a field their own server never asked for. | **DONE** — default removed, prop now required |
| E3 | `isCorePaymentMethodRow` — UI locked a payment method the API would have let you delete; the two comments said FOUR and THREE. | **DONE** |
| E4 | Desktop `SalesOrderNew` has no address rule; mobile and backend both do. | **OWNER** — adding a required field is a business call |
| E5 | `SalesOrderNew`'s confirm gate requires variants "date or no date" (owner 2026-08-08) while the line card shows nothing required without a date. Marker and gate disagree. | **OWNER** |

## F. Schema / keys

| # | finding | status |
|---|---|---|
| F1 | `scm.pos_carts` keyed `staff_id` alone — switching company destroyed the other company's cart, silently. | **DONE** — mig 0284 re-keys `(staff_id, company_id)`; 9 pg tests **written but NOT RUN** (no Docker, no `TEST_DATABASE_URL` here — CI is the gate) |
| F2 | `model_fabric_tier_overrides` / `compartment_fabric_tier_overrides` have the same single-column-PK defect; one company's upsert overwrites the other's. | **OWNER** — migration + a business question |

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
