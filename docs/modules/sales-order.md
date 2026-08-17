> ## Corrections — 2026-08-12 code-read sweep
>
> 1. Three stale line cites, behavior verified correct at the new spots: DELETE /:docNo registers at :5987 (not :5555); cancel-final guards at :5749-5754 and :5720-5728 (not :5396); tbcSwapCommandHandler at :8982 (not :8669). 83 claims clean, including the full Processing-Date gate set, voucher settlement, relink transaction and the surcharge charging.
> 2. “mig 0121/0118” for allocated_batch_no / items.warehouse_id are the 2990 source repo's numbers; this tree's 0118/0121 are unrelated. Columns themselves proven in the schema.

# Module: Sales Order (SCM)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Per-module technical doc — the data flow from the screen down to the database,
plus the performance characteristics. First of the per-module set; the same
structure applies to PO / DO / SI / GRN (they are near-identical clones).


---

## 0. STATUS — every status a Sales Order carries, and what moves it

> Added 2026-08-16, from a source read of `main` @ `dda30c19e`, after the owner
> asked: *"I have all kinds of statuses now — available, PO raised, by convert
> and so on. When does each one change, and to what?"*

### 0.0 The confusion is real, and it is structural: ONE order carries FIVE statuses

This is the first thing to say, because every downstream question depends on it.
A Sales Order does not have "a status". It has five, they live in different
places, they are computed by different engines, and **they routinely disagree
about the same order on the same screen** — which is not a bug report, it is the
design as it stands.

| # | Name | Where it lives | Who computes it | What the operator sees it as |
|---|---|---|---|---|
| 1 | `mfg_sales_orders.status` | STORED, header column | manual PATCH + three auto writers | the header status, and the list's status **filter** |
| 2 | `mfg_sales_order_items.stock_status` | STORED, per line | `recomputeSoStockAllocation` only | the per-line READY / PENDING / PARTIAL pill |
| 3 | `stock_state` | COMPUTED per request, per line | `computeMrp` (live) | the same-looking line pill, and the "Incoming PO" cell |
| 4 | `stock_remark` | COMPUTED per request, per SO | `summariseReadiness` over #2 | the list's Stock Remark cell |
| 5 | `lifecycle_state` + `delivery_state` | COMPUTED per request, per SO | `computeSoLifecycle` (latest-event-wins) | **the status PILL** — which overrides #1 |

Two of these five pairs are the ones that actually bite:

- **#2 and #3 are different fields with confusingly similar names, and they can
  disagree on the same line.** `stock_status` is a STORED projection that is only
  correct if the last allocation sweep succeeded; `stock_state` is recomputed
  live from MRP on every request. The list rolls up #2; the drill-down renders
  #3. That is why the list and the drill-down showed different answers for one
  order. See §0.3 and §0.4.
- **#5 OVERRIDES #1 in the UI.** The pill is not the status column. See §0.6.

### 0.1 SO HEADER status — the ten values

Vocabulary and guard: `backend/src/scm/lib/so-lifecycle-guards.ts`
(`SO_STATUSES`, `SO_STATUS_RANK`, `SO_LEGAL_REGRESSIONS`,
`soStatusTransitionError`).

Ranked spine: `DRAFT(0) → CONFIRMED(1) → IN_PRODUCTION(2) → READY_TO_SHIP(3) →
SHIPPED(4) → DELIVERED(5) → INVOICED(6) → CLOSED(7)`. `CANCELLED` and `ON_HOLD`
are side states and are deliberately UNRANKED.

**There are TWO write paths to this column, and only one passes the guard.**
The guard's own header says so: the AUTO state machine writes the column
DIRECTLY and never calls `soStatusTransitionError`. So every row below names
both.

**The automatic half is smaller than the guard's comment suggests — exactly TWO
modules, writing exactly THREE values between them:**

| Module | Writes | When |
|---|---|---|
| `scm/lib/so-stock-allocation.ts` | `READY_TO_SHIP` (advance), `CONFIRMED` (regress) | stock allocation makes the SO ship-ready, or stops doing so |
| `scm/lib/so-delivery-sync.ts` | `DELIVERED` (advance), `READY_TO_SHIP` (release) | every live line becomes fully covered, or stops being (a DO is cancelled, a line shrinks) |

Both go through `advanceSoGeneration`, which stands down while a human holds the
SO's edit lease. `routes/delivery-returns.ts` is named alongside them in the
guard's comment and it IS a trigger, but it writes no status itself — it calls
`syncSoDeliveredFromDo`, one module down. Verified by grep: `delivery-returns.ts`
does not reference `mfg_sales_orders` at all.

**Nothing in this tree automatically writes `SHIPPED`, `INVOICED` or `CLOSED` on
a Sales Order.** All three are manual-only. That is worth holding next to §0.6:
the pill an operator reads says "Invoiced" off `lifecycle_state`, while the
column behind it has not moved and will not move on its own.

`so-delivery-sync`'s release target is `READY_TO_SHIP`, not `SHIPPED` — the enum
has no `PARTIALLY_DELIVERED`, and only an SO whose stored status is *exactly*
`DELIVERED` is released. INVOICED / CLOSED / ON_HOLD / CANCELLED are left to
manual control: an invoiced order is not un-delivered by a DO edit, finance
unwinds the SI first.

| Value | In the owner's words | Set MANUALLY by | Set AUTOMATICALLY by | What it blocks |
|---|---|---|---|---|
| `DRAFT` | not written yet | `PATCH /:docNo/status`; POS/scan create | — | Blocks conversion: the From-SO PO picker filters DRAFT SOs out entirely. Also the ONLY status that permits `DELETE /:docNo`. |
| `CONFIRMED` | the order is real | `PATCH /:docNo/status` (the list's "Confirm" button) | **regress** from `READY_TO_SHIP` by `recomputeSoStockAllocation` when the order stops being ship-ready | — |
| `IN_PRODUCTION` | proceeded | `PATCH /:docNo/status` — this is the transition that stamps `proceeded_at` ONCE | — | — |
| `READY_TO_SHIP` | stock is in, call the customer | `PATCH /:docNo/status` | **advance** by `recomputeSoStockAllocation` when `isShipReady` and current is `CONFIRMED` or `IN_PRODUCTION` | — |
| `SHIPPED` | goods left | `PATCH /:docNo/status` | **nothing** | — |
| `DELIVERED` | customer has it | `PATCH /:docNo/status` | `so-delivery-sync.ts` — advance, when every live line is fully covered and the current status is one of CONFIRMED / IN_PRODUCTION / READY_TO_SHIP / SHIPPED | — |
| `INVOICED` | billed | `PATCH /:docNo/status` | **nothing** | — |
| `CLOSED` | done | `PATCH /:docNo/status` | **nothing** | Terminal for MRP/allocation (`SO_TERMINAL_STATES`): the order stops being demand. |
| `CANCELLED` | killed | `PATCH /:docNo/status` | — | **FINAL.** Cannot be reactivated (`so_cancelled_final`, 409) — the deposit already became customer credit. If it also reached AutoCount, a second guard refuses first (`cancel_is_final`, 409) because the 2.2 SDK has no un-cancel. Terminal for MRP/allocation. |
| `ON_HOLD` | paused | `PATCH /:docNo/status` | — | Blocks conversion: the From-SO PO picker filters ON_HOLD out. Unranked, so it may be entered from anywhere and resumed to anywhere — **except `ON_HOLD → DRAFT`, which is refused** (409), because reaching DRAFT is what unlocks the cascading `DELETE`. |

**The transition rule, exactly.** `soStatusTransitionError` rejects only two
things: an unknown target (`invalid_status`, 400) and a backward jump that is not
on the legal list (`illegal_status_transition`, 409). Everything forward, every
idempotent no-op, every ON_HOLD pause/resume (bar `ON_HOLD → DRAFT`) and every
listed regression passes. A blank or unrecognised `from` is allowed through
deliberately — a legacy row must never be over-blocked.

`SO_LEGAL_REGRESSIONS` — the backward edges the system performs on its own:
`IN_PRODUCTION → CONFIRMED`; `READY_TO_SHIP → {CONFIRMED, IN_PRODUCTION}`;
`SHIPPED → {CONFIRMED, IN_PRODUCTION, READY_TO_SHIP}`;
`DELIVERED → {CONFIRMED, IN_PRODUCTION, READY_TO_SHIP, SHIPPED}`. The first two
groups are stock regress; the last is delivery-return re-open.

**Other refusals on the manual path**, in the order they fire, all before the
transition table: self-scoped-sales ownership (404), un-cancel guards (409),
version CAS mismatch (409 + `428` when the client sent no version at all), an
active edit lease held by another human (409), and — for `CANCELLED` only — the
downstream lock (§0.7). `DRAFT → CONFIRMED` additionally runs the confirm gate
(salesperson + venue + every line a real catalog SKU with its required variant
axes) and returns an aggregated `422 validation_failed`.

### 0.2 What the automatic advance/regress actually keys on

`recomputeSoStockAllocation` (`scm/lib/so-stock-allocation.ts`) is the only
writer of the READY_TO_SHIP ↔ CONFIRMED pair, and its gate is **`isShipReady`,
never bare `isMainReady`** — see §0.5 for why that distinction exists.

Two things gate it that are easy to miss:

- **No Processing Date, no allocation.** An SO with `proceeded_at` NULL is in
  `allocGated`: its lines still walk, but they are FORCED to `PENDING`, never
  consume a stock bucket and never claim a sofa batch. Owner's rule, 2026-08-10:
  *"有 processing date 才来分配"*. So an order with stock physically available
  will sit at PENDING / CONFIRMED until it is proceeded. This is intended, and it
  is the single most common "why is my order not READY".
- **A human editing the order defers the header, not the lines.** If the SO's
  edit lease is held, the line-level flip commits and the header transition is
  recorded in `deferredDocNos` for a later sweep. A deferral is not an error.

### 0.3 LINE `stock_status` — the STORED per-line value

Column: `scm.mfg_sales_order_items.stock_status`. **Three values**, not two:
`READY`, `PENDING`, `PARTIAL`.

| Value | Meaning | Written by |
|---|---|---|
| `PENDING` | nothing allocated (`stock_qty_ready = 0`) | `recomputeSoStockAllocation`; also the literal stamped at SO/line CREATE and by `so-revision.ts` on a new revision |
| `PARTIAL` | some of the line's qty allocated, not all | `recomputeSoStockAllocation` only |
| `READY` | fully allocated | `recomputeSoStockAllocation`; `so-delivery-sync.ts` forces READY on delivered lines; SERVICE and a few create paths stamp READY from birth |

`summariseReadiness` treats `PARTIAL` as **not ready** — `isReady` is strictly
`stock_status === 'READY'`.

> **Do not confuse this column with the delivery-planning board's field of the
> same name.** `scm/lib/so-readiness-row.ts` emits a per-ROW `stock_status` that
> is `'READY' | 'PENDING'` — TWO values, derived from `isFullyReady`. Same name,
> different object, different vocabulary. That module exists precisely because
> the board had grown a second vocabulary inline (#2320).

**The stored value goes stale. Three mechanisms, and PR #TBD (2026-08-17) closed
the third-and-a-half of them — read which.**

1. **Only FOUR call sites are durable.** `scheduleStockAllocationAfterCommand`
   writes a queue row inside the caller's PG transaction (the three TBC line
   commands + amendment approve-so). The file's own SCOPE header states the
   rest: *"THIRTY-FOUR allocation triggers … still call
   `recomputeSoStockAllocation` best-effort"* — GRN post/cancel, DO ship/cancel,
   returns, stock takes, transfers, adjustments, consignment, and eight paths in
   `mfg-sales-orders.ts` itself. **STILL TRUE.**
2. **A best-effort trigger wrote NO queue row**, so the five-minute cron's
   `drainStockAllocationRecompute` found nothing pending and returned
   `{processed:false, completed:true}`. **FIXED 2026-08-17.**
   `recomputeSoStockAllocation` now enqueues its OWN retry row whenever a sweep
   it entered did not finish, so the cron is a real repair loop for all ~38
   triggers, not a backstop for the durable four.
3. **The single-flight lock returned early and the caller discarded it.**
   The recompute claims a durable lease row; if another recompute holds it, it
   returns `{ ok: true, reason: 'another_recompute_in_progress' }` and does
   nothing. `grns.ts` posts a GRN with a bare
   `await recomputeSoStockAllocation(sb)` and never reads the result. Two GRNs
   posted close together therefore left the second one's lines stale
   **deterministically**, not just on a crash. **The return shape is unchanged**
   (the drain keys off it) — what changed is that the skip now leaves a queue row
   and sets `queuedForRetry: true`, so "nobody will retry" is no longer one of
   the things `ok: true` can mean.

**What is NOT fixed, and needs the same work it always did:** a Worker that dies
BEFORE reaching the recompute still leaves no row and no retry. Only a queue
write inside the source write's own transaction covers that, which means moving
each route onto `runScmPgCommand` — the follow-up the SCOPE header describes,
highest count first (`grns` 6, `mfg-sales-orders` 7). **Allocation is still not
durable in general.**

**What ALSO fixes a stale line, as before:** the next *successful* recompute
triggered by any of the ~38 call sites — the sweep is GLOBAL, so an unrelated SO
save, GRN or DO re-derives every line.

**And the board no longer waits for any of that.** Since 2026-08-17 the SO list's
Stock Status column does not read this stored column alone — see §0.4.

### 0.4 LINE `stock_state` — the LIVE value, and why it disagrees with `stock_status`

Computed per request in `mfg-sales-orders.ts`, in BOTH `GET /:docNo` and
`GET /:docNo/items`, from the same `computeMrp` run that produces `coverage_po`.
Values: `'stock' | 'po' | 'shortage' | null`.

| Line kind | Rule |
|---|---|
| SERVICE (`isServiceLine`) | always `'stock'` — a service carries no inventory, so it is inherently available |
| SOFA | `stock_status === 'READY' ? 'stock' : (MRP says po ? 'po' : 'shortage')` — sofa coverage is decided by the batch-aware allocator, because MRP does not know about dye lots |
| everything else | `cov?.source ?? null` — **whatever MRP says**, with no reference to the stored column at all |

**So for a non-sofa, non-service line, `stock_state` and `stock_status` are
produced by two engines that never consult each other.** They disagree whenever
the stored projection is stale (§0.3) or whenever MRP's pooled view differs from
the allocator's per-line FIFO+warehouse view.

**Until 2026-08-17 the two surfaces disagreed IN FRONT OF THE OPERATOR.** The
list rolled up the STORED value; the drill-down pill rendered the LIVE one. The
owner met the result on `2990-SO-2608-002`: the board said the mattress was short
and the line he opened to check said it was in stock. He reported it as two bugs
— "why does it show READY when the item is pending" and "why is my Stock Status
not following the rule I set". It is one: two engines, one screen.

> The words he quoted were `SHORT: MATTRESS`, which only existed inside the
> one-day #2295 window (§0.5). #2334 restored the what-IS-ready vocabulary, so
> the SAME order now shows a BLANK cell instead — still wrong, still for the
> same reason, and no longer quotable by its label. The staleness and the split
> between the two surfaces are what this section fixes; the wording was never
> the defect.

### `stock_status_effective` — the verdict BOTH surfaces answer from

`backend/src/scm/lib/so-line-effective-stock.ts`. `effectiveLineStockStatus(storedStatus,
liveState)`, a UNION:

| stored | live | effective | why |
|---|---|---|---|
| `PENDING` | `stock` | **READY** | the stale-projection case — the goods are physically there |
| `READY` | `shortage` / `po` | **READY** | the allocator knows BOUND MODE and dye-lot batches; MRP structurally cannot see either |
| `PENDING` | `po` / `shortage` | `PENDING` | an incoming PO is not stock |
| `PARTIAL` | anything but `stock` | `PARTIAL` | |
| anything | `null` | the stored value | MRP had no verdict, or `computeMrp` threw — fail-soft to the pre-2026-08-17 behaviour exactly |

Neither engine may VETO the other; a line is short only when both say so. `null`
is a REQUIRED argument, not an omitted one — a new caller has to type it and
thereby say the stored value is standing alone.

Where it is used:

- `GET /mfg-sales-orders` rolls it up into `stock_remark` / `is_main_ready` /
  `planning_state`. It costs no extra query: that handler ALREADY awaits one
  `computeMrp` (`mrpForListProm`, for the source-PO union) and `mrpLineCoverage`
  is a pure flatten of that result.
- `GET /:docNo` and `GET /:docNo/items` stamp it on every line as
  `stock_status_effective`. `stock_state` and `stock_status` both stay on the
  payload — they are the two INPUTS, and the source chips and MRP page still read
  them individually.

`frontend/src/components/SoSourceChips.tsx`'s `soLineStockPill` (and its mobile
twin `mobile/source-chips.tsx`) now PREFER `stock_status_effective`, falling back
to the client-side `stock_state === 'stock' || stock_status === 'READY'`
expression only for a payload that predates the field. The fallback is
byte-identical to the old rule; the point is that the authority moved to the
server, where the list reads it too.

### 0.5 `stock_remark`, `is_main_ready`, `is_ship_ready`

All three come out of `summariseReadiness` (`scm/lib/so-readiness.ts`).

**`stock_remark` names what IS READY** (owner ruling, confirmed against real
orders 2026-08-16). It is the warehouse's "Remark 2" vocabulary, reproduced
from AutoCount — staff read the column to know what they can PULL now.

| Value | Means |
|---|---|
| `''` | nothing is ready yet. Covers an SO with NO live lines, an SO whose only main line is short, **and an accessory-only SO whose accessory is short** |
| `'READY'` | everything that must be allocated IS. Covers an accessory-only SO with all accessories in, and a service-only SO |
| `'PARTIAL'` | every MAIN line is in, an accessory is still pending. Ship-able — accessories never block delivery |
| `'BEDFRAME'`, `'SOFA'`, `'MATTRESS'` | that category is fully in, another MAIN category is not |
| `'ACC'` | every accessory is in, MAIN is not |
| `'BEDFRAME/ACC'`, `'MATTRESS/ACC'`, … | several groups in. `/`-joined, fixed order BEDFRAME, SOFA, MATTRESS, then ACC |

Two rules the vocabulary must keep, and `soReadinessRemark.test.ts` pins both:

1. **`PARTIAL` requires a MAIN line.** It asserts "the main products are in".
   The label branch is `mainCount > 0 && isMainReady`, never bare `isMainReady`
   — that flag is VACUOUSLY TRUE at `mainCount === 0`, which is exactly how an
   accessory-only SO with one short accessory came to print `READY (PARTIAL)`
   next to a false ship gate. The owner called it 骗人.
2. **The string never contains `READY` while anything is short.** That is why
   the label is the bare word `PARTIAL` and **`READY (PARTIAL)` is RETIRED.**

**One historical window.** Between the morning of 2026-08-16 (PR #2295) and the
restore later the same day, the remark named what was MISSING — `SHORT:
MATTRESS`, `SHORT: BEDFRAME, ACCESSORY`. Nothing emits those strings now, but a
stored remark or an AutoCount export from that window can still carry one;
invert it rather than reading it as this vocabulary. AutoCount's own corpus
spells the partial state `READY (PARTIAL)`; see `docs/stock-reconciliation.md`
§2.1 for the fold.

**`is_main_ready` vs `is_ship_ready` — use the second one.**

- `is_main_ready` = every MAIN line (SOFA / BEDFRAME / MATTRESS) is READY. It is
  **VACUOUSLY TRUE when the SO has no main line at all**, which is the right
  reading for an accessory-only order and a trap everywhere else. It is kept on
  the payload only because published consumers read it.
- `is_ship_ready` = THE gate. `mainCount > 0 ? isMainReady : isFullyReady`, and
  `isFullyReady` requires at least one live line. A line-less SO is therefore
  never ship-able — which is the guard added after 16 emptied-out POS test SOs
  auto-advanced to READY_TO_SHIP on 2026-08-13/14.

Accessories do NOT block ship when the order has a main line. Service-only orders
are ready on sight (owner ruling, 2026-08-16).

**The VOCABULARY is unchanged and the INPUT moved (2026-08-17).** `summariseReadiness`
still decides the words exactly as above; on the SO list it is now fed the
effective per-line status of §0.4 instead of the raw stored column, so
`stock_remark`, `is_main_ready` and `planning_state` on a list row all describe
what the drill-down shows. The ship GATE inside `recomputeSoStockAllocation` is
NOT affected — that sweep still summarises its own freshly-computed line targets,
which is the only input it can write against.

**Where `stock_remark` is RENDERED — one component, three surfaces.**
`frontend/src/components/StockRemarkPill.tsx` owns the pill, the sort rank, the
search value and the export value. `MfgSalesOrdersListV2.tsx`,
`ConsignmentOrders.tsx` and `vendor/scm/components/DeliveryPlanningBoard.tsx` all
call it. Before 2026-08-17 those three drew the same string three ways — the
designed mint/amber pill, grey `text-ink-secondary` body text, and a third pair of
hard-coded hexes keyed off a different field — which is why a genuinely short
order read as an incidental grey note on the one screen the owner has open.

`READY` is mint; **everything else that is not blank takes the amber WARNING
pair**, and that negative branch is deliberate (#2334) — a vocabulary that grows
a new token must not be able to fall through into a neutral slot and read as
fine. Blank is an em dash. The sort is `READY` → `PARTIAL` → longer ready list →
blank, i.e. by how much of the order is IN, which is the inverse of the ordering a
what-is-MISSING label needs; #2334 had to hand-carry that inversion into
ConsignmentOrders' private copy, and this module is why the next one lands in one
place.

### 0.6 The status PILL is not the status COLUMN

`frontend/src/vendor/scm/lib/so-status.ts` → `soStatusDisplay(status,
deliveryState, lifecycleState)`. This drives the SO list and detail pill.

1. If `status` is `CANCELLED` / `CLOSED` / `ON_HOLD` → show the stored status.
2. Otherwise **`lifecycle_state` wins**: `returned` → "Delivery Return",
   `invoiced` → "Invoiced", `delivered` → "Delivered" (or "Partially Delivered"
   when `delivery_state === 'partial'`).
3. Otherwise `delivery_state` wins: `partial` → "Partially Delivered", `full` →
   "Delivered".
4. Only if none of the above applies is the stored `status` shown.

`lifecycle_state` is computed by `computeSoLifecycle`
(`scm/routes/delivery-orders-mfg.ts`) on a **latest-business-date-wins** walk of
every non-cancelled DO, SI and Delivery Return, tie-broken by `created_at` then
by a corrective priority (return > invoice > delivery). Values: `none |
delivered | invoiced | returned`.

**Consequence, and it is the likeliest source of "my statuses do not make
sense":** an order whose stored `status` is still `CONFIRMED` displays
**"Delivered"** the moment a DO exists against it. Filtering the list by status
filters the STORED column; reading the pill reads the DERIVED one. The two
legitimately disagree, and nothing on screen says which is which.

`delivery_state` on the SO detail is `totalDelivered <= 0 ? 'none' :
totalRemaining > 0 ? 'partial' : 'full'`. **This is a different field from the
Delivery Planning board's `delivery_state`** (`derivePlanningState` in
`scm/routes/delivery-planning.ts`) — a third same-named field. See
`docs/modules/delivery-order.md`.

### 0.7 What LOCKS a Sales Order, and what the operator sees

Four distinct locks. Only one of them keys off the status column.

| Lock | Keys off | Blocks | The message |
|---|---|---|---|
| **Downstream (HARD)** — `scm/lib/downstream-lock.ts` | the EXISTENCE of a live (non-CANCELLED) DO or SI, **not** any status | header/line MUTATION and CANCEL. Raising the NEXT document is deliberately still allowed | `SO has a Delivery Order / Sales Invoice — delete or cancel it first to edit` (409) |
| **Processing-date (SOFT)** — `soProcessingLocked` | `processing_date` strictly BEFORE today in MYT (UTC+8), and status not DRAFT/CANCELLED | direct edit — routes the change through the amendment flow | `Processing date has passed — this Sales Order is locked. (Locked orders are what we PO to the supplier.)` (409) |
| **PO-raised (SOFT)** — `scm/lib/so-po-lock.ts` | a live (non-CANCELLED, **DRAFT counts**) PO claims any of the SO's lines | direct edit — routes to amendment | `A Purchase Order has already been raised for this order — submit an amendment so purchasing can re-send it to the supplier.` (409) |
| **Cancel-final** | `status === 'CANCELLED'` | any move off CANCELLED | `A cancelled Sales Order cannot be reactivated…` / `cancel_is_final` when AutoCount also holds it (409) |

> **The PO-raised lock is 2990 ONLY.** `soPoLocked` returns false immediately
> unless `isMirroredDocNo(docNo)`. Houzs orders are never PO-locked — they keep
> the date-only rule. Measured before shipping: 304 live SOs carried a live PO
> while remaining directly editable, and 302 of them were Houzs orders that
> simply never had a Processing Date. Locking those in one deploy would have
> flipped a two-year backlog to amendment-only, so the owner scoped it. Do not
> read the lock's existence as covering Houzs.

Both soft locks fail CLOSED on a read error, and so does the downstream lock — an
unreadable count refuses with `downstream_check_failed` rather than being spent
as a zero.

A discard (`DELETE /:docNo`) needs MORE than `status === 'DRAFT'`: `soDiscardBlocked`
also refuses when any live downstream document exists, and when the order carries
any payment (`so_has_payments`, 409) — a real draft can carry a POS deposit.

### 0.8 The "Incoming PO" column hosts FOUR different chips, and only one has an ETA

Renderer: `frontend/src/components/SoSourceChips.tsx` — one component for the
list drill-down, the detail and the `?edit=1` editor. Precedence order, and all
four can coexist on a partially-shipped line:

| # | Chip | Source field | Dress | Carries an ETA? |
|---|---|---|---|---|
| 1 | the PO the DELIVERED goods physically came from | `shipped_source_pos` | SOLID border | **No** — it is history, it has already arrived |
| 2 | `STOCK ADJ` | `shipped_source_adj` / a `kind:'adjustment'` ready chip | its own chip | **No** — a PO-less adjustment lot has no PO and no ETA |
| 3 | the PO a READY (allocated, un-shipped) line WILL draw from | `ready_source_pos` | DASHED — a live FIFO projection, recomputed every view | **No** — the goods are already in the warehouse |
| 4 | the genuinely INCOMING PO | `coverage_po` + `coverage_eta`, shown only when `stock_state === 'po'` | DASHED, monospace | **Yes** — `· ETA <date>` |

So a chip with no date is not a missing date. It is chip 1, 2 or 3 — goods that
have already arrived (or already shipped), for which an ETA would be meaningless.
Only chip 4 is "on the way", and only chip 4 is gated on `stock_state === 'po'`,
which means **only chip 4 depends on MRP being correct** (see §0.4 and
`docs/modules/mrp.md`). Chips 1 and 3 are suppressed for a PO already shown by a
higher-precedence chip, so one PO never appears twice.

The LIST's "PO No." cell is a different cell with a different rule
(`SoListPoCell`): SOLID = a goods source, MUTED = a raised PO. See the
"LIST PO No. column" notes further down this file.

### 0.9 Where the neighbouring status systems are documented

One home each — do not restate them here.

| Subject | Guide |
|---|---|
| PO / DO / GRN / SI / PI / returns / consignment status sets, who sets each, what each blocks | `docs/modules/purchase-order.md`, `delivery-order.md`, `grn.md`, `sales-invoice.md` |
| The board's `delivery_state` and the arrangement stage — and the THREE different fields named `delivery_state` | `docs/modules/delivery-order.md` §4 |
| Whether this SO can be converted to a PO at all, and what silently drops a line | `docs/modules/purchase-order.md` |
| Which document→document conversions exist, in which direction, with multi-select | `docs/modules/document-conversion.md` |
| Why `stock_state` / `coverage_po` / the ETA chip can be wrong today | `docs/modules/mrp.md` §5 |

---

## 1. Frontend

### Screens
| Surface | File | Notes |
|---------|------|-------|
| Desktop list | `frontend/src/pages/scm-v2/MfgSalesOrdersListV2.tsx` | Renders via the shared `DataTable`. **Windowed** past 30 rows (page-scroll-preserving, PR #430). |
| Desktop detail | `frontend/src/pages/scm-v2/SalesOrderDetail*.tsx` | Bounded to one doc's lines. |
| Mobile list | `frontend/src/mobile/MobileSalesOrders.tsx` | Card list (bottom "Orders" tab). |
| Mobile new/edit | `frontend/src/mobile/MobileNewSO.tsx` | 2600-line screen, **lazy-loaded** (PR #426). |

#### Mobile New / Edit SO is ONE single scrolling form

`MobileNewSO.tsx` renders new **and** edit as one single scrolling form — the
owner rejected the 5-step wizard on 2026-07-03. Every section (Customer, Order
info, Items, Payment) stacks in a single scroll with ONE primary action at the
bottom: Save draft / Create Sales Order / Save Changes.

It is wired to the real backend on the **unchanged** contract:

| Purpose | Call |
|---|---|
| CREATE (new / edit-draft) | `POST /mfg-sales-orders` → `{ docNo }` |
| EDIT (header fields only) | `PATCH /mfg-sales-orders/:docNo` |
| ITEMS | `POST` / `PATCH` / `DELETE /mfg-sales-orders/:docNo/items` |
| PHOTOS (per line) | `POST /mfg-sales-orders/:docNo/items/:id/photos` |
| PREFILL | `GET /mfg-sales-orders/:docNo` (header + items), `GET /mfg-sales-orders/:docNo/payments` |
| PAY (slip-backed rows) | `POST /mfg-sales-orders/:docNo/payments` |
| VENUE (derived) | `GET /mfg-sales-orders/active-venue` |

The backend recomputes honest pricing and mints the `doc_no` server-side, so the
client never sends a `doc_no`, and money crosses the wire as `*_centi` integers.

**CATEGORY-AWARE LINE VARIANTS — wired to the SAME real hooks the desktop
`SoLineCard` uses, never hardcoded arrays:**

- **Fabrics** ← `useFabricColoursActive()` + `fabric_library` series via
  `useFabricLibrary()`. The Fabric picker is a SEARCHABLE modal (700+ colours),
  not a native `<select>`.
- **Sofa** — Seat height ← `maintenanceConfig.sofaSizes`; Leg height ←
  `maintenanceConfig.sofaLegHeights`.
- **Bedframe** — Gap ← `maintenanceConfig.gaps`; Divan ←
  `maintenanceConfig.divanHeights`; Leg ← `maintenanceConfig.legHeights`.
  `totalHeight` (= divan + leg + gap) is COMPUTED into the variants blob for the
  backend, but no longer shown (owner: hide it).

Per-SKU `allowed_options` (Modular ON/OFF) filter every pool via
`useModelAllowedOptionsByCode`, exactly as `SoLineCard` does. The REQUIRED axes
per category are the shared `so-variant-rule`; Save is blocked when any line is
missing a required axis.

**Sofa follower-line inherit** mirrors desktop `SoLineCard`'s
`inheritVariantsByCategory` + `overriddenKeys`: follower sofa / bedframe lines
inherit the FIRST same-category line's variants, BUT a manually-changed follower
value WINS.

#### The `?edit=1` fork, and why leaving edit must leave the URL

`/scm/sales-orders/:docNo` is ONE route (`App.tsx`). `SalesOrderDetailV2` is a
thin router on top of it: with `?edit=1` it lazy-mounts the legacy
`SalesOrderDetail.tsx` editor, without it it renders
`SalesOrderDetailV2ReadOnly`. Two visibly different pages, one address.

So edit mode is a URL, not just component state, and every exit has to clear the
param. `setIsEditing(false)` alone left the operator on the legacy ledger — a
different-looking page at the address they were already on, with no route back
to the V2 detail they pressed Edit on (owner 2026-08-10: "按 Cancel 出來不一樣的
頁面"). `cancelEdit` and a completed whole-order `saveEdit` both call
`returnToDetail()`, which navigates to the bare docNo with `replace` (V2's
`goEdit` PUSHED `?edit=1`, so replacing collapses the pair instead of making
Back walk through two detail entries).

**The amendment path deliberately does not.** `submitAmendment` ends the edit
session and STAYS, because the raised-amendment notice it needs to show lives on
the legacy component.

#### Line photos on the read-only detail

The V2 detail has a **Photos** column: `photo_urls` has ridden on
`GET /mfg-sales-orders/:docNo` (ITEM_COLS) since PR-F and was simply never
rendered, so until 2026-08-13 the only way to SEE an imported AutoCount
reference shot was to enter edit mode. Tiles are
`components/scm-v2/SoLinePhotoStrip.tsx`; clicking one opens the shared
`MediaLightbox` (prev/next, Escape, Download) against the FULL object.

Both SO photo surfaces resolve through ONE state machine,
`vendor/scm/lib/so-line-photo.ts` → `useSoLinePhoto`. Do not write a second
loader: in production `/photos/:key/signed` **cannot sign** (the R2 S3-API
credentials have never been provisioned) and answers its `mode: 'proxy'` arm
with no `signedUrl` at all, so a hand-rolled loader that reads `signedUrl`
renders a permanent loading placeholder — indistinguishable from "still
loading", which is exactly how it ships. See §"Why photos need the proxy" in
`backend/src/scm/lib/photoProxyFallback.ts`.

### The delivery address block — both directions, shared layer

State / City / Postcode on `SalesOrderNew`, `SalesOrderDetail` and
`frontend/src/mobile/MobileNewSO.tsx` do NOT hold their own cascade. All three
call `frontend/src/vendor/scm/lib/address-cascade.ts` — `useAddressCascade` for
the option pools and `pickState` / `pickCity` / `pickPostcode` for the writes —
so the desktop and mobile surfaces cannot drift, which is what happened while
each held its own copy.

The operator may start from **any** of the three: picking a Postcode back-fills
State and City, picking an unambiguous City back-fills State, and picking a
State narrows both of the others. The State back-filled by a reverse resolve is
written in the SAME `setForm` as the value that produced it — routing it through
the State picker's own handler would clear the cascade and wipe that value.

Full rules, the ambiguity contract and the surfaces that deliberately opt out:
`docs/modules/address-cascade.md`.

### Data hooks
`frontend/src/vendor/scm/lib/sales-order-queries.ts`

- `useMfgSalesOrders(status?)` — the list.
  - `queryKey: ['mfg-sales-orders', status ?? 'all']`
  - `queryFn` → `authedFetch('/mfg-sales-orders?status=…')`
  - `staleTime: 30_000`, `placeholderData: prev` (keep old rows while a tab switch loads).
- `useMfgSalesOrderDetail(docNo)` — `['mfg-sales-order-detail', docNo]`, `enabled: !!docNo`.
- Mutations (`create/patch/proceed/cancel/…`) each call
  `qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] })` on success, so the list
  reflects a write immediately (same tab) and cross-tab via the MutationCache broadcast.

#### The status CAS — `expectedStatus` comes from the CALLER, never from the cache

`useUpdateMfgSalesOrderStatus` sends `{ status, version, expectedStatus }` to
`PATCH /:docNo/status`. `expectedStatus` is the server's compare-and-set on the
status column: the route refuses with `409 so_version_conflict` when it does not
equal the row's current status. It therefore has to carry the status the operator
was LOOKING at, before the click.

It is a **REQUIRED** mutation variable (`string | null`), and that is load-bearing.
It used to be derived inside the hook by reading the detail query cache — but the
hook's own `onMutate` paints the TARGET status onto that cache, and react-query
runs `onMutate` BEFORE `mutationFn`, so the mutation read its own optimistic write
and asserted `expectedStatus === status`. Every transition off a warm detail cache
was refused on the first click; Cancel SO on the detail page could not be completed
at all, while the list buttons worked because a cold detail cache made the paint a
no-op. Making the parameter required is what enumerated the six call sites —
`tsc -b` found two in `SalesOrderDetail.tsx` that a grep had missed. Pass an
explicit `null` where a surface genuinely does not know the current status: the
status half of the CAS is then omitted and the version CAS alone guards the write.

Pinned by `frontend/src/vendor/scm/lib/sales-order-status-expected.test.tsx`. The
mobile DRAFT→CONFIRMED path (`mobile/mobile-so-concurrency.ts`) already passed the
literal `expectedStatus: 'DRAFT'` and was never affected.

#### Cancelling does not disturb doc numbering

A cancel is an UPDATE of `{ status, version, updated_at }`; `doc_no` is never
written and the row is never deleted (the only two `mfg_sales_orders.delete()`
call sites are the create rollback and the DRAFT discard route). `mintMonthlyDocNo`
reads the month through `fetchMonthlyDocNos`, whose query carries only
`.like(col, '<prefix>-%')` and **no status predicate**, then takes max+1. So a
cancelled order keeps its number, still counts toward the max, and the next order
takes the next integer — contiguous, never reused. Only a hard DELETE (discard
draft) leaves a gap, which max+1 deliberately tolerates rather than re-minting
into (see the 2026-06-12 note in `scm/lib/doc-no.ts`).

### Caching / loading behaviour (why the list opens instantly)
Three layers, tuned so the list never shows a full-load spinner on a revisit:
1. **react-query in-memory** (`lib/queryClient.ts`) — `staleTime 30s`, `gcTime 30min`.
   A warm re-visit serves cached rows instantly and revalidates in the background
   (measured: refetch=false, skeleton=false).
2. **localStorage snapshot** (`lib/query-persist.ts`, PR #437) — persists the list
   query; on a COLD open (reload / PWA reopen) it hydrates the cache at boot so the
   last-known list renders instantly, then revalidates. Verified: list rendered at
   ~81ms, revalidation fetch didn't start until ~767ms. Namespaced by `__BUILD_ID__`
   so a payload-shape change on deploy can't hydrate a stale shape.
3. **`api/cache.ts`** — 15s path-cache + in-flight dedup under `authedFetch`.

Invalidation always wins over all three (mutation → invalidate → forced refetch).

---

## 2. API surface

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/api/scm/mfg-sales-orders` | list handler | Grid rows (+ `?summary=1` lightweight bucket mode, `?status=`, `?debtor=`; `?page=` opts into the paginated contract) |
| GET | `/api/scm/mfg-sales-orders/:docNo` | detail | One SO header + lines |
| GET | `/api/scm/mfg-sales-orders/my-mtd` | MTD scoreboard | Mobile Profile tiles |
| GET | `/api/scm/mfg-sales-orders/mine` | POS board | Salesperson's own orders |
| PATCH/POST | `…/:docNo/*` | mutations | proceed / cancel / amend / payments / etc. |

All under `backend/src/scm/routes/mfg-sales-orders.ts`. Auth: inside `/api/scm/*`,
`user.id` is the caller's **scm.staff UUID** (bridge-pinned); use `houzsUser.id` for
the public bigint or you get a 500 (uuid-in-int column).

Paginated contract (`?page=`) returns `{ salesOrders, total, page, pageSize,
statusCounts, aggregates }`. `statusCounts` carries `all` plus ONE lowercase
bucket per `SO_STATUSES` vocabulary entry (draft / confirmed / in_production /
ready_to_ship / shipped / delivered / invoiced / closed / on_hold / cancelled)
plus `other` (rows whose status is outside the vocabulary — legacy spellings,
blanks), so the buckets always sum to `all`. It is computed by ONE grouped
PostgREST aggregate over the base table (JS-reduce fallback if aggregates are
disabled). `?status=OTHER` filters to exactly that catch-all bucket; every real
status stays an exact match.

### Per-line source-PO trace on the detail payload (owner rule 2026-08-01)

`GET /:docNo` and `GET /:docNo/items` stamp, per line, on top of the existing
`stock_state` / `coverage_po` / `coverage_eta` / `shipped_source_pos`:

| field | meaning |
|---|---|
| `shipped_source_adj` | the delivered goods drew (at least partly) from a PO-less stock ADJUSTMENT lot — UI shows "STOCK ADJ", never a blank |
| `ready_source_pos` | `[{ po, qty, kind: 'po'\|'adjustment' }]` — the PO(s) a READY (allocated, un-shipped) line WILL draw from: sofa = stored `allocated_batch_no` (mig 0121, now in the `ITEM` select), non-sofa = FIFO projection over the bucket's open lots in the engine's consumption order (received_at ASC, id ASC), earlier claims first, off the SAME `computeMrp` result the handler already ran |

Resolution lives in the ONE shared resolver `scm/lib/source-po-trace.ts`
(`soLineShippedSources` / `soLineReadySourcePos`) — the same lib the DO / SI /
GRN surfaces read, so all four show identical source data (owner: "在我的 SO、
DO、SI 里，应该看到的数据都是一致的"). Render side is also ONE component:
`frontend/src/components/SoSourceChips.tsx` (+ `SoStockPill`) on the list
drill-down, `SalesOrderDetailV2` (Stock + Incoming PO columns — added
2026-08-01; the page previously dropped these payload fields entirely) and the
`?edit=1` editor; mobile twins in `frontend/src/mobile/source-chips.tsx`
(`MobileSODetail` line pill + chips). Full write-up:
`docs/modules/document-traceability.md` §2.8, including the lot-batch backfill
(`backfill-lot-batch-from-docs.mjs`) and the read-only measurement
(`check-so-source-trace.mjs`).

**LIST "PO No." column (owner 2026-08-02, SURFACE CHANGE).** The list stamps
`source_po_union` + `source_po_adj` per row — the UNION of the per-line source
chips the drill shows (shipped consumed batches ∪ READY projections, pure
`unionSoLineChips` over the same two resolvers; READY suppressed on
fully-shipped lines; ONE `computeMrp` per list load). The visible chips read
THAT, because the previous content (`converted_po_nos`, the convert-time
raise-link) lied by omission: an accessories/CS SO fulfilled from stock bought
under other POs raises no PO of its own and showed "—" while its drill named
the source PO.

**LIST "PO No." column — the raised PO is a CHIP again (2026-08-11, SURFACE
CHANGE).** Demoting `converted_po_nos` to a tooltip reintroduced the same lie
from the other side. BOTH source arms need EXECUTION: the shipped arm needs a
Delivery Order line, the READY arm needs an open lot that still resolves to a
PO. A CONFIRMED order that has not shipped and whose stock is not allocated
satisfies neither, so the cell rendered "—" for documents whose own
Relationship Map names a purchase order (`HC-SO-011733` → `HC-PO-008783` →
`HC-GR-004863`). Measured on production: of the 2,723 Houzs Century SOs at
most **53** can light the source arms at all, while **277** carry a real
non-cancelled PO on `purchase_order_items.so_item_id` — so the column was
blank for ~91% of the orders that have one. A tooltip on an em-dash is not an
answer: **if a link exists, a chip must show.**

The cell now renders two chip identities, never conflated — SOLID for a goods
source (`source_po_union`), MUTED for a raised PO (`converted_po_nos`, filtered
against the source set so a PO is never chipped twice), each with its own
tooltip. It is a LIST surface, so it caps at `PO_CELL_MAX` (3) and appends a
`+N` chip whose title lists every PO — many-POs-to-one-SO is real (12 Houzs SOs
carry 2, one carries 3) and must never render only the first in silence. `—`
now means "no purchase order of any kind", which is what a reader assumes it
means. `getValue` (search / export) returns the same combined list the cell
renders.

One derivation for both surfaces: `frontend/src/lib/soPoChips.ts`
(`poCellChips` + `PO_CELL_MAX`, pure). Desktop renders it via `SoListPoCell` in
`components/SoSourceChips.tsx`; the mobile Orders card via
`SourcePosRowMobile`'s `raised` slot (`mobile/source-chips.tsx`, row omitted
when empty — card idiom, and the `+N` cap is a list-cell rule so the phone
wraps the full list instead). Render tests for both surfaces:
`frontend/src/components/SoListPoCell.test.tsx`. No backend change was needed —
`converted_po_nos` was already on the list payload.

**LINE "SPECIAL:" segment — one request prints once (2026-08-11).** The
migrated-corpus backfill (`backfill-specials-into-variants.mjs`, PRs
#1926/#1940) is deliberately MERGE-ONLY and machine-asserts that it never
removes a pre-existing entry, so `variants.specials` legitimately holds BOTH
the parser's glued phrase and the picker code derived from it — and
`buildVariantSummary` printed both (`SPECIAL: BACKCUSHIONCHANGE8030 + Change
8030 Backcushion + Wooden Arm`). The stored data is correct; the doubled
RENDERING was the defect, and it is resolved at the display layer only:
`foldRedundantSpecials` in `scm/shared/variant-summary.ts` hides an entry when
another entry in the same list is a strictly richer twin of it. Deliberately
narrow — only a SINGLE-TOKEN (machine-glued / fragmentary) entry is ever
hideable, so an operator's multi-word request can never be suppressed. Measured
on production: **216 of 1,051** lines carrying specials rendered a redundant
twin (0 emptied, 0 live picker codes lost); **26 more** carry a SEMANTIC pair
(`NOSTICHINGINSITTINGAREA` beside `No notch on Seat Cushion`) that needs the
owner's phrase ruling and is deliberately left alone — see BUG-HISTORY for why
the phrase map was NOT vendored into the runtime bundles.

### Deleting an SO — DRAFT only, and the test-order escape hatch

`DELETE /:docNo` hard-deletes a **DRAFT and nothing else** — `409 so_not_draft`
on anything CONFIRMED or later. That is deliberate: a confirmed order is
CANCELLED, a reversible audited status change that also books any deposit as
customer credit, and cancel is FINAL (no un-cancel, because the credit has no
claw-back).

**Three locks, not one (2026-08-14).** The first two live in
`backend/src/scm/lib/so-lifecycle-guards.ts` (`soDiscardBlocked`), next to the
status-transition table they depend on. `status === 'DRAFT'` is a claim about a
COLUMN, not about the document chain, and the handler used to treat the two as
the same thing. They are not, because ON_HOLD used to let a row walk backwards
into DRAFT (below). So the route also asks:

| lock | refusal | why |
|---|---|---|
| `soHasDownstream(sb, docNo)` | `409` (the lock's own payload) | The same lock CANCELLED consults. `delivery_orders.so_doc_no` / `sales_invoices.so_doc_no` are `ON DELETE SET NULL`, so a delete leaves a real DO and a real invoice pointing at nothing. |
| a row in `mfg_sales_order_payments` | `409 so_has_payments` | The cascade takes the payment ledger with it and the DO/SI that could have explained it are gone too. A real draft CAN carry a POS deposit, so this is a refusal with an instruction — void the payments, or cancel instead of discarding. Fails CLOSED: an unreadable ledger is not an empty one. |
| `version` CAS + edit lease | `428` / `409` | Unchanged. |

**ON_HOLD is not a route back to DRAFT (2026-08-14).**
`soStatusTransitionError` (`scm/lib/so-lifecycle-guards.ts`) treats ON_HOLD as unranked so an order can be paused
from anywhere and resumed to wherever the operator needs — but that was written
as an unconditional pass on BOTH edges, which made `DELIVERED > ON_HOLD > DRAFT`
legal in two ordinary PATCHes even though `DELIVERED > DRAFT` is refused on rank.
`ON_HOLD > DRAFT` now returns `409 illegal_status_transition`. Every other resume
target is unchanged: nothing legitimately resumes into "not yet written", and an
order that must go back to the beginning is cancelled and re-raised, which leaves
a document behind.

Which leaves the POS smoke-test problem: a real handover on 2990 POS mints a real
`doc_no`, a real payment and real PWP vouchers. To purge one, use
**Actions -> "Delete test SO"** (`backend/scripts/delete-test-so.mjs`). Dry-run by
default; `apply=1` also requires `confirm_doc` to repeat the doc_no. It REFUSES on
any downstream DO/SI (both FKs are `ON DELETE SET NULL`, so a delete would
silently orphan a real document), on a status past CONFIRMED, on more than one
payment, and on vouchers already in circulation.

Vouchers are the part that does not cascade: `pwp_codes.source_doc_no` /
`.redeemed_doc_no` carry **no FK** to the SO, so nothing the database does will
clean them up. Both paths now settle them explicitly — the script deletes what
the order issued and hands back with `restore_redeemed=1` what was spent on it
(`BUG-HISTORY.md` 2026-07-28); the cancel path VOIDS instead of deleting, below.

### Cancelling an SO settles its PWP vouchers

`PATCH /:docNo/status` → `CANCELLED` (`backend/src/scm/lib/so-cancel-vouchers.ts`):

| voucher | on cancel |
|---|---|
| issued BY this SO (`source_doc_no`) | `status -> VOID` — never deleted, the cancelled order still needs its record |
| earned elsewhere, spent HERE (`redeemed_doc_no`) | `status -> AVAILABLE`, redemption columns cleared — the customer's property |
| issued by this SO, already redeemed on ANOTHER order | **cancel REFUSED**, `409 pwp_voucher_redeemed_elsewhere`, naming the code + that order |
| minted AND redeemed on this same SO | `status -> VOID` (dies with the order — NOT a refusal) |

`VOID` is a new value on `pwp_codes.status` (plain `text`, no check constraint).
Every redemption gate is an allow-list (`AVAILABLE`, or `RESERVED` owned by the
caller), so `VOID` is refused by construction rather than by a new rule.

The cancel transition — and only that transition — runs inside
`runScmPgCommand`'s real transaction, because a half-applied cancel would burn a
customer's vouchers on an order that is still live. So a cancel needs
`DATABASE_URL`: without it the endpoint fails closed with
`503 scm_pg_command_required`. See `BUG-HISTORY.md` 2026-07-29.

### The downstream lock — and why AutoCount cares

An SO with any non-cancelled Delivery Order or Sales Invoice against it cannot
be cancelled and its lines cannot be edited (`soHasDownstream`, 409
`so_has_downstream`). Emitting the NEXT DO is still allowed — only mutation and
cancel are blocked.

Owner, 2026-08-10, on the AutoCount cutover:
*"已经转到下游的单据, AutoCount 不许取消/改动 ... 是的 我们也是要这样"*.
AutoCount refuses to cancel or edit a transferred document, so the ERP must
refuse the same or the two systems disagree the first time someone edits a
shipped order — with the ERP wrong, because the stock has already moved.

`soHasDownstream` used to be a private copy inside this router; it now lives in
`backend/src/scm/lib/downstream-lock.ts` with its PO / DO / GRN siblings, same
signature and same JSON, and is unit-tested for the first time. Every SO
mutation that gets past it also queues an ERP -> AutoCount edit — see
`docs/modules/autocount-writeback.md`.

### The SO line's downstream links — `so_item_id`, and what deletes it

`scm.mfg_sales_order_items.id` is referenced by **three** tables, and all three
FKs are declared `ON DELETE SET NULL`
(`backend/scripts/scm-schema/2990s-full-schema.sql`):

| Referencing column | Line | What it decides |
|---|---|---|
| `purchase_order_items.so_item_id` | `:1747` | whether a shipment can bind its incoming PO — `resolveExpectedBatchBySoItem` (`dropship-batch.ts`) resolves the expected batch through it, and since 2026-07-31 that resolution decides the binding for EVERY short ship, not only a confirmed drop-ship (see below). `recomputeSoPicked` counts `po_qty_picked` from it |
| `delivery_order_items.so_item_id` | `:1651` | which SO line a shipped unit served |
| `sales_invoice_items.so_item_id` | `:1767` | which SO line a billed unit served |

So **deleting an SO line silently unlinks every downstream document** — the rows
survive, only the link is wiped, which is exactly what makes it invisible.

- **A genuine line DELETE** (`DELETE /:docNo/items/:itemId`, and the automatic
  free-gift cleanup in `free-gift-reconcile.ts`) SHOULD null: the line is gone,
  so a link to it would be a lie. Nothing to fix there.
- **A delete-and-REINSERT must not.** `POST /:docNo/items/:itemId/tbc-swap-sofa`
  replaces a whole sofa build with a new set of module lines when a TBC fabric is
  confirmed. Since 2026-07-31 it freezes the links first
  (`snapshotSoLineLinks`), then re-points them onto the replacement lines
  (`planSoLineRelink` / `applySoLineRelink`, `backend/src/scm/lib/so-line-relink.ts`)
  inside the SAME transaction. Matching is by SKU, paired ordinally within a SKU
  by `line_no`; an old module SKU the new build does not carry is **not**
  re-pointed — that link is genuinely gone, and it is reported
  (`soLinks: { restored, dropped }` on the response, plus `sourceLinksCarried` /
  `sourceLinksDropped` on the `UPDATE_LINE` audit row) rather than lost quietly.
- The single-item `tbc-swap` (`:8669`) UPDATEs the row in place — the id
  survives, so no link is touched. Safe by construction, not by a guard.
- The SO **amendment** REMOVE (`applySoAmendment`) is a genuine removal and keeps
  nulling; its `snapshotSo` `poLinks` blob is the compensating record the
  Approve-PO gate (`reviseBoundPo`) reads to reconcile the orphaned PO line. It
  captures the PO side only — the DO / SI sides are not snapshotted there.

The 2026-07-31 measurement of the live database: **101 PO lines, only 34 carry
`so_item_id` — 67 are NULL.**

#### What the link now decides at ship time

Until 2026-07-31 `so_item_id` only mattered if the operator reached the drop-ship
dialog: a plain "Ship anyway" ignored it, so the shipment bound nothing and the
GRN could never net it. That is no longer true. A DO line that ships before its
goods arrive and resolves **exactly one live bound PO** through this column is
bound to that PO's batch automatically, and the binding is recorded per LINE in
`delivery_order_items.committed_po_batch_no` (migration 0230). The full decision
table, and what "resolves" excludes (ambiguous multi-PO, partial short, already
allocated), lives in **`docs/modules/delivery-order.md` §5**.

Two knock-on effects for anyone working on the SO:

- **The link is now load-bearing for COSTING, not just for a dialog.** A bound
  line's OUT is stamped with the incoming PO number, so its COGS lands from THAT
  batch's lot when the GRN posts. Break the link (see the `ON DELETE SET NULL`
  trap above) and the shipment silently reverts to an unbound oversell.
- **MRP ATTRIBUTES the committed units to the PO that owes them.** `mrp.ts`
  subtracts them from that PO's incoming supply and adds the same units back to
  on-hand stock (the OUT had already taken them off `inventory_balances`). Read
  that precisely: **net availability does not change and no shortage figure
  moves** — the balance arithmetic already propagated the negative correctly and
  already tagged those units `source: 'shortage'` rather than `coverage_po`. What
  changes is that the commitment stops being a nameless negative in whichever
  bucket the OUT landed in, so Stock and PO-Outstanding stop being wrong in
  opposite directions on the SKU row.
- **A sofa SET must bind ONE purchase order.** One PO IS one batch number, so if
  two modules of a set resolve two different POs the ship is refused
  (`sofa_set_po_split`) rather than stamped with two batch numbers. Point every
  module's PO line at its Source Sales Order line before shipping.

Allocation order is unchanged by any of this and is worth restating, because it
is easy to assume otherwise: MRP allocates greedily by
`line_delivery_date ?? customer_delivery_date`, then `doc_no`. An urgent order
inserted with an earlier delivery date DOES re-shuffle the allocation and DOES
take stock and PO supply ahead of a later one — the delivery date is the
mechanism. (The `priority_rank` / `priority_reason` columns exist but have zero
readers; they are not what drives this.)

### The warehouse follows the SO — where the order's warehouse actually lives

Owner, 2026-07-31: **"我们的 item 都不会有仓库, 还是跟着 SO 的"** — an item never
carries a warehouse of its own; the warehouse comes from the Sales Order.

**There is NO warehouse FK on `scm.mfg_sales_orders`.** This is the surprising
part and the reason people look in the wrong place. The header records its
warehouse as the free-text **`sales_location`**, written by `warehouseLabel()`
(`lib/warehouse-label.ts` — the warehouse CODE when there is one, else the
name), which is itself derived from `customer_state` through
`state_warehouse_mappings`. So the SO's warehouse resolves as:

```
sales_location  ->  warehouses.code / warehouses.name    (what the SO says)
customer_state  ->  state_warehouse_mappings             (how it was derived)
```

recorded value first, derivation only as a fallback. That rule lives in ONE
place — **`backend/src/scm/lib/so-warehouse.ts`** — and every reader and writer
goes through it.

`scm.mfg_sales_order_items.warehouse_id` (mig 0118) is the per-line binding MRP,
inventory balances and auto-allocation all key on. It is **nullable**, and
several paths leave it null: imported history, the amendment ADD line
(`lib/so-revision.ts`) and the auto free-gift line
(`lib/free-gift-reconcile.ts`). Both of those write paths now inherit the SO's
warehouse (fail-soft — an unresolvable header still yields null, so a missing
state mapping can never block an amendment or a gift).

**`computeMrp` resolves a null line's warehouse from the SO header** before any
bucket key, warehouse filter or label is built (`routes/mrp.ts`), so the MRP
page, the SO detail's coverage and `po-so-coverage`'s reverse map all read one
answer. Before this, `2990-SO-2607-028`'s two-module LOTTI set rendered as TWO
rows — `Mrp.tsx`'s `groupBySo` keys on `` `${warehouseId ?? WH_NONE}|${soDocNo}` ``
— and the split was in the backend's own allocation, not only on screen.


Also relevant: `apply_so_header_cas` (mig 0173) rebinds `warehouse_id` on the
order's **NULL lines only** when the header's warehouse changes, while the
approved-amendment path (`so-revision.ts`) rebinds every non-cancelled line.

#### Company 1 cannot create an order with no stock location (owner 2026-08-13, SURFACE CHANGE)


The AutoCount write-back refused both of the owner's first two test orders —
`HC-SO-2608-002` came back `refused, nothing sent (MissingLocationError)`,
because AutoCount's `FK_SODTL_Location` rejects a line whose `Location` is not
a row in `dbo.Location` and an absent key reaches it as `""`. Neither order had
a delivery address, so neither had a State, so `deriveSalesLocationFromState`
returned null and the header saved with `sales_location` NULL. The ERP was
accepting a class of order it already knew the account book would refuse, and
only saying so afterwards in an outbox row.

**The rule** (`backend/src/scm/lib/so-location-gate.ts`):

| | |
|---|---|
| gated on | the **DERIVED warehouse** (`sales_location`), never on the bare presence of a State — a State with no `state_warehouse_mappings` row derives nothing either, so "a State was picked" does not answer AutoCount's question |
| `so_state_required` | no State picked. The salesperson fixes it, on this screen |
| `so_state_unmapped` | this State has no warehouse mapped. An **admin** task — naming it separately stops the salesperson being told to pick a State they already picked |
| companies | `LOCATION_REQUIRED_COMPANY_CODES = ['HOUZS']`. Add a company by putting its `companies.code` in that array (and its twin in `so-form-validate.ts`); nothing else changes. Identified by CODE, not id — the bigint ids differ between staging and prod |
| unknown company | **not gated**, same reasoning as `processingDateThresholdFor`'s looser fallback: over-gating stops the shop floor with no signal |
| shape | one `SaveProblem` in the shared `validation_failed` + `problems[]` 422, so every SO surface renders it through the existing `humanApiError` / `SaveProblemsList` path |

**Where it runs — the invariant is "wherever we enqueue an AutoCount create, a
location exists".** The ROUTER has exactly two such places and both are gated by
`so-location-gate.ts`:

1. **Create** (`createSalesOrderCore`), on `asDraft !== true`, immediately after
   `derivedSalesLocation` is resolved and before the header insert. A refusal
   calls `rollbackPwpClaims()` first, so a rejected order burns no voucher.
2. **`DRAFT -> live`** (`PATCH /:docNo/status`), on `fromNorm === 'DRAFT' &&
   toStatus !== 'CANCELLED'` — the exact condition of the `enqueueSoCreate`
   below it. Not gated on a cancel: discarding a junk scan draft queues no
   create and must not be stranded.

**Drafts are exempt**, same as the confirm gate and for the same reason: a
draft is the scan job's guess awaiting an operator's verdict, is never written
to AutoCount, and blocking it would break the scan flow.

**There is a THIRD `enqueueSoCreate` callsite, and it is not gated by this rule
— it is safe for a different reason (corrected 2026-08-15).** This paragraph
used to end *"`soLocationGateWiring.test.ts` fails if a THIRD `enqueueSoCreate`
callsite ever appears un-gated"*, and the test's own failure message says the
same thing. Both were wider than the check: it counted `enqueueSoCreate(` inside
the imported `mfg-sales-orders.ts` and asserted `=== 2`, so a callsite in any
OTHER file was invisible to it — and one was already there.

`scm/lib/autocount-requeue.ts` (the operator re-send tool) re-queues an outbox
row that already exists, so the document has already been through a gated
create. It is also safe by a second mechanism worth knowing, because it is the
one that would hold for a legacy order created before this gate existed:
`enqueueSoCreate` itself catches `MissingLocationError` and writes a **`skipped`
outbox row** carrying the reason (`scm/lib/autocount-outbox.ts`) rather than
sending a create AutoCount would refuse.

So the repo-wide sentence is *"every enqueue has a settled location, by one of
two mechanisms"*; *"the gate covers every enqueue"* is true only of the router.
The test now walks `backend/src` and fails on any callsite that is neither the
router nor a named exception carrying its mechanism — and on a named exception
whose file has stopped calling it, which would otherwise sit there as a promise
about nothing.

**Frontend twins (change together).** The rule is `soStockLocationError` in the
shared `frontend/src/vendor/scm/lib/so-form-validate.ts`, called by all four
create surfaces — `SalesOrderNew`, `MobileNewSO` (create only; an EDIT enqueues
an AutoCount *edit*, which leaves the book's own Location alone),
`SalesOrderNewGuided` and `SalesOrderNewFromProducts` (both inert — both land a
DRAFT, wired so they are gated automatically if that ever changes).

The same file exports `companyRequiresStockLocation(companyCode)`, the twin of
the backend predicate, for a surface that needs the QUESTION rather than the
guard. One caller, below.

> **`SalesOrderNewFromProducts` lands a DRAFT under a location-gated company**
> (owner-approved 2026-08-13, SURFACE CHANGE). That flow collects no address by
> design ("address is added on the SO detail after save"), so under company 1 a
> CONFIRMED create can never resolve a warehouse — between #2112 and this, the
> page could not raise an order at all (BUG-HISTORY). It now lands a draft for
> exactly the companies in `LOCATION_REQUIRED_COMPANY_CODES`, read through
> `companyRequiresStockLocation` so the scope is never re-derived: **company 2
> (2990) and every uncovered company keep landing CONFIRMED.** A draft is never
> written to AutoCount, so it owes no Location; the address is added on the SO
> detail and the `DRAFT -> live` transition re-runs the same gate there. The
> gate is deferred to the screen that can satisfy it, not bypassed. The page
> header and the Create CTA ("Save draft SO") say which outcome the operator is
> about to get. Pinned in `so-form-validate.test.ts`.

**Historical backfill for the header-unresolvable lines (2026-08-01, gated).**
Part `so-warehouse` on `backend/scripts/repair-2990-doc-refs.mjs` (workflow
**Repair 2990 doc references**) stamps `warehouse_id` on the lines the read
path can NEVER resolve — NULL warehouse AND a header where both
`sales_location` and `customer_state` resolve nothing (the
check-backfillable-gaps section-1 hard core; 24 lines on the 2026-08-01 run).
Document-evidence order, single-valued or refused: the line's own DO OUT
movement (where the goods physically left), else **unanimous** sibling
agreement, else the company's single active warehouse. The sibling arm does
NOT breach the callout above: the callout guards against pooling across a
warehouse boundary, and an SO whose every warehoused line names ONE warehouse
has no boundary to pool across — disagreeing siblings refuse, and the
single-warehouse fallback must not rescue them. Company-2990 rows are
mirror-maintained (`so-mirror.ts` drains DELETE-then-INSERT per SO, wiping
local stamps), so they verdict `mirror-source` — reported with the exact stamp
for the 2990 SOURCE database, never written here. Rule:
`classifySoLineWarehouse`, `backend/scripts/lib/doc-evidence-core.mjs`.

**Historical backfill for the MIGRATED AutoCount lines (2026-08-11, applied).**
A different population and a different rule. `import-ac-outstanding-so.mjs`
resolved every imported line's warehouse and then left `warehouse_id` out of its
INSERT column list, so all 13,881 migrated lines carried the AutoCount location
as free TEXT and a NULL `warehouse_id` — every one of them in the `WH_NONE`
bucket, unable to allocate, with sofa failing one step earlier because
`findCoveringBatch` returns null on a null warehouse before it looks at stock.
The column-list bug itself was fixed in #1848.

`backend/scripts/backfill-so-line-warehouse.mjs` (workflow **Backfill SO line
warehouse (migrated orders)**) filled them; all 13,907 migrated lines now carry
a warehouse. **The evidence rule is AutoCount, not the line's own text.** The
`location` text is the importer's transcription — the same script's output — so
each line is re-read from the committed AutoCount export by its own
`linked_ac_dtlkey` -> `DtlKey` (header `SalesLocation` only as a named fallback)
and filled ONLY where AutoCount independently reports the same location.
`CONFLICT`, no-evidence and unresolvable-location lines are left NULL and listed:
a null surfaces as a pending line, a guessed warehouse sends staff to an empty
shelf. The apply writes an explicit id list, never a `WHERE location = ...`
predicate, so the refused set cannot be swept back in.

Audited after the fact against AutoCount: 7,800 lines agree on the exact
`DtlKey`, 6,037 on the header, 70 have no AutoCount row (documents absent from
the outstanding-only export), and **0 are miswarehoused**. Verify with
**Stock criterion census (read-only)** — `check-stock-criterion.mjs`, section A.
That script, and the rest of the cutover/go-live audit family, could not run at
all between mig 0286 (2026-08-13) and 2026-08-14: they queried the column the
rename retired, and 42703 fails the whole statement. Fixed and gated — see the
`.mjs` audits row in "The surfaces that read this date by NAME" below.

### Processing-Date save gates (aggregated `validation_failed`)

Setting or changing the Processing Date (`scm.mfg_sales_orders.processing_date`
— one column, and since mig **0286** one NAME: the UI label, the API field
`processingDate` and the column are the same word. It was `internal_expected_dd`,
and an older dead column squatted on `processing_date` until 0189 dropped it; two paragraphs used to stand here, one written before
the rename and one after, each naming a different column — that is what a stale
guide does) runs
EVERY gate and reports all failures at once (`so-save-problems.ts` →
`{ error: 'validation_failed', problems: [...] }`, HTTP 422; rendered by the
shared `SaveProblemsList`/`humanApiError` on desktop + mobile):

| Gate | Code | Rule |
|------|------|------|
| Variants complete | `variants_incomplete` | every non-cancelled line's category-mandatory axes filled (`so-variant-rule`), **minus the by-SKU exemptions below** |
| Colour KIV | `fabric_colour_kiv` | **no line may still be colour-KIV** (series committed via `fabricId`/`fabricLabel`, no `fabricCode` — `isColourKiv` in `variant-summary.ts`). Owner rule 2026-07-24 after SO-2607-016: a Processing Date means every line is a fully-confirmed maintained selection. Fires only when the date is genuinely SET or CHANGED — unrelated edits to an old KIV order, and clearing the date, never block. Also enforced on line-ADD / line-EDIT against an already-dated SO (409). |
| Deposit, PER COMPANY | `processing_date_unpaid` | **Houzs 30%, 2990 50%** of the order total collected (`processingDateThresholdFor` in `order-rules`). Until 2026-07-31 the split existed only in a comment and both constants applied to everyone, so a 2990 order was refused at the Houzs 30%. An unknown/absent company code falls back to the LOOSER 30% on purpose — over-gating stops the shop floor with no signal. |
| Customer + delivery complete | `processing_date_incomplete` | customer name, delivery address line 1, postcode, delivery date. **No email** (owner 2026-07-31: "不需要email"). Added 2026-07-31 when the Processing Date and Proceed gates were unified — this half used to apply only to Proceed. (A 2026-07-31 impact measurement over the then-live dated SOs found none blocked by the four kept fields. The figures are not restated here: nothing in the repo re-measures them, and they predate the 0286 rename, so they are a record of that day rather than a current claim.) |
| Date sanity | `processing_date_past` / `delivery_date_past` / `processing_after_delivery` | no fresh past dates (unchanged past dates grandfathered); processing ≤ delivery |

### The by-SKU variant exemptions

Some SKUs physically cannot carry an axis, and demanding it reports a defect no
source can fix. Three exemptions, all keyed on the ITEM CODE, all in
`backend/src/scm/shared/so-variant-rule.ts`:

| Exemption | Matches | Drops | Owner |
|---|---|---|---|
| `isDivanOnly` | `\bDIVAN\s*ONLY\b` anywhere in the code | `gap` | 2026-08-09, *"divan only 不需要 gap"* — a divan sold without a mattress has no mattress gap |
| `isDivanlessFrame` | `ADJUSTABLE`, `(S+S)` / `(SS+S)`, `DOUBLE DECKER` / `DACKER`, `DDB` | `divanHeight`, `legHeight`, `gap` | 2026-08-10, *"电动床/抽拉床…像 DIVAN ONLY 一样豁免 — 要"* — no divan base at all |
| `isSeatlessPiece` | `^(CONSOLE\|CT)\b` on the **compartment** (after the first hyphen) | `seatHeight` | 2026-08-11, *"有些 sku 是没有的"*; AutoCount PO-009553 leaves the console box blank while both seat boxes carry a figure |

**`itemCode` is a REQUIRED parameter of `missingVariantAxes` /
`missingConfirmVariantAxes` and must stay required.** It is what decides these
exemptions; optional means every caller that says nothing keeps the old
behaviour with no compile error, which is how the DIVAN ONLY carve-out came to
apply on one of three confirm-path call sites after a PR claiming "every desktop
+ mobile call site". Pass an explicit `null` where a caller genuinely has no code
— nothing is exempted then. See **BUG CLASS optional-param-noop** in
`BUG-HISTORY.md`.

**There are FOUR implementations and only one of them is authoritative.** The
TypeScript rule; its byte-for-byte vendored twin
`frontend/src/vendor/shared/so-variant-rule.ts`; and the plain-JS mirror
`backend/scripts/lib/variant-axes.mjs`, which exists because a `.mjs` audit
script cannot import TypeScript. `backend/tests/variantAxesMirror.test.ts` pins
the mirror against the source — **and a mirror test is only as wide as its
corpus**: `isSeatlessPiece` lived in the mirror and not in the rule for three
days while that test passed, because its code list had no CONSOLE or CT case. It
now carries them, plus near-misses (`CONSOLE-1A`, `CT-2A`, `8030-CTRL`,
`8030-CONSOLIDATED`) that must NOT be exempt.

**No audit script may re-type any of this.** Import from
`scripts/lib/variant-axes.mjs`. `backend/tests/variantExemptionCallSites.test.ts`
fails a script that types an exemption pattern, one that judges completeness
without importing the mirror, or a call that passes only two arguments — the
shape that silently applies no exemption at all. Five scripts are covered:
`check-so-noncatalog-lines`, `cross-fill-so-po-variants`,
`check-cutover-metrics`, `check-po-so-completeness`,
`check-sofa-bedframe-completeness`.

Related short-circuit gates: remove-date is super-admin only
(`processing_date_remove_forbidden`), and the processing-date LOCK once the day
elapses (`so-field-policy`). POS "Proceed" stamps `proceeded_at` only — it never
writes `processing_date`.

### Both dates or neither — `processing_delivery_must_pair`

*"processing date 和 delivery date 必须同时有或者同时没有"* (owner, restated
2026-08-13). One predicate, `soDatePairRefusal` in
`backend/src/scm/shared/so-processing-date.ts`, and **every server write path
that can set or clear either date calls it**. It is not a UI rule: the client
guard (`so-form-validate.ts` `soDateGuardError`) still runs first for the
message, but nothing depends on it.

| Write path | File | Response |
|---|---|---|
| SO create | `routes/mfg-sales-orders.ts` (`createSalesOrderCore`) | 400 `processing_delivery_must_pair` |
| SO header PATCH | `routes/mfg-sales-orders.ts` | 400, and the aggregated 422 report re-states it |
| SO `/status` → IN_PRODUCTION (proceed writes the date) | `routes/mfg-sales-orders.ts` | 400 |
| SO amendment SUBMIT | `routes/mfg-sales-orders.ts` | 400 `amendment_dates_xor` |
| SO amendment APPROVE | `routes/so-amendments.ts` | 409 `amendment_dates_pair_stale` |
| CO create | `routes/consignment-orders.ts` | 400 |
| CO header PATCH | `routes/consignment-orders.ts` | 400 |
| aggregated save report (both directions) | `shared/so-save-problems.ts` | 422 problem |
| repair script | `scripts/unify-processing-date.mjs` | refuses the transaction |

**GRANDFATHERED, and that is part of the rule.** Live orders are honestly
unpaired — imported AutoCount history has no delivery date for some — so a save
that leaves BOTH dates exactly as it found them still succeeds. Only a save that
CHANGES a date is judged. `backend/scripts/probe-so-date-xor.mjs` counts the
offenders per company.

**CLEARING ONE CLEARS BOTH, one direction only.** Clearing the Processing Date
(already super-admin-only) also clears the Delivery Date — on the header AND, via
`p_apply_delivery_date`, on every `line_delivery_date`, or MRP keeps ordering by
a line date the header no longer holds. The reverse is a REFUSAL, not a cascade:
clearing the delivery date alone would have to clear the Processing Date, which
is exactly the write `scm.so.remove_processing_date` guards.

**The one deliberate exclusion is the 2990 mirror** (`routes/so-mirror.ts`). It
replicates rows 2990 already committed; a non-2xx keeps the row PENDING in
2990's outbox and its pg_cron drainer retries forever, so one legacy unpaired
company-2 order would wedge the queue behind it. The rule for company 2 belongs
in 2990's own write paths. The route says so in a comment, and
`tests/soDatePairWiring.test.ts` asserts the comment is still there.

The enumeration is a TEST, not prose: `tests/soDatePairWiring.test.ts` anchors on
each path's source and fails if one stops calling the predicate. That file exists
because the rule was previously hand-written in five places and simply missing
from three — and every unit test over the logic passed the whole time.

**ONE gate, one name (owner 2026-07-31).** *"不要又 Processing Date,又 Proceed,
全系统直接统一一个叫 Processing Date... Processing Date 就是当天 Proceed 的意思。"*
`meetsProceedGate` in `order-rules` states the rule behind ALL of it: setting
`processing_date`, the create's auto-proceed, and both manual proceed paths
(`PATCH /:docNo/status` → IN_PRODUCTION and `PATCH /:docNo` `proceededAt`).
**It is not the single FUNCTION behind all of it** — setting the date is
enforced separately in `so-save-problems.ts`, which never calls it; see *WHAT
WAS UNIFIED IS THE RULE, NOT THE FUNCTION* below before editing either. Net
effect of the unification: the proceed paths LOOSENED by one condition (email),
the processing-date path TIGHTENED by four (name / address / postcode / delivery
date), and the threshold became per-company. The money half is one predicate,
`meetsDepositGate` — the Proceed gate and the aggregated report above both read
it, so they cannot come to different verdicts about the same deposit.

**PROCEED IS THE DATE (owner, pinned 2026-08-13).** *"只要有 Processing Date，就
代表他 Proceed 了。Proceed 的日期是他填入 Processing Date 的日期。没有 processing
date 就代表没有 proceed。"* Proceeding therefore WRITES `processing_date`; it
does not stamp a click time. Until 2026-08-13 every proceed path wrote only
`proceeded_at`, so an order could sit IN_PRODUCTION with no start date — and
production queues by that date.

| Path | Where the date comes from |
|------|---------------------------|
| `PATCH /:docNo/status` → IN_PRODUCTION | the order's own `processing_date`, else the `internalExpectedDd` REQUEST KEY (the payload name is unchanged — only the column was renamed, and a payload rename would break every deployed client); a date written here clears the FULL gate table above **and the pair rule**, read live off the row |
| `PATCH /:docNo` `proceededAt` | this patch's `internalExpectedDd`, else the stored one |
| CREATE auto-proceed | `internalExpectedDd` on the create — no date means the order is created UN-proceeded, never refused |
| `PATCH /:docNo/status` → IN_PRODUCTION | the order's own `processing_date`, else `internalExpectedDd` on the request body (which the route now accepts); a date written here clears the FULL gate table above, read live off the row |
| `PATCH /:docNo` `proceededAt` | this patch's `processingDate`, else the stored one |
| CREATE auto-proceed | `processingDate` on the create — no date means the order is created UN-proceeded, never refused |

> **RESOLVED 2026-08-14 — the table above now describes what the route does.**
> It did not for a day, and the story is worth keeping. Mig `0286` applied on
> prod at 2026-08-13T13:46:59Z (Deploy run `31705868668`, `backend` job:
> `APPLIED 0286_scm_processing_date_one_name.sql (6 statements)`), so the old
> column was gone while SIX literals in
> `backend/src/scm/routes/mfg-sales-orders.ts` still named it — left behind when
> PR #2121 hand-resolved a 13-branch batch merge (`git log -S` on the SELECT
> string names `d33ac743`). Every one of them failed SILENTLY:
>
> | literal | what it did | now |
> |---|---|---|
> | `.select('proceeded_at, internal_expected_dd, …')` | PostgREST 42703 fails the WHOLE query; the error is discarded (`const { data: cur }`), so `curRow` was `null` and every gate below evaluated against nulls | selects `SO_PROCESSING_DATE_COLUMN` |
> | the row type declaring `internal_expected_dd` | agreed with the dead SELECT, so nothing type-complained | `processing_date` |
> | `stored: curRow?.internal_expected_dd` | always `null` | reads the constant |
> | `patch.internal_expected_dd = resolved.date` | wrote a column that does not exist | writes the constant |
> | `effOf('internal_expected_dd')` | the camel→snake map is `['processingDate','processing_date']`, so this key could NEVER exist — the header PATCH proceed path returned 422 `PROCEED_NEEDS_DATE` unconditionally | reads the constant |
> | `body.internalExpectedDd` on create | no live client sends that key (`SalesOrderNew.tsx`, `MobileNewSO.tsx`, `SalesOrderNewFromProducts.tsx` and this route's own INSERT all send `processingDate`), so `autoProceed` was **always false** — an order created WITH a Processing Date was created un-proceeded, the exact inverse of the owner's pinned rule | `readSoProcessingDateFromBody`, which takes the canonical key and still accepts the legacy one |
>
> **The lesson, and it is the reason this box stays.** Not one of the six was a
> typo — they were all correct code the day before, and a `RENAME COLUMN` made
> them wrong without touching them. A column name in a string, and a payload key
> read off a `Record`, are both invisible to `tsc`. That is precisely what
> `backend/src/scm/shared/so-processing-date.ts` exists for, and the fix is to
> read the name FROM it: `SO_PROCESSING_DATE_COLUMN`,
> `readSoProcessingDateFromBody`, `canonicaliseSoHeaderChanges`.
> `backend/tests/soDatePairWiring.test.ts` now fails on any live mention of the
> old name, so the next rename cannot go half-done in silence.

No path guesses a date: a proceed with none returns 422
`proceed_needs_processing_date` (`PROCEED_NEEDS_DATE` in `order-rules`), because
a guessed start date is a real order sitting in the factory queue on the wrong
day with nothing to show it was guessed. A date already on the order is never
MOVED by a proceed — rescheduling belongs to the header PATCH, which owns the
lock and the gate table. `proceeded_at` is still written and still read (the
stock allocator sorts by it), but it is no longer what makes an order proceeded.
Net effect: the proceed paths LOOSENED by one condition (email), the
processing-date path TIGHTENED by four (name / address / postcode / delivery
date), and the threshold became per-company.

**WHAT WAS UNIFIED IS THE RULE, NOT THE FUNCTION — there are TWO enforcement
sites, and changing one does not change the other.** This paragraph read
"`meetsProceedGate` is the single rule behind ALL of it" until 2026-08-13, and
that is not what the code does:

| path | enforced by |
|---|---|
| create-time auto-stamp of `proceeded_at`, and both manual proceed paths (`PATCH /:docNo/status` → IN_PRODUCTION and `PATCH /:docNo` `proceededAt`) | `meetsProceedGate` (`order-rules.ts:71`), called at `mfg-sales-orders.ts:624` and `:5110` — its ONLY two call sites |
| setting the processing date | `so-save-problems.ts` — the four completeness checks written out INLINE, plus `meetsDepositGate` for the money (imported at `:20`, called at `:187`). It contains **zero** references to `meetsProceedGate` |

Both sites read the same per-company threshold through the shared
`processingDateThresholdFor` and demand the same four facts, so the rule is one
rule TODAY. It is one rule by agreement, not by construction — edit either and
re-check the other. Believing the two shared a function is how a rule change
would land on half the system.

> A note on the money predicate, because the name is a trap: there is no
> `meetsProcessingDatePaymentGate` any more. `order-rules.ts:82-87` records it
> as one of the two functions that were COLLAPSED into `meetsDepositGate` on
> 2026-07-31 — *"a second copy could only ever drift into a second threshold,
> which is exactly what happened"*. In SOURCE, that comment is the only place
> the old name still appears; everything else is `BUG-HISTORY.md`.

**And then the STORAGE too (owner 2026-08-13).** *"把 internal expected date、
processing date 和 process date 都直接整合变成一个"* — PR #2077 / #2079 moved
519 company-1 orders out of `proceeded_at` into the SO's own Processing-Date
column; both companies reported zero split **when measured on 2026-08-13**. Mig
`0286` then renamed that column `internal_expected_dd` → `processing_date` on
`scm.mfg_sales_orders` and on the consignment twin. **`proceeded_at` is NOT being retired**, and this paragraph said it was
("stop-writing / stop-reading ahead of a drop, not a second fact") — which
also contradicted the registry row below. It is a live, separate column on
`scm.mfg_sales_orders`: `lib/so-stock-allocation.ts` selects and GATES on it,
`routes/mfg-sales-orders.ts` maps `proceededAt → proceeded_at`, and
`routes/delivery-planning.ts` selects it. Only the CONSIGNMENT twin was
dropped (mig 0284), because that one had zero readers and zero writers.

#### The client-side address marks — all three surfaces now say the same thing (2026-08-13)

The delivery address is **optional by default** (name + phone are the only
required customer fields). A **PROCESSING DATE makes it required**: that date is
the proceed signal, and a proceeding order has to be deliverable. Owner, in his
own words: *"只要是 proceed 的单，它都必须填；如果没有 proceed，就不需要必填。
就是 processing date。电话、电脑都一样的."*

Before 2026-08-13 the three surfaces disagreed:

| Surface | Rule it applied | Effect |
|---|---|---|
| Server (`so-save-problems.ts`, since 2026-07-31) | `if (facts.procDate && facts.completeness)` — required on `procDate` alone, and it demands the DELIVERY DATE in the same breath | the authority |
| `MobileNewSO.tsx` | `procDate && delivDate` (owner 2026-07-03) | a Processing Date with no Delivery Date showed **no required-field marks**, then the save was refused |
| `SalesOrderNew.tsx` (desktop) | no rule at all | a blank address (or "Fill in address later" still ticked, which BLANKS the address out of the payload) produced a bare `validation_failed` from the round trip with no idea which field |

The mobile `AND` was not merely stricter or looser — it **disagreed with the
server**. All three now key on the Processing Date alone, and the desktop page
names the missing fields (customer name, address line 1, postcode, delivery
date) before it sends, with an explicit hint to untick "Fill in address later".

#### The surfaces that read this date by NAME, not by binding

Everything below reads the Processing Date through a **string** — a select list,
a `Record<string, unknown>` lookup, a stored jsonb key, an inbound mirror
payload. They matter because they all fail the same way when the name moves: no
error, no type failure, just a value that stops arriving. The one place the name
lives is **`backend/src/scm/shared/so-processing-date.ts`**; these are bound to
it, and the removal condition for each legacy alias is written there.

| Surface | What a rename does to it | Bound? |
|---|---|---|
| `routes/so-mirror.ts` → `lib/mirror-map.applyMap` | 2990 is a SEPARATE repo on its own deploy schedule and keeps POSTing the old column. `applyMap` filters against the dest table's `information_schema` and DROPS an unknown key: no error, 200 returned, the date never arrives on any company-2 SO. | `aliasCols`, guarded on both sides (old name gone from dest AND new name present), so it is a no-op until the rename lands |
| `lib/autocount-outbox.SO_HEADER_COLS` | A string select list. PostgREST answers a missing column with 42703 and fails the WHOLE query; `noteReadFailure` records a `skipped` outbox row and the operator's save succeeds regardless — quiet, not loud. | interpolated from the constant (one template literal + `as const`; supabase-js needs a literal type) |
| `lib/autocount-outbox.soEditHeader` | Reads its header off a bare `Record`, so NOT type-checked. A stale literal reads `undefined` → `acUdfDate` null → the omit-when-absent rule fires → `UDF.PDate` is never sent and the AutoCount book keeps the old date. | keyed on the constant |
| `services/autocount-writeback.AcSoHeader` / `composeCreateSo` | The header is passed `as never` at the call site, so only the field name inside the type is checking anything. | computed property key from the constant |
| `scm.so_amendments.header_changes` (jsonb) | The heaviest one. Written at REQUEST time, read at APPROVE time — days later, across deploys. `applySoAmendment` `continue`s on a key the allow-list lacks, and `routes/so-amendments.ts` gates on the same literal. A pending amendment would approve cleanly, audit cleanly, skip the deposit gate, and write nothing. | `canonicaliseSoHeaderChanges` on both read sites |
| `backend/scripts/scale-pg-real-schema.mjs` + `tests/scaleRouteDrift.test.mjs` | A hard-coded column list `deepEqual`'d against the route's `HEADER`. **Loud** — it is the tripwire, and it is meant to fail. Note it also appends `, proceeded_at, paid_total_centi, balance_centi_live` as its own literal, so retiring `proceeded_at` needs an edit here too. | left loud on purpose |
| The `.mjs` audits under `backend/scripts` — the cutover / go-live / reconciliation / completeness family, plus `backfill-so-dates.mjs` and `probe-rename-preconditions.mjs` | Raw SQL, so 42703 kills the WHOLE statement: the audit does not narrow, it stops. Twelve of them were still naming `internal_expected_dd` after 0286 — see BUG-HISTORY 2026-08-14. `backfill-so-dates.mjs` is the one that WRITES: its "a person touched this date, refuse" scan matches audit-log TEXT, so it needs the retired spellings AND the current ones. | `SO_PROCESSING_DATE_COLUMN` from `backend/scripts/lib/so-processing-date.mjs` — the .mjs mirror, since a script cannot import the `.ts`. `tests/soProcessingDateMirror.test.ts` pins the two together; `tests/soProcessingDateOneName.test.mjs` walks the directory and fails on any non-comment mention of the retired name |
| `frontend/src/vendor/scm/lib/so-field-policy.test.ts` | Parses the backend policy table out of the file by regex on **quoted literals**. Loud (row-for-row equality), but it constrains HOW a rename may be written: the policy rows must keep string literals, so do not replace them with a constant. | n/a — a constraint, not a fix |
| `so_processing_date` (derived API field) | Stamped onto SI / DO list rows by `routes/sales-invoices.ts:688` and `routes/delivery-orders-mfg.ts:2889`, then read as a string by three frontends (`SalesInvoicesListV2:99`, `MfgDeliveryOrdersListV2:88`, and `MobileModuleList:1147,1198`'s `pick(r, "soProcessingDate", "so_processing_date")`). A backend-only rename blanks a "Processing" column with no error. Rename BOTH ends or neither. | not bound — see BUG-HISTORY 2026-08-13. **Corrected 2026-08-14:** this row said `so_internal_expected_dd` / `soInternalExpectedDd` until today; both ends moved to `so_processing_date` with the rename and the register did not. |
| `SalesOrderDetailListing.tsx:433` `opt(r, 'processing_date')` | An untyped string accessor over the flattened header; a miss renders `—`. The grid `key` is `processing_date` and is a SAVED LAYOUT key — do not rename that, users' stored layouts reference it. | not bound. **Corrected 2026-08-14:** this row said the accessor read `internal_expected_dd`; on `origin/main` `0c2a4e88` all three reads at `:433-435` are `processing_date`. |

### Column registry — every date in this DB that looks like a Processing Date

**Read this before binding any UI field, writing any query, or "unifying"
anything.** Owner, 2026-08-13, after saying it more than three times: *"你确保你的
process（就是整套系统）里，把 internal expected date、processing date 和 process
date 都直接整合变成一个，不要再搞多个了。因为每一次讨论到 processing date 的时候，
你就有各种各样的 bug，原因就是因为你有太多个了。这三个 date 其实都是指向同一个东西。"*

The DATA was unified on 2026-08-13 (519 company-1 orders migrated out of
`proceeded_at`; both companies reported zero split **as measured that day**).
The trap that survived was the NAMES — one concept answering to several column
names, so the next reader picked the wrong one. Mig **`0286`** then settled the
name itself: `internal_expected_dd` → `processing_date` on both tables. This
table is the whole answer.

> **CORRECTED 2026-08-14.** Until today the two rows below named
> `internal_expected_dd` as "the only storage this concept has. Use this one",
> and the closing rule said *"it is `internal_expected_dd`, full stop"* — the
> retired name, in the one table written to stop the next reader picking the
> wrong column. The registry was authored in #2106 on a branch that predated the
> rename branch, and PR #2121 merged both in one squash without re-reading it.
> The five stale call sites recorded in the CORRECTION box above are exactly a
> reader following this table.

| Column | What it actually is | Status |
|--------|--------------------|--------|
| `scm.mfg_sales_orders.processing_date` | **THE Processing Date.** The SO's one user-picked date, behind the UI label "Processing Date". Named `internal_expected_dd` until mig 0286 (2026-08-13). | **The only storage this concept has. Use this one** — via `SO_PROCESSING_DATE_COLUMN` in `backend/src/scm/shared/so-processing-date.ts:41`, never a hand-typed literal. In a `.mjs` script, which cannot import TypeScript, via the pinned mirror `backend/scripts/lib/so-processing-date.mjs`. |
| `scm.consignment_sales_orders.processing_date` | The same concept for a Consignment Order. CO create + PATCH read/write only this. Renamed by the same mig 0286. | Live, correct. |
| `scm.mfg_sales_orders.proceeded_at` | **A different fact:** the TIMESTAMP the system stamps when the order is Proceeded — not a date a user picks. `recomputeSoStockAllocation` gates on it (NULL ⇒ every line forced PENDING). | Live. Stays a separate column ON PURPOSE. What was unified with the Processing Date is the RULE (`meetsProceedGate`), never the storage. |
| `scm.mfg_sales_orders.processing_date` **(the OLD one, 2025–2026-08)** | Dead legacy snapshot that squatted on this name. Had no writer after PR #140, so it was NULL on every SO created/edited since — and rendered blank wherever someone bound to it (BUG-HISTORY: "SO read views showed a blank Processing date"). | **DROPPED — mig 0189.** The name was then free, which is why 0286 could take it. Do not confuse this dead column with the live one in row 1. |
| `scm.consignment_sales_orders.proceeded_at` | Never anything. Existed only because the consignment module was cloned from `mfg_sales_orders` wholesale; on this table it had zero readers and zero writers, ever. | **DROPPED — mig 0284** (`0284_retire_consignment_proceeded_at.sql`). |
| `scm.consignment_sales_orders.processing_date` **(the OLD one, mig 0153)** | Same clone artifact. Zero writers ever (the create INSERT omits it; the header PATCH builds its update from a closed allowlist that never contained it), so it was NULL on every row. | **DROPPED — mig 0286, step 1.** No longer a follow-up: 0286 had to clear this dead name before it could rename the live column onto it, and its guard drops it only while BOTH names are present, so a re-run cannot take the users' dates. |
| `public.sales_orders.ac_udf_pdate` | AutoCount's own UDF field `SO.UDF_PDate`, mirrored verbatim by `services/pull.ts` for AutoCount's document. Never the ERP's date; nothing joins the two. Read by nothing. | **RENAMED → `ac_udf_pdate`, mig 0285.** Kept (not dropped) because the mirror's job is to be a faithful local copy for AutoCount reconciliation — the harm was the name, not the data. |
| `public.sales_entries.processing_date` | The LEGACY NATIVE Sales module's own date (`/sales`, `Sales.tsx`, mig 070). A `sales_entry` is a **different document**: no SO row, no doc flow, and none of the SO machinery — no deposit gate, no KIV/variant gate, no elapsed-date lock, no `scm.so.remove_processing_date`, no stock allocation. | **KEPT under this name, deliberately.** A rename is UNSAFE: `applyEntryPatch` builds `SET ${k} = ?` from allowlisted keys, and the change-request approval path replays a JSON payload stored days earlier — after a rename those stored keys match nothing and the field is **silently dropped on approve**, with no error. Documented at both ends instead (`routes/sales.ts`, `Sales.tsx`). **Do not coalesce or merge it with the SO's date.** |

Two rules follow from the table. **Never add a ninth name** — if you need the
SO's Processing Date, it is `scm.mfg_sales_orders.processing_date`, read through
`SO_PROCESSING_DATE_COLUMN`, full stop. A column name inside a string is
invisible to the compiler: the `/status` proceed block kept selecting, comparing
and WRITING `internal_expected_dd` after the rename, and nothing failed to
build. **Never unify
across documents** — `sales_entries` and AutoCount's mirror share a *word*, not a
concept, and merging them would destroy real distinctions.

### Every line is a catalog SKU — free text never saves (owner rule 2026-08-08)


**The rule.** Every SO line names a REAL catalog SKU (`scm.mfg_products`,
company-scoped — see "Looking a product up by CODE" below). Typed text that
matches nothing can never become a row. Enforced at TWO layers:

**Insert layer** (every path that writes `mfg_sales_order_items` rows —
create / add-line / PATCH code change / tbc-swaps / amendment submit+apply;
the free-gift and delivery-fee writers already draw their codes FROM the
catalog; the 2990 mirror is a verbatim historical copy and is exempt):

| shape | verdict |
|---|---|
| non-blank code not in the company catalog | `409 unknown_item_code` (`validateItemCodes`) |
| non-blank code, INACTIVE, on a NEW pick (create / add-line / a PATCH that CHANGES the code / amendment ADD) | `409 unknown_item_code` with `inactive` — the picker only offers ACTIVE, so an INACTIVE arrival did not come from the UI. An UNCHANGED code on a line edit stays existence-only, so discontinued-SKU history remains editable |
| blank code + typed description (the square-pillow shape) | `409 so_free_text_line` — refused on EVERY create, draft or not |
| blank code + blank description | the scan pipeline's "Pick a product…" placeholder — allowed on DRAFT creates ONLY; the confirm gate below stops it there |

**Confirm gate** (`lib/so-confirm-gate.ts`) — runs on DRAFT→CONFIRMED
(`PATCH /:docNo/status`) and on every create that lands directly CONFIRMED
(`asDraft !== true`, i.e. desktop New SO / mobile wizard / POS handover /
from-products). Aggregated `validation_failed` + `problems[]` (HTTP 422, the
same contract as the Processing-Date gates), all reasons at once:

| problem | rule |
|---|---|
| `so_line_no_product` / `so_line_not_catalog` | every non-cancelled line resolves in the SO's own company catalog |
| `salesperson_required` | `salesperson_id` OR the legacy `agent` text set (HC-SO-2607-008 confirmed as "Unassigned") |
| `venue_required` | `venue` text OR `venue_id` set (owner: *"venue is compulsory的"*). No venue-less order class exists in code — venue-binding's "empty is honest" rule governs AUTO-resolution only; when it resolves nothing, confirm demands a human pick |

> **CORRECTED 2026-08-14 — the confirm gate no longer checks variants.** This
> table carried a fourth row, `variants_incomplete`, "every goods line's required
> axes via `missingConfirmVariantAxes`". Commit `16d94ab4` (#2072, 2026-08-13)
> removed it from all three surfaces: *"so-confirm-gate no longer reads variants
> at all: the field is off `SoConfirmLineFacts`, off the row type, and out of the
> SELECT."* Re-verified 2026-08-15: `backend/src/scm/lib/so-confirm-gate.ts`
> carries `/* NO VARIANT CHECK HERE … Variant completeness is the PROCEED rule
> (so-variant-check.ts, gated on the Processing Date), not the confirm rule. */`
> immediately before its `return out`, and `missingConfirmVariantAxes` still has
> ZERO production callers — only its two definitions (backend + the frontend
> mirror) and tests:
>
> ```bash
> grep -n 'NO VARIANT CHECK' backend/src/scm/lib/so-confirm-gate.ts
> grep -rn missingConfirmVariantAxes backend/src frontend/src | grep -v '\.test\.'
> ```
>
> *(This said `so-confirm-gate.ts:118-120` until 2026-08-15. The comment had
> moved to 141 and 118-120 is a different block entirely — the file is long
> enough that the reference stayed WITHIN range, so nothing mechanical could
> catch it: a line number that resolves is not a line number that is right. Cite
> a symbol, or the command that finds it.)*
>
> **Variant completeness is a Processing-Date gate only** — see the
> Processing-Date gate table above. The owner's ruling, 2026-08-13:
> *"只要是没有 proceed 这一张订单，其实都不一定是需要填写的。"* Re-adding it here
> is what blocked salespeople from booking real orders with real deposits for
> five days.
>
> `missingConfirmVariantAxes` had **zero production callers** when that was
> written — its two definitions and four test files, nothing else. **Resolved
> 2026-08-14:** the two false source comments it left behind (its own docblock
> claiming "desktop, mobile and the backend confirm gate all read THIS", and
> `frontend/src/vendor/shared/so-variant-rule.test.ts`'s header saying the same)
> are corrected, and it has ONE consumer again — the audit mirror
> `backend/scripts/lib/variant-axes.mjs`, so
> `check-so-noncatalog-lines.mjs`'s "confirmable?" section judges by the rule
> instead of by a hand-typed fifth copy of it.

**Who may write which key of the `variants` jsonb.** The column has several
writers and no schema, so ownership is by convention and the convention is
enforced in code:

| keys | owner |
|---|---|
| `fabricId` / `colourId` / `fabricCode` / `colourLabel` / `fabricLabel` / `gap` / `divanHeight` / `legHeight` / `totalHeight` / `size` | the AutoCount re-parse sweeps — `OWNED_VARIANT_KEYS` in `backend/scripts/lib/variant-merge.mjs` |
| `specials` (and the HOOKKA singular `special`) | `backend/scripts/backfill-specials-into-variants.mjs`, the only writer with the money guard — a picked add-on's surcharge folds into the authoritative unit price, so stamping a PRICED code reprices a historical document |
| everything else (POS configurator, line editors) | its own writer |

**HYDRAULIC is a tickable code, and it does NOT replace `divanHeight`**
(owner 2026-08-11, *"开 special order 那边勾选"* — this overrode the earlier
recommendation that a hydraulic base stay a property of the divan and never
become a `special_addons` row). The two are **complementary, not alternatives**:

- the **tick** (`variants.specials` gains `Hydraulic`) records *what the bed is*;
- **`variants.divanHeight`** records *how big it is*, and `parse-bedframe.mjs`
  derives it from the very same hydraulic wording (outer figure wins, an
  inner-only figure converts at +2 — owner's ruling 2026-08-10).

45 of the 49 lines that say HYDRAULIC carry both and must keep carrying both;
dropping the height in favour of the tick would discard a measurement someone
took. (The count disagrees with this section's own later figures — 49 lines
minus the 3 with no `divanHeight` is 46, which is also what the re-run below
reports. 45 vs 46 is UNVERIFIED as of 2026-08-13: settling it needs production
data, not the tree.) The chain — slip Desc2 to parser phrase to picker code, *and* the height
surviving — is pinned end-to-end in `backend/tests/parseBedframeHydraulic.test.ts`.
The code is created **at price 0** (`seed-hydraulic-special-addon.mjs`); the
owner sets the price when he is ready, and it must stay 0 while the 49 migrated
lines are being stamped.

Categories on a `special_addons` row must be **UPPERCASE** — both pickers filter
with `a.categories.includes(category.toUpperCase())`
(`SoLineCard.tsx` and `mobile/MobileNewSO.tsx`), so a lowercase token yields a
row the backfill can map to and no human can ever tick.

**What actually landed in production, 2026-08-11.** The `Hydraulic` row was
created by `seed-hydraulic-special-addon.mjs` (run **31454564942**) at
`sell=0 cost=0`, `categories=BEDFRAME`, `active=true`, read back on a fresh
connection. The stamp ran through `backfill-specials-into-variants.mjs` with
`SKIP_PRICED=1` (run **31454747001**): **SO 41 + PO 8 = 49 lines**, with **27
unrelated lines held back** for carrying a priced code. Every money column was
summed inside the transaction before and after — `unit_price_centi`,
`total_centi`, `unit_cost_centi`, `line_cost_centi`, `special_order_price_sen`,
`divan_price_sen`, `leg_price_sen` — all **IDENTICAL**, and the transaction
would have rolled back on any difference. A fresh read-only re-run
(**31454827796**) shows every one of the 49 now carrying the code, no line still
waiting to gain it, and `divanHeight` intact on the 46 that had one.

**The 3 lines with NO `divanHeight`** — the tick is the only thing the ERP knows
about these beds, so a human must read the slip. No height was inferred:

| doc | item | AutoCount Desc2 |
|---|---|---|
| `HC-SO-012403` | `BEDFRAME KIV` | `LVL 1 QUEEN HYDRAULIC` |
| `HC-SO-013122` | `BEDFRAME KIV` | `LVL1 HYDRAULIC KING` |
| `HC-SO-012039` | `HILTON (A)-(Q)` | `hydraulic` |

Two are `BEDFRAME KIV` placeholders whose Desc2 names no measurement at all; the
third is a real HILTON line whose entire Desc2 is the word `hydraulic`.

A sweep MERGES its patch (`variants = variants || patch`) and never rebuilds the
object; rebuilding deletes every key it has not heard of. `custom_specials` is a
DERIVED output of the pricing recompute (`mfg-pricing-recompute.ts:90`), which is
why picker codes belong in `variants.specials` and not there — but it is **not**
script-free: `backfill-sofa-special-orders.mjs:132` and
`apply-variant-patch.mjs:56,:82` both write the column (union / `COALESCE`, never
wholesale replace, DRY-RUN by default). Anything written there is still liable to
be rewritten by the next recompute.

Drafts stay freely saveable — the scan pipeline still lands imperfect drafts;
what changed is that they can no longer BECOME orders until resolved.
ON_HOLD-resume and reopen re-enter CONFIRMED without re-gating (legacy orders
must not strand).

**Frontend twins (change together).** Desktop `SoLineCard` marks unmatched
typed text with a red ring + "Not in the catalog" note (the text stays for
correction; the parent save guards refuse the line). `SalesOrderNew` + `MobileNewSO` pre-check venue / salesperson on Create, and
Save-as-draft skips both. **Neither pre-checks variants at CONFIRM** — that
sentence used to read "pre-check variants (confirm rule, KIV-exempt)" and was
wrong three ways: `SalesOrderNew.tsx` has no variant pre-check at all, and
`MobileNewSO.tsx:1778` calls `missingVariantAxes` — the PROCEED rule, which is
KIV-*blocking*, not KIV-exempt — behind `if (!asDraft && procDate)`, i.e. gated
on the Processing Date, not on Create-confirm. Both call sites pass
`l.itemCode` as the required third argument. The mobile headless
scan-draft path (`createDraftFromPrefill` → `buildItemBody`) sends an
UNPICKED line's description as '' (the desktop clean-placeholder rule,
2026-07-13) — it used to send the raw slip text, which is exactly how the
square pillow saved. `MobileSODetail`'s Create Sales Order and the desktop
DRAFT banner / list Confirm surface the refusal list via the existing
`humanApiError` problems rendering.

**A DRAFT never carries a Processing Date** (owner 2026-08-08 addendum,
2990-SO-2608-007 — `processing_date` equal to its SO date). The only
silent stamper was the backend scan job (`buildDraftSoBodyFromSlip`'s
2026-07-04 "slip delivery date ⇒ pin processing to today" rule, now
superseded): scan drafts land with BOTH dates null, and the operator keys the
pair at review (the create core's both-or-none pairing rule forbids carrying
the slip's delivery date alone; the mobile headless scan draft was already
dateless). The desktop Save-as-Draft's visible Processing Date FIELD is an
explicit operator entry and still saves. Confirm deliberately stamps NO
processing date: setting one is its own gated act (deposit threshold,
variants, KIV, customer completeness, delivery-date pairing) and an
auto-stamp at confirm would bypass every one of those gates. The
processing-date LOCK was verified to ignore DRAFTs on both ends
(`soProcessingLocked` / `procLockActive` both short-circuit on status DRAFT,
and every backend caller passes `status`), so a stamped draft misleads — it
does not lock.


**Existing damage** (pre-guard rows): Actions → **SO non-catalog lines check
(read-only)** (`backend/scripts/check-so-noncatalog-lines.mjs`) lists every
non-catalog line, confirmed order without salesperson / venue, confirmed
line with incomplete variants, and DRAFT carrying a Processing Date — with a
TEST? hint for the "Jalan Test" batch. Deliberately NO auto-repair: each row
needs a human to pick the right SKU / salesperson / venue / dates.

### The salesperson is stamped TWICE — `salesperson_id` and `agent`

`salesperson_id` (a `scm.staff` uuid) is the ERP's real attribution: scope,
commission, the Fair Report and the SO PDF all read it. `agent` is the legacy
free-text NAME beside it, and it is the ONLY field the AutoCount write-back
sends as the Sales Agent.

**They are now written together.** `soAgentToStamp` (`scm/lib/so-agent.ts`)
fills `agent` from the stamped salesperson's `scm.staff.name` whenever the
caller does not supply one, at all three create sites — the header, the goods
lines and the SERVICE lines — and the header PATCH moves it when the
salesperson is reassigned. An explicitly supplied `body.agent` still wins
everywhere; a blank one is not a supplied one.

Until 2026-08-13 nothing wrote `agent` except `body.agent`, which **no SO form
sends**, so it was empty on every order created since the cutover — and the live
AutoCount book refused each one with `FK_SO_SalesAgent` on go-live day. The SO
detail page hid it: `salespersonNameOf(agent, salesperson_id)` falls back to the
id, so a name appeared on screen with nothing behind it.

`docs/modules/autocount-writeback.md` §7n has the write-back half — how the two
columns resolve to one Agent, and why a create with neither is refused rather
than sent.

### Selling-price authoring — who may set the line price

The unit selling price is **operator-authored** and the trust gate is by SESSION,
not role (Owner ruling, `mfg-sales-orders.ts` `isPosTabletCaller`):
- **POS-tablet session** (`origin='pos'`, minted at `/api/pos/pin-login`): the
  server recomputes the authoritative catalog price and **drift-rejects (400)** a
  deviating client price — the anti-tamper non-negotiable. (Empty until the 2990
  POS repoints here.)
- **The SSO session is NOT a POS session** (Owner ruling 2026-08-16). `POST
  /api/pos/exchange-web-session` — the token behind
  `erp.houzscentury.com/#sso=<token>`, i.e. the "open this in Houzs" button on
  the tablet — mints an **origin-less** session. Between 2026-08-14 and this
  ruling it carried `origin='pos'` forward, and the salesperson who came through
  that door could not change a delivery-fee line from 250 to 125 in the ERP: 422
  `so_total_below_original`. Owner: 「为什么我们要跟着 POS 的规矩?进了这个
  ERP 就跟这个 ERP 的规矩。在我们 ERP 里编辑,金额就必须能改。」 So the gate
  below binds **the POS app** — requests made with the token the PIN door issued
  — and not the tablet, the device or the person. Anyone who can pass the PIN
  gate can obtain an ERP session and price freely; that is the accepted cost of
  the ruling, and the per-line audit trail (actorId / actorName on every SO line
  mutation) is what remains. `scm.so.price_override` is the permission key that
  could carry this as policy instead, if the owner later wants a narrower hinge.
- **Every other session** (desktop web ERP, mobile, invite, TOTP): **not POS →
  never drift-rejected.** Owner ruling 2026-07: a salesperson may hand-type the
  price. `recomputeFromSnapshot(..., trustOperatorSelling=true)` — passed on the
  create / add-line / patch paths as `!isPosTabletCaller` — persists the operator's
  entered price instead of normalising a catalog line to `sell_price_sen` (client
  0 = "not provided" still fills the catalog price). COST stays a server snapshot.
- **Frontend gate**: `SoLineCard` / `MobileNewSO` `canEditPrice = isAdminLevel ||
  isHatchSales`; the Houzs bridge (`vendor/scm/lib/auth.ts`) now returns
  `isHatchSales` true for `sales` (+ `super_admin`), so the price input is editable
  for salespersons on both surfaces.

### The payment slip is OPTIONAL on every SO path (owner ruling 2026-08-13, SURFACE CHANGE)

> Owner, verbatim: *"其实 SalesOrder 所有的付款都不强制 … 如果我们用 OCR scan
> 的话,它就可以直接进。那如果是 manually 填写的话,基本上不需要强求."*

A slip is proof, not a precondition. SAVED mode dropped the requirement on
2026-07-13; the NEW-SO (create) path kept it as "spec D4 — one slip per
payment" until 2026-08-13. It is now gone from every surface.

| where | before | now |
|---|---|---|
| `POST /:docNo/payments` (SAVED) | optional since 2026-07-13 | unchanged |
| SO create `payments[]` zod | `uploadSessionId: z.string().min(1)` | `.min(1).optional().nullable()` — `''` still rejected, because an empty string is a client forgetting to omit the field |
| SO create slip resolution | every row resolved or `400 slip_required` | rows that CLAIM a session resolve or 400; a row with none books `slip_key: null` |
| desktop / mobile save guard | shared `soSliplessPaymentError` blocked the save | **the function is deleted**, not neutered |
| `PaymentsTable` draft row | `<SlipUploadField required>` — red "Slip *" | `required={false}`; no callsite sets it any more |
| mobile PayCard copy | per-row "Planned — …" + "Each payment needs a slip to be recorded" | "A slip is optional — attach one here, or add it later" |

**The half that is NOT about the guard, and is the part that can lose money.**
Both create surfaces used to POST only the payment rows that carried a slip, so
the guard was the only thing standing between a cashier and a row that silently
never booked (BUG-HISTORY: *"Mobile silently dropped a slip-less SO payment"*).
Removing the guard alone would have re-created that bug on both surfaces. Both
writers now filter on the AMOUNT and nothing else — `recordNewPayments`
(mobile, renamed from `recordSlipBackedPayments`) and `flushPaymentDrafts` /
`paymentIntents` (desktop). **A guard removal and a writer filter are one
change; `so-slip-optional-contract.test.ts` fails if either half moves alone.**

`pendingDepositCenti` moved with them on both surfaces. It is GATE-ONLY money
(never booked) that tells the create what the client is about to post, and it
used to be filtered on the slip session. Left alone, a slip-less deposit would
count as RM0 against a Processing Date — the exact deadlock the field exists to
close, with the money plainly on screen.

**What a `slip_required` 400 still means.** Three sites remain and none of them
says "a payment needs a slip": a *claimed* session that does not resolve
(create, and `POST /:docNo/payments` inside `if (p.uploadSessionId)`), two
payments claiming one session, and `POST /:docNo/payments/:id/slip`, where a
slip **is** the request. Absent is fine; wrong is not — an id that resolves to
nothing would book a payment whose proof points nowhere.

Rule + schema: `backend/src/scm/lib/so-create-payment-slips.ts` (pure;
`soCreatePaymentsSchema` + `planCreatePaymentSlips`, the route keeps the
`pending_slip_uploads` read). Tests: `so-create-payment-slips.test.ts` (rule),
`soCreateSlipOptionalWiring.test.ts` (the route is wired to it),
`so-slip-optional-contract.test.ts` (both frontends).

**The OCR path is untouched.** A Scan-Order receipt was never a per-payment
slip session: it rides the create body as `receiptImageKey`, lands on the header
as `receipt_image_key`, and becomes the single-deposit row's `slip_key`
(`slipKey ?? receiptImageKey`). `paymentIntents()` still excludes the
receipt-backed draft so it is not booked twice, and the seeded draft still
carries the key. What changed for that path is only that it no longer needs to
be an *exemption* from anything.

### Delivery fee — every ringgit is a line (owner ruling 2026-08-07)


**One derivation, one write path.** The fee amount is owned by the pure
`computeSoDeliveryFee` (`scm/shared/pricing.ts` — the base is
`delivery_fee_config.base_fee` for the SO's company, whole-MYR ×100 → sen: the
familiar RM250), decomposed into line specs by `buildDeliveryFeeServiceLines`
(`scm/shared/service-lines.ts` — Σ lines === fee.total by construction), and
written by exactly one primitive: the atomic RPC
`scm.rebuild_mfg_so_delivery_lines` (migration **0214**: per-doc advisory xact
lock, delete → insert → header stamp in one call — the duplicate-fee race fix).

**Path inventory — how each SO-producing path satisfies the ruling:**

| path | fee? | how the line is guaranteed |
|---|---|---|
| **POS handover create** (`applyDeliveryFee` — the ONLY sender of a fee at create) | yes | `createSalesOrderCore`: `computeSoDeliveryFee` → `buildDeliveryFeeServiceLines` specs pushed into the SAME item insert as the goods; header fee dual-written equal to Σ(specs); a failed item insert deletes the whole header — the fee and its lines land together or not at all |
| **Desktop New SO / mobile New-SO wizard** | no | neither sends `applyDeliveryFee`; fee = 0, no line needed, header 0 |
| **Scan/OCR draft → create** (`buildDraftSoBodyFromSlip` / shell) | no | never sets `applyDeliveryFee`; the draft lands fee-less — an operator later triggering a fee does so through edits, which derive below |
| **Every line add / patch / delete** | re-derive | `rederiveDeliveryFee` → `recomputeDeliveryFeeCore` → 0214 RPC (stored cross-category source passed through) |
| **Customer change** | re-derive | `redetectCrossCategoryDelivery` → same core (re-runs the auto-match) |
| **Amendment apply** | re-derive | `applySoAmendment` → `rederiveDeliveryFee` |
| **2990 mirror import** (pre-cutover history) | verbatim copy | whatever shape 2990 held — the one path that could legitimately leave a header-only fee; those rows are exactly what the detector lists and the repair itemises |

**The bail rule (the 2990-SO-2608-006 fix).** `recomputeDeliveryFeeCore` bails
(derives nothing) only when the SO has **no `SVC-DELIVERY*` lines AND no header
`delivery_fee_centi`** — the dormant-fee rule: backend-authored SOs never grow
a fee. It used to bail on "no fee lines" alone, which was half of a back door
AND a heal-blocker: deleting/cancelling the fee line orphaned the header
snapshot, the derivation turned itself off forever (a fee-line-less SO could
NEVER be healed by any recompute, no matter how many edits followed), and
`recomputeTotals`' legacy line-less fallback kept folding the snapshot into
the total — 006 read subtotal RM0 / total RM250 with no line saying why. Now
an orphaned header fee is **re-materialised as lines through the same
derivation** on the next edit — the recompute no longer depends on a fee line
already existing; deleting a derived fee line is therefore a no-op — the way
to change the fee is to change what drives it (the items, the rate config, or
the `SVC-DELIVERY-ADD` operator line).

**The legacy fallback.** `recomputeTotals` still reads the header fee back for
a line-less SO — that exists ONLY for legacy (pre-P2 / mirror-imported) rows
and may not be deleted until Loo retires the column (SO-SKU spec §5 P6).
Integrity tooling: `backend/scripts/check-so-fee-line-integrity.mjs` (read-only
detector: every non-cancelled SO where total ≠ Σ(lines), with audit-log
evidence) + `repair-so-fee-line-integrity.mjs` (DRY-RUN gated; materialises the
missing line via the same 0214 RPC — total never changes, only itemises), both
behind the **SO fee-line integrity check (read-only)** workflow. Tests:
`backend/tests/soDeliveryFeeLineIntegrity.test.ts`.

### Looking a product up by CODE — always pass the company

`mfg_products.code` is **not unique**. Both companies keep their own SKU master,
so one code can name two different products: on 2026-08-01 seventeen did —
`CODY` / `FENRIR` / `JAGER` × `(K)(Q)(S)(SK)(SS)` plus two mattress codes — HOUZS's
manufacturing row (cost columns, NULL `sell_price_sen`) and 2990's selling row
(`sell_price_sen` + `pwp_price_sen`). Both are legitimate; neither can be renamed.

Every by-code read on the order path therefore takes a `companyId`:

| helper | file |
|---|---|
| `loadProductByCode` / `loadProductsByCodes` | `scm/lib/mfg-pricing-recompute.ts` |
| `loadModelSofaModulePrices` / `…Costs` / `…CostRows` | `scm/lib/mfg-pricing-recompute.ts` |
| `loadProductAndModel` / `loadProductsAndModels` | `scm/lib/allowed-options-check.ts` |
| `validateItemCodes` | `scm/lib/validate-item-codes.ts` |
| `findServiceLineCodes` | `scm/lib/service-line-guard.ts` |
| `findSofaLinesWithoutCompleteBatch` / `detectSofaSoItemIds` / `findIncompleteSofaSets` | `scm/lib/sofa-batch-guard.ts` |
| `snapshotUnitCostSen`, GRN + PI landed-charge CBM, delivery-planning / delivery-zones category maps, `scan-so`'s OCR catalogue | in their route files |

**`base_model` is a partial key too.** It is plain text on the same per-company
table, so the three sofa module loaders merge both companies' SKUs when
unscoped — and because their result is a module→price map keyed by module
suffix, the other company's module *replaces* this one's rather than competing
with it. Every non-`id` predicate on `mfg_products` (`code`, `base_model`,
`sku_code`, `barcode`) is a partial key; only `id` and a UUID `model_id` stand
alone.

**Two reads stay unscoped on purpose**, and say so inline:
`so-stock-allocation.ts` (recomputes every SO across both companies, 34 callers,
no request context) and `resolveDoSofaBatchMap` (reached only from
context-free inventory-cost helpers). Both use the catalogue solely to classify
a code as SOFA / SERVICE, i.e. a union across companies — correct while the two
rows agree on category, so `so-stock-allocation` logs a disagreement rather than
silently choosing.

Callers pass `activeCompanyId(c)` — or, inside `createSalesOrderCore` (which has a
`SoCreateContext`, not a Hono `Context`), its local `companyId`. `null`/`undefined`
degrades to no predicate, matching `validateSoDropdownFields` and
`loadFabricTierAddonConfig`, so a single-company install, a headless job and the
unit tests read exactly as before. Migration **0233** adds
`UNIQUE (company_id, code)` so the scoped `.maybeSingle()` is single by
construction.

**These move together or not at all.** Scope the pricing read but not
`validateItemCodes` and a foreign code passes validation, then prices at 0 and
dies as `pricing_drift`; scope neither and the SO path can price a line off the
other company's row — which is how an order came to be refused with
*"this SKU has no PWP price set (SKU Master)"* while the SKU Master, which **is**
company-scoped, showed RM 490 for that SKU. Tests:
`scm/lib/product-lookup-company-scope.test.ts`.

**Since 2026-08-13 the two GATES take the company as a REQUIRED argument** —
`validateItemCodes` and `findServiceLineCodes`. The degrade rule above still
holds (`null` means no predicate) but it can no longer be reached by SAYING
NOTHING: a refusal gate that is silently unscoped does not fail loudly, it
admits the other company's SKU, and "these move together" was an instruction no
compiler was enforcing. The pricing LOADERS keep `companyId?` and the documented
degrade — they are reads, not gates. See **BUG CLASS optional-param-noop** in
`BUG-HISTORY.md`.

---

## 3. Backend (list handler)

`backend/src/scm/routes/mfg-sales-orders.ts` — `mfgSalesOrders.get('/')`.

Flow:
1. **Scope** — `resolveSalesScopeIds()` → allowed salesperson ids (SELF + manager
   downline, or all for directors / `scm.so.view_all`). Feeds the main query's `.in()`.
2. **Main query** — reads the VIEW `mfg_sales_orders_with_payment_totals` (so the
   Balance column is live = total − Σpayments), `order by so_date desc limit 500`.
   ⚠️ **VIEW-TRAP** (`backend/docs/scm-view-trap-coe.md`): the view's column set is frozen at
   CREATE VIEW; a base-table column added to `HEADER` that the view lacks 500s the
   whole page. Post-view columns (delivery_state, amended_delivery_date) are read
   separately off the base table.
3. **Enrichment wave (PERF, PR #416)** — 6 independent per-doc_no reads run
   **concurrently** (was serial ~390ms desktop / 650ms mobile → ~40ms warm):
   payment-method summary, downstream DO/SI lock, deliverable-remaining, lifecycle +
   current-doc, warehouse labels, base-table planning cols. Only the item→catalog
   chain is sequential (catalog needs the item codes). Pattern: launch each as an
   immediately-invoked async thunk, await at its use-site.
4. **Assemble** — per-row flags (stock readiness, planning state, branding pill,
   payment-methods, has_children lock) merged onto the rows, returned as
   `{ salesOrders: [...] }`.

   Branding truth lives in `scm.mfg_products.branding` (stamped onto lines by
   `derive-line-branding.ts`; `product_models` feeds `generate-skus`). Owner
   2026-08-08: HC sofa = **Zanotti**, 2990 sofa = 2990's own brand; drifted
   'Houzs'/blank rows are repaired by **HC sofa branding fix (Zanotti)**
   (`fix-hc-sofa-branding.mjs`, DRY-RUN gated, #1723).

`?summary=1` skips the view join + item read entirely (dashboard only needs status
buckets) — do not fully-hydrate 500 rows for a count.

---

## 4. Database

Schema: `scm` (vendored 2990 clone, 108 tables). Key tables:

| Table | Role |
|-------|------|
| `scm.mfg_sales_orders` | SO header (doc_no PK-ish, status, salesperson_id, totals in sen, so_date, delivery_state, amended_delivery_date, company_id) |
| `scm.mfg_sales_order_items` | SO lines (item_group, stock_status, variants, warehouse_id) |
| `scm.mfg_sales_order_payments` | payments ledger (so_doc_no FK, method, online_type) |
| VIEW `scm.mfg_sales_orders_with_payment_totals` | header + `paid_total_centi` + `balance_centi_live` (Σ over payments) — the list reads this |

Indexes that matter here:
- `idx_msop_doc` on `mfg_sales_order_payments(so_doc_no)` — the payment-totals view's
  aggregation (already present; not the bottleneck).
- mig **0104** — trigram GIN on `mfg_products(description,barcode)` + partial
  `(category) WHERE status='ACTIVE'` (feeds the SO line item picker's search).
- FIFO / stock movement handled by scm PL/pgSQL functions (12 fns + 2 triggers,
  `search_path=scm` pinned) — a doc "proceed" moves stock via these.

Stock/inventory rules: DO=out, DR/GR=in, PR=out; one ledger + FIFO lots; balances
are a VIEW; allocation is computed; SO readiness is binary.

### The doc number: how it is minted, when a gap is permanent, how to rename

- Minted **`max(suffix) + 1`** per company+month prefix (`scm/lib/doc-no.ts:17`),
  deliberately NOT `count + 1` — `count+1` re-mints a surviving number forever
  once a row is deleted, and took down POS order creation on 2026-06-12.
- So deleting the **top** of a month returns those numbers to the pool and the
  sequence self-heals. Deleting from the **middle** leaves a gap the minter will
  never go back and fill. That is by design, not a bug.
- `doc_no` is the real PRIMARY KEY and **every FK pointing at it is
  `ON UPDATE NO ACTION`**, not CASCADE (`2990s-full-schema.sql:1652-1768`).
  `UPDATE ... SET doc_no = ...` is therefore REFUSED by Postgres while any child
  row exists. A rename is **copy the row under the new number -> repoint every
  reference -> delete the old row**, in one transaction:
  `backend/scripts/renumber-sales-orders.mjs` + the `Renumber sales orders`
  workflow (dry-run by default).
- Why that order is not optional: **five** of the seven FK'd child tables are
  `ON DELETE CASCADE` (the other two are `SET NULL`), so a reference the rename
  MISSED is **destroyed** by the delete rather than left as a visible orphan.
  The script re-scans for the old number and aborts before deleting, and a
  SECOND connection re-reads the renamed order afterwards and asserts its shape
  — the session that wrote is the worst witness that the write landed.
  The references that a hand-written table list forgets are the ones
  with **no FK at all** — `scm.pwp_codes.source_doc_no` / `redeemed_doc_no` are
  plain text, as is the AutoCount outbox — which is why the script discovers
  them by scanning `to_jsonb(t.*)` over every base table instead of trusting a
  list.

---

## 5. Performance summary (what's optimized, what to watch)

Optimized:
- List endpoint: 6 serial enrichment reads → one concurrent wave (**388ms → ~40ms warm**, PR #416).
- Desktop list: row windowing past 30 rows (PR #430).
- Cold/warm open: gcTime 30min (#436) + localStorage snapshot (#437) → no spinner.
- Search: trgm GIN indexes (0104).
- **Saving is the global sweep.** A create and every line add / edit / delete
  `await`s `recomputeSoStockAllocation` before answering (five call sites in
  `routes/mfg-sales-orders.ts`; only the header PATCH is deferred, PR #1982).
  The sweep is a chain of SERIAL PostgREST round trips, and its cost was set by
  ID COUNTS rather than row counts. Measured on prod by
  `probe-so-save-cost` (run 31937764356, 2026-08-16): **123 read round trips**,
  71 of them one read fetching **83 rows** — because it chunked all 14,169 live
  SO-line ids 200 at a time. Those reads are now INVERTED: they start from
  `mfg_sales_order_items` and pull the child rows through a PostgREST `!inner`
  embed, so no id list is enumerated. **123 → 30 round trips** on today's data (2026-08-16).
  Equivalence was proved against production by `probe-so-sweep-inversion`, not
  argued; the read shape is pinned by `tests/soAllocationReadShape.test.ts`,
  which asserts both the round-trip count and the allocation it produces.
- **The SO detail's Stock column is a whole MRP run.** `GET /:docNo` and
  `GET /:docNo/items` both call `computeMrp`, which walks every live SO line and
  every open PO. It **cannot be narrowed to one order**: a line's coverage
  depends on what higher-priority lines already claimed, so a single-order run
  answers a different question. It is now started with, rather than in front of,
  the three per-line reads beside it (`soCoverage`).

Watch as data grows:
- The 500-row `limit` on the list — beyond that, page it server-side + push filter/
  counts to the server (don't filter a page client-side).
- If AR aging (`/outstanding/summary`) gets slow, snapshot it server-side (follow the
  freshness guardrails in `docs/perf-optimization-plan.md` §G9).
- **What is left of the sweep's 30 round trips is dominated by two paged reads**
  that scale with live WIP, not with history: the SO headers and their lines.
  The next honest win there is not another read rewrite — it is moving the
  remaining four inline call sites onto `scheduleStockAllocationAfterCommand`
  so the sweep leaves the response path with a real durability guarantee
  (`lib/stock-allocation-job.ts` SCOPE header).
- **The MRP inside the detail GET is the next-biggest wait, and it is about to
  get heavier** — it currently truncates at `MRP_LOAD_CAP` and is being made to
  read more rows. Loading the Stock column separately from the document is a
  frontend contract change and belongs in its own PR.

**The AutoCount outbox enqueue stays ON the response path, on purpose.**
`queueAcSoEdit` → `enqueueEdit` → `composeSoState` adds roughly ten more serial
round trips to the end of every line write (header, items, locations, bindings,
salesperson, outstanding, payment refs, the pending-op lookup, the insert), and
**no caller reads its result** — `enqueueEdit` returns a boolean every call site
discards, and it never throws. So it could be handed to
`c.executionCtx.waitUntil` tomorrow. It is not, and the reason is worth writing
down rather than rediscovering:

- **What breaks if it fails after the response.** The operator has already been
  told the save succeeded. If the Worker is evicted before the deferred promise
  settles, the SO is edited in the ERP and **no outbox row exists at all** —
  not `pending`, not `failed`, nothing. AutoCount keeps the pre-edit order and
  the ERP has no record that it should not.
- **Why no existing check catches that.**
  `backend/scripts/check-autocount-outbox-health.mjs` reads the outbox TABLE. It
  answers FAILED / PENDING AGE / SKIPPED / SENT. Every one of those is a
  question about a row that exists; a row that was never written is invisible to
  all four. Today's inline call at least reaches `noteReadFailure`, which WRITES
  a row when the compose throws.
- **The condition that makes deferral safe.** A check that joins the other way —
  SO mutations in `mfg_so_audit_log` (`CREATE` / `ADD_LINE` / `UPDATE_LINE` /
  `DELETE_LINE`, human sources) against `autocount_outbox` rows for the same
  document and window, alerting on a mutation with no row. Build that first,
  then defer. Until then the ~10 round trips are the price of the failure being
  visible.

---

## Applying this to the sibling modules
PO / DO / SI / GRN follow the same shape (list hook → `/api/scm/<doc>` handler →
`scm.<doc>` tables). Differences to fill in per-module: the enrichment reads each
list does (audited — DO already parallel; GRN has a genuine item→downstream chain;
PO/SI make ≤1), and each doc's stock direction. See `docs/perf-optimization-plan.md`
for the cross-module audit.

---

## SO amendment — type classification + department routing

The SO amendment (revise a processing-locked SO + its bound PO) now classifies
each changed field into a TYPE (Processing vs Delivery / Commercial) and tags it
with a responsible DEPARTMENT, for display + accountability. **The apply gate is
unchanged** — approval stays single-signature; this is advisory routing only, no
new endpoint / permission / status / migration. The classifier and the shared PDF
are documented in full in **`docs/modules/purchase-order-amendment.md` §7**
(one `amendment-routing.ts` table drives both SO and PO).

SO-specific wiring:
- **Line atoms** come from `amendmentLineFieldKinds(line)` in
  `so-amendment-line-diff.ts` (SPEC / VARIANT / QTY / PRICE, or LINE for
  add/remove) — the SAME shared diff logic the desktop job card, the desktop diff
  modal and the mobile diff sheet already use, so all three label a row
  identically. **Header** atoms come from `soHeaderFieldKind(key)` in
  `so-amendment-header.ts`. **Every** amendable SO header key classifies as
  `DELIVERY` (Logistics) — `soHeaderFieldKind` returns that literal
  unconditionally, and `amendment-routing.ts` maps `DELIVERY` to Logistics.
  Purchasing is reached only through the `SUPPLIER` atom, which is a PO header
  field with no SO-header counterpart.

  **The list of amendable keys is NOT repeated here, on purpose.** This
  paragraph used to name five of them — delivery date, processing date, state,
  postcode, city — and by 2026-08-15 there were **thirteen**: the whole
  delivery-address block (`address1`..`address4`, `shipToAddress`,
  `billToAddress`, `installToAddress`) and `replacementDisposal` joined in the
  two-lane rework, and the prose did not follow. A reader planning an amendment
  would have concluded the ship-to address could not be amended.

  The list already has a guard the prose never had: `AMENDABLE_HEADER_KEYS` in
  `so-amendment-header.ts` is asserted equal to `soAmendableHeaderKeys()` by
  `so-field-policy.test.ts`, and a mismatch fails CI. Read it there:

  ```bash
  node -e "import('./frontend/src/vendor/scm/lib/so-amendment-header.ts')" # or just open it
  grep -n 'AMENDABLE_HEADER_KEYS = [' -A 20 frontend/src/vendor/scm/lib/so-amendment-header.ts
  ```
- **Surfaces (change together):** `AmendmentDetailV2.tsx` (type badges + per-row
  chips + Department-routing aside), the `AmendmentDiffModal` in
  `SalesOrderDetail.tsx` (a **Dept** column), and `MobileSODetail.tsx`'s
  `AmendmentDiffSheet` (type badges + per-row chips). Colour / fabric now also
  renders as its own change row on the SO PDF.
- **Audit:** `lib/so-revision.ts` stamps a `routing` field-change + a `routing …`
  note on the `AMENDMENT_SO_APPROVED` row recording which departments the single
  approval covered.

### What an approved amendment does to the LINE PRICE

**Owner ruling, 2026-08-16:** *"Any amount can be edited, unless it is locked. If
it has proceeded and a day has passed so it locked, then it goes through Sales
Amendment."* So the amendment is the sanctioned road for money on a locked SO,
and since that date it CARRIES the money. It did not before, and the paragraph
that used to sit here described the old behaviour as deliberate:

> Approving an amendment re-runs the honest-pricing recompute on every changed
> line … **authoritative by default**: it rewrites `unit_price_centi` to
> `mfg_products.sell_price_sen`… That is deliberate for a NATIVE order.

That was true of the code and wrong about the product. An operator typed RM 50,
an approver holding `scm.amendment.approve_*` signed RM 50, and the catalogue
price landed — on every SKU with one. A QTY-ONLY amendment did it too, because
the recompute is per-line, not per-changed-field, and the editor sends
`newUnitPriceSen` on every SPEC/QTY line.

**Today.** Approving still re-runs the honest-pricing recompute on every changed
line (`backend/src/scm/lib/so-revision.ts` -> `recomputeOneLine`), but the trust
it passes is derived from the APPROVAL, not from the payload:

| what the apply is given | native order | migrated order |
| --- | --- | --- |
| `approval` (the approve-so gate's receipt) | the requested price persists (`trustOperatorSelling: true`) | stored / requested price persists (`'including-zero'`) |
| `null` (any other caller) | catalogue, exactly as before | stored price kept |

`SoAmendmentApproval` is a **required** parameter of `applySoAmendment` with no
default, constructed only inside `approveSoCommandHandler` after
`hasHouzsPerm(c, approveKey)` and the transition check. With `approval === null`
the requested `new_unit_price_sen` is not read at all. That is the whole safety
argument: `new_unit_price_sen` is written straight from the browser and validated
nowhere (mig 0080 — bare nullable `integer`; the submit gate admits
`scm.amendment.create` OR any Sales-org user OR a lane approver), so what makes a
requested price payable is the signature, never the payload.

The ceiling is deliberate — an approved amendment grants exactly the authority
the operator would have had on the same order **before** it locked, since the
direct SO write path already passes `trustOperatorSelling = !(isPosTabletCaller)`
— and not one unit more.

**Two consequences worth knowing.**

- An approved price of exactly **RM 0** on a catalogued SKU still fills from the
  catalogue. `true` reads 0 as "not provided", which is the same rule the
  unlocked edit path uses; `'including-zero'` is reserved for a MIGRATED line,
  where 0 is a real AutoCount figure. An ADD line never gets `'including-zero'`
  on any order type — it is being authored now, so it has no AutoCount history.
- **`discount_centi` still has no amendment channel.** `scm.so_amendment_lines`
  has no discount column (mig 0080 + 0281: `new_item_code`, `new_variants`,
  `new_qty`, `new_unit_price_sen`, `new_remark`, `old_snapshot`), so a discount
  cannot be requested, approved or applied. The apply carries the line's existing
  discount forward untouched and an ADD line always lands at discount 0. Reducing
  an amount on a locked SO is therefore a **unit-price** change, never a discount.

**A MIGRATED order is exempt.** When the SO header carries `linked_ac_docno`
(migration 0271 — the marker that actually exists; `migrated_no_stock` lives only
on `scm.grns` / `scm.delivery_orders`, never on the SO or PO header), the apply
passes `trustOperatorSelling: 'including-zero'` and the stored price is kept. Two
reasons, both money:

- that unit price is what AutoCount recorded as negotiated with the customer, and
  `sell_price_sen` is in no sense a better answer for an order this ERP never
  priced;
- `'including-zero'` rather than plain `true` because a migrated sofa is
  routinely carried as the **whole-set price on ONE lead module line with 0 on its
  siblings**. Plain trust reads a stored 0 as "not provided" and hands the sibling
  a catalogue price anyway, which bills the set several times over.

If a migrated line's price genuinely must change, the amendment carries
`new_unit_price_sen` and THAT is what persists — a SPEC change alone does not
re-price a migrated line.

Note the reachability gate: a migrated SO is only `amendment_eligible` once it is
processing-locked, and the importer does not set `processing_date`, so today
most migrated orders cannot reach this path at all. The exemption exists so that
giving one a Processing Date does not silently destroy its price later.

**What the importer sets INSTEAD, and why that is worth knowing.**
`import-ac-outstanding-so.mjs` reads AutoCount's `UDF_PDate` (`:304`) and writes
it into **`proceeded_at`** — its header column list at `:390` ends
`…,payment_date,proceeded_at)` and contains no `processing_date`. So a migrated
order carries a proceed TIMESTAMP with no Processing Date, which under the
pinned owner rule (*"没有 processing date 就代表没有 proceed"*) is a state that
is not supposed to exist. It is inert for the amendment path described here —
that gate keys on the Processing Date, which is absent — but it means
`proceeded_at` and the Processing Date genuinely disagree on migrated rows, and
the stock allocator gates on `proceeded_at`. Do not "fix" one side without
reading `docs/cutover-tally-method.md` and `docs/stock-reconciliation.md` §6.1,
which describe the same split from the cutover end.

### A priced special add-on is CHARGED, not only costed (owner 2026-08-11)

Owner: *"让收费追上成本."* The SELLING path used to drop the surcharge the COST
path booked, so a priced add-on could only ever reduce margin.

The surcharge total is `breakdown.unitPriceSen - breakdown.basePriceSen` in
`scm/lib/mfg-pricing-recompute.ts`. The selling base is pinned at 0 by
`computeMfgLinePrice` (the product price tables are COST), so that subtraction
IS the director-authored selling surcharges — specials, divan, leg, total
height. It reached the customer's price through exactly one branch, gated on
`category !== 'SOFA' && effectiveBaseSen > 0`, which exempted two populations:

| exempt | why it was exempt | what it cost |
|---|---|---|
| every SOFA line | excluded by category; the sofa branch rebuilt the price from Σ module prices and never re-added the surcharges | the COST branch beside it DID re-add its own (`costSurchargesSen` on top of Σ module costs), so a priced sofa add-on was costed and never charged |
| any line whose product carries `sell_price_sen = 0` | excluded by the `> 0` test, in any category | same — costed, never charged |

Both now charge it, from the same figure the cost path uses. **A migrated line
still cannot re-price**: the new `sellingSurchargesSen > 0` arm is inert under
`trustOperatorSelling === 'including-zero'`, so the marker blocks it
structurally, not merely via the trust overwrite at the end of the function.
That belt-and-braces is load-bearing — 10,856 of 13,909 migrated lines are
priced 0 and 549 of those are SOFA, i.e. the exempt populations and the migrated
corpus are very nearly the same set. Pinned in
`mfg-pricing-recompute.surcharge.test.ts`.

**Clients that SUBMIT a price must now add the add-on themselves.** A trusted
(non-POS) author is unaffected — their hand-typed price is persisted as-is, and
the desktop line editor's `pricingBreakdown` is display-only by design. A
drift-gated POS caller is not: it must send `sofaSellingSen + surcharges + …` or
`driftThresholdExceeded` will 400 it. `specialAddonsSurchargeSen`
(`scm/shared/mfg-pricing.ts`) is the helper for exactly that and has **no caller
in either tree** — it is a WIRING GAP, not dead code, and must not be deleted.
It is inert only while every add-on is priced 0; the first add-on the owner
prices is the moment a price-submitting client has to call it.
