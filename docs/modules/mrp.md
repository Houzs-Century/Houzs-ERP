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
  **AND THE ALLOCATOR'S HEADER ROLL-UP NOW FOLLOWS IT TOO (2026-09-09,
  `docs/bugs/0738-a-delivered-line-kept-its-stale-pending-and-held-18-orders-ou.md`).**
  Step 3 skipping a fully-delivered line means the allocator never writes that
  line's `stock_status` again, so it is FROZEN — usually at `PENDING` for goods
  that shipped straight off a purchase order. The roll-up read that frozen value
  and counted the line as short, holding the order out of `READY_TO_SHIP`. It now
  passes `ReadinessLine.fulfilled` (the same `qty - delivered + returned`
  arithmetic step 3 uses), and `summariseReadiness` counts such a line the way it
  counts a SERVICE line: present, so a finished order is not mistaken for an
  empty husk, but gating nothing. Measured before the fix: 18 live company-1
  orders sat at `IN_PRODUCTION` with every still-outstanding line already READY.
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
  every consumer sees one binding. Since 2026-08-25 the same lib also holds
  the WRITE-side twin — `chooseCreateWarehouseDefault`, the SO-create default
  chain (Location, then State, then the creating operator's own store when the
  order is otherwise locationless; docs/bugs/0541) — so far fewer goods lines
  are born NULL in the first place. Read rule and write default live in one
  file on purpose: they must never disagree about the same order.

### 2.1 A row's `category` — the fallback, and why the row disappears without it

**The response field `skus[].category` is what puts a row on a tab.** The
frontend picks a tab's rows with `s.category === apiCategory` — the active tab's
own category (`frontend/src/pages/scm-v2/Mrp.tsx`; it read a hand-typed
`VIEW_CATEGORY[view]` until 2026-09-10, see §2.2) — so a row whose `category` is
`null` belongs to NO tab and is invisible on every one of them, with no empty
state, no count and no warning, because a missing row and a covered row look
identical here.

**The category is decided in ONE way, in two places, and they must stay the
same expression:**

```
prod?.category ?? catFromGroup(<the line's item_group>)
```

- the FILTER — `mrp.ts:1099`, deciding whether a line enters demand at all;
- the EMIT — `mrp.ts:1344`, the value that ships on the row (first non-null
  `catFromGroup` across the bucket's own rows).

`catFromGroup` (`mrp.ts:1087`) maps an `item_group` to
BEDFRAME / SOFA / MATTRESS / ACCESSORY / SERVICE and returns `null` for anything
else. It exists so a line whose `item_code` is not in `mfg_products` still shows
under its tab; **`null` out of it is still `null` on the row** — an unrecognised
group is not guessed at.

Until 2026-09-10 the emit site read `prod?.category ?? null` while the filter had
the fallback, so the engine kept those lines, planned them, and shipped them with
no category: eight accessory codes / 62 lines / 110 units on prod were planned and
shown nowhere (`docs/bugs/0777-mrp-dropped-8-accessory-codes-from-every-tab-because-the-row.md`).
If a third reader of a line's category is ever added, it uses this expression too.

### 2.2 The TAB LIST is the server's, not the page's — and the enum is OPEN

**`skus[].category` puts a row on a tab; §2.1 is only half of that.** The other
half is whether a tab for that category EXISTS, and until 2026-09-10 the page
typed its own list of four while the catalogue could hold nine
(`docs/bugs/0778-mrp-showed-four-tabs-while-the-product-catalogue-held-nine-c.md`).

`public.mfg_product_category` and its `scm` twin carry NINE members: the five in
the baseline DDL plus DINING / BEDLINES / DIFFUSER / CARPET, added by migrations
`0258`-`0261` and `0262`-`0265`. `backend/src/scm/routes/mfg-products.ts` lists
all nine as `MFG_PRODUCT_CATEGORIES` and rejects a product create outside them.
A line on any of the four newer ones was dropped TWICE — by the section-6 filter
because the page only ever sends one of its four tab values as `?category=`, and
again by the page's own equality — and neither drop was counted. Measured from
files committed in this repo: `backend/scripts/data/align-skus-houzs-century.json`
opens **181 of 1,242** SKUs across those four, and the AutoCount outstanding-SO
export carries **10 open lines / 15 units** on DINING codes.

**The enum is deliberately OPEN.** `20260905T0900_acc_item_groups.sql` ships
`scm.acc_register_item_group(text, text)`, `SECURITY DEFINER` and granted to
`service_role`, which `ALTER TYPE ... ADD VALUE`s both enums at runtime so the
owner can add a category himself; its header says *"every reader treats the enum
as an open list"*. So a hard-coded tab list does not merely miss four members, it
misses every future one.

**The rule now.** `MrpResult.categories` — every product category in the
company's catalogue, read in section 2, paged, company-scoped, and INDEPENDENT of
`catFilter`, so every tab's response carries the same list — decides whether the
page shows an Others tab. The derivation lives in one module,
`frontend/src/pages/scm-v2/mrp-views.ts`:

- the FOUR the owner works from — Sofa, Bedframe, Mattress, Accessories — always,
  in that order, standing even when `categories` is absent so an in-flight
  response cannot blank the tab bar;
- ONE **Others** tab appended when, and only when, the catalogue holds anything
  outside those four (owner 2026-09-10, 「应该要放others 一个category把」;
  `docs/bugs/0782-the-extra-mrp-categories-each-grew-their-own-tab-instead-of.md`).
  It is not one-tab-per-extra-category: that shape would grow a column the day
  the owner registers a category at runtime through `acc_register_item_group`;
- `SERVICE` never gets a tab, and never falls into Others — `isServiceLine` skips
  service lines BEFORE the category filter, so it could only ever be empty. Named,
  not silently filtered.

**Others is `category: null`, and that is a THIRD filter state, distinct from a
category string and from `'all'`.** It asks the server for NO `?category=` — it
stands for a SET, and a fake enum value in the query string would be filtered to
nothing — then keeps the rows no other tab claims. Membership is decided by
`rowBelongsToView`, which for Others claims **by EXCLUSION**: a row is Others' if
its category is non-empty, not one of the four, and not SERVICE. Exclusion is the
load-bearing choice — matching against the reported `categories` would strand a
row whose category is not in that list (a product deleted from the catalogue, a
category added between two requests, or a row the engine kept on its item GROUP,
§2.1). A `null`-category row stays off every tab, INCLUDING Others, so the catch-
all never becomes the bin that hides the §2.1 bug.

`mrpCategoryOf(tabId)` and the tab id are a declared inverse pair (`others` maps
to `null`), because the page must pick `?category=` before it has a response to
derive tabs from. The round-trip is pinned by `mrp-views.test.ts`, which also
asserts every enum member and every aligned-SKU category is claimed by SOME view
— on MEMBERSHIP, not on a tab NAME, since a name assertion would pass while a row
still fell through. Both tests read the vocabulary out of the SQL and the
committed alignment payload rather than a typed list, because a typed list here
would be the fault being tested.

**STILL OPEN, and it is the owner's call.** A row whose category is `null`
(§2.1's honest null) is dropped by the section-6 filter and counted nowhere. The
`undated` tally forty lines below shows the shape the fix would take — count on
the rows the `continue` removes, before it removes them — but it sits inside the
section 0777 changed the same day.

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

### And it is NOT `.in()` any more — an item code can carry a `"` (2026-09-10)

Both the supplier read and section 2's `mfg_products` read now build their filter
with `pgrestInList` (`backend/src/scm/lib/pgrest-in-list.ts`) and send it as
`.filter(column, 'in', …)`. **Do not change either back to `.in()`.**

`@supabase/postgrest-js` wraps a value in double quotes when it holds one of
`, ( )` and escapes nothing inside them; PostgREST requires a backslash before a
quote and a doubled backslash for a backslash. So an item code carrying an inch mark closes its own quote
early, the next `)` closes the whole `in.(` list, and **every code after it in
that batch matches nothing while the request answers 200.** Company 1's open
demand carries two such codes — `DUNLOPILLO GENERASI 5" MATT (S)` and
`… (SS)` — and on 2026-09-10 they were emptying the Supplier column on 38 item
codes at once (run 34457477642; full measurement in `docs/bugs/0780-mrp-shows-no-supplier-on-a-line-whose-product-is-bound.md`).

The payload is byte-identical to what `.in()` builds for any batch holding no
quote and no backslash, which is pinned against the real library in
`backend/src/scm/lib/pgrest-in-list.test.ts` — so adopting it changed nothing for
the reads that already worked.

Two consequences worth knowing before you touch this:

- **A test fake must implement `filter(col, 'in', payload)`**, and must parse it
  with `parsePgrestInList` rather than a second `split(',')` — a naive split
  reproduces the bug and reports a clean run. The shared fakes
  (`backend/src/scm/lib/fake-postgrest.ts`, `backend/tests/fakePostgrest.ts`) and
  `backend/scripts/lib/pgrest-shim.mjs` already do.
- **A test fake's comparison operators must compare by the column's type**,
  NULL matching nothing — the way `fake-postgrest`'s `gte`/`lte` do, and the
  way `lt` does since 2026-09-10 (docs/bugs/0785). Before that `lt` was
  numeric-only with a `?? 0` fold, so the only correct shape for a timestamptz
  month window — `gte(first) + lt(next-first)` — returned nothing against the
  fake while the real database returned the rows. A fake that silently drops
  rows on a string compare reports a clean run for the wrong reason.
- **The other reads in this tree still use `.in()` on an item code** — 67 of
  them outside these two as of 2026-09-10, counted by the enumeration block in
  the PR — so any of them can lose the same two codes. Unfixed, deliberately;
  the bug entry says why and what closing it takes.

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
- **A DISPLAY / SHOWROOM / SERVICE warehouse can supply nothing, since
  2026-09-08** (owner ruling 「分配时跳过这九个仓」,
  `docs/bugs/0686-the-allocator-promised-display-showroom-and-service-stock-to.md`).
  `lib/non-selling-warehouse.ts` is the ONE home for the three
  `scm.warehouses.type` values, shared with the dead-stock exclusion in
  `routes/inventory.ts`. The STORED allocator
  (`so-stock-allocation.ts`) applies it on **all three** of its paths — the
  pooled on-hand read, BOUND MODE and the sofa dye-lot matcher — because the
  latter two never read `inventory_balances` and a filter on that read alone
  would have covered one door of three.
  **This engine (`mrp.ts`) is deliberately NOT changed.** MRP answers "what does
  this warehouse hold", which is still 1,897 units in those nine, and that
  answer is correct; "what may be promised to a customer" is a different number
  and lives in the readiness layer (`so-line-effective-stock.ts`'s
  `lineNonSellingWarehouse` veto, sales-order.md §0.4). Keeping the two apart is
  the ATP split SAP / Odoo / NetSuite all model. If you add a NEW readiness
  consumer, gate it there; do not filter MRP's supply.
- **Company-1 bound groups are EXCLUSIVELY PO-bound in the stored allocator
  (2026-08-30,
  `docs/bugs/0572-a-company-1-bound-line-with-no-receipt-fell-through-to-the-p.md`).**
  `HARD_BOUND_COMPANY_ID = 1` in `lib/so-stock-allocation.ts`: a company-1
  bedframe / sofa / `(SP)` mattress line (`isHardBoundLine`) lights only from
  its own received PO — the pooled walk force-stamps it PENDING, never reads
  its bucket. Company 2 keeps the soft pooled model. The display union's
  promotion gate (`so-line-effective-stock.ts`) refuses to promote bound lines
  on MRP's say-so; see sales-order.md §0.3 for the company-split table and the
  `check-bound-exclusivity.mjs` census that re-measures the rule.
- **A SOFA'S BINDING CAN BE UNWRITABLE, and that is a separate failure from an
  absent purchase order.** The book records the SO -> PO edge at LINE grain in
  `PODTL.FromSODtlKey`, and `backend/scripts/repair-po-so-link-from-book.mjs`
  copies it — refusing whenever either key resolves to more than one ERP row,
  because a Map keyed by DtlKey would keep one of them. **Every sofa is in that
  bucket by construction**: one book line is one ERP row per compartment. So the
  whole sofa population was unrepairable by that tool, and a sofa piece whose
  purchase order exists in the book sat PENDING for ever while MRP told
  purchasing to raise a second one.

  `backend/scripts/repair-po-so-link-sofa-compartments.mjs` is the tool at the
  other grain: inside ONE pair of book lines, if every item code appears exactly
  once on each side then each purchase compartment has exactly one sales
  compartment of the same product to be, and the pairing is a copy rather than a
  choice. Anything else is refused — notably a MIRRORED build (`1A(LHF)+2A(RHF)`
  on the purchase side against `2A(LHF)+1A(RHF)` on the sales side), which is a
  build disagreement needing the drawing, not a link one.

  **The pairing rule lives in ONE place**, `backend/scripts/lib/sofa-po-so-pair.mjs`
  (`judgeCompartmentPair`), imported by the repair and by
  `backend/scripts/probe-staff-reported-flow.mjs`. Its contract matters and is
  easy to get wrong: **pass every ERP purchase row carrying the key, LINKED ROWS
  INCLUDED.** A compartment somebody already dedicated still occupies its sales
  row, so a tally over the unlinked rows alone under-counts the purchase side and
  hides the collision the guard exists to catch — which is exactly how two copies
  of this rule gave opposite answers on production about `HC-PO-010040 <- SO-012277`
  (`docs/bugs/0708-two-tools-answered-the-same-pairing-question-differently-twe.md`).

  **Size the two apart before quoting either.** Probe run `34202130553`
  (`probe-staff-reported-flow.mjs`): 2,842 live hard-bound sales lines carry no
  dedicated purchase line, and for **2,717 of them the book has no purchase
  order either** — the absence is CORRECT and quoting 2,842 as a backlog is
  alarming and wrong. Seven, on four orders, are the ones the book names and we
  do not hold. `docs/bugs/0707-a-sofa-s-purchase-line-could-never-be-linked-to-its-sales-li.md`.
- **AND SO DOES THIS ENGINE, since 2026-08-31** (owner's option 甲, company 1
  only). This bullet used to end "MRP's own pooled view knows none of this",
  and that gap was not academic: the migrated stock snapshot carries no variant,
  so a typed bedframe line looked into an empty bucket and reported a shortage
  for goods already received on its own purchase order
  (`docs/bugs/0581-mrp-told-the-owner-to-buy-bedframes-his-own-received-purchas.md`).
  Both sides now honour the binding — a bound PO line is DEDICATED and leaves the
  pool; a bound demand line does not read pooled STOCK, and covers from its own
  PO, received then outstanding.
- **AND SINCE 2026-09-09 IT COVERS FROM ITS OWN PO AND NOTHING ELSE** (owner:
  *「修,但只能动 Houzs Century」*;
  `docs/bugs/0736-mrp-let-a-pooled-purchase-order-cover-a-hard-bound-line-the-r.md`).
  The dedicated queue used to be followed by the POOLED queue, so a purchase
  order belonging to nobody could report a bound line as covered while the stored
  allocator — which accepts only that line's OWN purchase order — left it PENDING
  for ever. The buyer read "already on order" and the order never moved: the
  mirror of 0572 on the other screen, **10 of the 126** proceeded company-1
  bedframe/sofa lines with no dedicated PO, measured on prod.
  This bullet used to end by saying the rule was *"drawn at stock and only at
  stock"* because withholding the pooled PO queue as well made `po-so-coverage`
  report that an unlinked PO serves nobody. That was right about the mechanism
  and never sized: the whole population is **5 lines on 2 purchase orders**
  (`HC-PO-009024`, `HC-PO-010085`), both already owed a real link to the sales
  order they were raised for. Pooled supply is still **reported** —
  `poOutstanding` counts it — it just may no longer be named as a bound line's
  cover, so the line reads as the shortage it is.
- The bound branch does NOT decrement the bucket either: here the pool IS the
  bucket,
  every line in a company-1 bedframe bucket is bound, so nothing else can draw
  it, and leaving the units visible is what keeps the on-hand figure honest.
- **AND SOFA JOINED THE RULE ON 2026-09-09** — the bullet above used to end
  *"SOFA is excluded at this call site … section 8 has its own supply model"*,
  and that sentence read as a design choice while describing work not yet done.
  Section 8 planned every sofa SET on the pooled bucket key alone, which is
  survivable for an OUTSTANDING purchase order (it sits in the pool under its own
  key) and not survivable for a RECEIVED one: `left = qty − received_qty` is 0,
  the line never enters the pool, and with no `dedicatedReceivedByLine` leg its
  receipt could only arrive through the STOCK bucket — keyed on
  `fabricCode|seatHeight|legHeight|specials`, four free-text fields the order and
  the receipt spell differently far more often than not.

  Measured on the live page 2026-09-09: the sofa tab asked for **70 units on 28
  orders**; **42** were really missing, **8 of those orders (26 units) had their
  own purchase order fully received**, and 26 of those lines read READY on the
  sales-order screen at the same moment. STOCK read **0 on all 136 sofa rows**
  while **246 units** of company-1 sofa sat in the warehouse. Bedframe, already
  dedicated, was right to the unit on the same page (50 short, 50 lines with no
  PO). `docs/bugs/0769`.

  It was MRP catching up with the allocator, not a new rule: `isHardBoundLine`
  has named sofa bound since 2026-08-10, and on prod **zero** of 1,240 open
  company-1 sofa lines read READY without their own purchase order. Company 2
  keeps the pooled sofa model.

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
| `backend/scripts/check-mrp-so-line.mjs` | Read-only per-LINE verdict for ONE Sales Order — "why is this line not on the MRP page?". Prints each line's category (catalog vs `item_group` fallback), resolved warehouse, variant key and bucket, whether it enters demand and which rule dropped it when it does not, then replays that bucket's greedy walk (buckets allocate independently, so one bucket is exact). Trigger: Actions -> **MRP line check (read-only)** with the SO doc no. A second REPLICA of §2/§3/§6/§7 — move it with any allocation-rule change, same as the pairing detector. |
| `backend/src/scm/routes/mrp.test.ts` | Unit tests: R4 legacy pool (general + sofa), D6 flag invariance, D4 SHIPPED, D3 truncation guard, stock assignment, the `undated` tally + `parseIncludeUndated` spellings (2026-08-16), and the read wave (overlap happens, the bound holds, the plan is order-independent, a failed read still throws `mrp_load_failed`) |
| `backend/scripts/probe-mrp-roundtrip-cost.mjs` | Read-only production probe: times a sequential and a bounded-concurrent arm over the same read shapes, and asserts both read an identical row set before reporting any saving |
| `backend/scripts/probe-undated-demand.mjs` | Read-only production probe: how much live demand is undated, BOTH companies, with the refutation tests for why. Dispatch via `.github/workflows/probe-undated-demand.yml` |
| `backend/scripts/lib/undated-demand-queries.mjs` | That probe's SQL, in one home so a test can EXECUTE it. No shebang — a test imports it |
| `backend/tests-pg/probeUndatedDemandSql.pg.test.ts` | Runs every one of those queries against real Postgres in `backend-postgres`. Exists because the probe's first production dispatch died on unexecuted SQL |
| `frontend/src/pages/scm-v2/mrp-views.ts` | The page's TAB LIST, derived from `MrpResponse.categories` (§2.2). Holds the tab-id <-> category inverse pair, the SERVICE exclusion, and the Title-Case fallback for a category added to the enum at runtime |
| `frontend/src/pages/scm-v2/mrp-views.test.ts` | Reads `mfg_product_category` out of the SQL and the SKU counts out of `backend/scripts/data/align-skus-houzs-century.json` — never a typed list — and asserts every member is reachable from a tab |
| `frontend/src/pages/scm-v2/mrpCategoryTabs.test.tsx` | The same claim through the RENDERED page: the Dining tab exists, asks the server for `DINING`, and its row is on screen |

## 7b. The page's frozen header (2026-09-09) — BUILT, THEN DISARMED THE SAME DAY

> **THE FREEZE IS OFF ON THIS PAGE. `Mrp.tsx` calls
> `useFrozenTableHeader(false)`** — owner 2026-09-09, hours after it shipped:
> 「先把 MRP 的表头固定关掉」. Everything below still describes the wiring, which
> is deliberately left in place; only the arming flag changed. What went wrong is
> geometry, not integration, and the numbers are in `docs/bugs/0768`:
>
> ```
> --page-header-offset  151px      box sticks at    388px
> scroller max-height   443px      content        5,090px
> main.scrollHeight       879   === main.clientHeight   -> the page cannot scroll
> ```
>
> The design reserves the strip above the table and spends PAGE SCROLL to carry
> the composition up. On MRP the capped table is the only thing that made the
> page taller than the viewport, so capping it removed the very scroll the design
> needs: 388px reserved permanently, 443px of rows in an 879px window, ~98px of
> dead space below. **Before flipping the flag back, fix that** — give the
> composition real runway, or mark a `data-freeze-anchor` below the filter row so
> only the header strip is reserved — and measure those four numbers on the real
> page, because `docs/bugs/0753` states plainly that no test asserts the freeze
> and `#3430` was verified against a harness that had page scroll.
>
> `DataTable`'s use of the hook is untouched; every converted table still
> freezes.

Owner, 2026-09-09: "MRP 需要freeze row title" — the same rule he set on
2026-07-24 for every table ("每个table的header都要freeze"). MRP kept its own
hand-built Model -> Variant -> SO tree instead of `<DataTable>`, so it never
inherited the freeze.

The geometry was LIFTED OUT of `DataTable.tsx` into
`frontend/src/components/useFrozenTableHeader.ts` and both now drive it — a
second implementation would have had to rediscover the iterations that one
already survived (the cap must not eat the visible list, the page must still be
able to scroll the composition up to the pinned header). Read that file before
changing either surface.

What it means for this page, structurally:

- `.tableWrap` is now the bordered BOX only (`overflow: hidden`), and it carries
  the sticky offset. The scrolling moved one level in, to a new `.tableScroll`
  (`overflow-x: auto; overflow-y: auto`) — a sticky box cannot also be the
  scrollport its own sticky children resolve against. The horizontal scroll the
  wrap was added for in 2026-05-29 ("右边卡到了") lives there now.
- The sticky rule is `.stickyHead th`, on the TOP-LEVEL `<thead>` only. A bare
  `.table thead th` would also match the drilldown `.childTable`, which renders
  inside a `<td>` of this table, and float those nested headers over their own
  rows.
- The rule under the header is drawn with `box-shadow: inset 0 -2px 0`, not
  `border-bottom`: `.table` is `border-collapse: collapse`, where a sticky
  cell's collapsed border belongs to the table's border grid and stops painting
  once the cell leaves its resting place.
- A runway spacer renders at the bottom of the page while the freeze is armed.
  Capping the table's height shortens the page; the spacer gives back exactly
  the scroll that cap removed.

The freeze DISARMS itself when the rows do not overflow the cap, so a short
list keeps its plain flow and never grows an inner scrollbar.

## 8. Traps

- The engine runs in a Worker behind PostgREST: unbounded selects clip at
  ~1000 rows with NO error. Every read here is either bounded-by-codes,
  chunked (`chunkIn`), or capped-with-a-guard — but **a `.limit(N)` above the
  server's own `db-max-rows` is not a cap you can detect by counting rows
  against N.** That is precisely how the demand read came to plan over 7% of the
  data with a truncation guard sitting right underneath it (§5). A cap is only
  loud if the number it compares against is the number the server will actually
  return. Prefer `paginateAll` / `chunkIn` over a bare `.limit()` and a guard.
- **A row that is FILTERED IN must also be EMITTED with the value the filter
  used.** Whenever a field decides both "does this line count" and "where does
  this row appear", writing it twice is writing two rules. `category` did
  exactly this and cost 110 planned units of silence (§2.1, docs/bugs/0777).
  This class is worse than a crash: the page still renders, still looks
  complete, and the gap is found on delivery day.
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

## The pairing audit no longer skips a fully received PO line (2026-09-08)

`backend/scripts/audit-mrp-pairing.mjs` section (C2) compares each purchase-order
line's `item_code` with its stored sales-order line's — the only item-code
detector in the file. It iterated `poOpen`, and **`poOpen` drops a line the
moment it is FULLY RECEIVED.**

That is the state a wrong dedication does its damage in: the goods arrived, so
the customer's order reads READY against a bed that is not theirs. All nine wrong
dedications of `docs/bugs/0671` converge on it. So the detector answered *"which
OUTSTANDING lines disagree"* and printed as though it had answered *"which lines
disagree"* — `docs/bugs/0672` site 20, `docs/bugs/0684`.

It now iterates a second list, `poAll`, holding every non-dead line. **The
WAREHOUSE and VARIANT splits still count OPEN lines only** — a received line's
warehouse is history — and every shortage, bucket and pairing figure in the file
is unchanged, so the outstanding numbers stay comparable to earlier runs. The
item-code line now also prints how many of its hits are already fully received;
a zero there is a real zero for the first time.
