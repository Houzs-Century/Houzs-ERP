> ## Corrections — 2026-08-12 code-read sweep
>
> 1. computeMrp has 3 call sites in mfg-sales-orders.ts (list :1528 added 2026-08-02, detail :2883, :3042), not 2.
> 2. The Decision section's “provenance influences NO coverage precedence” is false against current code: stored link still outranks MRP floating (po-so-coverage.ts:53-57); the flip is PR-4, owner-gated. The §7 table is the correct current statement.

# Module: MRP (finished-goods demand vs supply)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Per-module technical doc for the MRP engine — `computeMrp` in
`backend/src/scm/routes/mrp.ts` and everything that reads its allocation.
This is a TRADING-company MRP (no BOM explosion): demand = outstanding
Sales-Order lines, supply = on-hand stock + open PO lines, allocation =
greedy by the EFFECTIVE delivery date (§4 — the amended date, not the
customer's original). Pure calculator, recomputed on every read, NO
persistence and NO stored SO<->PO lock.

> Written 2026-08-01 with `fix/mrp-consistency-tails` (the pairing-audit tail
> fixes). Read `BUG-HISTORY.md` 2026-08-01 "MRP pairing-audit tails" and the
> detector `backend/scripts/audit-mrp-pairing.mjs` before changing allocation
> rules — the detector REPLICATES this engine and must move in lockstep.

---

## Decision (owner, 2026-08-06): soft until DO, hard from DO

Before a Delivery Order exists, ALL supply-demand matching belongs to the
floating MRP allocator — pooled by (warehouse, item_code, variant_key),
constrained by one-batch-per-SOFA-set (bedframes exempt), ordered by delivery
date then doc_no. Nothing persisted before the DO may bind execution:
`purchase_order_items.so_item_id` and the mig-0235 allocation sub-lines are
**procurement provenance** — they record why we bought, they are displayed and
audited, and they influence NO cap, NO batch expectation, NO coverage
precedence.

At DO creation the allocator decides binding **live** — including which incoming
PO batch a ship-before-arrival commits to — and records it on the DO line
(`committed_po_batch_no`, mig 0230). From that moment everything is anchored
history: committed batches, OUT movements, lot consumptions, COGS, delivered
attribution. Post-DO records are never recomputed from provenance, and
provenance is never "hardened" into them.

A stored-link-vs-delivered divergence is therefore NOT a defect; a double-SERVE
in the delivered ledger IS. Do not reintroduce the stored link into any
execution path — that is the pre-2026-08 model this decision retires, and the
parked branch `wip/harden-so-po-link-parked` (which hardens the MRP pick INTO
the link) is formally ABANDONED by this decision; do not resurrect it.

Rollout is staged (lenses/docs → DO-time live allocator → pooled caps →
display demotion); until every stage lands, the transitional guard remains:
rejecting an SO-revision follow-up auto-releases the PO to STOCK.



### Why — the owner's business case (2026-08-06, verbatim intent)

Customise moves from Make-to-Order to **Make-to-Stock**, possible because every
SKU now carries its variant identity — a PO can order spot stock against a
specific (SKU, variant), and an incoming SO simply gets allocated.

1. **Cheaper procurement** — order ahead in bulk, negotiate the supplier down.
2. **No dead-stock risk from mistakes** — a mis-ordered spec is not dead goods:
   clear the order and the PO's units re-assign to the next identical demand
   automatically.
3. **Automated matching** — no more CS hand-matching after a mistake; sell the
   identical thing and the SO auto-assigns on open, straight to READY.
4. **Delivery flexibility** — spot stock ships early when the customer wants
   it; a rush order takes from the pool and the next PO backfills.

Every surface must present this model: the execution chains (SO→DO→SI,
PO→GRN→PI) are anchored facts; every pre-DO PO↔SO pairing is floating and
visibly live — including the Relationship Map, which "会跳动" by design.

## 1. The one engine and its consumers

`computeMrp(sb, opts)` is called by every surface that answers "what covers
this line". They must all read the SAME allocation — that is the module's core
invariant (po-so-coverage.ts: "SO->PO and PO->SO can never disagree").

| Consumer | File | includeUndated | Reads |
|----------|------|----------------|-------|
| MRP page `GET /mrp` | `mrp.ts` route | query param, default **true** (2026-08-18) | `skus[]` + `sofaSets[]` (the plan) |
| SO drill-down Stock column | `mfg-sales-orders.ts` (`:2916`, `:3075`) | true | `mrpLineCoverage` (SO->PO) |
| SO LIST ready-chip enrichment | `mfg-sales-orders.ts` (`:1561`) | true | the raw `MrpResult`; fail-soft — a thrown MRP just drops READY chips |
| PO / GRN / PI "Assigned SO" | `po-so-coverage.ts` (single + list) | true | `mrpReverseCoverage` (PO->SO) |
| Outstanding-SO shortage cap | `mfg-purchase-orders.ts` | true | per-line `shortageQty` |
| Reservations assigned/free | `inventory.ts` `/inventory/reservations` | true | `mrpStockAssignment` (stock side) |
| Procurement agent | `services/agents/procurement-agent.ts` | false | plan |
| CS agent | `services/agents/cs-agent.ts` | false | plan |

**`includeUndated` is DISPLAY-ONLY (since 2026-08-01, audit D6).** The
allocation always runs over the FULL active demand set; undated lines (no
EFFECTIVE delivery date at all — see §4) sort LAST, so they can only consume
supply the dated lines left behind — a dated line's coverage is identical
under both flag values. `false` merely omits undated rows/sets from the
output. Do NOT reintroduce the flag into the demand filter: that is exactly
the two-demand-sets divergence the audit caught.

### What the flag HIDES is reported (2026-08-16)

Display-only was never the problem; **silent** display-only was. Measured
against production on 2026-08-16 for company 2 (2990), the default view returned
**82 of 163** live SO-item ids and **8 of 68** short sofa sets, and the page said
nothing about the missing half — so a real shortage rendered as no shortage.
Owner: *"明明这个东西没有 ready,可是我的 MRP 却 show 不出来."*

> **HOW BIG IT ACTUALLY IS — measured on production, run 31962771658,
> 2026-08-16.** The 2990 sample above understates it badly. For **company 1
> (HOUZS)**:
>
> | | live | undated | share |
> |---|---|---|---|
> | SO LINES (MRP's demand set) | 13,916 | **11,392** | **81.9%** |
> | SO HEADERS | 2,724 | 2,207 | 81.0% |
>
> **Four fifths of the HOUZS book is behind this default**, which is why the
> count on the page is not cosmetic. Two further facts from the same run:
> **0** headers carry the date on a LINE while the header lacks it (so this is
> genuinely MISSING data, not misplaced — that rules out a family of wrong
> fixes), and 2,203 of the undated headers are CONFIRMED inside the five days
> 2026-08-09 .. 2026-08-13, which is a bulk write.
>
> **The number for 2990 is still UNKNOWN** — that run died before company 2 ran.
> Do not quote 81.9% as covering both companies; it is HOUZS.

`MrpResult` therefore carries `undated`, counted ALWAYS — on exactly the rows the
flag removes, before the `continue` that removes them:

| field | meaning |
|---|---|
| `lines` | undated rows in the general path — **honours `catFilter` + `whFilter`** |
| `shortageUnits` | units of `lines` the allocation could not cover |
| `sofaSets` | undated sofa SETS — **section 8 ignores `catFilter`**, so read this on the sofa view only |
| `sofaShortageUnits` | units of `sofaSets` the allocation could not cover |
| `hidden` | `!includeUndated` — the response states what it DID |

The two paths are counted separately on purpose: blending them would overstate
every non-sofa tab by the whole sofa book.

> **NOTHING IN THE UI READS `undated` ANY MORE — owner, 2026-08-20.** `Mrp.tsx`
> used to pick by tab and render the count in BOTH states, with a one-click
> **Show them** / **Hide them** wired to the existing toggle, reading `hidden`
> from the SERVER rather than from its own checkbox. The owner deleted that
> banner: 「黄色的也delete掉」, said after he was told it carried DATA (a count and
> an action) rather than instruction. His call, and a deliberate deletion — do
> not restore it as an accidental removal.
>
> The field is still computed, still returned, and still pinned by
> `backend/src/scm/routes/mrp.test.ts`. It is now an API-only fact. If it is ever
> surfaced again, the two rules above are what it has to obey: pick the tally by
> tab, and take `hidden` from the response.
>
> What ended the SILENCE now is the ROW: `DeliveryCell` in `Mrp.tsx` tags every
> undated line **No date**, and the always-visible **Show no-date** checkbox in
> the filter row is the only affordance that flips `includeUndated`. Both are
> pinned by `frontend/src/pages/scm-v2/mrpUndated.test.tsx` (renamed from
> `mrpUndatedBanner.test.tsx` in the same PR), which also pins the banner's
> absence as a negative so a quiet re-add fails.

### The default STAYS hidden — what changed is the silence (owner, 2026-08-18)

Owner, ruling on a build that had flipped it to shown: *"这个应该是要把没有日期的
藏起来的,不过我点 show no date 它才会出来."*

It has been `false` since 2026-05-29, on the reasoning that an undated line is
not orderable yet and this page is the ordering worklist. That reasoning holds.
The measurement that prompted a flip was real — the default view held 82 of 163
live 2990 SO-item ids and 8 of 68 short sofa sets — but the inference was wrong.
What the operator could not see was never the ROWS; it was that rows were being
withheld at all, because the page said nothing. **Hiding is legitimate. Hiding
SILENTLY is not.**

The banner was the 2026-08-16 answer to that silence. It is gone since
2026-08-20 (owner: 「黄色的也delete掉」), so what carries the point now is the
always-visible **Show no-date** checkbox plus the per-row **No date** tag — the
withholding is one tick from being undone and every withheld row identifies
itself once shown. The page-level COUNT is the part he chose to give up.

**Requiring a delivery date was considered and REJECTED.** 43% of 2990's sales
orders carry no delivery date, flat across June/July/August — a habit, not an
import artefact (HOUZS's 81.9% above IS one: its AutoCount importer's INSERT
carries neither delivery nor processing date). Forcing the field makes people
type a FAKE date, and a fake date is worse than a null one, because allocation is
BY DELIVERY DATE — a fake promise would jump the queue ahead of a real one. So
undated demand keeps its null instead: hidden by default, one click from view via
**Show no-date**, and when shown it is tagged **No date** on the row and sorted
last. (It is still always COUNTED — see the box above — but since 2026-08-20 the
count is not ANNOUNCED on the page.)

**This is safe only because the flag is display-only.** The allocation order is
unchanged and pinned by `mrp.test.ts` ("a dated line wins the scarce bucket over
an undated one — under either flag, whatever the row order"), which fails if
`byDateAsc` ever stops putting nulls last. Flipping visibility cannot move a unit
of supply; changing that sort would.

**A count is not a filter.** Nothing in `undated` feeds the allocation, and
`mrp.test.ts` pins that: the tally must equal the set of rows the flag removed,
with the shortage the ONE allocation actually gave them. That assertion is also
what catches a re-introduced demand filter — under the pre-D6 shape the removed
rows never reach the allocator, so the tally stops matching.

### `?includeUndated` parsing — `parseIncludeUndated`, exported and tested

`=== 'true'` was the entire parser until 2026-08-16, so **`?includeUndated=1`
returned the default plan with no error and no warning** (verified against
production). Accepted now, either case, trimmed: `true / 1 / yes / on` and
`false / 0 / no / off`; absent = `true` (2026-08-18); **anything else throws
`InvalidQueryFlag` and the route answers 400.** It is never quietly false — that
is the `optional-param-noop` trap CLAUDE.md names, and the other ~15
`req.query(x) === 'true'` sites in `scm/routes` still carry it.

## 2. Demand

- Source: `mfg_sales_order_items` (non-cancelled) joined `!inner` to its SO
  header. Status filter is pushed into SQL AND re-applied in JS via `SO_DONE`.
- `SO_DONE` is **`SO_TERMINAL_STATES`** from
  `backend/src/scm/shared/so-terminal-states.ts` — read it there rather than
  from this line, which was one of **fourteen** hand-typed copies across ten
  files until 2026-08-13 (`mrp.ts`, `so-stock-allocation.ts`'s PostgREST
  `not.in` string, and eight audit scripts — four names, plus inline SQL copies
  inside four of those same scripts). SHIPPED was added 2026-08-01
  (audit D4) to match `so-stock-allocation.ts` and the amendment terminal set.
  ON_HOLD still demands (owner call: a held order still drives purchasing).
- **The reservations endpoint does NOT agree, despite what this guide (and
  `mrp.ts`'s own comment) used to say.** `routes/inventory.ts` holds TWO sets of
  its own: `GET /reservations` has **five** (adds SHIPPED, still no DRAFT) and
  `GET /products` has **four** (`DELIVERED, INVOICED, CLOSED, CANCELLED`). So a
  DRAFT order is open demand on both Inventory surfaces and done here, and a
  SHIPPED order is open demand on one of them. Measured 2026-08-13, left standing
  deliberately: aligning either moves the Inventory page's
  committed / available / surplus figures and needs the owner's decision.
- Effective qty per line = `qty - (delivered net of returns)` via
  `soDeliverableRemaining` (delivery-orders-mfg.ts) — a DO in
  `DO_NOT_DELIVERED_STATES` never counts as delivered.
  `so-stock-allocation.ts` step 3 follows the same rule (aligned 2026-08-01,
  audit D5).
  **That set gained LOADED on 2026-08-20**, and until then this line read "DRAFT
  and CANCELLED". LOADED is a PRE-SHIP state — the inventory OUT fires only on
  ENTRY to a shipped state — so a delivery still on the lorry was shrinking MRP
  demand and the allocation job's remaining. It is one predicate now,
  `doCountsAsDelivered` in `shared/do-shipped-states.ts`; the full trace, and
  the dispatch it was blocking, are in `docs/modules/delivery-order.md` under
  *"Has this delivery counted?" is ONE predicate now*.
- **"Delivered" is read TWO ways, and has to be** (2026-08-17). The delivered
  sum lives in `lib/do-unlinked-coverage.ts::netDeliveredBySoItem` and counts
  (a) DO lines linked by `so_item_id`, plus (b) DO lines whose link is NULL but
  whose DO header still names the order in `so_doc_no`. Reason: that column is
  nullable behind an `ON DELETE SET NULL` FK, so deleting ONE Sales-Order line
  blanks the pointer on every document that served it — and reading only (a), a
  shipment that physically happened went invisible: the SO stayed CONFIRMED and
  MRP re-ordered goods already at the customer's house (26 lines across 8 live
  2990 DOs). (b) is confined to the order the header names, matched on item
  code, and CAPPED by (a), so the two readings cannot double-count and no unit
  moves between orders. `syncSoDeliveredFromDo` feeds `isSoFullyCovered` the
  same pair. Orphaned rows are healed by
  `backend/scripts/repair-do-so-item-links.mjs`; the path that blanks the
  pointer was still open when this shipped.
- SERVICE lines never create demand (`isServiceLine`).
- **The warehouse follows the SO**: a line's NULL `warehouse_id` is resolved
  from the SO header (`lib/so-warehouse.ts`) BEFORE bucketing, server-side, so
  every consumer sees one binding.

## 3. Supply

- On-hand: `inventory_balances` summed per bucket.
- Open PO lines: `qty - received_qty > 0` on a PO whose status is not in
  `PO_DEAD` (CANCELLED, DRAFT — a draft PO must never hide a real shortage).
  ETA = effective (latest revised) line date, else effective header date.
  Ship-to warehouse = line `warehouse_id` else header `purchase_location_id`.
- Ship-before-arrival commitments (mig 0230) are DEDUCTED from the PO pool and
  the same units ADDED BACK to on-hand — see the 4b block comment; the two
  always move together. Unreachable commitments surface as
  `unmatchedCommitments` (0 is the healthy reading).

### The supplier each row offers — one reader, chunked and paged

The MRP row's supplier list and its `mainByCode` pick come from
`supplier_material_bindings`, read through `readMfgProductBindings`
(`backend/src/scm/lib/supplier-bindings.ts`) in `computeMrp`
(`backend/src/scm/routes/mrp.ts`). It is not a plain `.in()`: the code list is
chunked by URL bytes, the result is paged past PostgREST's 1,000-row response
cap, and the order is total (`is_main_supplier DESC, item_code, id`).

Two ceilings were being crossed here before 2026-08-16 and only one of them was
loud. The IN-list was the whole demand code list in one URL, and the response
was 2,660 rows in production against the 1,000-row cap — so roughly two thirds
of the bindings never arrived and the SKUs they belonged to rendered
**"— none —"**, which is the difference between a row staff can convert to a
purchase order and a row they cannot. The fix was applied at this call site
alone; since 2026-08-19 the rule lives in the shared reader, so the five other
places that ask the same question inherit it instead of re-deriving it.

`suppliers` is deliberately NOT on `ModelGroup` in
`frontend/src/pages/scm-v2/Mrp.tsx`: a Model or a Sales Order does not have
suppliers, each VARIANT does. All three groupers used to copy it off whichever
child happened to be first, nothing read it, and the next renderer to want a
supplier on a parent row would have shown one module's binding against all three.

## 4. Buckets and allocation

### What is covering a line — ONE rule, two questions (2026-08-21)

A line's `source` is `stock`, `po` or `shortage`, and both rules live in
`scm/shared/mrp-alloc-source.ts`, mirrored byte-identically into
`frontend/src/vendor/shared/`:

| function | the question | who wins |
| --- | --- | --- |
| `allocSourceOf` | is this demand COVERED, and by what? | a shortage |
| `allocSourceCoveringPo` | is a purchase order INVOLVED? | a named PO, even when short |

The second is what the PURCHASE side asks (`SoLineCoverage` /
`PoCoverageAssignment` — advisory), where a partly-covering PO is the very thing
being reported. The two therefore disagree on one input — short AND covered —
and that is deliberate; it used to be an undocumented disagreement between two
copies six hundred lines apart in `routes/mrp.ts`.

**Both arms test the NUMBER, not "was a PO involved."** A PO that cannot name
itself is missing data, not an order. There were THREE hand-written copies of
this rule, and the third — `Mrp.tsx:307`, which synthesises the sofa-SET rows
because the backend returns sets in a different shape — had only two arms. It
was missing `stock`, so a sofa set with no shortage and no covering PO (received,
in the warehouse) was labelled `po`, and the chip printed the word **"ordered"**
because it had no number to show.

`'ordered'` was never a computed state: it was the fallback for
`source === 'po'` with no PO. It is deleted from both the desktop table and the
mobile card, because `source === 'po'` now guarantees a number. Trace:
`docs/bugs/0513-a-sofa-set-already-in-the-warehouse-said-ordered.md`.


- Bucket key = `(warehouse | item_code | variant_key)` (`composite()`;
  `WH_NONE` for unresolved warehouse). Variant key via `computeVariantKey` —
  byte-identical to `inventory_balances.variant_key`.
- Order: **EFFECTIVE delivery date** ascending (nulls last), tie-break SO doc
  no. Stock first, then POs by earliest ETA, remainder = shortage.
- **"Effective" has ONE definition and it lives in one file** —
  `scm/shared/effective-delivery.ts`, `effectiveSoDelivery`. Precedence:
  an OVERRIDDEN line date → `amended_delivery_date` → `customer_delivery_date` →
  a non-overridden line date as a last resort. The delivery board, PO coverage,
  `/inventory` reservations, the delivery agents and the stock allocator
  (`lib/so-stock-allocation.ts`) all read that same function.

  Until 2026-08-18 this engine read `line_delivery_date ?? customer_delivery_date`
  — the customer's ORIGINAL promise plus a per-line MIRROR of it — while the
  board read `amended_delivery_date ?? customer_delivery_date`. A rescheduled
  order moved on the board and did NOT move here, in the queue that decides who
  gets scarce stock and what is ordered first. Two screens, two answers, nobody
  told. Owner: 「我们都没有排产的，我们都不是 Production，我们应该只是送货的日期
  而已」 — there is no production to plan against, only the delivery date.

  **The line mirror is the half that is easy to miss.** `line_delivery_date` is a
  COPY of the header date while `line_delivery_date_overridden = false` (mig 0172
  `apply_so_header_followers` writes the pair), and a reschedule writes the
  HEADER only — so the mirror goes stale and a fix that consults the amended date
  only *after* the line date changes nothing. Measured on prod 2026-08-18: all 5
  live lines on the 3 rescheduled orders were exactly that shape.
- **Legacy `''` pool rule (R4 + audit D2)**: a real-variant bucket with NO PO
  supply of its own falls back to the same-warehouse empty-variant PO pool —
  a FALLBACK, never additive. Applies to the general path (section 7) AND the
  sofa path (section 8, since 2026-08-01). Known accepted limitation: two
  different variant buckets of one (warehouse, item) can each clone the same
  legacy pool (audit D-1 measures it; 0 live groups today).
- Sofa is grouped as per-SO-line SETS (section 8) drawing from the same pooled
  supply; set-level atomicity lives in `so-stock-allocation.ts` 7b (one
  covering batch or PENDING) and `ship-commitment.ts`, NOT here.

### "If the variants are different, will it still match my goods?" (owner, 2026-08-16)

Answered separately for the two kinds of supply, because on `main` today they do
NOT follow the same rule:

| Supply | Strict on variants today? | Rule |
|---|---|---|
| **On-hand STOCK** | **YES.** | The bucket key is `(warehouse \| item_code \| variant_key)` and `stockByKey.get(k)` is an exact lookup. There is no fallback. A unit whose `variant_key` differs is a different thing and does not satisfy the line. |
| **Open PO supply** | **NO — not yet.** | The legacy `''` pool rule above still applies: a variant-bearing bucket with NO PO of its own folds in the same-warehouse EMPTY-variant PO pool. So a variant-less PO **does** still count as supply for a specific-variant order, and can still hide a real shortage. |

So the strict-variant answer the owner asked for is **half live**. Making the PO
side strict too (and quarantining an unrecognised `item_group`) is PRs #2294 /
#2300 — **neither merged as of 2026-08-16**. Until they are, do not tell an
operator that a differing variant guarantees a separate purchase: it does on
stock, it does not on an open PO raised before SO→PO carried variants.

## 5. Failure modes — loud on purpose, EXCEPT the one that matters

> **CORRECTED 2026-08-16.** This section, and §8's "capped-with-a-loud-guard.
> Keep it that way", both asserted that a truncated read fails loudly. On `main`
> today **it does not, and it cannot.** Read the row below before trusting any
> MRP number.

| Error | Meaning |
|-------|---------|
| `mrp_load_failed: …` | Demand or PO-supply read errored. The PO read used to swallow this and plan with zero supply (phantom shortage rendered as truth) — it throws since 2026-08-01. |
| `mrp_load_truncated: …` | **DEAD CODE on `main`.** The guard fires at `length >= MRP_LOAD_CAP` (5000), but PostgREST answers with at most `db-max-rows` per response and a `.limit()` ABOVE that ceiling does not lift it — it is an upper bound, not a request. The read comes back at the server ceiling (1000), `length >= 5000` is permanently false, and the throw that exists to prevent exactly this can never run. |
| lead-time load throws | `loadLeadTimeBase` — a swallowed error would zero every lead time (order-by = delivery date). |

**What that means for every number this engine produces.** Measured on
production company 1 by read-only probe #2279 (workflow run `31941352447`, cited
in PR #2304): **13,918 demand lines matched the filters and the plan saw 1,000 of
them — 7.2%.** Because the demand read orders by `id`, a uuid, the surviving
slice is not "the newest" or "the oldest" — it is an arbitrary 7% spanning the
whole date range. Any given SO line, new or old, had roughly a 7% chance of being
planned.

Three consumers inherit this silently, and none of them can tell:

- the **MRP page** itself;
- the SO detail / drill-down's `stock_state` and the **chip-4 "Incoming PO + ETA"**
  (`mrpLineCoverage`) — see `docs/modules/sales-order.md` §0.4 and §0.8;
- the **From-SO purchase-order picker**, which is the expensive one. It filters
  on `shortageBySoItem.get(id) ?? 0 > 0`, so a line MRP never planned has no map
  entry, reads as shortage 0, and is treated as fully covered — it silently
  disappears from the picker. See `docs/modules/purchase-order.md`.

> **CORRECTED 2026-08-17.** The paragraph that stood here said "**As of
> 2026-08-16 none of the three is merged**, so the paragraph above describes
> production." That is now false in a way worth spelling out, because two of the
> three were closed rather than merged and a reader chasing them would find
> nothing. Verified with `gh pr view 2300 2304 2294 --json state,mergedAt`:
>
> | PR | state | landed |
> |---|---|---|
> | **#2300** | **MERGED** | 2026-08-16T14:13:24Z — this is the fix that shipped |
> | #2304 | CLOSED | never merged; superseded by #2300 |
> | #2294 | CLOSED | never merged; its variant-strictness half rode in on #2300 |
>
> So **§5's truncation description above is HISTORY, not production.** Every
> multi-row read pages since #2300, the `MRP_LOAD_CAP` guard is deleted rather
> than re-tuned, and the plan covers every open demand row. Read §5 as the
> account of a fixed defect — it is kept because the trap it documents (a
> `.limit(N)` above `db-max-rows` is not a cap you can detect by counting rows)
> is still live advice for any new read.
>
> The §4 table's "Open PO supply — **NO, not yet**" row is likewise stale:
> #2300 removed both legacy-`''` fallbacks, general and sofa. Supply now matches
> demand on the full variant key on BOTH sides.

### What #2300 cost, and what 2026-08-17 gave back

#2300 bought correctness with latency, and said so: *"roughly a dozen round trips
to on the order of a hundred ... They are sequential."* The owner reported the
result on 2026-08-16 — MRP 5,162 ms, and the **Sales Order list 5,272 ms**, which
is not a coincidence: `computeMrp` runs **once per SO list load** (§1), so that
page can never be faster than this one.

Sequential was how the reads were written, not a property of the problem. Since
2026-08-17 they run **bounded-concurrent** (`scm/lib/concurrency.ts`):

- the `soDeliverableRemaining` batch loop — ~14 batches, ~5 reads each, i.e. two
  thirds of the engine's round trips — runs `MRP_READ_CONCURRENCY` (6) batches at
  a time. Safe for the reason #2300 already gave for batching at all: the partial
  maps are a union of disjoint key sets.
- the lead-time base, the category walk, stock balances and PO supply depend on no
  earlier result, so they are ISSUED as one wave at the top of `computeMrp` and
  AWAITED at their original sites. The two warehouse masters are independent too
  and were deliberately LEFT sequential: both discard their read error, and
  `check-swallowed-reads.mjs` matches that by the `const { data … } = await …`
  shape at the use site, which hoisting destroys — the report would have gone
  from 1 swallowed read to 0 while the read stayed just as swallowed.

**No read was removed, widened, narrowed or re-ordered.** Measured with an
instrumented fake (2,800 docs, 1 ms/read), `origin/main` vs after: reads **56 →
56**, max in flight **1 → 6**, critical path **94 ms → 52 ms**. Identical read
count is the property that matters — it is what keeps this from re-creating the
#2300 defect. Production wall-clock comes from
`backend/scripts/probe-mrp-roundtrip-cost.mjs` (workflow
`probe-mrp-roundtrip-cost`), which times a sequential and a concurrent arm
against prod and **refuses to report a saving unless both arms read an identical
row set**.

Two things that follow, and are worth knowing before tuning anything here:

- **`MRP_READ_CONCURRENCY` is a bound, not a target.** The reads go through
  Hyperdrive's pooled connections; an unbounded fan-out trades latency for pool
  exhaustion, which is the owner's "must not destabilise" rule failing expensively.
  Re-run the probe before moving it.
- **Compute completely, ship narrowly does NOT apply to the allocation.** The plan
  is pooled and global — a correct allocation cannot be computed from one page of
  sales orders — so no amount of pagination on a CONSUMER reduces what this engine
  must read. That is the constraint #2300 exists to protect.

Advisory consumers (SO drill-down, po-so-coverage, reservations) catch and
degrade to "no coverage shown"; the MRP page and the agents fail loudly.
Both reads carry deterministic `ORDER BY id` and push their status not-in
lists into SQL (quoted-list form, filter path = the embed alias — the idiom
so-delivery-sync.ts proved). A NULL-status header is dropped by `not.in`,
matching so-stock-allocation's own SQL.

## 6. The stock side — reservations assigned/free (audit D8)

`GET /inventory/reservations` (inventory.ts) merges TWO views per open lot:

- **Hard view**: READY SO lines claiming the lot. Sofa claims are locked to a
  batch (`allocated_batch_no`); every other category is a bucket-level
  QUANTITY claim (identity only fixed at DO time by FIFO). A batched lot sees
  its own batch's locked claims + the bucket's batchless claims; an unbatched
  lot sees the full bucket. (Before 2026-08-01 a batched non-sofa lot saw
  NOTHING and always rendered FREE.)
- **Floating view**: `mrpStockAssignment` spreads each bucket's MRP-assigned
  on-hand qty across its lots FIFO -> `assigned_qty` / `free_qty` /
  `mrp_assigned_to`. This is the dead-stock signal both frontends render.
- `status` = RESERVED when hard-claimed OR `assigned_qty > 0`; it can never
  contradict the same row's `assigned_qty`. Contract stays `RESERVED | FREE`
  (no PARTIAL — the exact split is on the qty fields).

Frontend pair (one logic layer): desktop `pages/scm-v2/Inventory.tsx`
(Reservations tab + Stock Breakdown drawer) and mobile
`mobile/MobileStockCard.tsx`, both through
`vendor/scm/lib/inventory-queries.ts` `buildStockBreakdown` /
`lotAssignedQty` / `lotFreeQty`.

## 7. Files

| File | Role |
|------|------|
| `backend/src/scm/routes/mrp.ts` | Engine + `/mrp` route + `mrpLineCoverage` / `mrpReverseCoverage` / `mrpStockAssignment` |
| `backend/src/scm/lib/so-stock-allocation.ts` | The SECOND walk — writes `stock_status` READY/PARTIAL/PENDING. Same statuses, same DRAFT-DO rule; keep them aligned. |
| `backend/src/scm/lib/ship-commitment.ts` | Commitment deduction/add-back contract (`applyCommittedSupply`) |
| `backend/src/scm/routes/po-so-coverage.ts` | PO->SO precedence (delivered lock > stored link > MRP floating) |
| `backend/scripts/audit-mrp-pairing.mjs` | Read-only production detector — a REPLICA of sections 1-8; update it in the same PR as any allocation-rule change. Section (H) (2026-08-02) additionally enforces the owner's purchasing rule: cancelled/DRAFT POs fully out of the formula, and no over-ordering beyond demand for MATTRESS/BEDFRAME/SOFA (only ACCESSORY may be bought for stock) — reported per PO document with reason codes (STOCK-SLICE / SO-DONE / BUCKET-SPLIT / NO-DEMAND) plus received-but-unowned dead stock per bucket |
| `backend/src/scm/lib/concurrency.ts` | `mapBounded` / `eager` — the bounded read wave (2026-08-17). `eager` is what keeps error PRECEDENCE identical when a read is hoisted, and stops an un-awaited rejection killing the request |
| `backend/src/scm/routes/mrp.test.ts` | Unit tests: R4 legacy pool (general + sofa), D6 flag invariance, D4 SHIPPED, D3 truncation guard, stock assignment, the `undated` tally + `parseIncludeUndated` spellings (2026-08-16), and the read wave (overlap happens, the bound holds, the plan is order-independent, a failed read still throws `mrp_load_failed`) |
| `backend/scripts/probe-mrp-roundtrip-cost.mjs` | Read-only production probe: times a sequential and a bounded-concurrent arm over the same read shapes, and asserts both read an identical row set before reporting any saving |
| `backend/scripts/probe-undated-demand.mjs` | Read-only production probe: how much live demand is undated, BOTH companies, with the refutation tests for why. Dispatch via `.github/workflows/probe-undated-demand.yml` |
| `backend/scripts/lib/undated-demand-queries.mjs` | That probe's SQL, in one home so a test can EXECUTE it. No shebang — a test imports it |
| `backend/tests-pg/probeUndatedDemandSql.pg.test.ts` | Runs every one of those queries against real Postgres in `backend-postgres`. Exists because the probe's first production dispatch died on unexecuted SQL |

## 8. Traps

- The engine runs in a Worker behind PostgREST: unbounded selects clip at
  ~1000 rows with NO error. Every read here is either bounded-by-codes,
  chunked (`chunkIn`), or capped-with-a-guard — but **a `.limit(N)` above the
  server's own `db-max-rows` is not a cap you can detect by counting rows
  against N.** That is precisely how the demand read came to plan over 7% of the
  data with a truncation guard sitting right underneath it (§5). A cap is only
  loud if the number it compares against is the number the server will actually
  return. Prefer `paginateAll` / `chunkIn` over a bare `.limit()` and a guard.
- `companyId` is REQUIRED on `computeMrp` (typed `number | null | undefined`,
  key not optional) — see the #710/#712 incident comment at the signature.
- Status columns are ENUMS in Postgres — any raw SQL must `::text` before
  string ops (the detector documents the trap).
- One business rule, one home: `SO_DONE`-vs-allocation-status,
  DRAFT-DO-delivered, and the legacy-pool rule each drifted once already —
  that is precisely what the 2026-08-01 PR converged. Since 2026-08-13 the
  status set is an IMPORT (`shared/so-terminal-states.ts` + its
  `scripts/lib/so-terminal-states.mjs` mirror, pinned by
  `tests/soTerminalStatesMirror.test.ts`), so there is no longer a sibling copy
  to grep for — which is the point: "grep for its siblings" is advice that only
  works on the days someone remembers to follow it.

## 9. Stored planning snapshot — MRP is a "planning run" (option B, owner 2026-08-19)

`GET /mrp` used to run the whole `computeMrp` engine live on every open (~4s).
Owner decision 2026-08-19: MRP becomes a **stored planning run** — the industry
norm (SAP / Oracle / NetSuite run MRP on a schedule / on demand and the screen
reads the stored result), refreshed on a schedule + a manual **Regenerate**, with
the page showing "as of &lt;time&gt;".

- **Table** `scm.mrp_snapshots(company_id, result jsonb, computed_at, updated_at)`
  — one row per company, migration `0313`. A **cache, not a book of record**:
  when a company has no row, `GET /mrp` falls back to live compute (so the feature
  is inert until first populated, and `DROP TABLE` reverses it).
- **Served ONLY for the DEFAULT view** (no category/warehouse filter, undated
  hidden — `isDefaultMrpView`). `catFilter`/`whFilter` change the ALLOCATION
  inputs (mrp.ts `549` / `863` / `991` / `1203`), not just the output rows, so a
  stored full result cannot be safely post-filtered; a filtered or undated view,
  or an unpopulated company, computes **live** exactly as before. The response
  carries `stored` + `computedAt` for the "as of" indicator.
- **Regenerate:** `POST /mrp/regenerate` recomputes the default view + upserts,
  returns it fresh (gated `edit` on `scm.procurement.mrp` by the area guard).
- **Auto-refresh:** the Worker `scheduled()` handler's new `*/15` cron calls
  `refreshAllMrpSnapshots(env, nowIso)` for `MRP_REFRESH_COMPANY_IDS = [1, 2]`.
- Files: `scm/lib/mrp-snapshot.ts` (`readMrpSnapshot` / `refreshMrpSnapshot` /
  `refreshAllMrpSnapshots` / `isDefaultMrpView`), `mrp.ts` (`GET /` snapshot read
  + `POST /regenerate`), `src/index.ts` (cron branch), `wrangler.toml` (cron),
  `frontend/src/vendor/scm/lib/mrp-queries.ts` (`useRegenerateMrp` + `stored` /
  `computedAt`), `frontend/src/pages/scm-v2/Mrp.tsx` (Regenerate button + "as of").
