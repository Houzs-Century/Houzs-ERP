> ## Corrections — 2026-08-12 code-read sweep
>
> 1. Three stale line cites, behavior verified correct at the new spots: DELETE /:docNo registers at :5987 (not :5555); cancel-final guards at :5749-5754 and :5720-5728 (not :5396); tbcSwapCommandHandler at :8982 (not :8669). 83 claims clean, including the full Processing-Date gate set, voucher settlement, relink transaction and the surcharge charging.
> 2. “mig 0121/0118” for allocated_batch_no / items.warehouse_id are the 2990 source repo's numbers; this tree's 0118/0121 are unrelated. Columns themselves proven in the schema.

# Module: Sales Order (SCM)

> **Naming (vocabulary registry).** Three SO-header concepts are now declared in
> `backend/scripts/lib/vocabulary.mjs` (glossary: `docs/generated/GLOSSARY.md`):
> the salesperson is `salesperson_id` (uuid; the legacy `agent` text is kept for
> the AutoCount book, see "stamped TWICE" below), the ship-from warehouse is
> `warehouse_id` (the header's free-text `sales_location` snapshot is being
> unified onto it by a staged backfill migration), and the customer's own
> reference is `ref` (owner ruling #2429; `customer_so_no` is a transitional
> fallback and the dead `po_doc_no` / `customer_po` / `customer_po_id` /
> `customer_po_date` columns — 0%-filled, census-verified — are DROPPED from the
> SO header by migration 0310).
> No column was renamed in this registration — the two renames are reviewed
> follow-ups because they need a backfill / a view-guarded drop.

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
SHIPPED(4) → DELIVERED(5) → INVOICED(6)`. `CANCELLED`, `ON_HOLD` and `CLOSED`
are side states and are deliberately UNRANKED.

> **`CLOSED` = STOP CHASING THE REMAINDER (2026-08-22).** The customer ordered 10
> and took 7, or the supplier cannot supply the last 3. **The document STAYS and
> what was already delivered and invoiced STANDS** — only the outstanding part is
> given up on. Asked whether that case happens here, the owner: 「有的」.
>
> **It is NOT Cancel.** Cancel voids the whole document as if it never happened
> and cannot be reactivated; Close keeps a real sale that came up short. See
> `docs/modules/document-status-vocabulary.md` §1b for the two side by side.
>
> **UNRANKED on purpose.** Closing is reachable from wherever the order had got
> to and most closed orders never reach INVOICED, so a rank would state something
> false. It is enterable from every live status and the way OUT is refused
> (`illegal_status_transition`, 409): a closed order cannot be walked back into
> DRAFT / CONFIRMED / IN_PRODUCTION / READY_TO_SHIP / SHIPPED / DELIVERED /
> INVOICED. `CANCELLED` stays reachable, because the cancel guards own that call.
>
> **The refusal is load-bearing on its own**, re-checked 2026-08-22 after mig
> 0324 made the hold a marker. It was written against the two-step
> `CLOSED → ON_HOLD → DRAFT`, which is now dead by a second route (`ON_HOLD` is
> refused as a TARGET for every source). What it actually stops is the DIRECT
> move: `CLOSED` is unranked, so without the arm `from = 'CLOSED'` reaches the
> rank block, `SO_STATUS_RANK.CLOSED` is `undefined`, and the function returns
> `null` — `CLOSED → DRAFT` allowed outright, and DRAFT is what unlocks the
> cascading DELETE. `CLOSED → ON_HOLD` now answers `hold_is_not_a_status` (409)
> instead, and `ON_HOLD → CLOSED` is ALLOWED so a legacy row on the retired
> label can still be closed.
>
> **The HOLD marker is orthogonal, and no gate was added in either direction.** A
> held order may be closed and a closed order may be marked held —
> `PATCH /:docNo/status` never selects `on_hold`, and `PATCH /:docNo/hold` never
> writes `status` and deliberately does not gate on it. See
> `docs/modules/document-status-vocabulary.md` §1b.
>
> **Nothing automatic writes it, ever**, and no sweep is planned: no machine holds
> the fact that a remainder was given up on.
>
> **It also blocks the two downstream documents.** `SO_UNDELIVERABLE_STATUSES`
> (`shared/so-deliverable-states.ts`) and `SO_UNORDERABLE_STATUSES`
> (`lib/source-document-gates.ts`) both name it: if the rest is not coming,
> nothing more ships against the order and nothing more is bought for it. The two
> sets are held equal by `backend/tests/duplicatedDecisionPins.test.ts`.
>
> **A closed order still earns commission** — `COMMISSION_EXCLUDED_STATUSES` does
> not name it, deliberately. The part that went out was really sold.

> **THIS IS A RESTORATION, NOT A REVERSAL OF 2026-08-21.** `CLOSED` was removed
> from the app vocabulary that day and the removal was CORRECT. He wrote the
> lifecycle he actually runs — Draft, Confirm, In Production, Ready to Ship,
> Shipped, Delivered, Invoice, On Hold, Cancel — and narrowed the removal to this
> one status: 「照你的流程做，只删 Closed」. What went was a vague lifecycle STEP
> after Invoiced that nobody used, PROVEN empty first: company 1 holds 0 sales
> orders (probe run 32487749630) and company 2's own tab counts summed to its
> total with CLOSED at 0. What is back is a different decision under the same
> enum label.
> 
> **No migration was needed in either direction.** Postgres cannot `DROP VALUE`,
> so `CLOSED` never left `scm.mfg_so_status` — it is in the type's creating DDL
> (`backend/scripts/scm-schema/2990s-full-schema.sql`) and mig 0305 casts to it.
> Removing it from the app was always a change to `SO_STATUSES`, and so is
> putting it back.
>
> **It never left two places, and that is why the restoration is small.**
> `SO_TERMINAL_STATES` — a CLOSED row must be terminal, or it becomes live demand
> for MRP again — and the status-pill LABEL map, so such a row always rendered a
> word rather than a raw enum key.

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
a Sales Order.** All three are manual-only, and for `CLOSED` that is permanent
rather than a gap: no machine can know a remainder has been given up on. That is worth holding next to §0.6:
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
| `IN_PRODUCTION` | proceeded | `PATCH /:docNo/status` — the transition that marks the order proceeded (it used to stamp `proceeded_at`; that column is neither written nor read since #2396 / mig 0286, see the note below and line 1316) | — | — |
| `READY_TO_SHIP` | stock is in, call the customer | `PATCH /:docNo/status` | **advance** by `recomputeSoStockAllocation` when `isShipReady` and current is `CONFIRMED` or `IN_PRODUCTION` | — |
| `SHIPPED` | goods left | `PATCH /:docNo/status` | **nothing** | — |
| `DELIVERED` | customer has it | `PATCH /:docNo/status` | `so-delivery-sync.ts` — advance, when every live line is fully covered and the current status is one of CONFIRMED / IN_PRODUCTION / READY_TO_SHIP / SHIPPED | — |
| `INVOICED` | billed | `PATCH /:docNo/status` | **nothing** | — |
| `CLOSED` | 不追剩下的了 — stop chasing the remainder | `PATCH /:docNo/status` (the list's right-click **Close remaining**) | **nothing, ever** | No new Delivery Order and no new PO line — `SO_UNDELIVERABLE_STATUSES` (`shared/so-deliverable-states.ts`) and `SO_UNORDERABLE_STATUSES` (`lib/source-document-gates.ts`). Terminal for MRP/allocation (`SO_TERMINAL_STATES`): the order stops being demand. **One-way** — cannot move to any earlier live status (409); only `CANCELLED` is still reachable. Commission on what was delivered is UNAFFECTED. |
| `CANCELLED` | killed | `PATCH /:docNo/status` | — | **FINAL.** Cannot be reactivated (`so_cancelled_final`, 409) — the deposit already became customer credit. If it also reached AutoCount, a second guard refuses first (`cancel_is_final`, 409) because the 2.2 SDK has no un-cancel. Terminal for MRP/allocation. |
| `ON_HOLD` | **RETIRED as a status, 2026-08-22 (mig 0324)** | **nothing** | — | A hold is a MARKER now, not a step — see §0a below. `PATCH /:docNo/status` refuses this target with `hold_is_not_a_status` (409); it is still accepted as a `from`, so a legacy row can leave. The label stays in `scm.mfg_so_status` for ever (no `DROP VALUE`) and every pill map keeps rendering it. |

### §0a. A HOLD is a MARKER beside the status, not a step in the order's life

**The owner, 2026-08-22:** 「我们的hold是给我们知道一个 order hold这的」 — the hold
is there so people KNOW an order is paused. 「take off hold也要看」.

`scm.mfg_sales_orders` carries `on_hold` / `hold_reason` / `held_at` / `held_by`
(mig 0324), and the Sales Order LIST reads them through the payment-totals view,
which had to be taught the four columns separately (mig 0325 — the view
enumerates its columns, so a base-table column it does not name is invisible to
the list).

**`status` is never written by a hold, in either direction.** Put On Hold and
Take Off Hold both go to `PATCH /:docNo/hold` with `{ onHold, reason }`. So an
`IN_PRODUCTION` order that is held is still `IN_PRODUCTION`, and taking the hold
off restores nothing because nothing was lost.

**What it replaced.** `Put On Hold` used to write `status = 'ON_HOLD'`, which
OVERWROTE the progress — and no `previous_status` column exists anywhere in
`scm`, so `Take Off Hold` sent every released order to `CONFIRMED` regardless of
where it had been. Trace:
`docs/bugs/0516-putting-an-order-on-hold-destroyed-its-progress-and-taking-i.md`.

**On screen:** the real status pill AND a Hold chip, never one instead of the
other (`frontend/src/vendor/scm/components/HoldChip.tsx`). The list's **On Hold**
tab filters on the flag and deliberately OVERLAPS the status tabs; `other =
all − known` is still computed from the status walk alone, so the sum-to-All
invariant is untouched.

**What a hold blocks on the SO:** raising a Delivery Order
(`soCanRaiseDo(status, onHold)`), raising a Purchase Order from its lines
(`firstUnorderableSo`), commission (`soEarnsCommission(status, onHold)`), the
`/mine` board, customer LTV, sales analysis, the POS revenue cards and the
order-fulfilment agent. What it does NOT block is the machine re-deriving the
status from a fact — `so-delivery-sync` still advances a held order to DELIVERED
when its delivery completes, because that write can no longer erase the hold.

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

### 0.1a What the LIST offers on each status (2026-08-21)

The Sales Order list's row-drawer CTA is a switch on the STORED status, and its
last branch returns nothing — so a status it does not name gets no primary
button at all.

| stored status | primary button |
|---|---|
| `DRAFT` | **Confirm** |
| every deliverable status — `CONFIRMED`, `IN_PRODUCTION`, `READY_TO_SHIP`, `SHIPPED`, `DELIVERED`, `INVOICED` | **Transfer to Delivery Order**, when the caller may operate a DO (absent, never disabled, when they may not) |
| `CANCELLED` | **Reopen** |
| `ON_HOLD` | none |
| `CLOSED` | none — the remainder is not coming, so there is nothing to transfer |

**The RIGHT-CLICK menu offers four decisions and nothing else**
(`frontend/src/pages/scm-v2/row-menus.ts`, and the rule that decides membership
is in `docs/modules/document-status-vocabulary.md` §1b): **Confirm** on a draft,
**Put On Hold** / **Take Off Hold** (the mig-0324 MARKER, never a status write),
**Close remaining** on any live order, and **Cancel Sales Order** alone at the
bottom in red. Close and Cancel both sit behind a confirmation that says in plain
words what each one does to the money. **Close remaining is not offered** on a
DRAFT (no remainder to give up on), a CANCELLED order or an already CLOSED one —
but the hold entries ARE still offered on all of those, because a marker says
nothing about where the order is.

**The list carries a Closed tab**, between Invoiced and On Hold — one tab per
status (`frontend/src/pages/scm-v2/so-list-status.ts`), counted server-side from
`SO_TAB_STATUSES`. It is NOT folded into Delivered: an order whose remainder was
abandoned is a different fact from one that was delivered in full.

**The deliverable arm reads `soCanRaiseDo(row.status, row.on_hold)`** from the vendored
`shared/so-deliverable-states.ts` — the same predicate the delivery-order route
enforces with. It was `s === "confirmed"` until 2026-08-21, an allow-list of one
against the server's deny-list of three, so the button went ABSENT the moment
`recomputeSoStockAllocation` promoted an order to `READY_TO_SHIP` — which it
does by itself when the goods land. Owner-reported as a difference between the
two companies; the predicate carries no company term and never did.
`docs/bugs/0504-transfer-to-delivery-order-vanished-the-moment-stock-arrived.md`.

**Right-click on the list row** offers Open / Edit / Print, the transfer, and
then exactly FOUR decisions — **Confirm** a draft, **Hold**, **Close remaining**,
**Cancel**.
See `docs/modules/document-conversion.md` §8a for the shape and for what each of
the five lists deliberately does NOT offer.

> **CORRECTED 2026-08-22.** This sentence used to read "the same actions plus the
> four statuses that had no caller". Three of those four —
> `Mark In Production`, `Mark Shipped`, `Mark Invoiced` — were REMOVED the next
> day on the owner's ruling: 「按理说不应该允许这样手动去转，否则我们的
> transaction workflow 就全乱了」. Each is DERIVED by a machine from a fact
> (§0.2 lists the keys), so hand-setting one changed the list and not the fact,
> and the next sweep overwrote it. The rule that replaced the list: **a status a
> machine derives is never offered to a person**, which leaves only the three
> decisions no machine can make. `docs/modules/document-status-vocabulary.md`
> §1b, `docs/bugs/0515-the-sales-order-right-click-let-a-person-hand-write-a-status.md`.

### `SHIPPED` is a status with no tab of its own (2026-08-22)

Owner: 「Sales Order 的 Shipped 跟 Delivered 是合起来的」. The **Shipped** tab is
gone and `backend/src/scm/lib/so-tab-statuses.ts` gives the **Delivered** tab
both `SHIPPED` and `DELIVERED`.

`SHIPPED` is still WRITTEN — `so-delivery-sync.ts` sets it when a delivery order
is raised (§0.2) — and it is still a legal transition target. Only its tab is
gone. That asymmetry is the whole design: Postgres cannot `DROP VALUE`, so a row
carrying `SHIPPED` can always arrive.

**Where an unfolded status would go, stated accurately.** This list is the one
that HAS a catch-all — the handler computes `other = allCount - known` and
`MfgSalesOrdersListV2.tsx:2005` renders an **Other** tab when that count is
non-zero. So an unfolded `SHIPPED` order would still have been reachable, and
the reason to fold is the READER rather than reachability: goods that went out
belong under **Delivered**, not under **Other**. The four purchase/delivery
lists have NO catch-all, which is why `*_STATUS_BUCKETS` there must partition
the enum exhaustively and `so-tab-statuses.ts` deliberately does not carry that
name. Production carried SHIPPED · 0 against DELIVERED · 26 on the day of the
ruling.

**The list's three query sites all read the bucket**, not the raw param: the row
query, the count query and the money-KPI query in
`GET /api/scm/mfg-sales-orders`. A tab covering one status still reads through
it, so "what does this tab select" has one answer and not four.

**The desktop DETAIL page offers no transfer at all** — `SalesOrderDetailV2.tsx`
has no `transferToLabel('do')` call. The other desktop routes to a delivery
order are the Delivery Planning board's context menu and
`/scm/delivery-orders/from-so`.

### 0.2 What the automatic advance/regress actually keys on

`recomputeSoStockAllocation` (`scm/lib/so-stock-allocation.ts`) is the only
writer of the READY_TO_SHIP ↔ CONFIRMED pair, and its gate is **`isShipReady`,
never bare `isMainReady`** — see §0.5 for why that distinction exists.

Two things gate it that are easy to miss:

- **No Processing Date, no allocation.** An SO with `processing_date` NULL is in
  `allocGated`: its lines still walk, but they are FORCED to `PENDING`, never
  consume a stock bucket and never claim a sofa batch. Owner's rule, 2026-08-10:
  *"有 processing date 才来分配"*. So an order that genuinely has no Processing
  Date will sit at PENDING / CONFIRMED however much stock is on the shelf. That
  much is intended.

  > **CORRECTION (2026-08-18) — the previous version of this bullet described a
  > BUG and called it intended, which is why the bug survived.**
  >
  > It read: *"An SO with `proceeded_at` NULL is in `allocGated` … This is
  > intended, and it is the single most common 'why is my order not READY'."*
  >
  > The gate really did read `proceeded_at`, and that was the defect, not the
  > design. No shipped client writes `proceeded_at` when an operator sets a
  > Processing Date: CREATE persists the date to `processing_date` and stamps
  > `proceeded_at` only when the order *also* clears the proceed gate
  > (`autoProceed`); the header PATCH writes the date and never stamps a proceed;
  > and no frontend sends `proceededAt` at all. So an order given a Processing
  > Date on the detail screen locked, showed on the delivery board and pushed to
  > AutoCount as PDate while **every line was forced PENDING** — never consuming
  > a bucket, never claiming a sofa batch, never reaching READY_TO_SHIP — with
  > the goods physically in the warehouse, and with no error, no log and nothing
  > on screen. The frequency the old text observed was real; the explanation was
  > not. Anyone who read this page went looking for a missing proceed instead of
  > a gate on the wrong column.
  >
  > The gate now reads `processing_date`, the one column every write path
  > actually sets. It reads that column ALONE and deliberately does not also
  > consult `proceeded_at`: a second home for the rule is how it acquired a wrong
  > one. See BUG-HISTORY 2026-08-18.

  > **AND THE BLAST RADIUS #2396 SHIPPED WITHOUT (measured 2026-08-18,
  > `backend/scripts/probe-proceed-split.mjs`, prod, run `32093080121`).** That
  > PR says so itself: *"Blast radius on production is UNKNOWN and not
  > invented."* It is now measured. Company 1 — 2724 live orders, ZERO in either
  > disagreement class, so the flip is a true no-op there. Company 2 — 5 live
  > CONFIRMED orders GAIN allocation (the bug above), and **16 LOSE it**: 12
  > CONFIRMED and 4 READY_TO_SHIP, each carrying a Proceed stamp with no
  > Processing Date. Their lines go PENDING on the next recompute and the 4
  > READY_TO_SHIP orders drop back to CONFIRMED. That is the rule applied
  > correctly — *"没有 processing date 就代表没有 proceed"* — not a new fault, and
  > the repair is a human supplying the missing date, never a script inventing
  > one. Expect it, and do not read those 4 as a regression.
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

**The two allocation mechanisms are COMPANY-SPLIT (2026-08-30, owner ruling —
bug `docs/bugs/0572-a-company-1-bound-line-with-no-receipt-fell-through-to-the-p.md`).**
`HARD_BOUND_COMPANY_ID = 1` in `so-stock-allocation.ts`:

| company | bedframe / sofa / `(SP)` mattress (`isHardBoundLine`) | everything else |
|---|---|---|
| 1 (Houzs) | **exclusively PO-bound**: lights `min(received, need)` from its OWN dedicated PO (sofa: covering dye-lot batch first, then dedication). The pooled walk force-stamps PENDING — the pool is never its evidence, however well the bucket matches | pooled FIFO by (warehouse, code, variant_key) |
| 2 (2990) | dedication lights first if present, then the pooled walk — the soft model | pooled FIFO |

Before this split the un-receipted bound line FELL THROUGH to the pool for both
companies; it only looked hard-bound because typed variant keys never match the
blank-variant migrated stock, and it fired the moment both sides were blank
(HC-SO-013253). `check-bound-exclusivity.mjs` (workflow: *Bound exclusivity
census*) re-measures the rule on demand — company-1 "LIT WITH NO PO" must be 0.
Flipping company 1 to the pooled end-state later is that one constant.

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

Computed per request in `mfg-sales-orders.ts`, from the same `computeMrp` run
that produces `coverage_po`. Values: `'stock' | 'po' | 'shortage' | null`. It is
live in `GET /:docNo/items` and in the deferred `GET /:docNo/coverage`; **`GET
/:docNo` no longer runs MRP inline** (2026-09-01) — it returns `'stock'` for a
service line and `null` for every other line, and the client heals the real value
from `/:docNo/coverage` after the doc renders (see §2 and the perf note).

| Line kind | Rule |
|---|---|
| SERVICE (`isServiceLine`) | always `'stock'` — a service carries no inventory, so it is inherently available |
| SOFA | `stock_status === 'READY' ? 'stock' : (MRP says po ? 'po' : 'shortage')` — sofa coverage is decided by the batch-aware allocator, because MRP does not know about dye lots. Since 2026-08-29 that allocator answers in two steps: a single covering dye lot wins and stamps `allocated_batch_no`; with NO covering lot, the owner's hard binding takes over — a piece whose OWN converted PO has received lights `min(received, need)` per line, batch left null for the operator to pick at dispatch. Until then sofa lines never reached bound mode at all (docs/bugs/0565): they were diverted to the batch pass before `needs` was built, and every migrated set without an exact-multiset lot sat PENDING with its PO fully received |
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
liveState, gates)`, a UNION whose promotion arm is GATED (2026-08-30):

| stored | live | effective | why |
|---|---|---|---|
| `PENDING` | `stock` (gates open) | **READY** | the stale-projection case — the goods are physically there |
| `PENDING` | `stock` (either gate closed) | `PENDING` | see the two gates below — the live verdict is answering a different question |
| `READY` | anything | **READY** | the allocator knows BOUND MODE and dye-lot batches; MRP structurally cannot see either. The gates never veto a stored READY |
| `PENDING` | `po` / `shortage` | `PENDING` | an incoming PO is not stock |
| `PARTIAL` | anything but gates-open `stock` | `PARTIAL` | |
| anything | `null` | the stored value | MRP had no verdict, or `computeMrp` threw — fail-soft to the pre-2026-08-17 behaviour exactly |

**The two promotion gates** (`gates: { orderProcessed, lineHardBound } | null`,
bug `docs/bugs/0569-the-display-union-promoted-pending-lines-to-ready-past-the-p.md`,
owner report HC-SO-013367):

1. `orderProcessed` — the order carries a processing date. The allocator refuses
   to allocate to a date-less order (`allocGated`, "no processing date = the
   goods are not needed yet"), so the display must not light one either. This is
   how "accessories Ready" appeared on an order with no dates.
2. `lineHardBound` — `isHardBoundLine(item_group, item_code)` from
   `so-stock-allocation.ts`, the allocator's OWN bound predicate (bedframe /
   sofa / `(SP)` special-order mattress). Those buckets key on the VARIANT; MRP
   pools by SKU and is variant-blind, so its `stock` can be migrated blank-variant
   units the line's colour can never be served from. JAGER-(Q) read READY with
   no processing date, no linked PO and no matching stock — both gates open.

Neither engine may VETO the other; a line is short only when both say so. `null`
is a REQUIRED argument on all three parameters, not an omitted one — a caller
with no MRP result types `liveState: null` (the stored value stands), and a
caller that cannot establish the gate context types `gates: null`, which fails
in the STRICT direction: the promotion arm is off, the stored value still
stands.

Where it is used:

- `GET /mfg-sales-orders` rolls it up into `stock_remark` / `is_main_ready` /
  `planning_state`. Since 2026-08-18 the list DOES NOT run `computeMrp` on its
  critical path — those three fields (and the READY arm of the "PO No." chips)
  are emitted from the STORED status alone on first paint (`null` live coverage,
  the fail-soft branch above), and the client heals them a beat later from
  `GET /mfg-sales-orders/list-mrp-enrichment` (see the LIST "PO No." column note
  in §2 and §"why the list opens instantly"). `GET /:docNo/items` and
  `GET /:docNo/coverage` still run `computeMrp` inline; `GET /:docNo` DOES NOT
  (2026-09-01) — same deferral as the list.
- All three of `GET /:docNo`, `GET /:docNo/items` and `GET /:docNo/coverage` stamp
  it on every line as `stock_status_effective`. `stock_state` and `stock_status`
  both stay on the payload — they are the two INPUTS, and the source chips and MRP
  page still read them individually. On `GET /:docNo` the live state is passed as
  `null` (no inline MRP), so the STORED verdict stands until `/:docNo/coverage`
  overlays the recomputed one.

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

**`active-venue` resolves WITHIN one company, since 2026-08-20.** It returns the
venue TEXT from `resolveVenueBinding` and then maps that text onto a
`project_venues` id so the dropdown can select the row rather than only display
it. That name lookup used to carry no company predicate: venue names are not
unique across the two masters, so it could hand this company the OTHER company's
venue id — and that id is what the SO stores. It now carries
`activeCompanySql(c)`. A name this company does not master still resolves to
`venueId: null` with the TEXT standing, which is the existing fallback and is
unchanged. Same sweep as the venue PICKER fix in `docs/modules/projects-pms.md`
§Venues, where the leak was visible (`GET /venues?includeShowrooms=1` listed
every company's showrooms); guard for both halves is
`backend/tests/showroomVenueCompanyScope.test.ts`. Owner 2026-08-19: *"我们的
Venue、我们的 Warehouse、我们的 Showroom 等等，都是跟着看到自己公司的"*.

**A BLANK VENUE BESIDE A VENUE ID IS NOT A CLEAR (2026-08-31).** A client that
resolved the id and not the name sends `venue: ""` with a real `venueId`. Read
literally that is "clear the venue", and it deleted a live order's venue: the
audit log for `2990-SO-2608-070` records `venue: "2990s PJ" -> ""` and
`venueId: null -> "5cafa0a2…"` in ONE save. Mirrored 2990 orders all START in
that state — the mirror forces `venue_id: null` and keeps the text — so each one
was a single save away from the same loss.

Two places now refuse to write that blank, and they are not redundant: the client
one stops it being sent, the server one stops it whatever sends it.

- The desktop default-venue effect (`SalesOrderDetail.tsx`,
  `ConsignmentOrderDetail.tsx`) returns instead of writing an unresolved name.
  It is a one-shot — `if (form.venueId) return` — so a blank it writes can never
  be repaired by a later pass, which is what made this permanent.
- `PATCH /mfg-sales-orders/:docNo` resolves the pair through
  `venueNameForHalfWrittenPair` (`scm/lib/venue-binding.ts`), beside the binding
  rule the CREATE path already uses.

**It has THREE answers, and the third is load-bearing.** `resolved` writes the
name; `notApplicable` leaves the request alone; **`unresolved` — the venue master
could not be read, or the id matches nothing — makes the route DROP the venue
from the patch entirely** rather than write the blank. Collapsing that onto "no
name" would mean a five-second database blip deletes the venue off whatever is
being saved at the time, which is the same class of fault as the original bug.

**Clearing a venue is still allowed and still easy: send BOTH empty.** That is
what "this order has no venue" looks like, and `venue_required` at confirm is
what stops it being shipped in that state.

Tests: `src/scm/lib/venue-binding.test.ts` (the five outcomes) and
`backend/tests/mfgSalesOrderHeaderCas.test.ts` (the route honours them).
Ledger: `docs/bugs/0591-*`. Repair for orders already blanked:
`backend/scripts/repair-blanked-venue.mjs`.

The backend recomputes honest pricing and mints the `doc_no` server-side, so the
client never sends a `doc_no`, and money crosses the wire as `*_sen` integers.

**CATEGORY-AWARE LINE VARIANTS — wired to the SAME real hooks the desktop
`SoLineCard` uses, never hardcoded arrays:**

- **Fabrics** ← `useFabricColoursActive()` + `fabric_library` series via
  `useFabricLibrary()`. The Fabric picker is a SEARCHABLE modal (700+ colours),
  not a native `<select>`.
- **Sofa** — Seat Size ← `maintenanceConfig.sofaSizes`; Leg height ←
  `maintenanceConfig.sofaLegHeights`. The label is **Seat Size** on every
  surface (`so-variant-rule` declares it, and the SO line card renders it since
  2026-08-21 — it was the last screen saying "Seat Heights").
- **Bedframe** — Gap ← `maintenanceConfig.gaps`; Divan ←
  `maintenanceConfig.divanHeights`; Leg ← `maintenanceConfig.legHeights`.
  `totalHeight` (= divan + leg + gap) is COMPUTED into the variants blob for the
  backend, but no longer shown (owner: hide it). The rule — the arithmetic, the
  three parts it reads, and what is written when all three are blank — lives in
  `backend/src/scm/shared/total-height.ts`, mirrored to
  `frontend/src/vendor/shared/total-height.ts` and refereed by
  `total-height.canonical.test.ts`. Blanking divan/leg/gap CLEARS the stored
  total to `''`; it does not leave the previous number behind. Every surface
  that authors the value imports `computeTotalHeight` / `totalHeightPatch` —
  there is no per-screen copy, and the canonical test fails by name if one
  reappears.

**Every floating picker on the line card is placed by ONE shared module**,
`frontend/src/lib/anchoredPanel.ts`. The SKU dropdown and the fabric-colour
combobox are portalled to `<body>` (so a card's `overflow:hidden` cannot slice
them) and their geometry — which SIDE of the field to open on, and how tall they
may be — is measured from the field's live rect: the side with more room wins,
and the height is clamped to that room so the last rows and any footer bar stay
inside the window. Both pass 460px as their PREFERRED cap. Do not re-hand-roll
`top: rect.bottom + 4` for a new menu; that is what put the SKU picker's green
"Add N" bar off the bottom of the screen
(`docs/bugs/0504-every-portalled-dropdown-opened-downward-and-ran-off-the-bot.md`).

`anchoredPanelStyle` writes **both** `top` and `bottom`, with `'auto'` for the
edge the chosen placement does not use. That is load-bearing, not tidiness: a
placement supplies only ONE of the two, and React OMITS a style property set to
`undefined`, so the panel would keep whatever `top` its own class rule carries.
Both `SoLineCard.module.css` and `SalesOrderDetail.module.css` define
`.suggestList { position: absolute; top: 100%; left: 0; right: 0 }` for the
non-portalled layout, and against a `position: fixed` element `top: 100%` is the
whole viewport height — pinning both edges and squeezing the list to the height
of its own borders. That is what made the fabric picker look like a dropdown
that never opened: it was open, 2px tall, on the bottom edge of the window
(`docs/bugs/0521`). Two call sites had already hand-patched `right: 'auto'` for
the same class's `right: 0`; neutralising the edges in the shared module covers
every consumer instead. A test that asserts the unused edge is ABSENT is pinning
the defect — assert `'auto'`.

Per-SKU `allowed_options` (Modular ON/OFF) filter every pool via
`useModelAllowedOptionsByCode`, exactly as `SoLineCard` does. The REQUIRED axes
per category are the shared `so-variant-rule`; Save is blocked when any line is
missing a required axis.

**Sofa follower-line cascade — ONE module, and the master's LATEST change
wins.** The rule is `frontend/src/vendor/scm/lib/so-variant-cascade.ts`, imported
by `SalesOrderNew.tsx`, `mobile/MobileNewSO.tsx`, `SoLineCard.tsx` and — since
2026-08-21 — `pages/scm-v2/ConsignmentOrderNew.tsx`. The FIRST
line of a category is the MASTER; every later line of that category follows it.
Three outcomes per variant key, in this order:

1. the master MOVED that key since the previous run -> **force** it onto the
   follower, overwriting a value the operator typed by hand;
2. else the follower's own value is blank -> **fill** it (the pick-time
   inherit);
3. else **leave** it — an edit made after the master's last change stands until
   the master moves again.

Rule 1 is the owner's ruling of 2026-08-21, in his words 「第一个沙发再改就拉回去」:
it REPLACES the old `overriddenKeys` veto, under which a follower touched once
was sticky forever and line 1 could never correct it again
(`docs/bugs/0506-a-follower-sofa-line-touched-once-could-never-be-corrected-f.md`).
He gave it AFTER that fix shipped — the first version of the rule was written
into the implementing agent's brief and then reported in code as a ruling he
had already made
(`docs/bugs/0508-the-consignment-order-ran-its-own-copy-of-the-variant-cascad.md`).
"Since the previous run" is a snapshot each form holds in a ref and hands back
to the module; it is what keeps rules 1 and 3 from cancelling each other out.

`overriddenKeys` is still on the draft and still used — by the per-sofa fabric
COLOUR sync in `updateLine` / the mobile FabricPicker, which is scoped to one
physical sofa (`variants.buildKey`), not to a category. It no longer gates the
master cascade.

**Never inherited:** `remark` (per line) and `buildKey` (the build IDENTITY of
one physical sofa — copying it forges a compartment, which reaches the free-gift
trigger and the PDF module grouping;
`docs/bugs/0507-the-variant-cascade-copied-the-master-sofa-buildkey-onto-an.md`).
Fabric identity is additionally held back when master and follower are two
DIFFERENT split sofas.

**Which pages are on it, and which are not.** `SalesOrderNew`, `MobileNewSO`
and `ConsignmentOrderNew` run the live cascade. `DeliveryOrderNewV2` SEEDS from
the same module (`seedableMasterVariants` + `seedFollowerVariants`, so a picked
line never inherits `buildKey` or `remark`) but runs **no cascade** — a follower
line on a delivery order does not follow line 1 afterwards. That is an open
owner decision, not an oversight, and it is named in the module header rather
than left to inference. `soVariantCascadeSingleCopy.test.ts` holds this shape:
it fails if a page re-implements the rule, keeps an `overriddenKeys` veto, or
seeds from a hand-written memo.

**The one deliberate surface difference is a REQUIRED argument, not a default:**
desktop passes `null` (every category cascades), mobile passes
`{sofa, bedframe}` (the only variant panels it renders). `ConsignmentOrderNew`
passes `null` too, matching the desktop SO page it is a clone of.

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

#### What the primary button does on a locked SO — BOTH halves, always

An edit on a processing-locked SO splits in two (`so-field-policy`): FREE fields
save directly, CONTROLLED fields and line changes ride an amendment. The button
must therefore answer THREE questions, not one, and
`vendor/scm/lib/so-amendment-submit.ts` (`planAmendmentSubmit`) is the single
place that does:

| Plan | When | What happens |
|---|---|---|
| `AMENDMENT` | a line changed (incl. its **discount**, mig 0317), or any CONTROLLED header field did | direct half saved, then the amendment raised for approval |
| `DIRECT_ONLY` | only FREE fields (name / phone / email / note) or, on mobile, a staged payment | direct half saved; **no** amendment, and the operator is told so |
| `NOTHING` | both halves empty | the only case that is an error |

Both surfaces share one tail: `DIRECT_ONLY` skips **only** the amendment
creation. Do not reintroduce a single early return covering both halves — until
2026-08-21 that was the shape here, and it asked only about the amendment.
Desktop returned before its direct save ran and **discarded** contact edits;
mobile PATCHed first and then reported "No changes to submit" about work it had
just saved. Same missing question, opposite symptoms; see `docs/bugs/0488-*`.

`hasDirectHeaderChanges()` on `CustomerCardHandle` is derived from the very
patch `save()` would send, so the page cannot be told "nothing to save" about a
patch that would have been sent.

⚠️ **Every key a surface COLLECTS must also be passed as an original to
`withFrozenHeaderFieldsReverted`.** It reverts each amendable key present in the
patch to `original[key]`; an omitted key is `undefined`, which `outValue` turns
into **NULL** — not "leave it alone". Mobile omitted `address1`/`address2` while
still emitting them, so its direct PATCH carried `address1: null` and the server
409'd `so_locked_processing` on every amendment for any SO with an address.
`AmendableHeaderValues` is a `Partial`, so this does not fail to compile.

#### What an amendment LINE can carry — and the rule for extending it

`scm.so_amendment_lines` carries `new_item_code`, `new_variants`, `new_qty`,
`new_unit_price_sen`, `new_remark` (mig 0281) and `new_discount_sen` (mig
0317). The dirtiness test (`amendmentLineSig`, now in
`vendor/scm/lib/so-amendment-line-diff.ts`) is built from EXACTLY that list.
The rule, learned three times (remark 2026-08-11, discount 2026-08-21 — twice
in one day): **a field joins the signature only together with its payload
field, its column, its `applySoAmendment` write — and EVERY reader**: the
`GET /so-amendments/:id` select, the PDF map, and the three view-changes
renders. `git show --stat` the PR that added the previous field and touch every
file it touched (#1992 is the complete map). A signature entry without the channel records
phantom SPEC rows; a channel without the signature entry drops the edit in
silence — and since the DIRECT_ONLY branch exists, "in silence" can read as
*"Saved without an amendment"*, which is worse than an error.

The discount matters because of the **delivery fee**: the fee's unit price is
derived and rebuilt by `rederiveDeliveryFee` on every edit and every amendment
apply, so the line **discount is the only reduction that survives** — typing
125 over a derived RM 250 books `discount_sen = 12500`. On an unlocked SO that
saves directly; on a locked SO it now rides the amendment (clamped to
`[0, qty * unit]` at apply, rendered on the approver's card). The LANE is
decided by item code (`shared/amendment-lane.ts`): the fee is a service line,
so its amendment waits on **Logistics**; a product-line discount waits on
Purchasing.
Fields still without a channel: `lineDeliveryDate`, `description`, `uom`,
`itemGroup`, cost fields — an edit to those on a locked SO still goes nowhere.

The amendment-mode banner and the two-lane "submitted" notice also live in that
module. They were duplicated per surface and had drifted in both wording and
truth — both told operators that address lines "save straight away" for three
weeks after 2026-07-27 moved addresses under Logistics approval.

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

Since 2026-08-28 that state machine is source-parameterised
(`useScmLinePhoto('so' | 'po', …)` — `useSoLinePhoto` is the unchanged SO-shaped
wrapper) and the strip takes a required `source` prop, because the PO detail now
renders the carried copies of these photos through the same component. Same
keys, same R2 objects, shared byte cache — a thumb loaded on the SO detail is
free on the PO detail.

#### Line photos on the printed SO (owner mockup, 2026-08)

`sales-order-pdf.ts` prints photos as ONE "ITEM PHOTOS" block after
the items table and before PAYMENTS RECEIVED — table rows carry NO image; a
line with `photo_urls` appends " (photo)" to its first description line
instead. (Owner print QA 2026-08-28: every generated string is English-only —
a CJK char in generated text made `ensurePdfCjkFont` re-font EVERY
photo-carrying PDF off helvetica — and the labels/sizes below are the v2
ruling.) Each group in the block is keyed by the printed row number (`Item 3`,
or a range `Item 2-4` when consecutive rows carry a deep-equal photo list —
the sofa-set shared build photo prints once per set), with the item code
beside the chip and ~52mm square thumbnails, max 3 per row. A group never splits across pages: one
that does not fit moves whole to the next page under a continued heading. The
grouping/packing/page-fit logic and the drawing live in the shared
`vendor/scm/lib/pdf-item-photos.ts` (unit-tested beside it); the PO and DO
PDFs print through the same module (the per-document blob fetchers —
`fetchSoItemPhotoBlob` / `fetchPoItemPhotoBlob` / `fetchDoItemPhotoBlob` —
sit together in `sales-order-queries.ts`, one proxy contract). Only `.thumb`
siblings are fetched (never originals —
PDF size), through the authed proxy, collected before drawing, and every photo
is best-effort: a key whose fetch or decode fails is skipped silently, so a
missing photo can never fail the PDF. Thumbs uploaded by the client pipeline
are mostly WebP (which jsPDF cannot embed), so the module re-encodes each to a
small square JPEG via canvas. An empty block — no photos, or nothing fetched —
renders nothing at all.

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
`.like(col, '<prefix>-%')` and **no status predicate**, and hands that max to
`scm.next_doc_no_n` as a FLOOR. So a cancelled order keeps its number, still
counts toward the floor, and the next order takes the next integer — contiguous,
never reused.

A hard DELETE (discard draft) leaves a gap, and since migration 0316 that gap is
**permanent in both directions**: deleting the newest draft of a month no longer
hands its number back either, because the counter is a stored row rather than a
query over the survivors. That is the fix for the 2026-08-20 re-issue, not a
regression — see `docs/doc-number-reissue-coe.md` and the 2026-06-12 note in
`scm/lib/doc-no.ts`.

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
4. **Deferred MRP enrichment** (2026-08-18) — the list handler no longer runs the
   company-wide `computeMrp` (its dominant cost). It returns immediately with the
   SHIPPED-only "PO No." chips and stored-status readiness; the client then calls
   `GET /mfg-sales-orders/list-mrp-enrichment?docNos=…` once for the visible page
   and overlays the four MRP-derived fields (READY chips, `stock_remark`,
   `is_main_ready`, `planning_state`). The endpoint's pure assembly lives in
   `backend/src/scm/lib/so-list-mrp-enrichment.ts`; the client side is shared by
   desktop + mobile via `useSoListMrpEnrichmentMap` + `applySoListMrpEnrichment`
   (`frontend/src/lib/soListEnrichment.ts`); the doc set is chunked at 100 so
   mobile's infinite scroll stays bounded and each chunk caches independently.

Invalidation always wins over all three (mutation → invalidate → forced refetch).

---

## 2. API surface

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/api/scm/mfg-sales-orders` | list handler | Grid rows (+ `?summary=1` lightweight bucket mode, `?status=`, `?debtor=`; `?page=` opts into the paginated contract) |
| GET | `/api/scm/mfg-sales-orders/list-mrp-enrichment` | `mfg-sales-orders-list-enrichment.ts` | `?docNos=A,B,C` → `{ enrichment: { [docNo]: { sourcePoReady, sourcePoAdj, stockRemark, isMainReady, planningState } } }`. The deferred, MRP-derived half of the list (see §"why the list opens instantly"). Read-only, company + sales scoped, fail-soft. Registered before `/:docNo` so the static path is not captured as a doc number. |
| GET | `/api/scm/mfg-sales-orders/:docNo` | detail | One SO header + lines. FAST — does NOT run MRP inline (2026-09-01); MRP-derived line fields (`stock_state`, `coverage_po`/`coverage_eta`, `ready_source_pos`, live `stock_status_effective`) return their no-MRP defaults and the client heals them from `/:docNo/coverage` |
| GET | `/api/scm/mfg-sales-orders/:docNo/coverage` | detail | The DEFERRED live Stock column: runs the global `computeMrp` + `soLineReadySourcePos` (the code `/:docNo` stopped running inline) → `{ coverage: [{ id, stock_state, coverage_po, coverage_eta, ready_source_pos, stock_status_effective }] }`, one entry per line. Same company + self-scoped-sales 404 guard as the detail. Read-only, fail-soft. Client calls it after the doc renders |
| GET | `/api/scm/mfg-sales-orders/my-mtd` | MTD scoreboard | Mobile Profile tiles |
| GET | `/api/scm/mfg-sales-orders/mine` | POS board | Salesperson's own orders |
| PATCH/POST | `…/:docNo/*` | mutations | proceed / cancel / amend / payments / etc. |

All under `backend/src/scm/routes/mfg-sales-orders.ts`, except the deferred
`list-mrp-enrichment` endpoint, which lives in its own thin router
`backend/src/scm/routes/mfg-sales-orders-list-enrichment.ts` and is mounted at
the same `/mfg-sales-orders` prefix in `backend/src/scm/index.ts` — BEFORE the
main router, so its static path resolves ahead of `/:docNo`. It shares the
`scm.sales.orders` area guard via that prefix. Auth: inside `/api/scm/*`,
`user.id` is the caller's **scm.staff UUID** (bridge-pinned); use `houzsUser.id` for
the public bigint or you get a 500 (uuid-in-int column).

### Company hazards in this router — HAZARD 1 and HAZARD 2

`mfg-sales-orders.ts` carries two company traps that recur, so they are stated
ONCE here and referenced from the code as `HAZARD 1` / `HAZARD 2`. Five copies of
one paragraph is how a reason stops being read.

**HAZARD 1 — a NULL company is not "unscoped", it is "Houzs".** The customer
resolve RPC is defined by mig 0164 as

```sql
COALESCE(p_company_id, (SELECT id FROM public.companies WHERE code = 'HOUZS'))
```

so passing `p_company_id: activeCompanyId(c) ?? null` does not mean "no
preference" — it means **book it to Houzs**. A 2990 session whose company failed
to resolve would file its customer under the other organisation, with no error.
Both call sites (`createSalesOrderCore` and `patchMfgSalesOrderHeaderHandler`)
therefore use `requireActiveCompanyId` and refuse with a 409 rather than pass a
NULL. Never reintroduce `?? null` on that parameter.

**HAZARD 2 — `pwp_codes` is keyed `(company_id, code)`, and the writes BURN a
voucher.** Mig 0188 re-keyed the table, so a write keyed on `code` alone reaches
whichever company's row sorts first. Six paths do this and all six are
company-filtered:

| path | what an unfiltered write does |
| --- | --- |
| the claim (bulk / create) | burns the OTHER company's voucher |
| the rollback | un-burns the OTHER company's voucher |
| the TBC sofa reward release / re-point | hands the OTHER company's code back to stock |
| the TBC exchange DELETEs (sofa + non-sofa) | **DESTROYS the OTHER company's voucher** |
| the trigger / redeemed re-stamps (both exchanges + SO create) | re-points the OTHER company's voucher at a SKU that is not on its order |
| the kept-code reads that size the mint | mints the wrong NUMBER of replacement vouchers |

> This table said **three** paths until 2026-08-21 and listed only the claim
> side. The exchange paths — the ones that DELETE — were carrying `code` alone,
> the sofa DELETE sixty lines under a correctly-keyed release in the same
> function. Eight statements were fixed; a guide that undercounts a hazard is
> what let them sit. `backend/tests/pwpCodeCompanyKey.test.ts` now fails the
> build on a code-keyed `pwp_codes` statement with no `company_id`, so this
> table cannot go stale in that direction again. Entry:
> `docs/bugs/0496-voucher-delete-on-both-exchange-paths-was-keyed-on-code-alon.md`.

Where the company cannot be resolved these refuse — `409 company_unresolved` on a
route, a thrown error on the command path. **Claiming nothing is the safe
outcome; claiming another company's identically named code is not.** Widening the
filter to every company is never the answer to an unresolved company.

The rollback also carries `companyId` on each claim record rather than
re-resolving it, because the rollback loop runs outside the loop that resolved it.

### The 2990 receiver: `POST /api/sync/so-mirror` — IMPORT-ONCE since 2026-08-20

Not in the table above because it is not a staff endpoint. It is mounted
PRE-AUTH in `src/index.ts` and authenticated by a shared secret
(`x-sync-secret` == `SYNC_SECRET`), because the caller is 2990's DATABASE —
pg_cron + pg_net — not a person. Handler: `routes/so-mirror.ts`.

| inbound | what it does now |
|---|---|
| `{docNo, header, items, payments}`, `doc_no` **absent** for company 2 | imports it: header, then the whole item + payment set. Unchanged from before. |
| `{docNo, …}`, `doc_no` **present** | **writes nothing.** `200 {action:"skipped_existing", skipped:true}` + a `[so-mirror] skipped_existing` warning. |
| `{docNo, deleted:true}`, `doc_no` **present** | **refuses.** `200 {action:"refused_delete", refused:true}` + a `[so-mirror] refused_delete` warning. |
| `{docNo, deleted:true}`, `doc_no` absent | unchanged: the DELETE runs, matches nothing, acknowledges. |

**Why it changed.** Before the 2026-07-21 cutover this was a live replica and
re-applying 2990's copy was correct. After it, Houzs is the WRITER of `2990-`
orders (`HOUZS_OWNS_2990="true"`; the POS creates them here, Houzs mints the
numbers, the readonly wall lifts so staff can edit them) — and the receiver went
on replaying 2990's older copy over those edits. Worse than losing the edit: it
replaced the item set with a DELETE-then-INSERT, and
`delivery_order_items.so_item_id` is `ON DELETE SET NULL`, so every replay
blanked the Delivery Order lines that named those SO lines. Ten such lines
across four documents were live on 2026-08-20, **whole documents at a time**,
which is the shape only a whole-item-set replacement produces.

**How busy is this receiver, actually — measure, do not assume.** 2990's own
`public.sync_outbox` is readable from CI with the credentials this repo already
holds, and `mirror-drift-sentinel.mjs` (workflow **Mirror drift sentinel**)
prints it: on 2026-08-20 it read `source=69 mirrored=102 pending=0 sent=0
done=102 stuck=0 lastDelivery=2026-08-19T08:42:39Z`. So the queue is drained and
has delivered nothing for a day — the outbox is fed by triggers on 2990's OWN
tables, and post-cutover almost nothing writes there.

Two consequences worth knowing before you reason about this route:

- **An empty queue is a state, not a guarantee.** Any 2990-side change, or any
  row that fails and returns to `pending`, re-arms it. That is why import-once
  is the fix rather than "the mirror is quiet now".
- **A "the edit stuck" test proves nothing while the queue is idle.** It would
  also be true of a dormant mirror. The conclusive signal is the
  `[so-mirror] skipped_existing` log line firing for that doc while the value
  survives; the outbox reading above is how you tell whether a delivery was even
  offered during the window.

**Every refusal is 200, deliberately.** 2990's drainer keys on HTTP status;
non-2xx keeps the outbox row PENDING and retries forever, so one refused order
would wedge the queue and every later SO would stop arriving. A skip is a
delivered message we chose not to apply.

**The header is the commit marker.** A first import that dies part-way deletes
the header it just wrote before returning 500, so the retry redoes the whole
document instead of finding a header-only order and skipping it. Pinned by
`backend/tests/soMirrorImportOnce.test.ts`, which is in `MUST_GATE_MERGE`.

**Every decline is RECORDED — `scm.so_mirror_skips`, migration 0311.** This is
what makes the refusal provable rather than merely claimed, and it exists
because of the reading above: while the queue is idle a surviving edit proves
nothing, so the missing fact was "was a delivery even offered?".

| column | |
|---|---|
| `(company_id, doc_no, action)` | primary key. `action` is `skipped_existing` or `refused_delete` |
| `hits` | how many deliveries have been declined for that pair |
| `first_seen` / `last_seen` | `last_seen` is the one an acceptance test turns on |

One row per pair, **never one per delivery** — the drainer retries every 10s, so
append-per-event would grow by 8,640 rows a day per wedged document. The ceiling
is (2990 orders) x 2.

**Reading it:** `node backend/scripts/check-so-mirror-skips.mjs`, workflow **So
mirror skips**. An edit that survived while that doc's `last_seen` moved inside
your wait window is proof import-once held; an edit that survived while it did
not move says only that the mirror was quiet.

Two properties worth not breaking:

- **The write is wrapped and never fatal.** Same rule as mig 0302's delete
  audit: turning a correct refusal into a 500 would put the outbox row back to
  PENDING and wedge the queue, which is the exact failure the 200 avoids. A
  failed record is logged, and the refusal still stands.
- **The reader asserts the COLUMN SHAPE, not a row count.** 0311 is `CREATE
  TABLE IF NOT EXISTS`, so a pre-existing table of that name and a different
  shape would be skipped in silence and the INSERT would fail against it
  forever. An empty table and a wrong table both count zero; only the shape
  check tells them apart.

### The doc number is NOT a tenant key — every `/:docNo/*` read must say so

Document numbers are unique per company by **PREFIX convention** (`HC-`/bare =
HOUZS, `2990-` = 2990) and by nothing else. There is no constraint behind it, so
a `.eq('doc_no', docNo)` on its own resolves whichever company's row happens to
carry that string. The frontend fires the detail panels straight off the URL
(`enabled: Boolean(docNo)`), so a pasted or emailed `2990-` link is enough — no
deliberate act is needed.

Six child reads were keyed that way until 2026-08-18 and served the other
company's Sales Order panels: `/:docNo/audit-log`, `/:docNo/status-changes`,
`/:docNo/price-overrides`, `/:docNo/payments`, `/:docNo/slip-url`, and
`/cross-category-eligibility` via `checkCrossCategorySource`. Two of those are
worse than a row leak — `/slip-url` streams the R2 **object** (the payment slip
image itself), and the eligibility probe returns `debtor_name`, a customer
identity, from a GET needing only a document number. See BUG-HISTORY, 2026-08-18.

**The rule for anything new under `/:docNo/`:**

- a child-table read gets `scopeToCompany(builder, c)` — the same predicate
  `/:docNo/revisions` has always carried;
- a route that also needs the salesperson tier calls `selfScopedSalesBlocked(c, docNo)`,
  whose **step 1** is a `scopeToCompany` read of `mfg_sales_orders`. That is why
  the `/:docNo/payments/:id/*` routes were already safe and were left untouched;
- a helper that cannot express scoping — `checkCrossCategorySource` took only
  `sb` — takes `c` instead of being worked around at the call site.

**`pwp_codes.code` is a natural key too (2026-08-19).** Mig 0188 re-keyed
`pwp_codes` on `(company_id, code)`, but the voucher `code` is caller-supplied, so
a `.eq('code', X)` on its own resolves whichever company's row carries that string
— the same trap as `doc_no`. On SO create the PWP loop now resolves
`pwpCompanyId = activeCompanyId(c)` (refusing `409 company_unresolved` when unset
while codes are present) and carries `.eq('company_id', pwpCompanyId)` on the
prefetch, the atomic burn and the rollback; the two swap-line reads go through
`scopeToCompany`. The already-safe siblings are `lib/pwp-claim-single.ts` and the
add-line path. See BUG-HISTORY, 2026-08-19.

**Do not expect the gate to catch a miss.** `scripts/check-company-scope.mjs`
screens routes on `ID_PREDICATE` (`.eq('id')` / `.eq('*_id')`), so a `doc_no` key
is invisible to it; its natural-key pass understands `doc_no` but walks
`LIB_DIRS` and screens on `LIB_WRITE`, so it sees neither routes nor reads.
`backend/scripts/probe-natural-key-reads.mjs` reports the surface that falls
between the two passes — and its header explains why that count is an upper
bound on exposure rather than a defect list.

### There is no "(me)" — the Salesperson is always a real employee (owner 2026-08-21)

His ruling, on `HC-SO-2608-003`, an order he had raised himself minutes earlier
and which named him **"(former staff)"**: *「『我』不应该存在，永远要是一个真人。」*

`SalesOrderNew` / `MobileNewSO` used to carry a `SELF_SALESPERSON = '__self__'`
sentinel, rendered as `<name> (me)` whenever `resolveSelfStaff` could not find
the creator on the roster, and stripped again at submit
(`salespersonId !== SELF_SALESPERSON ? … : undefined`). **Both are deleted.**
The creator was missing for exactly one reason — `GET /staff/pickable?onlySales=1`
narrows to Sales positions and the owner is not one — so the sentinel was
covering for a roster that had been asked the wrong question. The roster now
always contains the caller (`team-members.md`, *"`GET /staff/pickable` ALWAYS
holds the caller"*), so `selfStaffMatch` resolves to a real `scm.staff` uuid on
every account and three things follow with no further code:

- the Salesperson field seeds to that id and SUBMITS it, instead of omitting it
  and leaving the backend to re-derive the caller;
- `defaultCollectedBy={selfStaffMatch?.id}` is a real id, so the Payments row's
  "Collected By" defaults to the person operating the screen instead of `—`
  (it stays changeable — `PaymentsTable`'s `collectedByAllowedIds` filter has
  always kept `s.id === defaultStaffId`);
- the pickers that must name a STORED `salesperson_id` pass it through
  `usePickableStaff({ onlySales: true, include: [<that id>] })` —
  `SalesOrderDetail`, `SalesInvoiceNew`, `DeliveryReturnNew`,
  `ConsignmentNote/Order/Return New+Detail` and `MobileNewSO`'s edit mode — so
  **`(former staff)` is now reachable only for a row that really is gone**, never
  for a person the filter merely hid.

The 2026-07-22 narrowing is untouched: an ordinary sales user's pick list is
exactly what it was. Trace:
`docs/bugs/0504-the-salesperson-picker-hid-the-person-using-it-so-the-so-sai.md`.

**The consignment order was NOT on that ladder, and it showed (2026-08-21).**
`ConsignmentOrderNew` read `useAuth().staff` from the vendored 2990 bridge
(`vendor/scm/lib/auth.ts:60`) and used it ON ITS OWN. That bridge exists so the
MRP page can ask `isAdminLevel(staff?.role)`; `role` is the ONLY field it
computes, and it returns a hard-coded `null` for `id`, `name`, `staffCode` and
`venueId` on every Houzs user. `useAuth().staff` itself is never null — only its
fields are — so a truthiness check on the object passes and every optional chain
silently yields null. The page therefore:

- gated its salesperson seed on `if (!currentStaff?.id) return`, which could
  never pass, so **Salesperson was never filled in on a consignment order**;
- built the non-admin branch of its picker from the same object, offering **one
  option labelled with the literal text `null (null)`** and an empty value.

`SalesOrderNew` and `SalesOrderDetail` pass those same fields into
`resolveSelfStaff` as ONE RUNG of the ladder above, so the nulls miss and the
ladder falls through — which is why only the consignment page showed it. It is
now on the same ladder. `bridgeStaffIsNotAPerson.test.ts` pins the bridge's
contract and holds every consumer to it. Trace:
`docs/bugs/0510-the-consignment-salesperson-picker-offered-null-null.md`.

### `item_group` is the SKU's — it decides the stock bucket (2026-08-22)

The Sales Order is the ORIGIN of the document chain, and its `item_group` is not
a label: `computeVariantKey(item_group, variants)` composes a sofa's fabric /
seat / leg **only** for a sofa or bedframe group. A line stored as `others` keys
its stock with the product code alone, and every downstream document — PO, GRN,
the inventory movement, the DO's stock check — copies that value faithfully.

`createSalesOrderCore` used to store `it.itemGroup ?? 'others'`. That fallback is
worse than `null`: `null` reads as *unknown*, `others` reads as a category
somebody chose, so nobody questions it.

It now takes the category from `productRowByCode` — the PRICING loader's map,
already read in the same function and already selecting `category`. That costs
no extra query and keeps the read company-scoped in LOCK-STEP with pricing,
which migration 0233 requires by name (both companies keep their own SKU master;
17 codes collided on 2026-08-01). `description2` is built from the same resolved
value. Trace:
`docs/bugs/0514-the-so-to-po-hop-lost-the-category-so-received-sofa-stock-wa.md`.

### Who owns the order — `salesperson_id` (owner 2026-08-17)

Two changes to the header PATCH, both because a resigning rep's orders have to
reach their replacement (*"如果第一个销售人员PIC辞职…"*):

- **`salesperson_id` is no longer identity-locked.** It used to freeze once a
  non-cancelled DO / SI existed — collateral, since those documents snapshot the
  customer, the addresses and the money, never who sold it. Everything else in
  the lock set stays frozen. The set, the rule, and the `agent` carve-out that
  makes the unlock actually work, now live in
  `backend/src/scm/shared/so-identity-lock.ts`.
- **Moving it needs `scm.so.attribute_other`, enforced server-side** (403
  `forbidden_attribute_other`). CREATE always checked that permission; the PATCH
  relied on the SO Detail page disabling the select, which the scope check does
  not substitute for — that only proves the order is the caller's own.

On a hard-locked order the page-level Edit button now opens for a caller who may
re-attribute, with the Salesperson field as the only live control. Bulk handover
(a resignation is fifty orders) has its own routes and guide: **`so-handover.md`**.

Paginated contract (`?page=`) returns `{ salesOrders, total, page, pageSize,
statusCounts, aggregates }`. `statusCounts` carries `all` plus ONE lowercase
bucket per `SO_STATUSES` vocabulary entry (draft / confirmed / in_production /
ready_to_ship / shipped / delivered / invoiced / closed / on_hold / cancelled)
plus `other` (rows whose status is outside the vocabulary — legacy spellings,
blanks), so the buckets always sum to `all`. It is computed by ONE grouped
PostgREST aggregate over the base table (JS-reduce fallback if aggregates are
disabled). `?status=OTHER` filters to exactly that catch-all bucket; every real
status stays an exact match. `?status=all` / `ALL` / empty means the **All** tab
— NO status filter (normalised by `effectiveStatusFilter`,
`scm/lib/so-list-filters.ts`); the raw param is never applied as
`eq('status', …)`, because no order carries the literal status `all`.

> **FIXED 2026-08-18: the list showed "no orders" for a company with 2,726 of
> them.** Two defects zeroed the paginated read (proven with the read-only probe
> `backend/scripts/check-so-list-empty.mjs`: HOUZS base=2726 / view=2726,
> `service_role` reads all 2,726 through the view — the money-rename view recreate
> was NOT the cause). (1) `?status=all` was applied as `eq('status','all')` →
> 0 rows; now normalised to no filter. (2) A page whose offset is at/beyond the
> count makes PostgREST answer `416 "Requested range not satisfiable"`, which the
> handler returned as a 500 and the grid masked as "No sales orders yet"; it now
> returns an EMPTY PAGE with the true count (`isRangeNotSatisfiable`, same lib).

> **FIXED 2026-08-18: a `statusCounts` that could not be READ was served as
> zeros.** The aggregate's error was inspected, the FALLBACK's was not:
> `paginateAll` answers `{ data: null, error }` on failure and the handler did
> `for (const r of (fb.data ?? []))`, so both reads failing produced
> `{ all: 0, draft: 0, … other: 0 }` beside a fully populated `salesOrders`
> page — every tab reading zero with rows on screen, and `all` (the SUM of the
> buckets) understating with them. It is now
> `500 { error: 'status_counts_failed' }` naming both failures, held in a
> variable so the LIST read's own error still reports first. Same guard as the
> PO / PI / SI / GRN / DO lists (`backend/src/scm/lib/status-counts.ts`); this
> list keeps its own reader because it counts by grouped aggregate rather than
> one head-query per bucket. A legitimately empty result is still 0 — that is a
> successful read of zero rows, not an absent answer.

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
fully-shipped lines). The visible chips read
THAT, because the previous content (`converted_po_nos`, the convert-time
raise-link) lied by omission: an accessories/CS SO fulfilled from stock bought
under other POs raises no PO of its own and showed "—" while its drill named
the source PO.

**Since 2026-08-18 the two arms of that union arrive at different times.** The
list handler computes only the SHIPPED arm inline (cheap real-batch reads) and
emits `source_po_union` = shipped-only on first paint. The READY arm needs the
company-wide `computeMrp` — the list's dominant cost — so it is no longer on the
list path: the client fetches it from
`GET /mfg-sales-orders/list-mrp-enrichment` (`sourcePoReady` / `sourcePoAdj`) and
merges it in with `applySoListMrpEnrichment` (sorted set union of shipped ∪ ready,
adj flags OR'd). `Union(shipped-only, ready-only)` per doc equals the old combined
union, so the healed cell is byte-identical to the old inline one — it just fills
in a beat later. Same deferral for `stock_remark` / `is_main_ready` /
`planning_state` (§0.5).

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
is easy to assume otherwise: MRP allocates greedily by the **effective delivery
date** (`scm/shared/effective-delivery.ts` — an overridden line date, else
`amended_delivery_date`, else `customer_delivery_date`), then `doc_no`. It read
`line_delivery_date ?? customer_delivery_date` until 2026-08-18, which meant a
rescheduled order kept its ORIGINAL rank here while the delivery board showed the
new date. The stock allocator (`lib/so-stock-allocation.ts`) reads the same
function, so the two engines cannot drift apart again. An urgent order
inserted with an earlier delivery date DOES re-shuffle the allocation and DOES
take stock and PO supply ahead of a later one — the delivery date is the
mechanism. (The `priority_rank` / `priority_reason` columns exist but have zero
readers; they are not what drives this.)

### The warehouse follows the SO — where the order's warehouse actually lives

Owner, 2026-07-31: **"我们的 item 都不会有仓库, 还是跟着 SO 的"** — an item never
carries a warehouse of its own; the warehouse comes from the Sales Order.

**The header's warehouse is the free-text `sales_location` snapshot, with a
canonical `warehouse_id` alongside it since mig 0309.** For most of this
module's life there was NO warehouse FK on the header at all — that is why people
look in the wrong place — and `sales_location` (written by `warehouseLabel()`,
`lib/warehouse-label.ts`: the warehouse CODE when there is one, else the name,
itself derived from `customer_state` through `state_warehouse_mappings`) is still
the value every reader/writer resolves through. Mig 0309 (batch-3 naming
unification) ADDED a nullable header `warehouse_id uuid -> scm.warehouses(id)`
and backfilled it from `sales_location` (code-then-name, company-scoped, only
where exactly one warehouse matches — 2772 of 2823 rows; the 51 unresolved
`"SLGR WAREHOUSE"` orders in company 2 stay on `sales_location`). It is a
SNAPSHOT that mirrors the per-line binding, NOT yet a read path: `sales_location`
remains the source of truth and is not being dropped. So the SO's warehouse
still resolves as:

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

**The PO SO-drift check resolves the same way** (`lib/so-po-drift.ts`,
2026-08-25, bug 0539). A PO line snapshots its source SO line's warehouse at
proceed time; the drift banner used to compare that against the SO line's RAW
`warehouse_id`, so a NULL line warehouse — inherited from the header — read as
"SO warehouse moved" on a line that never moved (it fired across a rebuilt SO
whose lines all carry NULL). It now resolves the SO line's effective warehouse
first (`so-warehouse.ts::resolveLineWarehouseId`) and flags a move only when both
sides resolve to a real, DISTINCT warehouse (`so-warehouse.ts::warehousesDiffer`).


**A goods line written with NO warehouse now says so** (2026-08-20).
`lib/null-warehouse-signal.ts::signalNullWarehouseRows` is called at all three
SO-line write paths — create (`POST /`), the sofa-split add-line and the
single-row add-line (both `PATCH /:docNo/items`) — and LOGS (never throws)
under the greppable `[null-warehouse]` tag, naming the route, document and
item. It exists because a null here is SILENT downstream: allocation buckets
by (warehouse, item, variant), so the line sits at PENDING with no incoming
PO while its goods sit received in the right bucket — 18 such lines from
three different writers were found on 2026-08-18, none of which said anything.
Service lines are excluded (they hold no stock; a guard that cries on every
delivery-fee line is one somebody turns off). The hourly do-link sentinel
counts the same shape, baseline 10 (the addressless orders below).

Also relevant: `apply_so_header_cas` rebinds `warehouse_id` when the header's
warehouse changes — on the order's **NULL lines** (mig 0173) plus, since mig
0330, the ids the route passes as `p_rebind_line_ids`; the approved-amendment
path (`so-revision.ts`) rebinds every non-cancelled line.

#### The order is born belonging to the operator's store (owner 2026-08-25)

A POS walk-in has no address yet, and until 2026-08-25 the create default
derived the per-line warehouse from the State ALONE — so a no-address order
wrote every goods line `warehouse_id NULL` (2990-SO-2608-045: four of them,
docs/bugs/0541; the hourly sentinel red for days on the same class after the
0501 rebuild). Now the create default is the READ chain applied at write time
— explicit Location, then State — plus one final fallback: **the creating
operator's own store** (`scm.staff.showroom_warehouse_id`, verified in the
ACTIVE company's warehouse master because `scm.staff` is one shared table).
The decision is `so-warehouse.ts::chooseCreateWarehouseDefault` (pure); the
reads are `lib/so-create-warehouse-default.ts`. A resolved Location or State
always wins, and an EXPLICIT Location that resolves to nothing blocks the
store too (the operator said something specific; that case keeps its NULL and
the `[null-warehouse]` signal). The header's `sales_location` falls back to
the same store label, and the single-row / sofa-split add-line paths inherit
the ORDER's warehouse (`resolveSoWarehouseId`) instead of the State-only
derive — so every goods-line write path binds a warehouse whenever the header
has one.

**The 2026-07-22 State-change conflict gate is narrowed to its stated
reason** (`lib/so-state-warehouse-rebind.ts`): a bound line 409s only when a
LIVE downstream PO/DO anchors it (DRAFT POs count as live, same ruling as
`so-po-lock`); an un-anchored bound line MOVES with its order inside the CAS
transaction (`p_rebind_line_ids`, mig 0330). Without this, no state maps to a
showroom, so every store-born order would 409 on the address fill. The anchor
lookup fails CLOSED (unreadable downstream = anchored = the old blanket 409);
the mismatch read keeps its historical fail-OPEN (gate skipped, only NULL
lines rebind). All-or-nothing: one anchored line blocks the whole change.

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

**ONE PRESS, ONE LIST (2026-08-23).** Owner: 「开单要按两次」. The required-field
check and the proceeding-address check were two passes with a `return` between
them, so a form missing one of each named only the first — the operator fixed
it, pressed again, and was told about the second. `soProceedingAddressErrors`
now collects the address complaints and `soRequiredFieldsMessage(missing,
proceeding)` takes BOTH lists, so one press yields the whole list. The
lone-proceeding-field case keeps its own reason rather than being folded into
the generic sentence — the two tests that disagreed about it were right about
the reason and the CODE was what was wrong. Pinned in `so-form-validate.test.ts`.

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
single-warehouse fallback must not rescue them. Company-2990 rows verdict
`mirror-source` — reported with the exact stamp for the 2990 SOURCE database,
never written here. Rule: `classifySoLineWarehouse`,
`backend/scripts/lib/doc-evidence-core.mjs`.

> **The REASON for that verdict expired on 2026-08-20, the verdict did not.**
> This paragraph used to justify it with *"`so-mirror.ts` drains
> DELETE-then-INSERT per SO, wiping local stamps"*. It no longer does — the
> receiver is import-once and never rewrites a doc_no Houzs already holds, so a
> stamp written here now survives. What still holds is that these lines'
> warehouse evidence lives in the 2990 source database, which is why the classifier
> reports rather than writes. If that ever stops being the reason, the verdict
> should be revisited on its own merits, not on this sentence.

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
| ~~Deposit, PER COMPANY~~ | ~~`processing_date_unpaid`~~ | **REMOVED 2026-08-20 by owner ruling — see "THE DEPOSIT IS NO LONGER A SAVE GATE" below.** It was Houzs 30% / 2990 50% of the order total collected (`processingDateThresholdFor` in `order-rules`). No save path weighs it any more, on any surface. The predicate `meetsDepositGate` still EXISTS and is still correct — the orphaned proceed refusal renders it — but nothing live consults it. |
| Customer + delivery complete | `processing_date_incomplete` | customer name, delivery address line 1, postcode, delivery date. **No email** (owner 2026-07-31: "不需要email"). Added 2026-07-31 when the Processing Date and Proceed gates were unified — this half used to apply only to Proceed. (A 2026-07-31 impact measurement over the then-live dated SOs found none blocked by the four kept fields. The figures are not restated here: nothing in the repo re-measures them, and they predate the 0286 rename, so they are a record of that day rather than a current claim.) |
| Date sanity | `processing_date_past` / `delivery_date_past` / `processing_after_delivery` | no fresh past dates (unchanged past dates grandfathered); processing ≤ delivery |

### THE DEPOSIT IS NO LONGER A SAVE GATE (owner ruling, 2026-08-20)

His words: **「以电脑为准 —— 两边都不查」** — the desktop is the standard, and
NEITHER surface checks the money. This is a POLICY change, not a bug fix.

**Why he was asked.** The rule had become a property of the SCREEN rather than
of the order:

| path | before the ruling |
|---|---|
| desktop create (`SalesOrderNew.tsx`) | sent a bare literal `manualEntry: true` on EVERY create — tied to no checkbox and to no operator decision — and the backend dropped the deposit condition for it |
| mobile create (`MobileNewSO.tsx`) | sent nothing, so the phone REFUSED the identical order the desk had just accepted |
| header edit (`PATCH /:docNo`) | no waiver at all. Fires when the patch SETS or CHANGES the Processing Date (an unchanged value is dropped by the normalisation at the top of the handler, so an unrelated header edit never reached it) — so a hand-keyed RM 0 order was accepted at create and then refused the moment anyone RESCHEDULED it, naming a deposit the operator had been told was fine the day before |
| `/status` → IN_PRODUCTION | applied it through `soProcessingDateProblemsForDoc` |
| amendment approve (`so-amendments.ts`) | summed the payment ledger and applied it again |

**What changed.** The condition was removed **where it is decided** —
`ProcessingGateFacts.deposit` and step 2 of `collectProcessingGateProblems`
(`shared/so-save-problems.ts`) are gone, so all five paths above lose it from one
place. The alternative (a second `manualEntry` flag on the phone) would have been
a second copy of the thing that made this surface-dependent in the first place.
`companyCode` went with it on that type and on `soProcessingDateProblemsForDoc`'s
signature — it existed only to pick the deposit fraction, and removing it from
the SIGNATURE rather than ignoring it is what made the compiler name every
caller. That is how the amendment-approve path was found; a grep had missed it.

**What did NOT change, and must not be read as loosened:**

- The other four conditions still refuse — customer name, delivery address line
  1, postcode, delivery date. An order purchasing cannot deliver against is
  still not releasable.
- Variants, colour-KIV, the past-date rules and the pair rule are untouched.
- The deposit is still COLLECTED and still booked; `deposit_sen` is written at
  the create exactly as before. Only the REFUSAL is gone.
- Payments still cannot be recorded against a cancelled order, etc. — none of
  the payment module moved.

**Two live traps this leaves, deliberately out of scope:**

1. **`proceedGateFailures` / `collectProceedGateProblems` (`order-rules.ts`)
   still carry a deposit condition.** They are reachable only through
   `soProceedGateBlocked`, which has had NO callers since 2026-08-18, so they
   refuse nothing today — but whoever wires a future proceed path to them will
   silently resurrect a rule the owner removed. Read this paragraph first.
2. **`pendingDepositSen` is now inert.** Both `SalesOrderNew.tsx` and
   `MobileNewSO.tsx` still compute and send it, and the create no longer reads
   it — it existed only to feed this gate ("GATE-ONLY money, never booked"). It
   is harmless and it is the `optional-param-noop` shape; removing it touches
   `so-slip-optional-contract.test.ts`, which belongs to the SEPARATE
   slip-optional ruling of 2026-08-13, so it was left for a follow-up rather
   than folded in here.

   The exact sites, so the follow-up does not have to rediscover them
   (`git grep -n "pendingDepositSen" -- frontend/src`, run 2026-08-20):

   | file:line | what it is |
   |---|---|
   | `mobile/MobileNewSO.tsx:2061` | the mobile create body's key |
   | `pages/scm-v2/SalesOrderNew.tsx:1587` | the desktop's computation |
   | `pages/scm-v2/SalesOrderNew.tsx:1594` | the desktop create body's key |
   | `vendor/scm/lib/so-slip-optional-contract.test.ts:95,98,130,132` | the contract test that pins both — and the reason this is a follow-up, not a tidy-up |

   Under `backend/src` the only remaining mention is the comment recording the
   removal (`scm/routes/mfg-sales-orders.ts`). No code reads the key.

Pinned by `backend/src/scm/shared/deposit-not-a-save-gate.test.ts` (behaviour)
and `backend/tests/depositGateOffWiring.test.ts` (that no surface re-introduces
it), plus the inverted route-level case in
`backend/tests/soProceedRefusalNamesCondition.test.ts`.

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
elapses (`so-field-policy`). POS "Proceed" marks the order proceeded; it does NOT write
`processing_date` (and no longer writes `proceeded_at` either — that column is
retired, #2396 / mig 0286).

### A sofa never shares an order — `so_sofa_no_other_main`

A SOFA line may not sit on the same document as a BEDFRAME or a MATTRESS line
(PR #519). SERVICE / ACCESSORY / OTHERS ride on any order. One home,
`backend/src/scm/lib/main-mix.ts`, and **every server path that can put a
caller-supplied item code on a line calls it** — the same shape as the date-pair
rule above, and for the same reason: it was hand-written five times and reached
five of eight paths.

| Write path | File | Form |
|---|---|---|
| SO create | `routes/mfg-sales-orders.ts` (`createSalesOrderCore`) | `createMixRefusal` — FLAT |
| SO add-line | `routes/mfg-sales-orders.ts` `POST /:docNo/items` | `lineMixRefusal` — differential |
| SO edit-line | `routes/mfg-sales-orders.ts` `PATCH /:docNo/items/:itemId` | `lineMixRefusal` |
| SO TBC swap | `routes/mfg-sales-orders.ts` `tbcSwapCommandHandler` | `lineMixRefusal` |
| SO amendment SUBMIT | `routes/mfg-sales-orders.ts` `POST /:docNo/amendments` | `amendmentMixRefusal` |
| CO create | `routes/consignment-orders.ts` `POST /` | `createMixRefusal` — FLAT |
| CO add-line | `routes/consignment-orders.ts` `POST /:docNo/items` | `lineMixRefusal` |
| CO edit-line | `routes/consignment-orders.ts` `PATCH /:docNo/items/:itemId` | `lineMixRefusal` |

**FLAT on create, DIFFERENTIAL everywhere else, and the difference is the whole
rule.** A create asks "does this document mix?". Every other path asks "does this
change INTRODUCE a mix?" — `mixesSofaWithOtherMain(after) && !mixesSofaWithOtherMain(before)`
— so an order written before the rule existed stays editable. Putting the create
form on an edit path would make every historic mixed order permanently
uneditable, which is worse than the rule's own failure.

**The sofa EXCHANGE path (`tbc-swap-sofa`) is exempt and says why**: it refuses
`prev.item_group !== 'sofa'` and refuses a replacement whose catalogue category
is not SOFA, so it is SOFA → SOFA by construction and cannot move a MAIN
category. That exemption is recorded in the wiring test, not in prose.

**A failed read is not a pass.** Each function returns `MixRefusal | null`, never
a boolean: 400 `so_sofa_no_other_main` when it mixes, 409
`sofa_mix_check_unavailable` when the line or catalogue read failed. The earlier
helper discarded its read error, which made a blip look like an empty order and
an empty order can never mix.

**The client check is a SECOND implementation on purpose** — it must refuse
before a request, and it reads free-text `itemGroup` where the server reads the
catalogue enum. It has the same two forms: `hasSofaMixConflict` (flat) on the
New-order surfaces, `sofaMixIntroduced(before, after)` on the EDIT surfaces, both
in `frontend/src/vendor/shared/so-variant-rule.ts`. An EDIT surface using the flat
form refuses saves the server would accept.

**That is not hypothetical, and the phone was the last one holding it.**
`frontend/src/mobile/MobileNewSO.tsx` renders new AND edit as one form, and its
`save()` ran the flat form ABOVE the edit branch, so on an order written before
the rule existed a rep could not save ANY change from the phone — not a phone
number — while desktop's `SalesOrderDetail.tsx` had moved to the differential
form in #2395. Fixed 2026-08-20: mobile now calls
`sofaMixIntroduced(origItems, edited)`. `origItems` is empty on a create, so on
that path the differential form IS the flat question and nothing changed there.

**The enumeration is a TEST, not prose**: `backend/tests/mainMixOneHome.test.ts`.
Its population is every unit in the two routers that runs `validateItemCodes`, so
a NEW line-write path fails it without anyone remembering to add a row here.

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

**"CLEARED" IS `=== undefined`, NEVER `typeof === 'string'`.** The forms send a
cleared date as JSON `null` (`payloadFor`: `f.processingDate || null`), so a
handler that decides "did this request name the key?" by asking whether the value
is a string reads a clear as ABSENT and judges the pair against the row it is
replacing rather than the one it will leave. Both header PATCHes now derive the
effective value through `effectiveDateAfterPatch` (`scm/lib/date-coerce.ts`),
which uses the same coercion the write does. Removing BOTH dates was refused for
being unpaired, and removing only the delivery date was accepted and applied —
`docs/bugs/0578-*` has the reproduction of each.

**The one deliberate exclusion is the 2990 mirror** (`routes/so-mirror.ts`). It
replicates rows 2990 already committed; a non-2xx keeps the row PENDING in
2990's outbox and its pg_cron drainer retries forever, so one legacy unpaired
company-2 order would wedge the queue behind it. The rule for company 2 belongs
in 2990's own write paths. The route says so in a comment, and
`tests/soDatePairWiring.test.ts` asserts the comment is still there.

**Since 2026-08-20 that exclusion is a ONE-TIME exclusion, and it shrank on its
own.** The receiver is import-once: it writes only a `doc_no` company 2 does not
already hold, and every later delivery of the same order is a no-op. So the
unpaired-dates exemption now covers the FIRST import of a legacy order and
nothing else — every subsequent state of a 2990 order is authored in Houzs, by a
path that does run the pair gate.

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
date), and the threshold became per-company. The money half was one predicate,
`meetsDepositGate`, read by both — **and since the owner's ruling of 2026-08-20
the aggregated save report no longer reads it at all** (see *THE DEPOSIT IS NO
LONGER A SAVE GATE* above). The two cannot disagree about a deposit because only
one of them still has an opinion, and that one is the orphaned proceed refusal.

**PROCEED IS THE DATE (owner, pinned 2026-08-13).** *"只要有 Processing Date，就
代表他 Proceed 了。Proceed 的日期是他填入 Processing Date 的日期。没有 processing
date 就代表没有 proceed。"* Proceeding therefore WRITES `processing_date`; it
does not stamp a click time. Until 2026-08-13 every proceed path wrote only
`proceeded_at`, so an order could sit IN_PRODUCTION with no release date at all
— and nothing ever told purchasing the order was theirs to order.

| Path | Where the date comes from |
|------|---------------------------|
| `PATCH /:docNo/status` → IN_PRODUCTION | the order's own `processing_date`, else `processingDate` on the request body (`readSoProcessingDateFromBody`, which reads the canonical key FIRST and still accepts the legacy `internalExpectedDd`); a date written here clears the FULL gate table above **and the pair rule**, read live off the row |
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
a guessed date releases a real order to purchasing on the wrong day with nothing
to show that the date was guessed. A date already on the order is never
MOVED by a proceed — rescheduling belongs to the header PATCH, which owns the
lock and the gate table. `proceeded_at` is now neither written nor read: #2396
moved its last reachable decision (the stock allocator's gate) onto
`processing_date`, and this change removed the three remaining writes — the
create INSERT's stamp, the /status IN_PRODUCTION stamp, and the header PATCH's
`proceededAt` key. It is no longer what makes an order proceeded, no lock or
payload consults it, and the column awaits only its DROP — which is one deploy
behind the code on purpose.
Net effect: the proceed paths LOOSENED by one condition (email), the
processing-date path TIGHTENED by four (name / address / postcode / delivery
date), and the threshold became per-company.

**WHAT WAS UNIFIED IS THE RULE, NOT THE FUNCTION — there are TWO enforcement
sites, and changing one does not change the other.** This paragraph read
"`meetsProceedGate` is the single rule behind ALL of it" until 2026-08-13, and
that is not what the code does:

| path | enforced by |
|---|---|
| create-time auto-stamp of `proceeded_at`, and both manual proceed paths (`PATCH /:docNo/status` → IN_PRODUCTION and `PATCH /:docNo` `proceededAt`) | `meetsProceedGate` (`order-rules.ts`). The create site reads it directly; both manual proceed paths reach it through `soProceedGateBlocked` (`backend/src/scm/lib/so-proceed-gate.ts`) → `collectProceedGateProblems` (`so-save-problems.ts`) |
| setting the processing date | `so-save-problems.ts` `collectProcessingGateProblems` — the four completeness conditions, the variant / KIV rules and the date rules. **No money term since 2026-08-20** (owner ruling). It contains **zero** references to `meetsProceedGate` and, now, zero to `meetsDepositGate` |

Both sites read the same per-company threshold through the shared
`processingDateThresholdFor` and demand the same four facts, so the rule is one
rule TODAY. The two PREDICATES are still one rule by agreement, not by
construction — edit either and re-check the other. Believing the two shared a
function is how a rule change would land on half the system.

Their WORDING, since 2026-08-18, is one table by construction: both render every
condition through `completenessProblem` / `depositProblem` in `so-save-problems.ts`,
which differ only in a trailing clause ("before a Processing Date can be set" vs
"before this order can be proceeded"). `tests/soProceedRefusalWiring.test.ts`
fails if either grows its own sentence.

**A REFUSAL NAMES THE CONDITION THAT FAILED (2026-08-18).** The proceed paths
used to refuse with ONE stored sentence naming all five conditions whenever any
single one was unmet. On 2026-08-17 that cost the owner a day: he read the word
"deposit" on a ZERO-TOTAL order and chased a money bug that did not exist — the
deposit term is vacuously met at `total <= 0` (`meetsDepositGate`), and the order
was missing its postcode. The 422 body now is:

```json
{
  "error": "proceed_gate_unmet",
  "reason": "Delivery postcode is required before this order can be proceeded",
  "problems": [
    { "code": "processing_date_incomplete",
      "message": "Delivery postcode is required before this order can be proceeded",
      "field": "Postcode" }
  ]
}
```

`error` is unchanged — clients match on it, and this is additive. `problems` is
the SAME aggregated key the save gate uses (`validationFailedBody`), so the
surfaces that already render every reason at once (`parseSaveProblems`, owner
2026-07-18) picked it up with no client change. The deposit line states the real
shortfall (paid, needed, company %) and **never appears for a zero-or-negative
total** — `depositProblem` asks `meetsDepositGate` rather than testing the total
itself, so it cannot drift back.

`meetsProceedGate` is now DEFINED as `proceedGateFailures(i).length === 0`. The
verdict and the list of reasons are one expression, not two readings of one rule
— which is the only shape in which they cannot disagree about an input.

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
`scm.mfg_sales_orders` and on the consignment twin.

**AND NOW `proceeded_at` IS BEING RETIRED (owner 2026-08-18).** This paragraph
said the opposite for five days — *"`proceeded_at` is NOT being retired … it is
a live, separate column"* — on the argument recorded in `order-rules.ts`: an
audit stamp is a different KIND of fact from a date a user picks, so what was
unified was the RULE, not the storage. The owner has overruled that FOR THE
PURPOSE OF DECISIONS, naming the scope himself: frontend, backend and database.
His reason is the one the bug record supports — every Processing-Date bug this
repo has had came from there being more than one of them.

Where it stands after 2026-08-18:

| layer | state |
|---|---|
| frontend | **Done.** No type, no query select list, no component field mentions it. `procLockActive` decides on `processing_date` + `status`; `status` is now a REQUIRED parameter, which is what replaced the status-blind `proceeded_at` fallback. |
| backend, locks | **Done.** `soProcessingLocked`, `soEditLocked`, the amendment door and `delivery-planning`'s board guard all read `processing_date` + `status` only. |
| backend, payloads | **Done.** The SO list projection, the detail select, the POS board select, the dashboard summary and the `/status` response no longer carry it. Nothing consumed any of them. |
| backend, the leak | **Done.** Remove-Processing-Date used to clear the date and leave the stamp, which the stamp-once filter then froze permanently — the one live path that manufactures a split row. The header PATCH now clears both together. |
| backend, the allocator | **Done (#2396).** `allocGated` reads `processing_date`. Its measured blast radius — which #2396 shipped without — is in the bullet in §"Allocation" above. |
| backend, the writes | **Done, and only after the read moved.** The create INSERT's stamp (and `autoProceed`, which existed only to decide it), the `/status` IN_PRODUCTION stamp, the `['proceededAt','proceeded_at']` PATCH-map entry and its stamp-once filter are gone. Stopping the writes while the allocator still read the column would have landed every NEW order with a NULL stamp and gated it out of allocation forever, so the order mattered. |
| database | **The one step left, and deliberately NOT in this release.** `deploy.yml` runs `pg-migrate` BEFORE `wrangler deploy`, so a column dropped in the same release that stops selecting it 42703s every SO read for the length of the deploy (that is #1191/0189). Once this commit is live, nothing reads it and the drop is 0284's shape. The exact SQL, and the view-ACL trap it must clear without dropping the view, are in `shared/so-processing-date.ts` under "RETIRING THE SECOND STORAGE". |

One writer nobody had counted: **the 2990 mirror.** `routes/so-mirror.ts` upserts
`applyMap(body.header, …)`, which keeps every inbound key that exists on the
Houzs table — so a `proceeded_at` arriving from 2990 (a separate repo on its own
deploy schedule, which never got the 2026-08-13 unification) was written straight
through. It needs no code change: `applyMap` filters against
`information_schema`, so the drop silently ends it. Until then it is the only
thing that can still put a value in the column, and nothing reads it.
*(Narrowed further 2026-08-20: import-once means it can only do so on an order's
FIRST arrival, so the reachable population is new legacy imports, not every
re-delivery of every company-2 order.)*

Also gone with the writes: **`soProceedGateBlocked`**, whose two call sites were
the `/status` stamp block and the header PATCH's `proceededAt` branch. The RULE
did not move — every path that sets a Processing Date runs
`collectProcessingGateProblems`, which checks the same four completeness facts
inline and the money through `meetsDepositGate`; after unification that is every
path that proceeds an order.

> **The "TWO enforcement sites" table below is now ONE site and TWO orphans.**
> #2383 landed hours earlier and lifted the proceed gate into
> `backend/src/scm/lib/so-proceed-gate.ts` with a per-condition refusal. Removing
> the last two call sites leaves both that module's `soProceedGateBlocked` and
> `order-rules`'s `meetsProceedGate` with no caller in routes, lib or the
> frontend. **Neither is deleted** — deleting a freshly-shipped export to tidy a
> merge is how work gets silently undone, and a future proceed path that needs to
> refuse should call it. The table warned that the two enforcement sites were held
> in step *"by agreement, not by construction"*; that agreement now has one party,
> `collectProcessingGateProblems`. Full note at `soProceedGateBlocked` itself. The `/status` branch it guarded fired only when the order
ALREADY carried a date, i.e. it re-gated a state that had already passed the same
gate — and inconsistently, since an order that also carried a stamp was not
re-gated at all.

Only the CONSIGNMENT twin is already gone (mig 0284), because that one had zero
readers and zero writers.

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
| `backend/scripts/scale-pg-real-schema.mjs` + `tests/scaleRouteDrift.test.mjs` | A hard-coded column list `deepEqual`'d against the route's `HEADER`. **Loud** — it is the tripwire, and it is meant to fail. Note it also appends `, proceeded_at, paid_total_sen, balance_sen_live` as its own literal, so retiring `proceeded_at` needs an edit here too. | left loud on purpose |
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

> **WHAT THE DATE MEANS — owner, 2026-08-18, correcting this repo.** *"因为我们
> 有时候开单，未必是要直接 Processing 这张单的。所以 Processing Date 就代表这张单
> 可以安排订货了，然后过了一天我们才会落下来，然后采购才会去订货"*. **The
> Processing Date is the date this order is RELEASED FOR PURCHASING TO ORDER
> GOODS.** Raising an order is not the same as acting on it; setting the date is
> the release signal, and roughly a day later the order drops through and
> purchasing places the order.
>
> **There is no production scheduling in this business.** *"我们都没有排产的，我们
> 都不是 Production，我们应该只是送货的日期而已"*. Every comment and doc line that
> called this a "go-to-production" date or reasoned about a "factory queue" was
> describing a business that does not exist. Those were rewritten on 2026-08-18
> and `so-processing-date-names.test.ts` fails if one comes back.
>
> **NOT IMPLEMENTED, and not to be claimed.** The ~1 day lag is a fact about the
> business, not about this code. Nothing defers anything by a day, and MRP does
> not read this date to decide when to order at all: it derives `orderByDate =
> delivery date − category lead days` and only DISPLAYS the Processing Date. The
> comment at `routes/mrp.ts:193` said the field "drives when to order" for months
> while the code ignored it — adjacent evidence, not evidence.

> **UPDATED 2026-08-18 — the names, and how many of them could actually go.**
> Owner: *"全部你都是要统一掉的，不要那么多个"*. Seven names existed for this one
> fact. `processing_date` (column) and `processingDate` (payload key) are THE
> names. `proceeded_at` stopped being read by any decision in #2396.
>
> **Four of the remaining five could NOT be retired, and that is the finding, not
> the shortfall.** `PDate` is **AutoCount's own UDF name** — it belongs to the
> other system, and renaming it here would only stop the value arriving there.
> `internal_expected_dd` / `internalExpectedDd` are each a name a **queue outside
> this deploy** still carries. `target_date` looked deadest of all and is
> **actively written by the POS** — 46 orders in 90 days.
>
> Every one of those four is blocked by something OUTSIDE this repository, and
> not one of them could be seen from the source. The exact preconditions live on
> their constants in `backend/src/scm/shared/so-processing-date.ts` and are
> *measured*, not described, by section F of
> `backend/scripts/probe-rename-preconditions.mjs`.

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
| `scm.mfg_sales_orders.proceeded_at` | The TIMESTAMP the system used to stamp when an order was Proceeded. **The SAME fact in the wrong shape**, not a different one — "proceeded" IS "has a Processing Date" (owner, pinned 2026-08-13). Its last reachable decision was `recomputeSoStockAllocation`, which gated on it (NULL ⇒ every line forced PENDING) **while no shipped client wrote it** — the #2396 defect. | **RETIRED IN CODE 2026-08-18; the column awaits its DROP.** This row used to read "stays a separate column ON PURPOSE. What was unified with the Processing Date is the RULE, never the storage" — overruled by the owner: one concept, one storage, all three layers. #2396 moved the gate; this PR removed the writes that only existed to feed it, so **no code reads or writes it any more**. The DROP is one deploy behind on purpose (see the `database` row above) — `pg-migrate` runs before `wrangler deploy`, and the live Worker still SELECTs it. Nothing ever read the value AS a timestamp: the desktop Proceed Date field was deleted 2026-06-05, the dashboard hook carrying it has zero callers, and no export or AutoCount payload names it. The "when" is already in `scm.mfg_so_audit_log`, which nothing gates on. Do not add a new reader. |
| `scm.mfg_sales_orders.processing_date` **(the OLD one, 2025–2026-08)** | Dead legacy snapshot that squatted on this name. Had no writer after PR #140, so it was NULL on every SO created/edited since — and rendered blank wherever someone bound to it (BUG-HISTORY: "SO read views showed a blank Processing date"). | **DROPPED — mig 0189.** The name was then free, which is why 0286 could take it. Do not confuse this dead column with the live one in row 1. |
| `scm.consignment_sales_orders.proceeded_at` | Never anything. Existed only because the consignment module was cloned from `mfg_sales_orders` wholesale; on this table it had zero readers and zero writers, ever. | **DROPPED — mig 0284** (`0284_retire_consignment_proceeded_at.sql`). |
| `scm.consignment_sales_orders.processing_date` **(the OLD one, mig 0153)** | Same clone artifact. Zero writers ever (the create INSERT omits it; the header PATCH builds its update from a closed allowlist that never contained it), so it was NULL on every row. | **DROPPED — mig 0286, step 1.** No longer a follow-up: 0286 had to clear this dead name before it could rename the live column onto it, and its guard drops it only while BOTH names are present, so a re-run cannot take the users' dates. |
| `public.sales_orders.ac_udf_pdate` | AutoCount's own UDF field `SO.UDF_PDate`, mirrored verbatim by `services/pull.ts` for AutoCount's document. Never the ERP's date; nothing joins the two. Read by nothing. | **RENAMED → `ac_udf_pdate`, mig 0285.** Kept (not dropped) because the mirror's job is to be a faithful local copy for AutoCount reconciliation — the harm was the name, not the data. |
| **`PDate`** — AutoCount's UDF key, not a column of ours | The name the ERP WRITES the Processing Date out under, at `services/autocount-writeback.ts` (create + the clearable-UDF map) and `scm/lib/so-edit-header.ts` (edit). | **EXTERNAL. NEVER "UNIFY" IT** — pinned as `SO_PROCESSING_DATE_AC_UDF`. AutoCount matches UDFs by NAME: rename it and the connector drops an unknown key, the document posts **200 without it**, and every Processing Date silently stops reaching the account book. Both write sites carry the warning; the guard test fails if either loses it. |
| `scm.mfg_sales_orders.target_date`, `scm.consignment_sales_orders.target_date` | The POS-era **"Target Date"** stamp. PR #140 dropped the field from the SO form — *"targetDate → replaced by Processing + Delivery Date"* — and `grep -rn targetDate frontend/src native e2e` returns **zero**: no client in *this* repo sends the key. It is nevertheless accepted on four write paths, selected into three read shapes and typed on two frontend rows. Every signal inside the repo says dead field. | **LIVE — NOT RETIRED. Do not sweep it.** Prod, 2026-08-18 (`probe-rename-preconditions.mjs` section F): **46 of 2826 SO rows carry one and ALL 46 were CREATED inside the last 90 days**, newest 6.75 days old. A row born with the value was given it at create and the ERP has not written it at create since #140 — so **the POS handover is still sending it**, and `routes/reports.ts` still reads it into the sales-report export. The 2026-08-18 sweep removed the name from all eight sites and **put every one back the same day** once the probe answered. `SO_TARGET_DATE_RETIREMENT_BLOCKED` records it and the guard test fails if a door is closed again. |
| `public.sales_entries.processing_date` | The LEGACY NATIVE Sales module's date (`/sales`, `Sales.tsx`, mig 070). **The SAME CONCEPT** — owner 2026-08-18, overruling an earlier census that recommended treating it as separate: *"全部我们只有一个 Processing Date"*. What differs is the ROW: a `sales_entry` has no SO row, no doc flow, and none of the SO **machinery** — no deposit gate, no KIV/variant gate, no elapsed-date lock, no `scm.so.remove_processing_date`, no stock allocation, no pair rule. | **KEPT under this name — it already spells the canonical word.** Unified in stages. **Stage 1 shipped 2026-08-18:** the module now ACCEPTS the canonical `processingDate` too, folded onto the stored key on all four roads in (create, direct PATCH, change-request queue, approve replay) by `canonicaliseSalesEntryBody`. **Stage 2 (retiring the old inbound key) is NOT shipped** and must not be done blind: `applyEntryPatch` builds `SET ${k} = ?` from allowlisted keys and the approval path replays a payload stored days earlier, so a dropped key is **silently ignored on approve**, with no error. Precondition and the exact `SELECT` are on `SO_FORM_TEXT_FIELDS` in `routes/sales.ts`. Same name, same meaning — still **never coalesce or join the two tables' rows.** |

Three rules follow from the table.

**Never add a new name.** If you need the SO's Processing Date it is
`scm.mfg_sales_orders.processing_date`, read through `SO_PROCESSING_DATE_COLUMN`,
full stop. A column name inside a string is invisible to the compiler: the
`/status` proceed block kept selecting, comparing and WRITING
`internal_expected_dd` after the rename, and nothing failed to build.

**Never rename a name this repo does not own.** `PDate` is AutoCount's, and the
`ac_udf_pdate` mirror exists to be a faithful copy of AutoCount's field. A sweep
that "unifies" either one changes nothing in AutoCount and silently stops the
value arriving there.

**Unify the NAME, never the ROWS.** The owner's *"全部我们只有一个 Processing
Date"* is about vocabulary: one word, one meaning, everywhere. It is not licence
to coalesce `sales_entries` with `mfg_sales_orders`, or either with AutoCount's
mirror — those are different documents that now correctly share a word.

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

> **`venue_required` is only satisfiable on a surface that HAS a Venue field
> (2026-08-25).** "When it resolves nothing, confirm demands a human pick" is
> true of the desktop and the phone — `SalesOrderNew.tsx:1911` renders a Venue
> dropdown over the 92 `project_venues` rows (owner 2026-06-22, *"houzs 的 venue
> 是 manually 選的"*). The 2990 POS handover had no such field and sent no venue,
> so its users hit this problem AFTER the customer had signed with nothing on
> screen that could answer it.
>
> Measured the same day (`probe-so-venue-gate`, runs 32827817087 / 32826133061):
> **0** PMS projects were running, **83 of 90** active staff resolved no venue
> from any source, and exactly **one** warehouse in the system carries a
> `venue_name` (`PJ SHOWROOM`, company 2). Between exhibitions this gate is
> unsatisfiable by resolution alone for almost everyone — the picker is the
> answer, not the resolver. Fixed POS-side in `wenwei4046/2990s#774`; full trace
> in `docs/bugs/0539-the-confirm-gate-demanded-a-venue-the-pos-screen-had-nowhere.md`.
>
> **A confirm can pass this gate and still store NO venue.** The rule reads
> `venue` OR `venue_id`, but `venue_id` is a uuid column and `project_venues` ids
> are INTEGERS, so `venueIdUuidOrNull` (`mfg-sales-orders.ts:746`) nulls any id a
> client sends. A payload carrying only `venueId` is accepted and lands blank,
> silently. Any new client must send the venue TEXT.

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
summed inside the transaction before and after — `unit_price_sen`,
`total_sen`, `unit_cost_sen`, `line_cost_sen`, `special_order_price_sen`,
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
Save-as-draft skips both.

> **"Is this me?" is ONE module, not one per screen** (2026-08-20). The
> salesperson pre-check above only fires when the creator was not recognised on
> the staff roster, and mobile matched email-then-name while desktop had moved to
> `user_id` first in #2049 — of 140 production `scm.staff` rows 18 carry an email
> and 102 carry `user_id`, and `user_id` is what the backend joins on
> (`resolveOwnerStaffId`). So the MAJORITY of salespeople were not recognised as
> themselves on the phone and could be refused by this very gate. The ladder now
> lives in `frontend/src/vendor/scm/lib/self-staff.ts` (`resolveSelfStaff`:
> user_id → bridge staff id → email → name) and both `SalesOrderNew` and
> `MobileNewSO` call it; the desktop ladder was moved verbatim, so that screen is
> unchanged. `SalesOrderDetail.tsx` still holds a third copy for the Add-Payment
> "Collected By" default — knowingly, because switching it would change which
> people that picker matches. **Neither pre-checks variants at CONFIRM** — that
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

### A payment on the ORDER now settles the INVOICES raised off it (2026-08-23)

Until this date the money stopped here. `scm.mfg_sales_order_payments` and
`scm.sales_invoice_payments` were two ledgers with no link, so an order carrying
a MYR 2,000 deposit produced an invoice reading "No payments recorded yet" with
the full total outstanding — the office chased money already in the drawer
(`docs/bugs/0525-payments-taken-on-the-sales-order-never-reached-the-sales-in.md`).

**Nothing is copied and nothing extra is posted.** The invoice side READS THROUGH
to this ledger; the rule and the reasoning live in
`docs/modules/sales-invoice.md`, *The deposit taken on the SALES ORDER*, and
since 2026-08-23 EVERY invoice surface reads it through one served field,
`so_deposit_applied_sen` (same guide, *ONE field name, on every surface*). What
changes on the ORDER side is one hook: every writer of this ledger now re-rolls
the statuses of the invoices raised off the order, so the invoice list cannot
fall behind.

| Writer | Where | Re-rolls the invoices |
|---|---|---|
| `POST /:docNo/payments` and `scan-so.ts`'s receipt booking | `recordSoPaymentRow` (`scm/lib/so-payment-row.ts`) | yes — from the shared CORE, so both writers get it |
| `PATCH /:docNo/payments/:id` | the route (it has no shared core) | yes |
| `DELETE /:docNo/payments/:id` | `afterSoPaymentRemoved` (`scm/lib/so-payment-row.ts`) | yes — a reversed deposit must put the invoice back on the chase list |
| the two deposit inserts on SO CREATE | `mfg-sales-orders.ts` | no, and correctly: no invoice exists for the order yet |

Best-effort throughout, exactly like the AutoCount enqueue and the GL posting
beside them — a failure never fails the operator's save, and the next roll
self-heals.

### Payment methods: THREE choosable, FOUR protected — and one list feeds every picker

Every payment dropdown on both surfaces renders from **`scm.so_dropdown_options`**
through `useSoDropdownOptions(category)` + `optionsOrFallback(category, data)`
(`frontend/src/vendor/scm/lib/so-dropdown-options-queries.ts`). Categories:
`payment_method` -> then one of `payment_merchant` + `installment_plan` (Merchant),
`online_type` (Online), or nothing (Cash).

**Three is what an operator may CHOOSE. Four is what the API refuses to delete.**
They are different questions and conflating them has now produced two wrong
comments and one wrong picker:

| | value |
|---|---|
| selectable `payment_method` rows | `Merchant`, `Online`, `Cash` — mig 0037 deactivated the L1 `Installment` row; an EPP receipt is Merchant plus an `installment_plan` tenure |
| rows `PAYMENT_METHOD_CORE_VALUES` protects | those three **plus `Installment`** — re-locked 2026-08-13 so the deactivated row historical payments point at cannot be deleted (`scm/shared/payment-methods.ts` carries that trace) |
| `payment_merchant` banks | the twelve mig 0037 seeds, including Pinelabs / AEON / HSBC |

`POST /so-dropdown-options` refuses the `payment_method` category outright;
`PATCH` refuses a VALUE edit or `active: false` on a protected row; `DELETE`
refuses a protected row entirely.

**`FALLBACK_OPTIONS` is a hand-written copy of that table and it rots.**
`optionsOrFallback` returns it whenever the API is loading or answers zero rows,
so it is what an operator sees on a cold load — on BOTH surfaces. It offered the
retired `Installment` and held nine of the twelve banks until 2026-08-20. It is
now pinned against mig 0037 by
`frontend/src/vendor/scm/lib/so-dropdown-options.fallback.test.ts`, which PARSES
the migration rather than restating it, so a later migration that changes either
set fails the test until the fallback moves with it.

**Never re-guard a value against a static list after the catalog has spoken.**
Two instances, both now removed:

- `MobileNewSO` re-checked a scanned payment method against a `PAY_METHODS` array
  built from `FALLBACK_OPTIONS`, on top of a value `reconcilePayment`
  (`vendor/scm/lib/scan-prefill.ts`) had already snapped against the live
  catalog with `snapValue` — and which returns `null` rather than a bad method.
  It dropped nothing while the static list happened to be a superset and was one
  maintenance edit from silently blanking a correct scan. This is the same
  correction the file's own header records for customer type and building type.
- `RecordedPayments` (the mobile recorded-payment edit sheet) rendered its
  **Method** select from a hardcoded `["Cash","Merchant","Online","Installment"]`
  while the three sub-pickers beside it already read the catalog. Now
  `withStoredOption(optionsOrFallback("payment_method", ...))` like its siblings —
  `withStoredOption` grandfathers a stored value back in as an option, which is
  what stops a controlled `<select>` displaying its FIRST option while state
  holds the real one.

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
lock, re-derive → header stamp in one call — the duplicate-fee race fix;
migration **0310** made the re-derive REUSE its rows, see "the line keeps its
identity" below).

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
`delivery_fee_sen`** — the dormant-fee rule: backend-authored SOs never grow
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

**Reducing the fee on ONE order (2026-08-19): use the line's DISCOUNT, and it
survives.** Typing a lower unit price on a fee line was never going to hold —
the rebuild derives the price, one truth — and until this date the discount
road was silently dead too: the line PATCH accepted a bounded discount on a
delivery line, and the very next rebuild wrote `discount_sen: 0` over it. An
operator who typed 250 → 125 watched the line "nuke to 0 and disappear"
(the rebuild deleted and re-inserted the `SVC-DELIVERY*` set). Now the rebuild
recovers each fee line's discount by `item_code`, clamps it to the rebuilt
line's own total (a fee line can never go negative), and re-applies it — so
the SO prints unit 250 / discount 125 / total 125, which is how every other
price reduction on an SO is expressed. The header mirror carries the NET, so
Σ(lines) === header still holds. The `SVC-DELIVERY-ADD` gross is recovered
from unit × qty rather than `total_sen`, or a discounted ADD line would
compound the reduction on every save. A component that disappears on rebuild
(the base swapping to CROSS on a follow-up change) drops its discount rather
than migrating it to money it never named.

**The line keeps its identity (2026-08-20, migration 0310).** The rebuild now
UPDATEs the fee lines in place instead of deleting and re-inserting them
(`backend/src/db/migrations-pg/0310_scm_rebuild_so_delivery_lines_keeps_identity.sql`
— this module owns that RPC; the earlier bodies are 0214 and 0305).
This is not tidiness — **a Delivery Order can carry a delivery-fee line**
(`routes/delivery-orders-mfg.ts` records Nico's DO for 2990-SO-2606-034, blocked
on `SVC-DISPOSE-SOFA` and `SVC-DELIVERY-CROSS` being "short" at BALAKONG), and
`delivery_order_items.so_item_id` is **ON DELETE SET NULL** (0235). So every
single fee change used to blank the link of any DO that had shipped that fee,
and left an SO that still showed a delivery line — a *different row wearing the
same `item_code`*, which is why an investigator checking "is the line still
there?" sees yes. That appearance is why 0302 set the FK theory aside; only
`created_at` distinguishes the two, and `scm.mfg_so_item_deletions` now records
the deletes directly. Rows are matched per `item_code` by their **position in
the specs array**, because `buildDeliveryFeeServiceLines` emits
`SVC-DELIVERY-CROSS` twice on a follow-up that also crosses categories — so
keep that order stable. A component that genuinely disappears is still deleted,
and still takes its link, which is correct: the line it named is gone. This is
also the precondition for ever exposing an editable delivery charge — without
it, every edit manufactures an orphan.

**Where the operator types it (2026-08-20).** The reduction had a server road
and no door: the line PATCH accepted a bounded discount, the rebuild kept it
(#2490) on a row that now keeps its id (0310) — but `SoLineCard.tsx` rendered
`discountSen` only as a READ-ONLY "− Discount" row that appears once the value
is already above zero. Its editable inputs were description, remark, qty, unit
price, delivery date, variants and photos; `$ Override price` writes
`unit_price_sen`, not a discount. So the only writer of a delivery-line discount
was the POS voucher split, and an operator could not reduce a fee at all.

Now the SAME amount cell does it, because that is where the operator already
tried: on a `SVC-DELIVERY*` line the cell SHOWS the line net and WRITES the
difference as `discountSen` (`frontend/src/vendor/scm/lib/delivery-fee-amount.ts`,
executed by `delivery-fee-amount.test.ts`). Type the amount you want charged —
250 → 125 books a 125 discount, and the printed SO still reads unit 250 /
discount 125 / total 125. Three properties are deliberate: **the semantics are
TARGET, not discount** (on a 250 fee, wanting 200 books 50 — 250 → 125 is a
coincidence that hides the difference, which is why a test pins 200); **a higher
figure books no discount**, since a fee rise needs its own `SVC-DELIVERY-ADD`
line rather than a negative discount with nothing naming the money; and **a
blank or unreadable box writes nothing**, because `Number('')` is 0 and that
would read as charge-nothing and waive the fee on the way to retyping it. A real
waiver is still typed as `0`. Non-fee lines are untouched — the cell remains the
unit price, on the same `canEditPrice` gate.

**...and the verdict is LOCKED per mounted line (2026-08-20, third pass).**
Deriving fee-vs-price live from the gross shipped a second regression within the
hour of the first fix: typing "250" writes RM 2 after the first keystroke, the
gross is now positive, the next render flips the cell into amount-to-charge, and
"25…" reads as a target above the RM 2 gross — no discount, and the sync-back
pins the box at 2.00 ("stuck at RM 2"; pasting 250 worked because paste is one
change event). `lockedFeeSemantics` makes the decision ONCE per mounted line and
never re-derives it per keystroke: a line that ARRIVES priced edits as a fee, a
line authored from 0 stays a plain unit price until saved and re-mounted, and a
product pick over the line resets the verdict. The keystroke sequence itself is
a test case.

**A hand-authored fee line is a plain PRICE, and that is why the verdict is
per-mount (2026-08-20).** This paragraph used to describe the rule as
`editsFeeAsDiscount(isFeeCode, grossSen)`. That predicate was **DELETED the same
day** by #2529 and replaced by `lockedFeeSemantics` above; the reason is kept
here because the CASE it was written for is still live and still decides the
answer. A delivery-fee line added by hand on a NEW SO starts at 0, and there the
operator is AUTHORING the fee: reading 250 as a target booked a discount of
`max(0 - 250, 0)` = 0, never wrote the price, and the box snapped back to RM 0.
That matters more than it sounds, because `applyDeliveryFee` — the create flag
that makes the server derive a fee — is sent ONLY by the POS handover (`git grep
applyDeliveryFee -- frontend/src` returns nothing; see `mfg-sales-orders.ts`), so
a Houzs-authored SO has always had its fee typed in as a unit price. **In the ERP
the typed amount IS the value** — owner, 2026-08-20: *"运费应该根据实际的价钱
去填写。我们的 POS System 已经 preset 了 250，但进到 ERP 其实也只是把那个 amount
填进来而已，所以正常来说 ERP 里是可以随意填写 amount 的"*. POS presetting 250 is a
default carried in, not a derivation the ERP must defend. The two readings on
record are complementary, not opposed: #2490 is the BACKEND half (the reduction
survives the rebuild) and #2527/#2529 the FRONTEND half (where it is typed and
what the cell means).

**… and it only holds while nothing ELSE is saving (2026-08-20, migration 0314).**
Everything above is about one editor typing one figure. A second line changed in
the SAME Save used to put it back. `rebuild_mfg_so_delivery_lines` takes its
advisory lock when it is CALLED, and `recomputeDeliveryFeeCore` READS the fee
lines long before that — including the two things the operator owns on them
(the `SVC-DELIVERY-ADD` gross and `discount_sen`). `runSoLineWrites` fans the
dirty-line stage out with `Promise.allSettled`
(`frontend/src/pages/scm-v2/so-add-lines.ts`), every one of those PATCHes ends in
`rederiveDeliveryFee`, and one Save's PATCHes all carry the same edit-lease token
so nothing separates them:

    P_fee   writes discount_sen = 12500, reads, derives 125
    P_sofa  reads BEFORE that commit, derives 250 (discount 0)
    P_fee   takes the lock, writes 125
    P_sofa  takes the lock, writes 250      <- quoted RM 125, invoiced RM 250

The lock made that ordering deterministic; it never made it impossible. **0314
turns read-then-lock into lock-read-compare-write.** The caller sends the
operator-owned fee state it derived FROM as `p_expect_state` —
`deliveryFeeStateKey` in `backend/src/scm/shared/service-lines.ts`, keyed by row
id so the comparison is order-free — and the function re-reads that state under
its own lock and **returns false without writing** when it has moved.
`recomputeDeliveryFeeCore` is then a bounded loop (three attempts) over
`recomputeDeliveryFeeAttempt`: re-read, re-derive, call again. If the lines keep
moving it writes NOTHING, the same fail-closed posture as the failed header read
("a failed read is not 'no fee'").

Three things about that are deliberate and worth not re-litigating. It returns a
**boolean, not a `RAISE`** — the same RPC runs inside `runScmPgCommand`
(tbc-update / tbc-swap / tbc-swap-sofa) where an exception rolls back a whole save
that only needed recomputing; and in that path convergence is guaranteed rather
than likely, because the xact lock the first call took is held for the rest of the
transaction. `p_expect_state` **NULL means do not check**, which is what
`repair-so-fee-line-integrity.mjs` and the pg fixtures want. And only the
`SVC-DELIVERY*` lines are in the expectation — a concurrent GOODS-line edit is
still read unlocked, so an ordinary multi-line Save does not retry n times; the
derivation reads goods lines for CATEGORY and item code, not qty or price.

The write half of all of this now lives in
`backend/src/scm/lib/so-delivery-fee-rebuild.ts` rather than inline in the router:
one place that owns 0214 serialisation, 0310 line reuse and 0314 staleness
refusal.

**All three faults were on THIS side — it was not the mirror.** An earlier draft
of this section blamed the `2990-*` revert on the SO mirror replaying its copy.
#2518 withdrew that with a measurement: 2990's `sync_outbox` shows its last
successful delivery at **2026-08-19T08:42:39Z** with an empty queue, while both
`SVC-DELIVERY` deletes on 2990-SO-2608-033 (2026-08-20 01:41 and 02:40, mig
0302's forensic log) postdate it and carry `application_name = PostgREST 14.5` —
the fee rebuild, not the mirror, which reaches Postgres through postgres.js and
appears nowhere in that log. The three faults were `discount_sen: 0` written
over an accepted discount (#2490), the rebuild replacing rows so they changed id
(#2514), and the discount having no input (#2516). The mirror's
DELETE-then-INSERT is still real and still worth import-once (#2515) — it is the
only known mechanism that orphans a WHOLE document's DO lines at once — but it
explains the repaired delivery links, not a reverted fee.

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
| `createMixRefusal` / `lineMixRefusal` / `amendmentMixRefusal` | `scm/lib/main-mix.ts` |
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

   **A HEADER BRANDING THAT IS A PLACEHOLDER IS NOT A BRAND (2026-08-31).**
   Every surface prefers the SO header's own `branding` text over the derived
   label, and AutoCount's branding field is free text the floor fills with a
   placeholder rather than leaving empty: **170 imported company-1 orders carry
   the literal `NONE`** (measured), so a TRION bedframe printed "NONE" where
   the catalog plainly says BEDFRAME (owner, HC-SO-013402). The import keeps
   copying the book faithfully; the READERS now ask
   `isPlaceholderBrandText(header)` first — a small CLOSED list (NONE / N/A /
   NIL / TBC / KIV / dashes / blank), never a heuristic, so a real brand
   ("Nonesuch") is never swallowed. Consumers: `MfgSalesOrdersListV2.tsx`
   (`brandOf`), `mobile/MobileSalesOrders.tsx`, and the Sales/Fair report's
   derive-blank pass. Bug `docs/bugs/0575-the-book-s-none-placeholder-outranked-the-derived-branding-a.md`.

   **The LABEL rule is `scm/shared/so-branding-label.ts`, and since 2026-08-18
   the sofa half of it no longer depends on that data being repaired.** The
   owner restated the same 2026-08-08 rule as two equations —「houzs
   sofa=zanotti / 2990 sofa=2990s sofa」— so SOFA now returns the COMPANY's
   house brand (`ZANOTTI` / `2990s Sofa`) and does not read the line at all.
   That matters because the repair above did not reach everything: 11 ACTIVE
   Houzs sofa SKUs (the whole `5526-*` family, 8 of them already on orders)
   still carry blank branding, and the old rule printed the bare noun "Sofa"
   for them. MATTRESS is the other half — it reads the **SKU's** branding for
   BOTH companies («both company also»), falling back to the category noun
   "Mattress" when the SKU carries none; the manufactured `2990 Mattress`
   fallback and the regex that folded `2990` / `2990's` / `2990s` into it are
   both deleted. Callers must therefore hand the rule the SKU's branding, not
   the line's: `first_item_branding` is resolved SKU-first for a mattress line
   in both the list handler and `so-display-branding.ts`.

   Surfaces on the shared rule: SO list (desktop + mobile), Consignment Orders,
   Delivery Planning. `SalesOrderDetailV2.tsx` is NOT — it still reads
   `branding || first_item_branding || "—"` directly, so it can print a
   different string than the list for the same order. That divergence predates
   this change and is unfixed.

   **The PDF LETTERHEAD is a different code path from the grid LABEL, and it
   had the same rule only half-implemented.** `GET /:docNo` stamps
   `resolvedBrandLogoKey` — the R2 key of a brand LOGO the SO PDF prints IN
   PLACE OF the company logo (`frontend/src/vendor/scm/lib/sales-order-pdf.ts`
   passes it to `drawHeader`; the company letterhead is the fallback when it is
   null). Until 2026-08-21 that resolver read `project_brands` with **no company
   predicate** and hardcoded the name `'ZANOTTI'`, so a 2990 HOME SDN. BHD.
   Sales Order printed Houzs's mark — the owner found it on
   `2990-SO-2607-026`, and production counted 69 orders in that state. The rule
   now lives in `backend/src/scm/lib/brand-letterhead.ts`, reads the pool with
   `activeCompanySql(c)`, and resolves the company's house sofa brand through
   `houseSofaBrandName(companyCode)` — the SAME shared module the label uses.
   It returns **null** for an unidentifiable company, where `brandingLabel`
   keeps its 2990 default: a label may never be blank, a letterhead may never be
   wrong. `"2990s Sofa"` exists as a 2990 brand row with no `logo_r2_key`, so
   2990 sofa orders print the 2990 company letterhead until the owner uploads
   one. Entry `docs/bugs/0489-a-2990-sales-order-pdf-printed-houzs-s-zanotti-logo.md`.

   **And the PDF's STATUS word is a third path again, fixed 2026-08-26.**
   `sales-order-pdf.ts` title-cased the stored value with its own hand-rolled
   caser, so the sheet printed `Ready To Ship` where the screen says
   **Ready to Ship**, and `In Production` where `status-pill.ts` says
   **Proceed**. It now calls `statusLabel('so', header.status)` — the one home
   the owner's 2026-08-21 ruling put those words in — and
   `frontend/src/vendor/scm/lib/pdf-status-label.test.ts` renders this document
   for every status in the SO vocabulary and compares what was drawn.
   **`IN_PRODUCTION` is the one word still unsettled**: `status-pill.ts` says
   *Proceed*, `frontend/src/pages/scm-v2/so-list-status.ts` says *In Production*
   while claiming the two match, and both are live on screens. The sheet follows
   `status-pill.ts`; picking the word is the owner's call. Entry
   `docs/bugs/0548-every-printed-document-title-cased-the-raw-stored-status-ins.md`,
   rule `docs/modules/document-status-vocabulary.md` §1.

`?summary=1` skips the view join + item read entirely (dashboard only needs status
buckets) — do not fully-hydrate 500 rows for a count.

---

## 4. Database

Schema: `scm` (vendored 2990 clone, 108 tables). Key tables:

| Table | Role |
|-------|------|
| `scm.mfg_sales_orders` | SO header (doc_no PK-ish, status, salesperson_id, totals in sen, so_date, delivery_state, amended_delivery_date, company_id) |
| `scm.mfg_sales_order_items` | SO lines (item_group, stock_status, variants, warehouse_id) |
| `scm.mfg_sales_order_payments` | payments ledger (so_doc_no FK, method, online_type). Also READ by `scm/lib/si-order-deposit.ts` — the deposit here settles the Sales Invoices raised off the order |
| VIEW `scm.mfg_sales_orders_with_payment_totals` | header + `paid_total_sen` + `balance_sen_live` (Σ over payments) — the list reads this |

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

- Minted from **`scm.doc_number_counters`** (migration 0316) — one row per
  series (`HC-SO-2608`), claimed by `scm.next_doc_no_n` in a single
  `INSERT … ON CONFLICT … RETURNING`, so two concurrent saves cannot read the
  same value. The counter only ever goes UP.
- The live rows are still read, and are now only a FLOOR: the answer is
  `GREATEST(counter, max(suffix) + 1)`, so a row inserted out of band pushes the
  counter up and a deleted row cannot pull it down.
- **Deleting a document does NOT return its number** — neither from the middle
  of a month nor from the top. Gaps are normal and permanent, exactly as in
  AutoCount, SAP, Odoo and NetSuite. There is deliberately no gap-filling.

  > **CORRECTED 2026-08-21.** This bullet used to read *"deleting the top of a
  > month returns those numbers to the pool and the sequence self-heals"*. That
  > was accurate and it is the defect: on 2026-08-20 the go-live wipe emptied
  > Houzs Century's months, the counter read max=0, and the ERP re-issued
  > `HC-SO-2608-001/002`, `HC-PO-2608-001` and `HC-PI-2608-001` — which the
  > licensed AED_HOUZS account book had held since 2026-08-14/17. AutoCount
  > refused them with `Primary Key Error` and was right. Once a number leaves
  > this system the surviving rows stop being a record of what was issued.
  > `docs/doc-number-reissue-coe.md`.

- **When a gap has to be closed, there is now ONE tool that does it** —
  `backend/scripts/reclaim-doc-no.mjs`, Actions -> **Reclaim a document
  number**. It is the only thing in the tree that moves a counter DOWN, and it
  exists because deleting the newest document of a month is a normal operation
  (a POS smoke test) with no way back. `MODE=plan` prints the counter row, the
  highest surviving suffix, what `scm.autocount_outbox` remembers, and the
  verdict; `MODE=apply` also needs `CONFIRM_SERIES` to equal the series. It
  REFUSES an `HC-` series with no override (those are the numbers the AED_HOUZS
  book holds — the incident above), a target that is not below `next_n`, a
  target any surviving row or any outbox row already carries, and a series type
  it has no source table for. Reclaiming is for a number that never left the
  system; a gap in the middle of a month is still normal and still permanent.

  `delete-test-so.mjs` now READS the counter and names the doc number the next
  save will take, with a WARNING and this command when the deleted number is
  gone for good. It used to assert the opposite from `MAX()` alone —
  `docs/bugs/0574-delete-test-so-told-the-operator-the-deleted-number-would-co.md`.
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
- **The SO detail's Stock column is a whole MRP run — and `GET /:docNo` no longer
  pays for it (2026-09-01).** `computeMrp` walks every live SO line and every open
  PO (~105 DB round-trips) and **cannot be narrowed to one order**: a line's
  coverage depends on what higher-priority lines already claimed, so a single-order
  run answers a different question. Running it inline made a cold detail open ~4.7s.
  The detail now returns FAST from the persisted `stock_status` alone, and the live
  coverage moved to a deferred `GET /:docNo/coverage` the client calls after the
  doc renders (docs/bugs/0589) — the same deferral the list took in 2026-08-18.
  `GET /:docNo/items` (the POS items endpoint) still runs it inline.

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
> line … **authoritative by default**: it rewrites `unit_price_sen` to
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
| `approval` (the approve-so gate's receipt) | the requested price persists, **RM 0 included** (`trustOperatorSelling: 'operator-zero'`) | stored / requested price persists (`'including-zero'`) |
| `approval`, but the line is an **ADD** | requested price persists, except a **0**, which reads as "not provided" and takes the catalogue figure (plain `true`) | same |
| `null` (any other caller) | catalogue, exactly as before | stored price kept |

**RM 0 (2026-08-19).** Until this date the native row above passed plain `true`,
which reads `manualUnitSelling > 0` — so zero was the one amount an approved
amendment could not carry, and an approver who signed RM 0 got the catalogue
price instead, silently. That matched the unlocked road when it was written; on
2026-08-18 the unlocked road gained an operator-authored zero
(`zeroPriceIntended` -> `'operator-zero'`, #2425), and this path did not follow,
so the two disagreed on one value. Editing an existing line now uses
`'operator-zero'` and the two agree again. It also stops a pure QUANTITY
amendment re-pricing a line that sits at 0 — a free gift or PWP reward — which
the editor triggers because it sends `newUnitPriceSen` on every changed line.

**Add and Edit differ on 0 IN AN AMENDMENT, deliberately.** An amendment's ADD
line names a SKU and nothing else about it is established, so a 0 there is
likelier an unfilled field than an intended giveaway; an EDIT moves a price the
line already carries. Both behaviours are pinned in
`so-revision.amendmentPrice.test.ts`. Changing either means changing that test in
the same PR — and asking the owner first.

**On an UNLOCKED SO both accept 0, and the difference is the claim, not the
operation** (2026-08-19). The direct line writes — `PATCH /:docNo/items/:itemId`
and `POST /:docNo/items` — both ask one helper, `erpLineTrust`
(mfg-pricing-recompute.ts):

| the line write is given | trust |
| --- | --- |
| a POS session | `false` — the POS cannot state intent; its 0 is the documented "not provided" case |
| price 0 **with** `zeroPriceIntended: true` | `'operator-zero'` — the 0 persists |
| price 0 **without** the claim | `true` — reads as "not provided", takes the catalogue figure |
| any non-zero price | `true` — a non-POS author prices freely |

Until 2026-08-19 only the PATCH had this wired, so an office user could set a
line to RM 0 by editing it but not by adding it at 0 — the same amount accepted
on one click and silently replaced on another. The amendment path has no
`zeroPriceIntended` to read (only `new_unit_price_sen`), which is why it keeps
the split above rather than joining this table.

**SO CREATE joined the same table on 2026-08-20, and until then it was not in it
at all.** `erpLineTrust` was wired into the two LINE writes only; create computed
one boolean for the whole request (`!(await isPosTabletCaller(c))`) and handed
the same value to every line's recompute, so `zeroPriceIntended` was never read
there. A line staff marked FREE on a NEW order was therefore silently re-priced
to the catalogue figure on **both** surfaces, and the customer was invoiced for
it; editing the line afterwards fixed it only at the desk.

| | new SO line at RM 0 | existing SO line edited to RM 0 |
|---|---|---|
| desktop, before | reverted to catalogue | 0 sticks |
| mobile, before | reverted to catalogue | reverted to catalogue |
| both, now | 0 sticks when the operator typed it | 0 sticks |

**The claim is now made from ONE place, and its second argument is the safety.**
`frontend/src/vendor/scm/lib/zeroPriceClaim.ts` — `zeroPriceClaim(unitPriceSen,
authored)` — replaces the arrow that lived inside `SalesOrderDetail.tsx` and was
therefore unavailable to create and to the whole of mobile. `authored` is
REQUIRED and has no default:

- **true** — the operator typed into the price box on this line, OR the line
  already exists and its 0 is its PERSISTED price being carried through an edit
  (a qty-only edit re-sends the price, so withholding the claim there would
  re-price a free line). A line seeded from a persisted row — desktop
  copy-to-new-SO, mobile edit-prefill — is authored by construction; the mobile
  edit-DRAFT road re-CREATES the order, so without that seed a free line would go
  back to the catalogue.
- **false** — the client could not resolve a price. An unpriced catalogue SKU,
  and every sofa build (the server prices those from the Model's module SKUs at
  save), reaches the wire at 0. **Claiming those would persist RM 0 instead of
  pricing them**, which is a far worse defect than the one this closes — the
  trust arm wins over the server's own module arithmetic. That is why a blanket
  "claim every 0" is wrong and why the signal is threaded from the price INPUT
  (`priceAuthored`, client-only, never persisted) rather than inferred.

Pinned by `backend/tests/zeroPriceCreatePath.test.ts` (the wiring plus what the
helper answers) and `frontend/src/vendor/scm/lib/zeroPriceClaimWiring.test.ts`
(which surface makes which claim, and with which fact).

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
- **`discount_sen` still has no amendment channel.** `scm.so_amendment_lines`
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

---

## The AutoCount answer arrives with the save, not five minutes later

Owner 2026-08-19. Two changes to this module's surface; the rule and the reasons
live in `docs/modules/autocount-writeback.md` §6b, and the code in
`backend/src/scm/lib/ac-preflight.ts`.

`ac-preflight.ts` carries a SECOND verdict from 2026-08-20, and it is not this
one. `AC_NOT_SENT` means *the accounts do not have this document*;
`AC_SENT_INCOMPLETE` (`acNotCarriedProblems`) means *they DO have it, and a
field on it did not come with it* — the case that only arises on the four
TRANSFERRED documents, whose route applies a strictly narrower header than an
edit does. Two codes and not one, because filing the second under the first
would tell an operator their goods receipt is ERP-only when the book already
holds it, which sends them to raise it twice. Nothing on a sales order or a
purchase order raises `AC_SENT_INCOMPLETE`; it is named here only so the two
are not confused when reading that module.
See `docs/modules/autocount-writeback.md` §7c5.


**1. CONFIRM now asks the write-back's own salesperson question (a 422, and it
is narrower than it sounds).** `backend/src/scm/lib/so-confirm-gate.ts` used to
accept `salesperson_id` OR any non-blank `agent` text. `agent` is free text with
no writer that keeps it honest — production rows hold bare `scm.staff` UUIDs and
the literal placeholder `"Unassigned"` — so the order the rule was written for
(HC-SO-2607-008, owner 2026-08-08) satisfied it, and then died in the write-back
queue as `MissingAgentError` where nobody saw it. The gate now calls
`resolveAcAgent`, the same function that decides what the account book is given.

- **What is newly refused:** an order with NO salesperson link whose `agent` is
  not an AutoCount sales agent. Message names the text — *"'Unassigned' is not a
  salesperson this order can be credited to"* — because telling someone to
  assign a salesperson while the box visibly holds a value sends them in a
  circle.
- **What is NOT refused, and is pinned by tests:** an order carrying a
  salesperson (any real `scm.staff.name`, including a rep hired since the
  cutover), or an `agent` the book already spells. Same `salesperson_required`
  code as before, so no confirm surface changes.
- **Cost:** zero extra reads. Both callers already select `salesperson_id,
  agent`.

**2. CREATE returns `acNotSent` when the accounts will not take the order.**
`POST /api/scm/mfg-sales-orders` now carries `acNotSent: SaveProblem[]` beside
`docNo` when the write-back composer refused the document — absent otherwise.
Never a 422: the order is committed by then, and every remaining cause needs
master data the salesperson does not own. Rendered by
`frontend/src/vendor/scm/lib/ac-not-sent.tsx`, which owns the whole dialog so a
new surface cannot get it subtly different.

**Not yet wired**, and recorded here rather than counted as done: the mobile
wizard (`frontend/src/mobile/MobileNewSO.tsx`), the POS handover, and the
DRAFT → live transition (its response object is built inside the status command,
so it carries no key). Those three still save in silence.

**Also folded in:** the aggregated save-gate popup — the renderer for every
refusal above — moved from three hand-written copies into `notifySaveProblems`
(`frontend/src/vendor/scm/components/SaveProblemsList.tsx`). What is shared is
"is this an aggregated gate failure, and if so, this popup". What is deliberately
NOT shared is each surface's own fallback: this page's inline banner and the
mobile wizard's own wording both survive.

## Right-click Print, for the whole chain (owner ruling, 2026-08-22)

**The list's right-click Print now prints the whole chain (2026-08-23).** Right-
clicking a row offers `Print` for the order itself, `Print Delivery Order <no>`
for each delivery it shipped on, and `Print Sales Invoice <no>` for each invoice
raised against it — **without leaving the list**. It replaces a Print that
navigated to `?print=1`, which could only ever reach the row's own document.

The list payload gained `do_refs` and `si_refs` for it: the two enrichment
selects at `routes/mfg-sales-orders.ts` were already reading `delivery_orders`
and `sales_invoices` by `so_doc_no` for `has_children` and the DO No. column, so
each gained one column (`id`) and **no extra round trip**. `do_nos` is unchanged
— it feeds a DISPLAY column that must still list a delivery carrying no id,
while a print entry needs an address. `lib/downstream-doc-refs.ts` and
`lib/so-delivery-order-nos.ts` hold that split; the full rule, the per-list
enumeration and the one-to-many cap are in
`document-conversion.md` §8b.
