# Inventory Costing — Oversell Uncosted-COGS COE (Correction of Error)

**Date:** 2026-07-24
**Trigger:** Owner reported that some ACCESSORIES were already SHIPPED but the Delivery Order shows NO cost — RM0 — with margin therefore reading as pure profit on those lines. Asked for a read-only audit of the whole inventory-costing pipeline ("this is the most money-sensitive area") before any fix.
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
3. **Storing the shortfall explicitly — owner/eng.** The trigger discards `qty_short`; there is no column flagging an OUT as under-costed, so detection depends on the consumptions-vs-qty join. A persisted shortfall flag would make orphaned RM0 rows self-evident. Design decision, deferred.

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
