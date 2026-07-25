# Inventory Post-Path Idempotency Audit — double-post / write-without-consume

**Date:** 2026-07-25
**Trigger:** After the MAKOTO ledger divergence (`docs/inventory-ledger-divergence-coe.md`) — a DO edited 35 min after shipping wrote a resync DELTA OUT that consumed no lot — the owner asked for EVERY inventory-affecting document post path to be checked for the same class of risk: *"会不会 GR 两次、DO 两次?比如 PO、Sales Invoice、DO 等等"* — can a document post its stock/cost movements TWICE, or create a movement that bypasses/skips the FIFO consume?
**Status:** READ-ONLY AUDIT + DETECTION. Every path traced statically against `origin/main` (file:line cited). NO post-path code changed, NO data repaired — both are owner-owned, staging-first decisions. Shipped a read-only detector (`backend/scripts/check-duplicate-movements.mjs` + workflow) to size any exposure across all documents. One concrete new gap (GRN confirm has no DB backstop) is logged in `BUG-HISTORY.md`.

---

## 1. The two failure modes we checked for

1. **Double-post** — the same document writes its stock movement for a bucket TWICE, doubling on-hand qty and (for IN) cost/value. ("GR 两次 / DO 两次".)
2. **Write-without-consume** — an OUT (or negative ADJUSTMENT) inserts a real `inventory_movements` row (the running balance decrements) but the FIFO trigger's consumer matches fewer lots than the movement demands and **discards the shortfall** (`qty_short`), so lots + COGS do not move. This is the MAKOTO mechanism (`inventory-fifo-trigger.sql:176-198`).

## 2. How stock is written, and where the guards live

- **Single insert path.** Every document writes stock through `writeMovements` → a plain `INSERT` into `inventory_movements` (`backend/src/scm/lib/inventory-movements.ts:116`). There is no JS-side consume.
- **Single consume path.** The AFTER-INSERT trigger `trg_inventory_movement_fifo` → `fn_inventory_movement_fifo` (`backend/scripts/scm-schema/inventory-fifo-trigger.sql:267`) is the ONLY thing that opens lots (IN / positive ADJUSTMENT) or consumes them (OUT / negative ADJUSTMENT). Its OUT branch discards `qty_short` (`:193-198`) — the shared write-without-consume risk for EVERY outgoing path.
- **Idempotency guards come in four flavours:**
  - **G1 — DB partial UNIQUE index** on `(source_doc_type, source_doc_id, product_code, variant_key)` per doc type, keyed WITHOUT `movement_type`. In the repo only `uq_inv_mov_cs_do_source` / `uq_inv_mov_cs_dr_source` exist (`0153_consignment_module.sql:542-548`). `uq_inv_mov_do_source` (0100) and `uq_inv_mov_dr_source` (0102) are referenced throughout the code but their DDL lives ONLY in prod (2990s-ported) — **not reproducible from this repo**. GRN / PURCHASE_RETURN / STOCK_TRANSFER / STOCK_TAKE / ADJUSTMENT / PC_* have **no** unique index in the repo schema dump (only the non-unique `idx_inv_mov_doc`, `2990s-full-schema.sql:1816`).
  - **G2 — JS existence check** before insert (count movements already written for this doc; no-op if any).
  - **G3 — atomic status compare-and-swap** (`.eq('status', <prev>)` on the flip) so only the call that actually transitions the row proceeds to write stock.
  - **G4 — ledger-driven delta** (read current movements, write only `target − current_net`); a re-run with no line change yields delta 0, so it is idempotent by construction.

> ⚠️ **Repo/prod contradiction to resolve empirically.** `delivery-orders-mfg.ts:1135` says *"Migration 0109 dropped the per-bucket UNIQUE so we can freely write multiple delta rows"* while `:1311` says `uq_inv_mov_do_source` (0100) still rejects a same-key opposite row. Both cannot be simultaneously true of one index. Because that DDL is prod-only, section (0) of the detector reads `pg_indexes` directly to report the ACTUAL unique indexes on `inventory_movements` — the ground truth on which paths have a DB net.

## 3. Per-path risk table

Ranked by whether the path can double-count stock/cost in prod. "Consume risk" = shares the OUT-side `qty_short` discard (the MAKOTO write-without-consume) whenever an outgoing delta's key matches no lot.

| # | Path (file:line) | Inserts movements? | Double-post guard | Can EDIT/RE-POST/RESYNC create a delta? | Risk |
|---|---|---|---|---|---|
| 1 | **DO resync DELTA OUT** — `delivery-orders-mfg.ts:1141` `resyncInventoryForDo`, delta OUT `:1256-1269` | OUT (delta) | G4 (ledger delta — no double-post) | Yes — edit-after-ship writes a delta OUT through the FIFO trigger | **HIGH (known, write-without-consume)** — the MAKOTO path. Delta OUT can match zero lots (sofa batch/variant key mismatch) → `qty_short` discarded. Documented in the divergence COE. |
| 2 | **GRN confirm / post** — `grns.ts:339` `postGrnAndRollup`, IN write `:448` | IN | **G-partial only** — route-level `if row.status==='POSTED'` early return (`grns.ts:1715`); the flip is `.neq('status','CLOSED')` (`:352-356`), NOT a compare-and-swap; **no G1 index** (`uq_inv_mov_grn_source` does not exist); **no G2** existence check inside `postGrnAndRollup` | No post-ship resync exists (editing a posted GRN does not re-adjust stock) | **MEDIUM–HIGH (new).** Two concurrent confirms of a DRAFT GRN both read DRAFT, both pass the 1715 check, both flip (both succeed under `.neq CLOSED`), both write IN → **doubled stock + doubled value**, with no DB backstop to catch the race. Weakest-guarded stock-IN path. See BUG-HISTORY. |
| 3 | **Purchase Return post** — `purchase-returns.ts:377` (create-as-posted); re-post guard `:913` | OUT | route-level `if status IN (POSTED, COMPLETED)` early return (`:913`); **no G1 index** (`uq_inv_mov_pr_source` absent) | Created-as-posted, movements inline; no delta resync | **MEDIUM (new).** Same non-atomic-read class as GRN but narrower window (fresh header per create; the re-post route early-returns). No DB net. |
| 4 | **DO first-ship** — `delivery-orders-mfg.ts:833` `deductInventoryForDo`, write `:925` | OUT | **G2 + G1** — existence check `:834-841` AND `uq_inv_mov_do_source` (0100, prod) | First ship only; edits go through path #1 | **SAFE (double-guarded).** Cannot write a second first-ship OUT. |
| 5 | **DR (delivery return)** — `delivery-returns.ts:306` existence check, `:386` write, resync `:420` | IN (+ delta OUT on reduce) | **G2 + G1** (`:306-312` + `uq_inv_mov_dr_source` 0102, prod); resync G4 | Yes — mirror of #1; delta OUT on line-reduce shares consume risk | **SAFE against double-post**; delta OUT shares the write-without-consume risk (same as #1). |
| 6 | **Consignment note ship / return** — `consignment-notes.ts:362`, `consignment-returns.ts:368` | OUT / IN (delta) | **G4 + G1** (ledger delta; `uq_inv_mov_cs_do_source`/`_cs_dr_source` 0153, in repo) | Yes — ledger delta, idempotent | **SAFE against double-post.** Give-back OUT deltas share consume risk. |
| 7 | **Purchase Consignment Receive / Return** — `purchase-consignment-receives.ts:194`, `-returns.ts:189` | IN / OUT (delta) | **G4 only** (ledger delta; first IN gated to one `PC_RECEIVE` per bucket, `receives.ts:167-169`); no G1 index | Yes — ledger delta, idempotent by construction | **SAFE against double-post** (re-run → delta 0). Give-back OUT deltas share consume risk. |
| 8 | **Stock Transfer** — `stock-transfers.ts:207` `fn_stock_transfer_apply` | OUT+IN (net-zero, one txn) | atomic DB function (one transaction, rolls back whole transfer on any line failure, #1241); fresh header per create (`:236` create-and-auto-post) | No re-post path | **SAFE.** Fresh header each POST; atomic apply. (Function body is prod-only — noted.) |
| 9 | **Stock Take post** — `stock-takes.ts:667` post gate, `:721` write; reverse `:501` | ADJUSTMENT (signed) | **G3 — atomic `.eq('status','OPEN')`** compare-and-swap on the POST flip (`:669`); reverse gated `.eq('status','POSTED')` (`:501`) | No re-post (status advanced atomically) | **SAFE (strong).** Only the call that flips OPEN→POSTED writes movements; race-safe. |
| 10 | **Inventory Adjustment** — `inventory-adjustments.ts:106` | ADJUSTMENT (single) | N/A — the movement row IS the document (no `source_doc_id`); one intentional INSERT per request; a decrease verifies on-hand in the exact batch/variant first (`:82-97`) | No re-post concept | **SAFE-ish.** Only a user double-click double-submit doubles it (universal to all create endpoints). Negative adjustment's on-hand pre-check makes a false short unlikely. |
| 11 | **Sales Invoice** — `sales-invoices.ts` (whole file) | **NO — zero inventory references** | N/A — SI copies COGS from the DO line and books AR only (`sales-invoices.ts` `POST /from-dos`); it never touches `inventory_movements` / lots / consumptions | N/A | **SAFE / not applicable.** SI cannot double-post stock because it never posts stock. Re-issuing an SI moves no inventory. |

## 4. What the audit RULED OUT (SAFE — so the owner knows what NOT to chase)

- **Sales Invoice double-posting stock — IMPOSSIBLE.** `grep` of `sales-invoices.ts` returns ZERO references to `inventory_movements` / `writeMovements` / `inventory_lot` / `fn_consume`. SI is AR + cost-copy only. Whatever happens to an SI (re-issue, edit, void) moves no stock.
- **DO / DR first-ship double-post — RULED OUT.** Double guard: JS existence check (`delivery-orders-mfg.ts:834-841`, `delivery-returns.ts:306-312`) AND the prod DB partial-unique index. A second first-ship OUT/IN cannot be written.
- **Stock Take double-post — RULED OUT.** The POST flip is an atomic compare-and-swap `.eq('status','OPEN')` (`stock-takes.ts:669`); a concurrent second post finds the row no longer OPEN and writes nothing.
- **Stock Transfer double-post — RULED OUT.** Create-and-auto-post writes a fresh header and applies all lines in one atomic DB function (`fn_stock_transfer_apply`, #1241); there is no separate re-postable `/post`.
- **Consignment / PC receive-return double-post — RULED OUT.** All use the ledger-delta pattern (G4): the write is `target − current_net`, so a re-run with no line change computes delta 0 and writes nothing. CS_DO/CS_DR additionally carry a DB unique index (0153).
- **A manual/legacy insert bypassing the trigger — LOW.** `writeMovements` is the single insert path and the AFTER-INSERT trigger always fires; there is no trigger-disabled insert in any post path.

## 5. Where the real gaps are (evidence, not vibes)

1. **GRN confirm has NO DB double-post net (new, MEDIUM–HIGH).** Unlike DO/DR, `postGrnAndRollup` relies solely on a route-level status read (`grns.ts:1715`) plus a non-atomic `.neq('status','CLOSED')` flip. There is no `uq_inv_mov_grn_source` index and no movement-existence check inside the function. A double-submit / concurrent confirm of a DRAFT GRN can write the IN movements twice — doubling stock qty AND landed value/cost — with nothing at the DB layer to reject the second write. `PURCHASE_RETURN` shares this class with a narrower window. Logged in `BUG-HISTORY.md`.
2. **Write-without-consume is a trigger-level fault shared by ALL outgoing paths (known, HIGH).** Every OUT / negative-ADJUSTMENT routes through the same OUT branch that discards `qty_short`. Any path that can emit an outgoing delta whose key (variant, and for sofas `batch_no`) resolves differently from the open lots will record a movement with no (or partial) consume. Documented root cause in the divergence + oversell COEs; the detector sizes it per-movement.

## 6. Recommended guards (NOT implemented — owner / fix-change owns the money-critical FIFO edits)

These are described so the fix-change implements them without conflicting with the concurrent FIFO-fix PR. All are staging-first per the migration-0154 discipline.

- **R1 — a per-document partial UNIQUE index for GRN (and PURCHASE_RETURN):** `CREATE UNIQUE INDEX uq_inv_mov_grn_source ON inventory_movements (source_doc_type, source_doc_id, product_code, variant_key[, batch_no]) WHERE source_doc_type = 'GRN';` (and the `PURCHASE_RETURN` twin), mirroring `uq_inv_mov_do_source` / the 0153 CS indexes. This is the same G1 net that already protects DO/DR; it closes the concurrent-confirm double-IN at the DB layer regardless of the app-level race. **Decide the key first** (whether `batch_no` is included) so it matches how GRN writes one IN per (bucket, PO batch) — a GRN legitimately writes one IN per batch, so `batch_no` likely belongs in the key. Backfill/dedupe any existing duplicates BEFORE creating the index (it will fail on existing dupes — which is itself a useful signal).
- **R2 — make GRN confirm an atomic compare-and-swap:** change the flip in `postGrnAndRollup` from `.neq('status','CLOSED')` to `.eq('status','DRAFT')` (accepting the legacy already-POSTED no-op explicitly), so only the call that actually transitions DRAFT→POSTED proceeds to write IN — the same G3 pattern stock-take already uses (`stock-takes.ts:669`). Cheaper than R1 and closes the race without new DDL; R1 is still the belt-and-braces net.
- **R3 — a G2 existence check inside `postGrnAndRollup`:** before writing IN movements, count `inventory_movements` for `(source_doc_type='GRN', source_doc_id=grnId, movement_type='IN')` and no-op if any exist — a direct copy of `deductInventoryForDo` guard #1 (`delivery-orders-mfg.ts:834-841`). Defends every caller of `postGrnAndRollup`, not just the confirm route.
- **R4 — stop the OUT branch discarding `qty_short`:** persist the shortfall (a column/flag on the movement) so an under-consumed OUT is self-evident instead of only detectable via the consumptions-vs-qty join. This is the shared write-without-consume fix already deferred in both COEs — it turns section (B) of every detector from a join into a column read.
- **R5 — route resync OUT key resolution through the SAME key the first ship used** so a sofa/variant delta OUT keys to the open lots the original OUT consumed (the FALSE-short root, divergence COE §5). Owner-owned FIFO change.

**Do not** add a unique index that includes `movement_type`: the existing DO/DR indexes are deliberately keyed WITHOUT it so a cancel's balancing row is forced onto an ADJUSTMENT (see `inventory-movements.ts:330-336`) — a GRN index should follow the same convention to stay compatible with the reversal design.

## 7. Detection shipped (read-only, sizes any exposure)

`backend/scripts/check-duplicate-movements.mjs` + `.github/workflows/duplicate-movements-check.yml` — following the `check-inventory-integrity.mjs` / `check-uncosted-cogs.mjs` / `check-soak-gate.mjs` shape (workflow_dispatch, own concurrency group `duplicate-movements-check`, `secrets.DATABASE_URL`, SELECT-only, exit 0 for every answer, `::notice::` output, schema/columns discovered from `information_schema`, never writes). It reports:

- **(0) IDEMPOTENCY BACKSTOPS** — the actual UNIQUE indexes on `inventory_movements` from `pg_indexes` (resolves the 0100-vs-0109 contradiction and shows which doc types have a DB net).
- **(A) DOUBLE-POSTED buckets** — `(source_doc_type, source_doc_id, warehouse, product, variant, batch, movement_type)` groups with more than one row, split into HARD (single-post types: GRN / PURCHASE_RETURN / STOCK_TRANSFER / STOCK_TAKE — a real double post) vs EXPECTED (resync types — context only).
- **(B) WRITE-WITHOUT-CONSUME** — outgoing movements whose `Σ qty_consumed` < movement qty (the discarded `qty_short`), per movement with document + date.

It is complementary to `check-inventory-integrity.mjs`, which reconciles the ledgers at the BUCKET aggregate level; this one works at the per-DOCUMENT / per-MOVEMENT grain to name the specific doubled document and the specific short OUT.

Run: Actions → **Duplicate movements check (read-only)** → Run workflow; the verdict appears as run annotations.

## 8. Verification

- Backend `tsc --noEmit`: **clean (exit 0)** — the audit adds only a `.mjs` script + a `.yml` + docs, no TypeScript.
- `node --check backend/scripts/check-duplicate-movements.mjs`: **OK**; the script also loads at runtime and its `postgres` import resolves (it exits with the expected "DATABASE_URL not set" guard when run without a DSN).
- Workflow YAML: tab-free; structurally identical to the sibling read-only workflows (`uncosted-cogs-check.yml`, `inventory-integrity-check.yml`).
- **NOT run against prod** — by design it runs in CI via the workflow using `secrets.DATABASE_URL`; production counts land when the owner runs it. No local DB exists in this environment.

## 9. Lessons

- **A guard is only as strong as its weakest entry point.** DO/DR earned both an app check and a DB unique index; GRN quietly got neither at the DB layer. When one document class in a family gets a hard backstop, audit whether its siblings that write the same table got it too.
- **"It can't post twice because the route checks status" is not the same as "it can't post twice."** A read-then-flip that isn't an atomic compare-and-swap has a race window; only the DB (unique index) or an atomic status transition actually closes it. Stock-take does it right; GRN does not.
- **Read the index from the database, not the migration file.** The repo's own comments disagree about whether `uq_inv_mov_do_source` still exists after 0109. The only honest answer is `pg_indexes` — which is why the detector reads it live.
- **Size before fixing money data.** As with the two prior COEs, the safe first move is a read-only detector that quantifies the exposure and hands the owner the numbers — not a hot fix to the FIFO layer.
