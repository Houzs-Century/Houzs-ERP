# Inventory Costing — Oversell Uncosted-COGS COE (Correction of Error)

**Date:** 2026-07-24
**Trigger:** Owner reported that some ACCESSORIES were already SHIPPED but the Delivery Order shows NO cost — RM0 — with margin therefore reading as pure profit on those lines. Asked for a read-only audit of the whole inventory-costing pipeline ("this is the most money-sensitive area") before any fix.
**Status (updated 2026-07-31):** §5 item 3 ("storing the shortfall explicitly") is **CLOSED in the form that mattered** — see §8. A ship-before-arrival now records WHICH incoming PO it is bound to, per LINE, so the receipt-time reconcile can claim it without the header drop-ship flag. §5 item 2 (backfill of the 3 historical movements) stays open; nothing below back-fills anything.

**Status (updated 2026-07-29):** Root cause TRACED and confirmed against the code. Detector shipped 2026-07-24 and RUN 2026-07-29 — measured exposure **3 short-costed OUT movements / 3 units / 2 DOs**. Owner then approved the write-path fix ("都处理"), which SHIPPED 2026-07-29: every stock-IN path now retro-costs prior shorts, not just GRN post (§7). **Backfill of the 3 historical movements is still DEFERRED** to the owner (§5 item 2). This is the per-class COE; the specific RM0 symptom is also logged in `BUG-HISTORY.md`.

---

## 1. Incident — what staff saw

Accessories that had physically shipped on a DO carried `unit_cost_centi = 0` / `line_cost_centi = 0`, so the DO (and its Sales Invoice) showed RM0 COGS and 100% margin on those lines. Not every shipped accessory — a subset — and they did not self-correct over time.

## 2. Root cause — traced against the code, not guessed

The FIFO costing pipeline itself is CORRECT by design. The fault is a WIRING gap in when the retro-cost reconcile is invoked.

**The pipeline (all correct, cited):**
- **IN (GRN post):** `backend/src/scm/routes/grns.ts` `postGrnAndRollup` writes an `IN` movement at landed MYR cost (`unit_cost_sen = round(PO price x rate) + allocated freight`, migration 0082, `grns.ts:435`); the FIFO trigger opens one `inventory_lots` row (`backend/scripts/scm-schema/inventory-fifo-trigger.sql`, `IN` branch).
- **OUT (DO ship):** `deductInventoryForDo` (`delivery-orders-mfg.ts:833`) writes an `OUT` movement; the trigger's `OUT` branch calls `fn_consume_fifo` / `fn_consume_fifo_batch` (oldest lot first, `ORDER BY received_at ASC, id ASC`), stamps the real COGS onto the movement, then `restampDoActualCost` (`delivery-orders-mfg.ts:529`) copies it onto the DO line, and the SI copies the DO (`sales-invoices.ts` `POST /from-dos`, line 1178).
- **Allocation:** SO line = `cost_price_sen` snapshot at create (estimate, `mfg-sales-orders.ts:1059`); DO = actual FIFO; SI = from DO; PI = final authority (`recost.ts`, `recostFromGrn`/`recostForPi`).

**The gap:** the soft "ship anyway" oversell path (`check-stock-availability.ts`, gated by `confirmShortStock`) lets a DO ship MORE than the warehouse holds. `fn_consume_fifo` then costs only the units on hand and RETURNS the remainder as `qty_short` — which the trigger's `OUT` branch **DISCARDS** (`inventory-fifo-trigger.sql`: the OUT branch only sets `total_cost_sen = v_result.total_cost_sen`; `qty_short` is never persisted). So the short units ship at **ZERO** recorded cost. That RM0 is meant to be retro-costed later by `fn_reconcile_uncosted_out` (migration `0154_scm_oversell_retrocost.sql`) when replenishing stock arrives.

**Why some never self-heal:** `fn_reconcile_uncosted_out` is invoked from EXACTLY ONE place — the GRN post handler (`grns.ts:493`, via `reconcileUncostedOuts` in `oversell-retrocost.ts`). Verified by exhaustive grep: no other caller, and no scheduled sweep exists. But lots are opened by MANY other stock-IN paths that never call any reconcile:
`stock-transfers.ts:233,259`, `stock-takes.ts`, inventory adjustments (the trigger's positive-`ADJUSTMENT` branch), `purchase-consignment-receives.ts:194`, and the return paths (`delivery-returns.ts`, `consignment-returns.ts`, `purchase-returns.ts`).

So when an oversold accessory is replenished by an **inter-warehouse transfer** or a positive **stock-take/adjustment** (routine in a multi-branch shop) rather than a GRN, the prior RM0 OUT is **never** retro-costed. COGS stays understated -> margin overstated permanently, and `inventory_balances` (signed movement sum) diverges from `v_inventory_value` (sum of `inventory_lots.qty_remaining`) forever — the exact failure mode migration 0154's own header warns about, but which 0154 only closed for the GRN entry point.

**Tool that proved it:** static trace of `origin/main` — the sole callers of `reconcileUncostedOuts` / `reconcileDropshipBatches` are `grns.ts:461,493`; `writeMovements` (the lot-creating path) is called from all the other IN routes listed above with no accompanying reconcile. The runtime SIZE of the exposure is measured by the detector shipped in §3 (production numbers land when the owner runs it).

## 3. Shipped (2026-07-24) — detection only, NO costing-logic change

| PR | What | Effect |
|----|------|--------|
| (this PR, DRAFT) | `backend/scripts/check-uncosted-cogs.mjs` + `.github/workflows/uncosted-cogs-check.yml` — a read-only detector following the `check-soak-gate.mjs` pattern (workflow_dispatch, own concurrency group, `secrets.DATABASE_URL`, SELECT-only, exit 0 for every legitimate answer, results as `::notice::` annotations). Runs two queries: (a) uncosted/RM0 OUT movements on non-cancelled DOs, split into SHORT-COSTED (units with no lot consumed — the oversell gap) vs ZERO-PRICED (fully consumed at RM0 — the self-healing Pending-price case); (b) which short-costed buckets have OPEN cover lots NOW (the TRUE permanent-miss set), with an estimated understated-COGS figure walked oldest-lot-first. | Sizes the exposure without an owner interruption or the DSN in front of a human. Touches no data and no costing logic. |

Run: Actions -> **Uncosted COGS check (read-only)** -> Run workflow; the verdict appears as run annotations.

## 4. What the audit RULED OUT

- **Category exemption for accessories — FALSE.** Only SERVICE SKUs (`SVC-*`: delivery fee / dispose / lift) are FIFO-exempt (`service-sku.ts`, `isServiceLine`; skipped in `deductInventoryForDo` and the GRN IN builder). `ACCESSORY` is a goods group with `variant_key = ''` (`variant-key.ts:19`) and IS FIFO-costed. So the RM0 is a missing-cost condition, not "accessories aren't costed."
- **A broken pipeline — FALSE.** IN/OUT/FIFO/allocation are correct by design (§2). The FIFO ordering, the DO restamp, the DO->SI copy, and the PI recost cascade all work.
- **The display switch — NOT the cause.** `costing-enabled.ts` gates cost DISPLAY only, never capture, and deliberately excludes the product-cost path; it cannot zero stored cost data.
- **3 of the 4 RM0 mechanisms self-heal.** (A) oversell shipped before the GRN posts -> reconciled when that GRN posts; (B) GRN received at 0 / "Pending" price -> fixed by `recostFromGrn` when the PI lands; (C) reconcile fired but no lot was available yet -> retried idempotently on the next receipt. Only the 4th — oversold, then replenished via a NON-GRN IN path — is the permanent miss.
- **A variant-key mismatch stranding accessory cost — LOW.** Accessories key to `''` on both the IN and OUT sides, so plain accessories match. (Sofa/bedframe legacy POS-vs-Backend keys remain a separate, noted fragility — not this incident.)

## 5. DEFERRED — owner decides (intentionally NOT auto-done)

1. ~~**The fix itself — owner (money-critical costing change).**~~ **RESOLVED 2026-07-29** — owner approved, option (a) shipped. See §7.
2. **Backfill of already-stranded rows — owner. STILL OPEN.** The detector has now quantified the set: **3 short-costed OUT movements, 3 units, 2 DOs** (`2990-DO-2607-009` TRION-(K); `2990-DO-2607-017` TRION-(K) + 2990 KETTA-FIRM MATT (K)), measured 2026-07-29. The §7 fix is GO-FORWARD ONLY and deliberately did not touch them — retro-costing historical rows is a data repair with its own cost-basis decision, same STAGING-first discipline. Note the fix will repair these three by itself the moment those buckets next receive stock through ANY path, so doing nothing is now a valid option in a way it was not before.
3. ~~**Storing the shortfall explicitly — owner/eng.**~~ **ADDRESSED 2026-07-31, differently than proposed — see §8.** The trigger still discards `qty_short`, and deliberately so: the shortfall stays LEDGER-DERIVED (`ABS(qty) - SUM(qty_consumed)`) because that is what makes every reconcile idempotent and lets a repair fall away by itself. What was actually missing was not a shortfall flag but a BINDING — which incoming PO a short shipment is owed by. That is now `delivery_order_items.committed_po_batch_no` (mig 0230). A short OUT is still detected by the consumptions join; what changed is that it can now say who owes it.

## 6. Lessons

- **A correct function is not a correct system.** `fn_reconcile_uncosted_out` is right; it was simply wired to one of several stock-IN entry points. When a retro-cost/repair routine exists, audit EVERY path that creates the condition it repairs, not just the one it was born next to.
- **"Best-effort, self-heals later" needs a guaranteed later.** The oversell RM0 is acceptable ONLY because a receipt reconciles it — that guarantee silently doesn't hold for non-GRN replenishment. Any "will be fixed on the next X" needs X to be the ONLY way the state can change, or a sweep to catch the rest.
- **Size before fixing money data.** The safe first move on a money-critical gap is a read-only detector (this PR), not a hot fix — it quantifies the exposure and gives the owner the numbers to decide, with zero risk to the FIFO layer.
- **Verify against the pipeline, not the symptom.** The RM0 looked like "accessories aren't costed"; tracing the actual code showed accessories ARE costed and the real fault was reconcile wiring — the ruled-out list (§4) is what stops the next person re-chasing the category-exemption theory.
- **Count the paths before writing the fix (added 2026-07-29).** The 2026-07-24 trace listed five other stock-IN paths. Grepping the write side properly at fix time found **sixteen** callsites that open a lot, because a lot is opened by the trigger's `IN` branch AND its positive-`ADJUSTMENT` branch, and half the openers are resyncs / reversals / cancels rather than anything named "receive". A fix scoped to the five named paths would have looked complete and left the hole open.

## 7. Write-path fix SHIPPED — 2026-07-29 (owner-approved)

Owner approved §5 item 1 ("都处理") after the detector returned the numbers. Option (a) shipped: extend the caller set. **Go-forward only — no backfill** (§5 item 2 stays open).

**Mechanism.** New shared helper `reconcileUncostedAfterIn(sb, rows, performedBy)` in `backend/src/scm/lib/oversell-retrocost.ts`. It takes the movement rows a path just committed, keeps the LOT-OPENING ones — `IN`, or `ADJUSTMENT` with `qty > 0`, mirroring the trigger's own test in `inventory-fifo-trigger.sql` — captures the receipt cutoff, and calls the SAME `reconcileUncostedOuts` → `scm.fn_reconcile_uncosted_out` (0154) the GRN post has always used, then re-stamps the affected DO lines + Sales Invoices. **NO SQL, schema, or migration change**: the function's signature is untouched; only who calls it changed. **It never throws** — a retro-cost is a repair, never a precondition of the receipt that triggered it, so a failure is logged and swallowed and the shortfall is retried idempotently on the next IN into that bucket.

**Paths that now reconcile** (previously: GRN post only):

| Path | File |
|---|---|
| GRN post (unchanged — see note) | `scm/routes/grns.ts` `postGrnAndRollup` |
| GRN warehouse relocate / line add / line edit | `scm/routes/grns.ts` |
| Stock transfer (destination warehouse) | `scm/routes/stock-transfers.ts` `writeTransferMovements` |
| Stock take post (positive variance) + reverse | `scm/routes/stock-takes.ts` |
| Manual inventory adjustment (positive delta) | `scm/routes/inventory-adjustments.ts` |
| Purchase-consignment receive resync | `scm/routes/purchase-consignment-receives.ts` |
| Delivery (customer) return — create + resync | `scm/routes/delivery-returns.ts` |
| Consignment note resync (reduce / cancel returns stock) | `scm/routes/consignment-notes.ts` |
| Consignment return resync | `scm/routes/consignment-returns.ts` |
| PC return resync (reduce / cancel returns stock) | `scm/routes/purchase-consignment-returns.ts` |
| Purchase-return reversing delta | `scm/routes/purchase-returns.ts` |
| DO resync add-back + DO cancel/reversal add-back | `scm/routes/delivery-orders-mfg.ts` |
| Consignment loaner hop + its reversal | `scm/lib/consignment-loaner.ts` |
| Generic `reverseMovements` (reversing an OUT writes an IN) | `scm/lib/inventory-movements.ts` |

**Why `postGrnAndRollup` was deliberately left alone.** There the oversell reconcile must run AFTER `reconcileDropshipBatches`, and its cutoff is captured BEFORE that call. That ordering decides which reconcile gets first claim on the arriving lots, so it is load-bearing; routing it through the helper would have moved the cutoff and inverted the claim order. It calls the same `reconcileUncostedOuts` either way — there is one implementation, two entry shapes.

**Verification honesty.** `npm --prefix backend typecheck` clean and `npm --prefix backend test` green. Those prove the wiring compiles and the pure model still behaves; they do **NOT** prove the trigger/function behaviour — the scm FIFO layer is Supabase Postgres + PL/pgSQL and this repo's vitest harness rebuilds only the D1 side, so no test in this repo executes `fn_reconcile_uncosted_out`. Per the 0154 header the runtime behaviour is validated on STAGING, not here.
**Superseded 2026-07-31:** that last sentence was true when written and is no longer. `backend/tests-pg/shipCommitment.pg.test.ts` executes BOTH `fn_reconcile_uncosted_out` and `fn_reconcile_dropship_batch` against a real postgres:16 (CI job `backend-postgres`). The lesson recorded in the 2026-07-29 venue entry applies here too: before writing "cannot be verified", check whether the harness already exists.

## 8. Ship-before-arrival binds its incoming PO — 2026-07-31 (owner-approved)

Owner, on how the sofa main flow is meant to work: *"Sofas are bound to a batch
number. When the sofa hasn't arrived and the supplier ships direct, we raise a
DO. Before raising the DO you already know which PO this order matched. When they
pick ship-anyway, that matched PO should be bound and go negative against it.
Because sofas have batch numbers, when that PO converts to GRN it offsets; when
it converts to PI, the costing offsets too. So MRP must not budget those SOs and
POs any more."*

**What was wrong.** The binding hung off the drop-ship DIALOG, not off the fact
that the line has a resolvable PO. `scm.fn_reconcile_dropship_batch` (0057,
hardened 0088, enum-fixed 0155) claims an OUT only when the SOURCE DO carries
`is_dropship = TRUE` — a HEADER flag, set all-or-nothing (`body.dropShip === true`
**AND** every offending line has a bound PO), and one that migration 0057 itself
documents as driving *"the UI badge ONLY"*. A plain "Ship anyway" therefore left
the flag FALSE, so even a batch-stamped OUT was invisible to the reconcile
forever. Measured on prod 2026-07-30/31 with `check-hard-committed-po.mjs`:
**3 short OUTs, ALL `is_dropship = N`, none carrying `batch_no`, 0 claimable.**

**The fix — migration 0230, plus a pure decision module.**

| Piece | What |
|---|---|
| `scm.delivery_order_items.committed_po_batch_no` | the per-LINE marker: "this line shipped before its goods arrived, against THIS incoming PO's batch" |
| `planShipCommitments` (`backend/src/scm/lib/ship-commitment.ts`) | the PURE decision table that writes it — see `docs/modules/delivery-order.md` §5 for every row |
| `fn_reconcile_dropship_batch` | claims on `is_dropship` **OR** a matching per-line marker. A plain "Ship anyway" now nets on receipt, and one unresolvable line on a mixed DO no longer denies netting to the rest |
| `fn_reconcile_uncosted_out` (0154) | the MIRROR exclusion — it must not retro-cost a line-committed OUT from an arbitrary lot, which for a sofa means another dye lot |

**The header flag was deliberately NOT widened.** Making `is_dropship` mean "any
short ship" would have put the "Drop-ship — batch not received" badge on ordinary
oversells and made a document-level flag the arbiter of a line-level fact. The
claim signal belongs where the decision is made.

**A PARTIAL short is deliberately left unbound.** If some stock IS on hand,
stamping the batch would route the whole OUT through `fn_consume_fifo_batch`,
which finds no lot for a batch that has not arrived — so the units that WERE
available would stop being costed at ship time. Losing real ship-time cost to
gain a batch stamp is a bad trade. Those shortfalls stay with the §7 oversell
retro-cost, which is batch-agnostic and runs on every stock-IN path.

**What this does NOT do.** No backfill: the 3 stranded OUTs carry no `batch_no`
and nobody but the owner can say which PO each belongs to (§5 item 2).
Go-forward only.

**The MRP half, and the trap in it.** The same change stops MRP offering units a
shipment already owns — but the deduction is PAIRED with an add-back to on-hand
stock, and that pairing is the whole correctness argument. A ship-before-arrival
writes a real OUT, so `scm.inventory_balances` (SUM of IN − OUT, mig 0084) has
ALREADY deducted those units: the ledger has always carried the commitment, just
as a nameless negative in whichever bucket the OUT landed in. **Deducting from PO
supply alone would count it twice and invent a shortage that does not exist.**
Net availability is therefore unchanged by this change; what changes is that the
commitment is now attributed to the PO that owes it instead of silently taxing
whichever Sales Order happens to sort first in the bucket. `applyCommittedSupply`
guarantees deduction and add-back are the same number in the same bucket, and a
unit test asserts exactly that invariant.

**Verification.** 24 pure decision cases
(`backend/src/scm/lib/ship-commitment.test.ts`) and 12 real-Postgres cases
(`backend/tests-pg/shipCommitment.pg.test.ts`). The pg suite applies migration
0230 itself, DEMONSTRATES the old behaviour first (no claim signal -> reconcile
returns 0, cost stays RM0), then walks the full claim: ship 2 short bound to
`2990-PO-2607-009`, receive 3 at RM1,200 each, reconcile -> 2 consumed, movement
stamped 240,000 sen, lot down to 1 remaining, and the MRP commitment recomputes
to zero on its own. Executed locally against a real PostgreSQL 16.4 as well as in
CI's `backend-postgres` job.
