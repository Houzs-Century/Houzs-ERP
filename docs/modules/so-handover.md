# Module: Salesperson handover (SCM)

> **Line numbers here are INDICATIVE.** Resolve a route to its current line with
> the generated artifact, which is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Moving a salesperson's Sales Orders to another salesperson. Written 2026-08-17
when the owner asked, on a resignation: *"如果第一个销售人员PIC辞职，销售订单是否
可以分配给第二个人PIC来更新销售订单"*.

Read `sales-order.md` first — this module only moves ONE column on an order, but
that column decides who can see it.

---

## 1. Why this needed a module at all

`mfg_sales_orders.salesperson_id` is not decoration. It is the key SO row-level
visibility filters on (`sales-order.md` §2, the `scopeIds` `in('salesperson_id', …)`
on the list, detail, count and money queries). So an order left on a departed rep
is not merely mis-labelled — **it is invisible to the person now answering that
customer**, and it stays in the departed rep's My-Cases-style scope.

Two things blocked the fix before 2026-08-17:

1. **`salesperson_id` was in the SO identity lock** — frozen once a non-cancelled
   DO / SI existed. That was collateral, not intent: a Delivery Order and a Sales
   Invoice snapshot the customer, the addresses and the money. Neither snapshots
   *who sold it*. The owner ruled the column out of the lock; everything else in
   `SO_IDENTITY_LOCK_COLS` stays frozen.
2. **The header PATCH had no server-side permission check.** It mapped
   `salespersonId` straight through and relied on the SO Detail page disabling
   the select. The route's scope check only proves the order is the caller's
   OWN, so a self-scoped salesperson could hand their own order to anybody.

Both now live in `backend/src/scm/shared/so-identity-lock.ts`, which is the file
to read before changing any of this.

## 2. The `agent` carve-out — the part that is easy to break

`agent` is the AutoCount rep NAME on the header, and it IS identity-locked.
`scm/lib/so-agent.ts` (`followSalespersonToAgent`) makes it follow a reassigned
salesperson so the account book, the SO list and the Detail Listing stop naming
the previous rep.

Those two facts fight each other: unlocking `salesperson_id` alone is dead on
arrival, because handing over a delivered order also writes the new name into
`agent` and the lock 409s on THAT instead. So the header PATCH records whether
`agent` changed *only* because it followed the salesperson, and
`changedIdentityLockCols(updates, before, { agentFollowedSalesperson })` exempts
exactly that case. A client-authored `agent` never sets the flag and stays
locked.

If a future change moves the follow, moves the lock check, or reorders them, this
carve-out is what silently breaks — the symptom is a 409 `so_identity_locked`
naming `agent` on an otherwise legitimate handover.

## 3. Surface

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/api/scm/so-handover/holders` | `scm.so.attribute_other` | WHO holds this company's Sales Orders — `{ holders: [{ staffId, name, staffCode, active, orders }] }`, most orders first. The From picker's list; see §6 for why it is not the roster |
| GET | `/api/scm/so-handover/preview?from=<staffId>` | `scm.so.attribute_other` | Every SO in the active company currently attributed to that staff id: `{ from, total, truncated, batchMax, orders[] }`, capped at 500 |
| POST | `/api/scm/so-handover/apply` | `scm.so.attribute_other` | Moves a named batch: `{ fromStaffId, toStaffId, docNos[] }` → `{ moved[], skipped[] }` |
| POST | `/api/scm/so-handover/share` | `scm.so.attribute_other` | Grants or withdraws ACCESS without moving attribution: `{ staffIds[], docNos[], mode }` → `{ changed[], skipped[] }`. See §8 |

Both in `backend/src/scm/routes/so-handover.ts`, mounted in `scm/index.ts` behind
the `scm.sales.orders` area guard. The preview is gated too — it enumerates
another salesperson's order book.

Also reachable per-order: the header PATCH (`salespersonId`) from SO Detail, same
permission, same audit. On a hard-locked (DO/SI) order the page-level **Edit**
button opens for a caller who may re-attribute, and only the Salesperson field
opts out of the lock — every other field stays disabled, so **Override** is still
the door for addresses and lines.

### Refusals

| Status | Body | When |
|---|---|---|
| 403 | `forbidden` | caller lacks `scm.so.attribute_other` |
| 403 | `forbidden_attribute_other` | same, via the header PATCH |
| 400 | `missing_staff` / `same_staff` / `no_orders` / `too_many_orders` | payload guard, `parseHandoverBody` |
| 409 | company-unresolved refusal | no active company on the request |

**A MIGRATED order is refused per order, not with a status.** *Added 2026-09-08,
`docs/bugs/0702-*`.* While `scm.migrated_so_lock` is on, an order carried across
from AutoCount cannot be reassigned here — it lands in `skipped[]` with the
lock's own sentence, and the rest of the batch still moves. That is deliberate:
a 409 for the whole POST would refuse twenty-four movable orders because one was
migrated, and this route's entire shape is per-order reporting.

This is the module's **third door onto a migrated sales order**, and it was open
until that date. The router-level factory `migratedSoReadonly()` guards
`/mfg-sales-orders/*` and `/so-amendments/*` (`scm/index.ts`); mounting it here
would NOT have worked, because `soDocNoFromPath` resolves the document number out
of the PATH and `POST /apply` carries a LIST of them in the body — the guard
would have found nothing, answered "not migrated", and waved every write
through. So the handler asks the same decision itself, per order, through
`migratedSoReadonlyState(c, docNo, isMigrated)` — the one function the guard and
the SO detail screen also call, so the button and the endpoint cannot disagree.
`isMigrated` is REQUIRED and answered off `linked_ac_docno` on the row the
handler already reads.

**`docNo` joined that call on 2026-09-08**, when the lock was re-grained from
ORIGIN onto CORRECTNESS (`scm.migrated_so_lock = 'verdict:<companies>'`,
`docs/migrated-so-lock.md` §10). Under that value the refusal is about ONE
document — *"HC-SO-010789 still differs from the AutoCount book on: document
total"* — so this route hands over the order it is looking at and each entry in
`skipped[]` names its own reason instead of repeating a class sentence
twenty-four times. Nothing else here changed: same function, same per-order
shape, same bypass cohort, and while the switch reads `1` the sentence is the
old class one exactly as before.

The parameter is positional and REQUIRED, which is how this call site was found
at all: it was written by a different lane hours before the re-grain landed, and
the compiler refused it (`Expected 3-4 arguments, but got 2`) rather than letting
it keep the old behaviour silently. That is the `optional-param-noop` rule
(`docs/bugs/0098-*`) paying for itself across two branches.

**`*` / `scm.admin` bypass it**, the same cohort that bypasses the write freeze.
And read `docs/migrated-so-lock.md` §2b before trusting the predicate: the
AutoCount write-back stamps `linked_ac_docno` on the ERP's own documents, so a
NEW order joins the locked population shortly after it is saved.

## 4. Why apply() is shaped the way it is

- **The operator sees the list first.** Three steps — pick who is leaving, read
  the exact orders, pick who takes them. Reassignment is bulk and irreversible-ish
  (an undo is another handover), so the middle step is the product, not a
  formality.
- **`docNos` is explicit, never "everything for this staff id".** The preview can
  be minutes old, so `apply` re-reads each order and **skips any whose
  `salesperson_id` is no longer `fromStaffId`**, reporting the reason. Without
  that re-check a stale tab could move an order somebody else had just claimed.
- **25 per batch** (`HANDOVER_BATCH_MAX`). Each order costs a read, a write, an
  audit row and an AutoCount enqueue; the UI loops batches and shows progress. A
  60-order POST that 524s halfway is worse than four clean batches.
- **Per-order reporting, not a count.** `{ moved, skipped }` — a handover that
  half-applied in silence is how an order goes missing from both reps' lists.
- **No financial column is written.** Commission is booked off the DO / SI
  snapshots, which keep the rep who sold the order; moving the SO re-books
  nothing.

## 5. What each moved order writes

| Sink | What lands |
|---|---|
| `mfg_sales_orders` | `salesperson_id` = new staff; `agent` = new staff's name (skipped when that name cannot be read — a stale name beats an empty one). **Both are fields `sync-ac-delta`'s header lane copies back from AutoCount**, so an edit here and that sync meet on the same column — see `docs/modules/sales-order.md`, "The lane will NOT write a field a person owns" |
| `mfg_so_audit_log` | `recordSoAudit` `UPDATE_DETAILS`, field changes `salespersonId` and `agent` with from → to, note `Salesperson handover` |
| AutoCount outbox | `enqueueEdit({ docType: 'SO', touchedFields: ['agent'] })` — see `autocount-writeback.md`; without it the account book keeps naming the departed rep |

## 6. Frontend

`frontend/src/pages/scm-v2/SalespersonHandover.tsx`, rendered as a collapsible
section on **SO Maintenance** (`/scm/sales-orders/maintenance`) behind the same
permission the API enforces.

- **From** lists **who HOLDS orders** — `GET /so-handover/holders`
  (`useSoHandoverHolders`), ordered by order count with the count in the label.
  Inactive holders are labelled and still selectable; most of them have left,
  which is the point.

> **IT USED TO READ THE STAFF ROSTER, AND THAT HID THE PEOPLE THIS PANEL IS
> FOR.** *2026-09-09.* `GET /staff` runs `scopeStaffRowsToActiveCompany`, and
> `staffCompanyIds` (`scm/lib/staffCompanyScope.ts`) buckets a staff row with
> **no linked ERP user** to the **2990 mirror**. An AutoCount-imported rep who
> never had an ERP login — the normal shape for a long-resigned one — was
> therefore unselectable while HOUZS was active.
>
> **Measured, not argued** (`check-so-holders.mjs`, production run
> 34336422828): **22 holders / 339 non-cancelled orders in HOUZS** could not be
> picked, including all three reps the owner had come to hand over.
>
> **Switching company does NOT rescue it**, which is what made this worth fixing
> rather than documenting: their ORDERS are in HOUZS while their staff rows
> answer to 2990, so under HOUZS you see the orders and not the person, and
> under 2990 you see the person and not the orders. Neither company can complete
> the handover.
>
> A list derived from the ORDERS cannot omit somebody who holds one. The
> diagnostic that measured it is still there and still useful for "how many will
> actually move": `backend/scripts/check-so-holders.mjs` + the **SO holders
> check (read-only)** workflow.
>
> `/holders` counts the SAME way `/preview` lists — company-scoped, no status
> filter — so the number on the picker and the number on the list under it
> cannot disagree.
- **To** reads `usePickableStaff` (company-scoped, active only), so an order can
  never land on a departed or cross-company rep.
- **Also give access to** (2026-09-09) reads the same pickable list and ADDS to a
  chip list — one `SearchableSelect` that resets to `""` after each pick, rather
  than a multi-select control nothing else in this codebase uses.
- All pickers are the house `SearchableSelect`.
- The two actions sit side by side on the preview header and each is enabled by
  its OWN field, so the one the operator has not filled in cannot fire. Progress
  carries the action that owns it (`{ done, total, action }`) — without that the
  Share button counted orders a running handover was moving.

## 7. Tests

| File | Pins |
|---|---|
| `backend/src/scm/shared/so-identity-lock.test.ts` | what still freezes, that `salesperson_id` does not, the `agent` carve-out, and that the carve-out smuggles nothing else through |
| `backend/src/scm/routes/so-handover.test.ts` | the payload guard for BOTH operations: `parseHandoverBody` (both staff ids required, no self-handover, dedupe, batch cap) and `parseShareBody` (dedupe, the 10-people cap, the same batch cap, and that `mode` defaults to `add` — including that an unrecognised mode like `replace` falls back to `add` rather than through) |
| `backend/tests/soHandoverMigratedLock.test.mjs` | five call-site assertions: the migrated-SO lock is asked here, `linked_ac_docno` is read, the refusal reaches `skipped`, it happens BEFORE the update, and it is per order (`continue`, never a whole-batch `return`) |
| `frontend/src/pages/scm-v2/SalespersonHandover.test.tsx` | the preview is a GET before any write, the 25-per-batch chunking, and that skips are reported rather than swallowed |
| `backend/tests/soSharedOrderScope.test.ts` | that the SO-only reach is real: every SO scope site goes through `applySoScope` / `soDocOutOfScope`, and the downstream sales documents still filter on `salesperson_id` |

---

## 8. SHARING — several salespeople on one order (2026-09-09)

> Owner, on the handover panel: *"接手的 sales person 可以选择 multiple 吗？可以让
> 接手的几位 sales person 都有权限"*. Asked who the account book should then name,
> he ruled **全部平等，不设主** — equal access, no primary among them.

### 8.1 It is a SECOND operation, not a flag on the first

`/apply` moves attribution: one person, `salesperson_id` + `agent` + the
AutoCount edit. `/share` grants access: any number of people,
`collaborator_staff_ids` and nothing else.

They are separate endpoints because the owner's ruling forced it. A "multiple
recipients" flag on `/apply` would still have to write ONE `salesperson_id`,
which means picking one of the selected people — the primary he said not to have.
Splitting the operations is that ruling made structural: the panel offers
**Hand them to** (one person, moves the name) and **Also give access to** (any
number, moves nothing), and the operator can run either, both, or neither.

**The consequence, stated plainly:** sharing alone leaves `salesperson_id` where
it was. If that is a departed rep, the SO list, the reports and the AutoCount
book keep naming them — which is the thing `/apply`'s `enqueueEdit` exists to
prevent. That is the accepted trade of "no primary", and a resignation that also
needs the book corrected runs **Hand them to** as well.

### 8.2 Two columns, and the split is the whole design

`backend/src/db/migrations-pg/20260909T1000_scm_so_collaborator_staff_ids.sql`
adds both columns, the trigger and the backfill;
`backend/src/db/migrations-pg/20260909T1001_scm_so_payment_totals_view_carries_collaborators.sql`
teaches the view to enumerate them, and is a separate file because it is the
risky half (§8.8).

| Column | Role |
|---|---|
| `collaborator_staff_ids uuid[]` | **INPUT.** What an operator granted. The only one anything writes. |
| `access_staff_ids uuid[]` | **DERIVED.** `salesperson_id` + collaborators, maintained by `trg_mfg_so_sync_access_staff_ids`. What every scoped read filters on. Never write it. |

**Why derive instead of filtering on both.** A read asking "salesperson_id is
mine OR collaborators overlaps mine" is a PostgREST `or=(...)` built by string
concatenation, with the scope's uuids inside BOTH an `in.(a,b)` list and an
`ov.{a,b}` array literal — two kinds of comma nesting in one term, which is the
sort of thing that works in testing and then quietly matches the wrong set.
Against one derived column the filter is a single `ov` and each call site is a
one-word swap.

**Why a trigger.** `salesperson_id` has many writers — SO create, the header
PATCH, `/apply`, and `sync-ac-delta`'s header lane copying back from AutoCount. A
derived column maintained in TypeScript is correct until the first writer that
forgets, and the symptom of forgetting is an order nobody can see.

**The trigger's `UPDATE OF` list names `access_staff_ids` itself**, not just the
two sources. Without that, a write touching only the derived column would not
fire the trigger and would persist whatever it said — a row-level permission set
by a typo.

**Why arrays on the header rather than a child table.** Every scoped SO read is a
LIST filtered by the caller's scope. A child table becomes a join, or an
`IN (<every shared doc_no>)` built per request — a rep sharing 500 orders would
put 500 doc numbers in a query string. Overlap against an array is bounded by the
number of PEOPLE in the caller's scope, typically one. The cost is no per-grant
metadata; the SO audit log carries actor and timestamp on field
`collaboratorStaffIds`, which is the record anybody would actually read.

### 8.3 Reach: Sales Orders ONLY, by owner ruling

Asked how far shared access should go, the owner chose Sales Orders only. So:

| Honours sharing (`applySoScope` / `soDocOutOfScope`) | Still `salesperson_id` only |
|---|---|
| SO list + summary + counts + money KPIs (`mfg-sales-orders.ts`) | Delivery Orders |
| SO detail, `/items`, the write-side mutation guard | Sales Invoices |
| SO list enrichment (list + detail) | Delivery Returns |
| SO amendments (list + detail) | Consignment orders |
| The amendment-creation gate | Quotes, reports, AR reconciliation, unbilled deliveries |

The right-hand column is not an oversight. Those documents snapshot the rep who
sold the order, and that snapshot is what commission is booked from — the same
reason `/apply` writes no financial column. A co-owner sees the Sales Order they
are working; they do not inherit someone else's invoice.

### 8.4 The migrated-SO lock is deliberately NOT asked

`/apply` asks it (§3). `/share` does not, and that is the one decision in the
handler worth arguing with. The lock stops an order whose ERP copy already
differs from the AutoCount book from being edited in ways that widen the gap.
`collaborator_staff_ids` has no counterpart in that book — nothing syncs it and
no verdict can disagree about it — while asking the lock would mean the migrated
open orders, most of the book, could never be shared: exactly the population a
resignation strands. `/apply` still asks, because `/apply` writes `agent`, which
IS an AutoCount field.

### 8.5 `add` / `remove`, and why there is no `replace`

The operator is acting on up to 25 orders whose current collaborators they cannot
see. A replace would silently drop a grant somebody else made — the bulk-tool
version of losing data. So `mode` is `add` (default) or `remove`, both explicit
and both bulk, and an unrecognised value falls back to `add` rather than through.
Re-running a grant reports "Already shared with all of them" in `skipped` rather
than counting as done: an operator who ran it twice should see that the second
run changed nothing.

Unlike `/apply` there is no `same_staff` refusal — sharing an order with the
person already attributed to it is harmless (the derived column de-duplicates),
and refusing it would fail a bulk grant because one order in the batch happened
to be theirs.

### 8.6 Where a share is VISIBLE

> Owner 2026-09-09, immediately after the bulk tool shipped: *"SO 详情页也要能
> 看到共享给了谁"*. Until then a grant existed only on the maintenance panel and
> in the audit log — **state a user cannot see is state they cannot correct.**

| Surface | What it shows |
|---|---|
| SO Detail, desktop (`SalesOrderDetailV2.tsx`) | a **Shared with** `Field` beside Salesperson, names A→Z |
| SO Detail, mobile (`MobileSODetail.tsx`) | the same, as a `RoField` under the Salesperson row |
| SO History drawer / mobile timeline | the audit row's field key `collaboratorStaffIds` reads **"Shared with"** (`so-audit-labels.ts`, `mobile/so-history-labels.ts`) — it printed the raw key until this shipped |
| SO Maintenance | where granting and withdrawing actually happen (§8.1) |

**The field is absent, not blank, on an unshared order.** Most orders are shared
with nobody, and a field that is empty on almost every order teaches people to
stop reading it — which defeats the point of showing it at all.

The two screens share the LOGIC and not the rendering:
`frontend/src/vendor/scm/lib/so-collaborators.ts` (`collaboratorNames`,
`collaboratorLabel`) resolves ids to names, dedupes, sorts A→Z, and answers
**"Unknown user"** for an id that resolves to nobody — a grant to somebody since
removed is information, and a uuid on screen is the defect it replaces
(`useStaffLookup`'s `actorNameOf` set that convention). Desktop renders a
`Field`, mobile a `RoField`; neither re-derives which names to show.

> `MobileSODetail.tsx` was AT its file-size ceiling, so this could not be added
> until something left. `HIST_FIELD_LABEL` / `HIST_MONEY_FIELDS` moved verbatim
> to `frontend/src/mobile/so-history-labels.ts` — pure constants, no behaviour,
> and the file's own comment already called the map a duplicate of desktop's.
> That is the repo's prescribed remedy for a file at its ceiling (a new module,
> never a bigger number), not an optional tidy-up.

### 8.7 What each shared order writes

| Sink | What lands |
|---|---|
| `mfg_sales_orders` | `collaborator_staff_ids` = the new set; `access_staff_ids` re-derived by the trigger. **No attribution column, no `agent`, no money.** |
| `mfg_so_audit_log` | `recordSoAudit` `UPDATE_DETAILS`, field `collaboratorStaffIds` from → to (comma-joined uuids), note `Sales order shared` / `Sales order sharing withdrawn` |
| AutoCount outbox | **nothing.** There is no field to write. |

### 8.8 The view migration is the risky half — read this before touching it

`20260909T1001` is separate from `20260909T1000` for the same reason 0325 was
separate from 0324: one is an `ALTER TABLE` that cannot fail, the other touches a
view that took production's Sales Order list down for every user once already.

**Shipping T1000 without T1001 does not degrade the list — it 500s it**, for
every user, because the scope filter itself moved onto `access_staff_ids` and the
view would not carry that column. The two files must land together.

`CREATE OR REPLACE`, never DROP + CREATE. A recreated view is a NEW object with
an EMPTY ACL — that is how 0189 killed the list and needed both 0190 and 0191 to
repair, with nobody having written down what the grants were. `CREATE OR REPLACE`
may only ADD columns at the END of the select list, which is what this does;
every prior column keeps its name, type and position byte-for-byte from 0325. If
a future edit needs to REORDER or RETYPE one, `CREATE OR REPLACE` will refuse —
the answer is to carry 0312's grant-restore block, never to reach for DROP to
silence it.
