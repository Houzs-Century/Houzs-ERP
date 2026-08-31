# Module: ERP -> AutoCount write-back (SCM)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

After go-live the ERP is master and every document it creates must appear in
AutoCount. This is the ERP half. The AutoCount half already exists and was
proven against the live `AED_HOUZS` book on 2026-08-07.

> **It ships OFF — but on ONE gate now, not two.** `scm.app_config` key
> `scm.autocount_writeback` is seeded `'off'` by migration 0277, and while it is
> off nothing is queued and nothing is drained.
>
> **`AC_SYNC_URL` is NO LONGER unset.** It was SET on 2026-08-11
> (`backend/wrangler.toml:42` = `https://autocount.houzscentury.com`, in the
> top-level `[vars]` block) after the Cloudflare tunnel was repointed at
> AcSyncService and the service answered `{"ok":true,"book":"AED_HOUZS"}` on
> `/health`. So the URL gate is OPEN and the DB toggle is the only thing between
> the ERP and the live licensed account book. Both must be on for a document to
> reach it; today exactly one is.
>
> **The two gates are not symmetric.** The DB toggle stops ENQUEUEING —
> `enqueueAcOp` returns false before the insert (`autocount-outbox.ts:172-175`).
> `AC_SYNC_URL` stops only the DRAIN (`ac_service_not_configured`): the enqueue
> path takes no `Env` and never reads it. So clearing the URL would leave rows
> piling up in the outbox, whereas the toggle keeps the queue empty.
>
> The third gate is the `AC_SYNC_KEY` SECRET. `wrangler.toml:232-236` records it
> as not set, but a comment is not the secret store — whether prod actually holds
> it is UNVERIFIED as of 2026-08-13 and needs a `wrangler secret list`.

**Do not describe either direction as "the sync".** There are THREE independent
switches and they are in different states — reading one as the whole gives a
wrong answer:

| direction | switch | state |
|---|---|---|
| **Inbound PULL** (AutoCount -> ERP, recurring cron SO/PO/overdue/creditors/stock + manual `/api/sync/pull`) | `AUTOCOUNT_SYNC_DISABLED` (`wrangler.toml:24`, prod `[vars]`) | **`"false"` — LIVE.** Disabled 2026-06-13 at owner request, RE-ENABLED 2026-07-14. Staging is `"true"` (`:302`) |
| **Legacy outbound writes** (the old `services/autocount.ts` push, not this outbox) | `AUTOCOUNT_WRITES_DISABLED`, a hard-coded `const … = true` (`autocount.ts:28`) | **OFF**, returns `skipped: AUTOCOUNT_WRITES_DISABLED` (`:138-143`). Not env-driven — flipping it is a code change |
| **This module** (ERP -> AutoCount outbox write-back) | `scm.app_config` `scm.autocount_writeback` | **`'off'`** (above) |

The one-time cutover IMPORT is a fourth, separate thing — a finished historical
migration, recorded in `docs/autocount-cutover-ledger.md`. It is not the
recurring inbound pull in the table above.

---

## 1. The two halves

| Half | Where | What it is |
|---|---|---|
| AutoCount | `backend/scripts/autocount-service/AcSyncService.cs` | A .NET 4 HTTP service running ON the AutoCount host, driving the licensed 2.2 SDK. NINE POST routes (`/create-so`, `/create-po`, `/so-to-do`, `/po-to-gr`, `/do-to-iv`, `/gr-to-pi`, `/cancel`, `/edit`, `/ensure-masters`) plus `GET /health`, which since 2026-08-15 answers `builtAt` + `mvid` as well as the book — the only way to establish WHICH BUILD the office host is running. Reflected SDK surface in `sdk-api-reference.txt` — there is no published reference. |
| ERP | `backend/src/scm/lib/autocount-outbox.ts` + `backend/src/services/autocount-writeback.ts` | An outbox: routes enqueue, a cron drains, the returned AutoCount document number is recorded back onto the ERP row. |

AcSyncService's routes, and the outbox `op` that targets each:

| Route | `op` | ERP flow |
|---|---|---|
| `/create-so` | `create_so` | SO create |
| `/create-po` | `create_po` | PO create |
| `/so-to-do` | `so_to_do` | SO -> Delivery Order |
| `/so-to-po` | `so_to_po` | SO -> Purchase Order. NOT one of the four below: a purchase document transferring from a sales one uses its own SDK method (`AddSOToPOTransferDetail`), and the ERP sends it only when every line maps 1:1 to a sales line the book has a key for. A consolidated purchase stays a plain `create_po` with the source SO numbers in `Ref` — see `scm/shared/po-transfer-shape.ts` |
| `/po-to-gr` | `po_to_gr` | PO -> Goods Receipt |
| `/do-to-iv` | `do_to_iv` | DO -> Sales Invoice |
| `/gr-to-pi` | `gr_to_pi` | GRN -> Purchase Invoice |
| `/cancel` | `cancel` | cancel — all six types (SO, PO, DO, GR, IV, PI) |
| `/edit` | `edit` | edit — all six types: header, lines, variant/SKU changes |
| `/ensure-masters` | **none** | opens the items and salespeople a document names, BEFORE it is sent. It is called INLINE by the drain (`autocount-outbox.ts:1767-1780`), never queued — 0277's `op` CHECK admits only the eight ops above |

There is deliberately **no create route for DO / GRN / Invoice / Purchase
Invoice**, and there cannot sensibly be one: in the 2.2 SDK you build one of
those four by transferring a SOURCE document's lines, so a parentless one cannot
be expressed at all.

> **CORRECTED 2026-08-17.** This paragraph, §7 and §7d each said the SDK's *only*
> construction primitive is `AddPartialTransferDetail`. That was read off a
> reflection dump taken with `BindingFlags.DeclaredOnly`, which skips inherited
> members — and the rest of the transfer API is inherited from `SalesDocument` /
> `PurchaseDocument`. `FullTransfer` (three overloads) and `PartialTransfer`
> (four) exist. The conclusion above survives the correction — all of them
> transfer FROM something, so a parentless document is still inexpressible — but
> the reason given for it was wrong. See **BUG CLASS
> instrument-blind-spot-as-a-finding** —
> `docs/bugs/0267-bug-class-instrument-blind-spot-as-a-finding-the-search-foun.md`. The ERP CAN create all four parentless (a manual
GRN with no PO is an explicit owner decision), and each such document is
recorded as a `skipped` outbox row by `recordParentlessCreate` so the
divergence is written down rather than silently dropped.

---

## 2. Why an outbox and not a direct call

The AutoCount host is a Windows box on the shop floor behind a tunnel. It
reboots. The SDK opens a session per call. Three consequences decided the shape:

1. **A write to AutoCount must never fail a user's save.** Every enqueue
   function swallows its own errors and returns `false`; a salesperson pressing
   Save must not care whether the AutoCount box is up.
2. **A dropped push must be recoverable.** One row per intended operation, with
   `attempts` and `last_error`, drained by the existing 5-minute cron.
3. **A year later, "what did we tell AutoCount, and what did it answer" must be
   a `SELECT`.** Rows are never deleted.

The table follows `email_outbox` (migrations 0005 + 0269) and the drain follows
`amendment-command.ts` — deliberately the same two shapes this repo already
runs, not a third to learn.

---

## 2b. The document number is a SHARED namespace, and the book never forgets

**白话.** 我们送去 AutoCount 的单据号码，账本会永远记住。ERP 这边就算把单据删掉，
账本还是留着那个号码 —— 所以号码不能重发，一发就被拒绝（`Primary Key Error`）。

Sending a document to AED_HOUZS makes its number exist in a **second namespace
the ERP cannot see, cannot query, and cannot wipe.** Two consequences that are
easy to get wrong, and both were got wrong on 2026-08-20:

1. **A number the ERP no longer has may still be taken.** Document numbers used
   to be minted `max(suffix) + 1` over the rows that still existed for the
   month, so a wipe that emptied Houzs Century's month reset the series to 001
   — and the book still held `HC-SO-2608-001/002`, `HC-PO-2608-001`,
   `HC-PI-2608-001`, `HC-DO-2608-001/002` and `HC-SI-2608-001`. Since migration
   0316 the counter is `scm.doc_number_counters`, it only goes up, and its HC
   2608 rows are seeded ABOVE the numbers the book is evidenced to hold. Each
   row's `seed_source` names its evidence. `docs/doc-number-reissue-coe.md`.
2. **The outbox is the ERP's only memory of what it sent, so it must survive a
   wipe.** `scm.autocount_outbox` used to be on `golive-wipe-hc.mjs`'s CLEAR
   list; wiping it is why the queue could truthfully report "never sent" for
   numbers the book demonstrably held. It is on KEEP now — a wipe marks HC's
   `pending` rows `skipped` and deletes none of them. What was sent is a fact
   about the book, and deleting our copy of it does not make it untrue.

**What is still UNKNOWN, and is not papered over:** our GRN minter writes
`HC-GRN-…` while the book's goods-receipt number from the 2026-08-17 host
session is `HC-GR-…` (`ac-live-proof.json` `proof.po_to_gr`). Different strings,
so as written they cannot collide — but whether the office host maps one onto
the other has never been established. The counter is seeded past the GRN number
the ERP is evidenced to have issued, and that row says in words that it is not
book evidence.

---

## 3. The table — `scm.autocount_outbox` (migration 0277)

| Column | Meaning |
|---|---|
| `op` / `doc_type` / `doc_no` / `doc_id` | Which operation, on which ERP document |
| `payload` | **A snapshot**, taken at enqueue. It is the record of what the user's save actually produced; it is never recomposed at drain |
| `status` | `pending` / `sent` / `failed` / `skipped` |
| `attempts` / `last_error` | Retry bookkeeping. `MAX_ATTEMPTS` = 6 |
| `ac_doc_no` | What AutoCount answered with |
| `dedupe_key` | Unique among PENDING rows only. `NULL` = always enqueue |

Two things are resolved LATE, at drain, and only two:

- **The AutoCount document number of the parent** (a conversion's `FromDocNo`)
  and **of the subject** (a cancel/edit's `DocNo`). Neither exists until the
  create that makes it has drained. This is a foreign-key resolution, not a
  recomposition. A row whose parent is unresolved is left `pending` **without
  burning an attempt**; sweeps drain oldest-first, so the parent's create is
  ahead of it in the same batch.
- **The flag**, so a switch turned off after rows were queued stops the push.
  Those rows stay `pending` — off is not a failure.

### `linked_ac_docno` — the map, both ways

The drain writes the returned number onto the ERP row. 0277 adds the column to
`purchase_orders`, `delivery_orders`, `grns`, `sales_invoices` and
`purchase_invoices`; `mfg_sales_orders` already had it from 0271.

`purchase_orders.linked_ac_docno` is a **known recording gap being closed**, not
a new column: `import-ac-outstanding-po.mjs:314` added it at runtime with its
own `ALTER`, so it exists in production but appeared in no migration
(cutover ledger §1 "坑二"). `IF NOT EXISTS` makes 0277 a no-op against the live
database and makes the column real everywhere else.

---

## 4. The toggle

`scm.app_config` key `scm.autocount_writeback`, read by
`scm/lib/autocount-writeback-flag.ts`. Same table, grammar and 30s cache as the
go-live write freeze (0272 + `scm/lib/write-freeze.ts`):

```
'off' / '' / row absent  -> nothing is queued or sent
'all'                    -> every company
'1' / '1,3'              -> ONLY those companies
```

"Fails open" here means **the caller is never harmed**, not that an unreadable
flag turns the feature on: a read error re-serves the last known state, and the
seeded default is `off`. `isWritebackEnabled` never throws.

Checked twice — at enqueue (nothing accumulates while off) and again per row at
drain (the flag is per company and can flip mid-sweep).

**The STATUS report answers "on for THIS company", not "on for anybody"**
(2026-08-18). `GET /autocount-outbox` publishes two different facts, because a
reader needs both: `scope` is what the switch literally says — the whole
allow-list, which an admin has to be able to see — and `on` is whether that
list covers the CALLER's active company, which is what governs whether his next
save queues anything. It used to publish `on: scope !== 'off'`. With the live
value set to one company id, the other organisation's operator was told on this
page that sending was switched on for him and that saving would queue a
document; neither was true, and his company-scoped queue stayed permanently
empty with nothing erroring. `on` is `null`, rendered as its own sentence, when
the company cannot be resolved — a report must not claim the switch is off on
the strength of a company it could not read, which is the opposite of what
`isWritebackEnabled` does at enqueue (that one refuses, because writing into a
live account book on a guess is worse).

---

## 5. The downstream lock — owner rule, 2026-08-10

> **"已经转到下游的单据, AutoCount 不许取消/改动 ... 是的 我们也是要这样"**

AutoCount's `CancelDocument` refuses a document it has already transferred
downstream, and its `Edit` cannot retract a line a DO already shipped. The ERP
enforces the same rule, or the first edit of a shipped order leaves the two
systems permanently disagreeing — with the ERP wrong, because the stock has
already moved.

`backend/src/scm/lib/downstream-lock.ts`:

| Function | Locks on |
|---|---|
| `soHasDownstream(sb, soDocNo)` | any non-CANCELLED `delivery_orders` or `sales_invoices` on that SO |
| `poHasDownstream(sb, poId)` | any non-CANCELLED `grns` on that PO |
| `doHasDownstream(sb, doId)` | any non-CANCELLED `delivery_returns` or `sales_invoices` on that DO |
| `grnHasDownstream(sb, grnId)` | any `grn_items` with `invoiced_qty > 0` or `returned_qty > 0` |

**Blocked:** line mutations and cancel. **Not blocked:** raising the NEXT
downstream document — an SO with one DO can still emit another (partial
delivery). That matches AutoCount, which keeps transferring but refuses to
rewrite history.

A **cancelled** child does not lock: an SO whose only DO was cancelled is free
again.

The rule is not new — it existed as four private copies inside four
multi-thousand-line route files, where no test could reach it. 0277's PR moved
it into one module with a pure `downstreamVerdict` underneath, and the four
routers now import it. Same signatures, same JSON, same 409s.

---

## 6. Where the routes enqueue

Each hook sits at the point the document becomes permanent — after the
`record*Create` audit row, past every compensating rollback.

| Flow | File | Anchor |
|---|---|---|
| SO create | `scm/routes/mfg-sales-orders.ts` | after `recordSoAudit(... 'CREATE')`, before `c.json({ docNo }, 201)` — **never for `asDraft`** (`:5637-5639`): a draft is the scan's guess, not an order |
| SO create (draft confirmed) | `scm/routes/mfg-sales-orders.ts` | `PATCH /:docNo/status` when the transition LEAVES DRAFT (`:5989-5999`) — the second create anchor |
| PO create | `scm/routes/mfg-purchase-orders.ts` | after `recordPoCreate(...)` — **never for a DRAFT PO** (`:1401-1408`) |
| PO create (draft confirmed) | `scm/routes/mfg-purchase-orders.ts` | `PATCH /:id/confirm`, after the flip (`:4075-4079`) — a third create anchor |
| SO -> DO | `scm/routes/delivery-orders-mfg.ts` | `POST /` (SO-linked only) and `POST /from-sos` |
| PO -> GRN | `scm/routes/grns.ts` | `POST /from-pos` and `POST /from-po-items` (per bucket) |
| DO -> SI | `scm/routes/sales-invoices.ts` | `POST /from-dos` |
| GRN -> PI | `scm/routes/purchase-invoices.ts` | `POST /from-grn` and `POST /from-grn-items` (per bucket) |
| SO cancel | `mfg-sales-orders.ts` | `PATCH /:docNo/status` when the transition is to CANCELLED |
| PO cancel | `mfg-purchase-orders.ts` | `PATCH /:id/cancel` |
| DO cancel | `delivery-orders-mfg.ts` | `PATCH /:id/status` when the transition is to CANCELLED |
| GRN cancel | `grns.ts` | `PATCH /:id/cancel`, after the atomic flip won the race |
| SI cancel | `sales-invoices.ts` | `PATCH /:id/status` inside the atomic CANCELLED branch |
| PI cancel | `purchase-invoices.ts` | `PATCH /:id/cancel`, after the atomic ACTIVE->CANCELLED flip won |
| SO edit | `mfg-sales-orders.ts` | `queueAcSoEdit` from the header PATCH, line add/edit/delete, `tbc-update` / `tbc-swap` / `tbc-swap-sofa`, the admin price `override`, and `so-amendments.ts` approve-so |
| SO edit (salesperson HANDOVER) | `so-handover.ts` | `enqueueEdit({ touchedFields: ['agent'] })` once per order that actually moved, inside the loop and after every `continue` — so a skipped order queues nothing. `agent` is the AutoCount rep NAME and it follows a reassigned salesperson, so without this the account book keeps naming the departed rep. See `so-handover.md` |
| SO edit (a PAYMENT moved the balance) | `mfg-sales-orders.ts` | `enqueueEdit` inside `recordSoPaymentRow` — the insert CORE, so `scan-so.ts`'s background receipt booking is covered as well as `POST /:docNo/payments`; plus `queueAcSoEdit` in `PATCH` and `DELETE /:docNo/payments/:id`. **Not** on `POST /:docNo/payments/:id/slip`, which attaches proof and moves no money |
| PO edit | `mfg-purchase-orders.ts` | `queueAcPoEdit` from the header PATCH, line add/edit/delete, `bulk-supplier-date` (per PO that moved), `convert-from-so`, and `po-amendments.ts` approve |
| DO edit | `delivery-orders-mfg.ts` | `queueAcDoEdit` from the header PATCH and line add/edit/delete |
| GRN edit | `grns.ts` | `queueAcGrnEdit` from the header PATCH and line add/edit/delete |
| SI edit | `sales-invoices.ts` | `queueAcSiEdit` from the header PATCH, line add/edit/delete, and `POST /:id/items/from-do/:doId` (the partial transfer) |
| PI edit | `purchase-invoices.ts` | `queueAcPiEdit` from the header PATCH and line add/edit/delete |
| PO create (from SOs) | `mfg-purchase-orders.ts` | `convertSosToPosCore`, per bucket, when the inserted status is not DRAFT — this is what `POST /from-sos` and the MRP agent both ride |
| GRN / PI created **with a parent** | `grns.ts`, `purchase-invoices.ts`, both `POST /` | `enqueueConvert` `po_to_gr` / `gr_to_pi` when the LINES name a source, via `lib/convert-parent.ts`. Fixed 2026-08-23 (`docs/bugs/0524`) — the THIRD document to carry this same defect, after the SI row below fixed it on 2026-08-17. Both routers had recorded every document as parentless, including everything the desktop conversion screens produce, and the desktop never calls `/from-po-items` or `/from-grn-items` at all: the pickers navigate to the New form, and the New form posts here. The old comment argued a conversion would send the PO's outstanding lines instead of the typed quantities — true only WITHOUT `DtlKeys`, which `readConvertSourceKeys` supplies whenever it can name every line. |
| DO created parentless, and GRN / PI with NO linked line | those routers' `POST /` | `recordParentlessCreate` — a `skipped` row, because AutoCount has no create for these. Not requeueable, which is why a wrongly-parentless row also loses its Send-again button |
| SI created on `POST /sales-invoices` | `scm/lib/si-autocount-source.ts` | The one of the four that RESOLVES the source before it says anything. `POST /` accepts `deliveryOrderId` and a per-line `doItemId`, so the unconditional `recordParentlessCreate` that used to sit there claimed a fact it never checked and filed every desktop from-DO invoice as ERP-only (`HC-SI-2608-001`; BUG-HISTORY 2026-08-17). Now: one source DO with every line linked -> `enqueueConvert` `do_to_iv`; several -> the merged-conversion skip; a linked line beside a standalone one -> `mixed-source-lines`; genuinely no source -> `recordParentlessCreate`, unchanged |
| line REMOVED, any of the six | the six `DELETE /.../items/:itemId` handlers | `retiredLineOf(...)` BEFORE the row is destroyed, handed to the edit as `retire` — see 7a |

**An amendment is an EDIT, never a delete-and-recreate.** `applySoAmendment` and
`applyPoAmendment` rewrite a confirmed document's header and lines in place; the
queue call sits after the amendment's own optimistic-lock flip won, so exactly
one edit is queued per applied amendment. Re-creating the document instead would
destroy AutoCount's own `DocTransfer` links and its audit trail — a worse loss
than the ERP-side one, and forbidden outright by the owner's rule that nothing is
ever deleted.

A **variant or SKU change IS a line change** — AutoCount takes it as `Desc2` +
`ItemCode` on the same `DtlKey` — so the `tbc-*` routes need no operation of
their own. Those three run inside `runScmPgCommand`, so their enqueue sits
OUTSIDE the transaction and fires only on a 2xx.

`tests/autocountWritebackWiring.test.ts` pins every one of these anchors so a
refactor cannot silently unhook the queue.

`tests/autocountWritebackCells.test.ts` asks the stronger question. Pinning named
anchors is a regression net, not a coverage claim: a test whose name says "every
SO mutation path queues an edit" while its body checks seven hand-listed places
passes forever after the eighth path is added — and the NAME is what the next
reader trusts. So that file DERIVES the expected set from `AcSyncService.cs`: it
reads the `case` labels out of `Cancel()` and `Edit()` and asserts the ERP asks
for exactly the same six document types. A type the service can handle and the
ERP cannot reach now fails automatically, with nobody having to remember.

**Anchor a pin on the DECLARATION, not on the registration line (2026-08-23).**
The DO add-line case anchored on `deliveryOrdersMfg.post('/:id/items',` and read
forward to the handler's own tail. When that handler became a named export
(`addDeliveryOrderItemHandler`, so the outbound-category suite could drive it —
`docs/bugs/0524-…`), the registration became a ONE-LINE call BELOW the body: the
start anchor still matched, the end anchor was now behind it, and the pin failed
on a handler whose `queueAcDoEdit` had not moved an inch. It is repointed at the
`export const` line. Prefer the declaration for any handler that is, or might
become, a named export — `patchDeliveryOrderStatusHandler` and
`createDoFromSoLinesHandler` are already that shape in the same file.

### Two cases that need care

**Create then edit before the drain runs.** `enqueueEdit` first looks for a
still-PENDING create for the same document and REPLACES its payload. Queueing an
edit behind a stale create would push the pre-edit order into the live book and
then correct it, which is visible to whoever is looking at AutoCount.

**Cancel before the drain runs.** `enqueueCancel` marks the pending create
`skipped` and queues nothing. Creating a document in a live account book only to
cancel it is not a no-op to the people using that book.

### A CARRIED-OVER document must never be enqueued at all

`enqueueConvert` has none of the "already in AutoCount" protection its
`enqueueSoCreate` / `enqueuePoCreate` siblings have — both of those bail when the
parent already carries a `linked_ac_docno`. Convert has no such check, and every
document carried over at the 2026-08 cutover carries a `linked_ac_docno`, so
`dispatchOne` would resolve a real `FromDocNo` and push a `gr_to_pi` /
`do_to_iv` transfer for an invoice the live AED_HOUZS book **already holds**. The
result is a duplicate invoice in the owner's real accounts, and nothing on the
ERP side looks wrong afterwards.

The refusal therefore sits IN FRONT of the enqueue, in the route handler, not
inside the outbox: all eight paths that can attach a migrated goods receipt or
delivery to an invoice call `refuseMigratedSources`
(`src/scm/lib/migrated-chain.ts`) and return 409 before any enqueue is reached.
`backend/tests/migratedConvertGuard.test.mjs` asserts the ORDER, not merely the
presence — a refusal placed after the enqueue is no refusal at all.

Since 2026-08-20 it asserts the ANSWER rather than one spelling of the call. A
refusal may be returned through `c.json(...)` or through
`refuseWithoutWriting(c, ...)`; the second additionally releases the request's
idempotency claim so an operator can correct the payload and try again
(`src/scm/lib/no-write-refusal.ts`). Both are refusals, both are the same status,
and the rule this gate guards was never about which one is used — pinning the
literal text would have blocked the Purchase Invoice create adopting the release.
What stays pinned: the guard must RETURN, at the same status, carrying
`mig.reason` so the failure is findable.

Invoices for carried-over documents are written by
`backend/scripts/create-migrated-invoices.mjs`, which enqueues nothing by
construction. They carry `migrated_no_stock = true` (migration 0294), the same
predicate 0276 gave `scm.grns` and `scm.delivery_orders`.

Note the asymmetry worth remembering: `scm.grns.linked_ac_docno` holds the
**PO's** AutoCount number, not the receipt's, despite migration 0276's own
comment. A convert transfer pushed from a migrated GRN would therefore also name
the wrong source document.

### What each side is composed FROM

| Payload field | ERP source |
|---|---|
| SO header | `scm.mfg_sales_orders` — `debtor_name`, `agent` + `salesperson_id` (§7n), `sales_location`, `ref`, `phone`, `address1-4`, and `branding` / `venue` / `po_doc_no` into UDF |
| SO lines | `scm.mfg_sales_order_items`, including `linked_ac_dtlkey` (migration 0273) — the AutoCount line an edit addresses |
| PO header | `scm.purchase_orders` — `po_number`, `po_date`, `notes`. **The creditor is a JOIN**: the table is supplier-keyed, so `CreditorCode` / `CreditorName` come from `scm.suppliers.code` / `.name` through `supplier_id`. It has no `agent` and no `ref` at all, so a create sends null for both and an edit omits `Ref` entirely rather than blanking AutoCount's |
| PO lines | `scm.purchase_order_items`, same `linked_ac_dtlkey` |

Every column these reads name is listed once at the top of
`scm/lib/autocount-outbox.ts`. That is deliberate: PostgREST does not ignore a
column a table does not have, it fails the whole query with **42703**, so a
phantom column silences an entire flow (see `BUG-HISTORY.md`, 2026-08-10).

---

## 6b. The refusal reaches the OPERATOR, not only the queue

Owner, 2026-08-19: *"开单的时候就挡住 AutoCount 一定会拒绝的形状,不要等到五分钟后
在队列里默默失败"* — refuse the shapes AutoCount will certainly reject while the
document is being written, not five minutes later in a queue.

**The shape being fixed is SILENCE, not permissiveness.** Every one of the eight
refusals in §7 is computed INSIDE the operator's own request: `enqueueSoCreate`
composes the whole payload and is awaited three lines before
`c.json({ docNo }, 201)`; `enqueuePoCreate` likewise on all three PO anchors in
the table above. The refusal was caught, filed as a `skipped` row, and the
operator was handed a 201. That row is the right record for an engineer — it is
durable and it names the foreign key — but it lives behind `scm.autocount.read`
(`scm/index.ts`), which no salesperson or buyer holds. So the person who raised
the document believed it was in the accounts, and nothing ever told them
otherwise.

`scm/lib/ac-preflight.ts` is the ONE place that turns a refusal into a sentence
an operator can act on, and the one place that decides whether the ERP may stop
the save for it. It re-derives nothing: the verdict is the composer's own
`resolveAcAgent`, or the composer's own thrown refusal class.

### Block or warn, per cause

The owner's standing rule is that a gate may only fail someone for something
they could have caused. A block on a document the operator cannot fix is worse
than silence — it stops the shop floor AND blames the wrong person.

| Cause | Where it is asked | Verdict | Why |
|---|---|---|---|
| No sales agent the book will accept | confirm gate, BEFORE the insert | **BLOCK** (422) | The fix is the Salesperson picker on the same screen. Not a new gate — `salesperson_required` has refused this since the owner's 2026-08-08 ruling on HC-SO-2607-008; it simply asked a laxer question than the composer and let that order's own value `"Unassigned"` through |
| PO line ambiguous under this creditor (`ItemCodeError`) | after the save, on the create response | **WARN** | The remedy is master data: retire the duplicate AutoCount item, or record what this supplier calls it in `supplier_material_bindings`. A buyer owns neither |
| Supplier has no creditor code (`MissingCreditorError`) | after the save | **WARN** | `scm.suppliers.code` is issued by accounts |
| No stock location, Desc2 over the ceiling, a sofa that cannot fold, a keyless line, an unreadable document | after the save | **WARN** | Already blocked earlier where a gate can name the fix (§7's stock location, `so-location-gate.ts`), or needs data the operator does not own |

**The severity is expressed by the call site, not by a flag.** `acNotSentProblems`
is only ever handed a refusal the enqueue has already thrown, after the document
is committed — it cannot refuse a save because there is no save left to refuse.
A 422 there would be a lie: the order exists.

### The one live cause, measured

Of the five refusal causes recorded against production between 2026-08-13 and
2026-08-17, four are closed by earlier work (§7's stock location, the sales
agent stamp, the conversion's `DebtorCode`, the transfer's `CreditorCode`). One
is still reachable by a document raised today, and it is on the PURCHASE side
only: with a creditor that owns none of an ERP code's candidates,
`resolveAcItemCode` still answers `ok:false, reason:'ambiguous'`. Measured
against the compiled cutover map — **117** ambiguous ERP codes, **117** refuse
under a foreign creditor, **0** refuse when no supplier is named. A sales order
names no supplier, so the sales path is clear; a purchase order always names
one.

### The response key

The create responses carry `acNotSent: SaveProblem[]`, absent when the document
composed cleanly. `frontend/src/vendor/scm/lib/ac-not-sent.tsx` reads it and owns
the title; the SENTENCES travel verbatim from `ac-preflight.ts`, because the
thing that decides a document is unsendable is the composer and the wording has
to follow the reason. `backend/tests/acNotSentWiring.test.ts` is the referee
across the two packages — nothing else makes the backend's key and the
frontend's key the same string.

Wired on the desktop SO create and all three PO anchors. NOT yet on the mobile
SO wizard, the POS handover, or the DRAFT -> live transition (which returns a
response object built inside its command) — those still refuse in silence and
are recorded as such rather than counted as done.

---

## 7. What the ERP can express and AutoCount cannot

`AddPartialTransferDetail(fromDocType, fromDocKeys)` takes **ONE source
document** — a mixed key array answers `InvalidTransferItemException` (measured
on the live book, 2026-08-16). Merging is done by calling it once per source, or
natively by `FullTransfer(String[] docNos, …)` when the whole of each source
moves.

**A MERGED CONVERSION IS NO LONGER ONE OF THE SHAPES BELOW — since 2026-08-18.**
The ERP names every source document it drew from and the transfer goes:
`enqueueConvert` takes `AcDocRef | AcDocRef[]`, one source writes
`payload.fromDoc` and several write `payload.fromDocs`, and the drain resolves
each through its `linked_ac_docno` into `FromDocNos`. If any one source has no
AutoCount counterpart yet the row WAITS rather than sending the subset — a
delivery order in the book carrying one sales order's lines out of two would be
`sent`, and nothing would ever look at it again.

Two consequences worth carrying:

- `conversionIsPartial` counts leftovers **per parent**. It used to compare one
  parent's line count against the total taken from all of them, which is only
  ever right for a single source; with a merge it reads a partial transfer as a
  whole-document one and sends no `DtlKeys`, so AutoCount moves every
  outstanding line on every source. That is D14 one level up.
- `scm.autocount_outbox` is append-only, so every merged conversion recorded
  BEFORE that date still carries `AutoCount transfers from ONE source document`
  and still classifies `no-autocount-shape`. The needle stays for exactly that
  reason; the remedy now says the row is history. Those documents were never
  composed, so **Send again cannot help them** — they are a one-off backlog to
  raise by hand.

Some ERP shapes still have no AutoCount shape at all.

They are written to the outbox with `status = 'skipped'` and the reason in
`last_error` (`recordConvertSkipped`). Inventing N AutoCount documents would
create records the ERP does not have; dropping it silently would leave a
shipment in one system and not the other with nothing to find it by. **A
divergence that is written down can be found.**

Find them with:

```sql
SELECT doc_type, doc_no, op, last_error, created_at
  FROM scm.autocount_outbox
 WHERE status = 'skipped'
 ORDER BY created_at DESC;
```

**A skipped row is TERMINAL — fixing its cause does not bring the document back.**
That is what §9's re-queue tool exists for. `enqueueSoCreate` is reachable from
exactly two places (SO create, and `DRAFT -> live`), and `enqueueEdit` bails on
`if (!composed.linkedAcDocNo) return false;` — so a document that never reached
AutoCount cannot be edited back into the queue, and re-saving it does nothing.

**A compose that FAILED is written down the same way.** If a read the payload is
built from errors — a column that is not there, a dead REST edge — the enqueue
logs `[autocount-outbox] <op> compose read failed` and writes a `skipped` row
carrying the database's own message, then returns false. It does **not** compose
what it managed to read. `data ?? []` on a failed read is an empty line list,
and an order pushed into a live account book with no lines on it is
indistinguishable, from the AutoCount side, from one the operator really did
leave empty.

---

## 7a. Line identity — the DtlKey, and why an edit can be REFUSED

An AutoCount document line has no identity the ERP can set. The SDK's only
handle is `DtlKey`, assigned by AutoCount at save, and `/edit` addresses a line
with `doc.EditDetail(dtlKey)`. The ERP stores it in
`scm.mfg_sales_order_items.linked_ac_dtlkey` and
`scm.purchase_order_items.linked_ac_dtlkey` (migration 0273) — and, since migration **0280**, on all four downstream line tables too (`delivery_order_items`, `grn_items`, `sales_invoice_items`, `purchase_invoice_items`). All six carry it; 0280 is what made a DO / GRN / SI / PI edit expressible at all.

### The defect this section exists for

`/edit` used to fall through to `doc.AddDetail()` for a line with no key —
reading a keyless line as "genuinely new". **Measured on production 2026-08-11,
before any backfill: 0 of 13,907 SO lines and 0 of 864 PO lines on
AutoCount-linked documents carried a key.** Every line was keyless, so the first
edit of any document would have appended a second copy of every line the
operator did not touch into the live account book. On a purchase order those
copies are permanent — `PurchaseOrder` exposes neither `DeleteDetail` nor any
line-level `Cancelled` in the 2.2 SDK.

Two causes, both now closed:

| cause | fix |
|---|---|
| Create routes returned only the DocNo, so an ERP-created document had NULL line identity forever | Create and convert routes now answer `lines: [{Seq, DtlKey, ItemCode, Desc2}]`, and the drain stores them |
| The cutover-migrated documents were never backfilled | `backend/scripts/backfill-ac-line-keys.mjs` + the **Backfill AutoCount line keys** workflow |

### The refusal

`composeEdit` throws `KeylessLineError` when **any** line lacks a usable
`DtlKey`, and the whole edit is refused. `enqueueEdit` catches it and writes a
`skipped` outbox row whose `last_error` starts `refused, nothing sent (<ErrorName>): ` — the parenthetical carries the refusal class (`KeylessLineError`, `SofaCollapseError`, `ItemCodeError`, `MissingLocationError`) — and names
the offending line. Nothing is POSTed.

```sql
SELECT doc_type, doc_no, last_error, created_at
  FROM scm.autocount_outbox
 WHERE status = 'skipped' AND last_error LIKE 'refused, nothing sent (%'
 ORDER BY created_at DESC;
```

The remedy for a row in that list is to backfill that document's line keys, then
save it again.

`AcSyncService` carries the **same** refusal, so a service binary that has not
been rebuilt is also safe. The ERP copy exists so the request is never sent.

**A partial edit is not offered.** One keyless line refuses the whole document.
Sending the keyed lines and dropping the rest would push a payload that does not
describe the order.

**Composed lazily, on purpose.** When the document's `create` is still sitting
unsent in the outbox, an edit REPLACES that create's payload instead of queueing
an edit — and a document that has never reached AutoCount cannot have line keys
yet. Composing the edit eagerly would refuse that entirely legitimate path.

### Storing what a create returns

`persistLineKeys` (`scm/lib/autocount-outbox.ts`) zips the returned keys onto the
ERP rows **by index** — `toDetails` is a strict 1:1 map, so the Nth detail sent
is the Nth row. It **verifies before it writes**: the counts must match and every
`ItemCode` must match, or nothing is stored at all.

That asymmetry is deliberate. A **missing** key is refused loudly by
`composeEdit`. A **wrong** key is not refused at all — it silently edits a
different line in a live account book. So an unprovable zip stores nothing, and
the document keeps NULL keys.

Failing to record identity never changes the dispatch outcome: the document IS
in AutoCount and the row IS `sent`. It is logged, not retried.

### Adding a line to a document AutoCount already has — DECLARED, never inferred

A new line on an existing AutoCount document carries no key, and a keyless line
means two opposite things: just added, or never backfilled. The ERP does not
guess. The route that did the inserting NAMES the rows it inserted
(`newLineIds`), and `composeEdit` marks them `IsNewLine: true` — which
`AcSyncService` turns into `AddDetail()` — **only when every other keyless line
on the document is one of those declared rows.** A document with an
undeclared keyless line has not been backfilled, so nothing on it can vouch for
the new one, and the whole edit is still refused. Setting `IsNewLine` on a guess
re-opens the duplicate-append defect one line at a time, and on a purchase order
a duplicate cannot be removed at all.

| document | add a line | remove a line | line photographs |
| --- | --- | --- | --- |
| SO | yes, since 2026-08-11 | yes (`Retire`) | yes |
| PO | yes, since 2026-08-31 | yes (`Retire`) | yes, since 2026-08-31 |
| DO / GR / IV / PI | yes, since 2026-08-31 | yes (`Retire`) | no |

Photographs travel as KEYS in the outbox payload and are fetched at drain time;
`photosOf` is document-type agnostic, the drain keys off the OP not the type, and
`AcSyncService`'s line loop is `dynamic`, so `Photos` becomes `FurtherDescription`
on a purchase detail exactly as on a sales one. What gated the purchase side was
evidence, not code: the `\wmetafile8` shape had only been proven on the live book
for sales orders.

Where it is wired: `queueAcSoEdit` / `queueAcPoEdit` take `newLineIds` and pass
them to `enqueueEdit`, which forwards them to `composeSoState` /
`composePoState`; those spread them into `composeEdit`'s options. The SO sites
are the two line-insert routes in `mfg-sales-orders.ts` (the sofa build and the
ordinary line); the PO sites are `POST /:id/items` and `POST
/:id/convert-from-so` in `mfg-purchase-orders.ts`. Search for `newLineIds`
rather than trusting a line number — this file's citations rotted once already.

**AND THE ADDED LINE LEARNS ITS KEY BACK — since 2026-08-31.** AutoCount assigns
the DtlKey, so until the ERP is told it, the added row stays `linked_ac_dtlkey =
NULL` and the NEXT edit of that document is refused by the very guard above (the
declaration is per-REQUEST; a later edit declares nothing). `/edit` now answers
with the document's line keys when it added a line — the same `CreatedLines()`
read-back the CREATE path has always used — and `persistNewLineKeys` stores them.

That store does NOT reuse the create path's by-position zip: the book orders by
DtlKey, the payload is in ERP line order, and an added line is last in the book's
order but anywhere in ours. It reasons on the DIFFERENCE — a key the payload did
not already carry is one this edit created — re-checks the ItemCode, and stores
nothing at all on any disagreement. `composeEdit` names the ERP rows behind each
declared-new line as `ErpLineIds` (a list: a sofa build is several rows).

**The service half needs a host deploy** (`deploy-on-host.ps1`). Until it lands,
an edit answers with no line list and the ERP half is a no-op —
`docs/bugs/0583-*`.

**A document already held back is repaired by `POST
/autocount-outbox/relink-lines`** — it reads the document out of the book
(`/doc-read`, served since 2026-08-15) and stamps the keys onto our keyless
lines. No host deploy. The matching rules and every refusal are in
`scm/lib/autocount-relink-lines.ts` with their own tests: a book line another row
already claims is not a candidate, a repeated code needs Desc2 to separate it
(prefix-tolerant, the book truncates its own), and an ambiguous line refuses
ITSELF while the rest still land. It matches on the RAW ERP code today, so a line
whose code the bindings rewrite is refused rather than mis-assigned —
`docs/bugs/0585-*`.

**Clear-and-rebuild is NOT how to fix one of these**, though AutoCount's own docs
sample it: it destroys every DtlKey — the identity behind `FromSODtlKey`, the
transfer chain, the photographs and retirement — and on a TRANSFERRED document
AutoCount's own troubleshooting page says the source is left pointing at nothing
and the document goes grey and uneditable.

**A new line also gets a stock location, and only a new one.** An existing line
with no location omits the `Location` key so the account book keeps the value it
owns; a new line has no such value, so the document's own warehouse stands in
(`newLineLocation`, distinct from `defaultLocation`, which applies to every
line). If neither exists the key is omitted and AutoCount applies its own
default — not refused: the evidence that a missing Location is fatal comes from
the CREATE path, which assigns the key unconditionally, and the edit path is
`ContainsKey`-gated.

### Retirement — `Retire: true`

No detail class in the SDK has a line-level `Cancelled` (the string appears zero
times in `sdk-api-reference.txt`), and only `SalesOrder` has `DeleteDetail`. So
`AcSyncService` retires a line in place: `Qty = 0`, `Transferable = false`, and
an `[ERP-CANCELLED]` prefix on `Desc2`.

`Qty = 0` is the load-bearing part. AutoCount's own outstanding predicate is
`Qty - ISNULL(TransferedQty,0) > 0`, so only zeroing the quantity makes
AutoCount's outstanding set agree with a retired ERP line.

**The ERP now sends `Retire`, from two places, and they are not the same thing.**

| source | what it is | where it comes from |
|---|---|---|
| `ErpLine.cancelled` | a RETAINED line the ERP has written off | `scm.mfg_sales_order_items.cancelled`, the only line table with the column |
| `enqueueEdit({ retire })` | a line the ERP HARD-DELETED | `retiredLineOf(sb, table, itemId)`, called by all six line-DELETE routes BEFORE the row is destroyed |

The second is what makes line removal reach AutoCount at all, and it is easy to
get wrong by doing nothing: **`/edit` applies only the lines it is GIVEN**
(`AcSyncService.cs`, its `Lines` loop). A deleted row is simply absent from the
recomposed payload, so without an explicit retirement the account book keeps the
line live, outstanding, and transferable into a later DO or GRN. Leaving it out
is not neutral — it is a divergence.

Order of operations therefore matters and is pinned by a test: the DELETE handler
reads the row's `linked_ac_dtlkey` FIRST, because after the delete the key is
gone with the row.

Three rules the composer keeps:

- **A retired line carries the minimum that identifies it** — `DtlKey`,
  `ItemCode`, and `Desc2` only when the ERP has one. No `Qty`, `UnitPrice`,
  `Description` or `Location`: the service's `Retire` branch `continue`s before
  it reads them, so sending them is inert today and a trap the day a service
  build stops short-circuiting. `Desc2` is OMITTED rather than nulled when the
  ERP has none, so the book keeps its own text under the marker.
- **A cancelled line with no `DtlKey` is REFUSED**, like any other keyless line
  and for a sharper reason: it means the ERP wants a line retired in the account
  book and cannot name which one. Dropping it would be a silent divergence.
- **A re-added line that inherited the same key wins over the retirement.**
  Retirements are appended last and deduplicated against the retained lines,
  because `/edit` applies `Lines` in order and the retirement would otherwise
  zero a line the operator just restored.

**A cancelled line is never on a CREATE.** On an edit AutoCount already holds the
line, so a retirement is the honest rendering; on a create it holds nothing, and
the honest rendering of a written-off line is its absence. `composeCreateSo` and
`composeCreatePo` filter through `live()`.

**What is still NOT built: the soft cancel itself.** Five of the six line tables
have no `cancelled` column, and all six DELETE routes still hard-delete the row.
So the owner's cancel-never-delete rule is honoured **towards AutoCount** on all
six today, and **inside the ERP** on none of them. Converting a DELETE into an
`UPDATE ... SET cancelled = true` needs every reader of that table taught to
exclude the row first — `purchase_order_items` alone has ~186 references — and a
half-converted soft cancel is worse than the hard delete it replaces, because a
hard delete is at least consistent. `docs/autocount-line-retirement-plan.md`
holds the per-gap evidence and the order to do it in.

---

## 7b. The two shape mismatches the composer resolves — D9 and D10

Between the ERP's line list and AutoCount's, two things do not line up. Both are
handled in `composeDetails` (`src/services/autocount-writeback.ts`), in this
order.

> **CHANGED 2026-08-13, owner decision. Read this before the two sections below —
> they describe the mechanisms, and these are the rules those mechanisms now run
> under.**
>
> **D9 no longer folds a NEW order.** One ERP line goes to AutoCount as one
> line: `9028-1A(LHF)` and `9028-2A(RHF)` each arrive as themselves. Folding is
> reserved for a build the account book ALREADY holds as a single line, and the
> DtlKeys say which is which, per build — compartments sharing one key fold,
> distinct keys are left alone, no keys at all is a create. Mixed (some keyed,
> some not) still folds, so the keyless-line refusal in 7a stops the document
> and asks for a backfill. The rule lives in `collapseSofaLines`'s `flush()`.
>
> **D10 no longer refuses an unknown code.** It resolves to the ERP's own code
> and `/ensure-masters` opens the item (7e). The old rule was right while
> sending an unmapped code meant referencing an item the licensed book does not
> hold; it does not any more, and its cost was total — whole product ranges are
> in no cutover row, so every order containing one was blocked outright. A BLANK
> code is still refused, and a MAPPED code is still never sent as itself.
>
> **The full order of preference when nothing else decides**, for a document
> with no creditor (which every sales order is, since the PO does not exist yet
> when the order is written back):
>
> 1. one candidate — take it
> 2. the document's creditor, when it has one (purchase orders only)
> 3. a candidate NAMED like the ERP code
> 4. `HOK`, then `NB` — the owner's supplier preference; settles 103 of the 117
>    ambiguous codes, almost all BEDFRAME
> 5. the ERP's own code, opened on first use
>
> **Because the shape is settled first, the resolver does no sofa reasoning.**
> A folded line reaches it as `<model>-1S`, an unfolded one as its own
> compartment code, and each resolves to what it is. A compartment is never
> redirected to its model — that used to happen and it gave one sofa two
> different AutoCount items depending on which side of the collapse the caller
> sat. See BUG-HISTORY, 2026-08-13.
>
> **An EDIT never sends `ItemCode` for a line AutoCount already owns.** Same
> rule `Location` runs under: the book's own value is the truth on a line it
> holds. Swapping a product still propagates, because a swap is a delete plus an
> add — the removed row is retired and the added row has no DtlKey, so it keeps
> its code. 194 real lines sit under the two brand items the cutover collapsed
> and an edit must not move them.


### D10 — `material_code` is not `ItemCode`

**Two sources, and the LIVE one wins.** `scm.supplier_material_bindings` is this
ERP's own record of the cross-ref — `material_code` is our internal code,
`supplier_sku` is AutoCount's, one row per supplier — populated at the cutover
precisely so ERP codes could be pushed back. It is consulted FIRST, because it
is the only one of the two that GROWS: the compiled CSV below is a snapshot of
the book on 2026-08-05 and cannot know a product opened since.

That was not a nicety. Without it the resolver refused every post-cutover SKU; a
refused line refuses the whole document; and the document never reached the
drain — so `/ensure-masters` never ran for the very case it was built for. A new
product was unwritable and the feature meant to fix that was unreachable.

`is_main_supplier` orders the lookup, and **a purchase order narrows further**:
it knows its own creditor, and that supplier's binding beats the main one. One
internal code bound to several suppliers is the normal case, not the edge.

**The read itself is `readMfgProductBindings`** (`backend/src/scm/lib/supplier-bindings.ts`),
which `bindingsFor` in `backend/src/scm/lib/autocount-outbox.ts` now calls instead of
issuing its own query. Three properties, and this resolver depends on all three:
the `item_code` IN-list is CHUNKED by URL bytes, the result is PAGED past
PostgREST's 1,000-row response cap, and the order is TOTAL —
`is_main_supplier DESC, item_code, id`. The first two stop a binding from simply
not arriving (2,660 rows in production on 2026-08-16 against that cap); the
third is what makes "the first row seen per code is its main supplier" a rule
rather than a coin toss, because `is_main_supplier DESC` alone leaves every tie
in planner order. `readOrThrow` still wraps it, so a failed read throws rather
than resolving to a silently short map.



The ERP calls a sofa `9028-1S`; the licensed book calls it `AMN-SF9028 SOFA`.
The record of the cutover is
`backend/scripts/data/autocount-erp-mapping-1561.csv`, compiled into
`src/services/autocount-item-map.ts` because a Worker has no filesystem.
Verified against the live `AED_HOUZS` `Item` table on 2026-08-11: 1561 rows both
sides, zero codes missing either way.

The map is **not invertible on its own**. The cutover collapsed supplier-specific
AutoCount codes onto one ERP code, so of 1427 distinct ERP codes:

| | count | |
|---|---:|---|
| resolve to exactly ONE `ItemCode` | 1310 | 91.8% |
| resolve to SEVERAL | 117 | 8.2% — 102 BEDFRAME, 6 MATTRESS, 4 ACCESSORY, 4 SOFA, 1 ACC |
| of those, separated by the creditor | 109 | a PO knows its supplier; an SO does not |
| **still ambiguous with the supplier known** | **8** | **refused, never guessed** |

`resolveAcItemCode` returns exactly one code or a named refusal
(`unmapped` / `ambiguous`) carrying the candidates. **There is no fallback to
`material_code`** — that fallback is what would put an item the book has never
heard of onto a live document, and on a purchase invoice such a line can never
be removed (the 2.2 SDK exposes neither `DeleteDetail` nor a line-level
`Cancelled` for PI).

### D9 — a sofa is N ERP lines and ONE AutoCount line

The ERP models a build as one line per compartment (`{model}-1A(LHF)`,
`{model}-CNR`, …); AutoCount holds one line per sofa with the build written into
`Desc2` as free text. `collapseSofaLines`
(`src/services/autocount-sofa-collapse.ts`) folds a run of consecutive
compartment rows sharing a model and a `Desc2` back into one line carrying
`{model}-1S`.

Reconstructing the owner's `Desc2` grammar from a compartment list is **lossy**,
so reconstruction is not the primary path:

1. **ECHO.** Both cutover importers already wrote the original `Desc2` verbatim
   onto every compartment row. If it still decodes to everything the ERP row
   holds — the compartments **and** the seat size, the colour and the specials —
   the build has not been edited and the original text *is* the faithful answer.
   Measured on the real corpus: **551 of 551 decodable builds echo
   character-for-character**, whitespace excepted.

   The attribute half of that check is not belt-and-braces. Matching on the
   piece list alone would echo the *old* colour of a re-coloured sofa into the
   account book — a wrong line, not a missing one, with the ERP showing the new
   value, nothing refused, and no marker anywhere that the edit was dropped.
   Re-colouring every coloured build in the corpus and asking what comes out:
   with the attribute check, **341 recomposed / 41 refused / 0 stale**; without
   it, **382 of 382 still carry the colour the ERP no longer holds.**
2. **COMPOSE**, only when the stored text no longer decodes to what the ERP has
   — i.e. the operator actually changed the build.
3. **GATE, always.** Whatever text is about to be sent is fed back through the
   *same* decoder the importers use (`scripts/lib/parse-sofa.mjs` — deliberately
   the same module; a second copy that drifted would make the gate prove
   nothing) and is refused unless it reproduces the compartment sequence, the
   seat size, the colour and the specials.

The gate is what stands between a reconstruction and the account book, and it is
load-bearing rather than decorative: `autocount-sofa-collapse.test.ts` asserts
that the composer is *known* to spell some real builds wrong and that **none of
those escape the gate**. Deliberately reverting the inverse to its naive form
(bare digits for armed ends) does not produce a single corrupted `Desc2` — it
only raises the refusal rate.

Refusals that reach the outbox as a `skipped` row:

| reason | what to do |
|---|---|
| no `Desc2` on the compartment rows | the build has nothing to carry it; fix the line |
| `Desc2` longer than 100 chars | `SODTL.Desc2` / `PODTL.Desc2` are `nvarchar(100)`; truncating would drop part of the build |
| compartments disagree on quantity | the run is not one build |
| cannot spell the compartment list | e.g. a solo `3S`, which decodes to a two-piece build |
| composed text does not survive a decode | the gate fired |

`Qty` is the **shared** compartment quantity, not the sum; `UnitPrice` is the sum
of the compartments, because the importer put the AutoCount line price on the
first compartment and zero on the rest.

**One AutoCount line has ONE `DtlKey`.** A build carries line identity only when
*every* compartment holds the same key; anything else collapses to `null` and is
refused loudly by `composeEdit` (§7a). Half a build's keys present is evidence
the mapping is broken, not evidence of identity.

**Retirement is a property of the WHOLE build, for the same reason.** A cancelled
line reaches AutoCount as `Retire: true` (§7a), and AutoCount holds one line for
the build — so there is no row there that could carry half a retirement. The
three cases, and only the middle one is a judgement call the composer refuses to
make:

| the build's compartments | what is sent |
|---|---|
| all cancelled | one `Retire: true` line, addressed by the build's `DtlKey` |
| **some cancelled, some not** | **`SofaCollapseError` — the whole document is refused, naming the build.** Cancel the rest of it, or reinstate them |
| none cancelled | an ordinary keyed edit |

The refusal is raised **before** the keyless-line check, because a half-cancelled
build is a question about what the operator meant, not a missing backfill —
telling them to backfill a key would send them after the wrong thing.

### The stock location — mandatory on a CREATE, untouched on an EDIT

The two paths need OPPOSITE rules for the same field, which is why this has its
own heading.

`AcSyncService`'s create applies the key unconditionally
(`Set(() => d.Location = Str(it, "Location"))`) and `Str` turns an absent key
into `""`. `""` is not a row in `dbo.Location`, so the live book rejects it:

```
2026-08-11 11:54:59  /create-so  (no Location on either line)
  -> AutoCount.Data.ForeignKeyException  FK_SODTL_Location
     table "dbo.Location", column 'Location'
2026-08-11 11:57:43  /create-so  (Location "KL" on both lines)  -> saved
```

So a create resolves a location per line, in this order, and **refuses when it
runs out** (`MissingLocationError`, a visible `skipped` row — never `""`):

| | source |
|---|---|
| 1 | the line's own `warehouse_id`, resolved to the warehouse CODE (`scm.warehouses`), then through `LOCATION_MAP` |
| 2 | the document — `mfg_sales_orders.sales_location`. A purchase order has none: its ship-to warehouse is per LINE, so there is nothing to inherit and step 2 does not apply |
| 3 | refuse, naming the line |

An **edit** does the opposite: no location means OMIT the key, because the
account book already holds one and a blank would erase it. The same asymmetry
is why `create` is composed LAZILY in `composeSoState` / `composePoState` — an
edit builds the same state object, and eagerly composing a create it will never
send would refuse the edit for the create's reasons.

**The SO side now refuses at CREATE TIME instead** (owner 2026-08-13, after
`HC-SO-2608-002`). A `MissingLocationError` is correct but lands in the wrong
place: hours later, in an outbox row, about an order the salesperson was told
had saved. So company 1's sales orders are gated where the human is —
`backend/src/scm/lib/so-location-gate.ts`, run at the two places the SO router
enqueues a create (create, and `DRAFT -> live`). The composer's refusal stays
exactly as it is: it is the backstop for every path that is not that gate
(imports, the 2990 mirror, a future company not yet on the list), and it is
what proves the gate is not merely advisory. Full rule + company list:
`docs/modules/sales-order.md`, "Company 1 cannot create an order with no stock
location".

Both files are generated and CI-guarded — `npm run audit:ac-item-map` and
`npm run audit:ac-sofa-corpus` run in `backend-typecheck`, so refreshing an
export without regenerating cannot leave the composer resolving against last
month's book while the suite stays green.

---
## 7c. A conversion must name the lines it took

`AcSyncService`'s convert routes resolve their source lines through `DtlKeys()`:
if the payload carries a `DtlKeys` array it transfers exactly those, and **if it
does not, it reads the account book for every still-outstanding line on the
parent** and transfers all of them.

`enqueueConvert` used to send no `DtlKeys` at all, deliberately — the reasoning
was that AutoCount's own book is the authority on what is still outstanding. It
is, and that is beside the point: a delivery order shipping 2 of a sales order's
5 lines produced an AutoCount DO of **all 5**, moving stock in a live account
book that never moved here. Partial shipment is the daily case, not an edge one.

`readConvertSourceKeys` now resolves the subset from the downstream document's
own source-line links, and has three outcomes:

| outcome | when | what is queued |
|---|---|---|
| `DtlKeys: [...]` | every line names a source line, and every one of those carries a `linked_ac_dtlkey` | the conversion, naming exactly those lines |
| refusal | a STRICT SUBSET of the parent's lines, and some source key is missing | a visible `skipped` row; the remedy is the line-key backfill |
| no `DtlKeys` | the document covers EVERY line of the parent, or the ERP cannot read its own links | the conversion, unchanged — "all outstanding" is the same set, and a diagnostic read must never cost a shipment |

The source link per type: `delivery_order_items.so_item_id`,
`grn_items.purchase_order_item_id`, `sales_invoice_items.do_item_id`,
`purchase_invoice_items.grn_item_id`. A cancelled parent SO line is not counted
as one the conversion left behind — nobody will ever transfer it.

### 7c1. FULL or PARTIAL — the ERP decides, in ONE place

Owner, 2026-08-16: 「你要确保它是可以 partially transfer 跟 fully transfer 的。
跟着我们的 ERP 就对了」. Both shapes have to work and the ERP is the authority on
which one a document is. `PlanTransfer` in `AcSyncService.cs` is the whole of that
decision, and it reads only what the payload SAYS — never what the numbers happen
to add up to on the day:

| the payload carries | shape | the SDK call |
|---|---|---|
| no `DtlKeys` | **FULL** — the whole source document, every line, full quantity | `FullTransfer(String[], TransferFrom, FullTransferOption)`. It takes an ARRAY of document numbers, so several sources into one target is native and needs no per-document grouping. A new optional `FromDocNos` names them; absent, it is `[FromDocNo]` |
| `DtlKeys` | **PARTIAL BY LINE** — the ERP named the lines it took | `AddPartialTransferDetail(fromDocType, keys, bool)` once per source document. Not a workaround: it is the documented call for "these lines, at whatever is outstanding", and the only one whose arguments the ERP actually sends |
| `Details[].Qty` | **PARTIAL BY QUANTITY** — 3 of a 5-unit line | `PartialTransfer(TransferFrom, …, Decimal, …)`, once per line |

A named set is **never promoted to a full transfer** because it happens to equal
everything outstanding. That equality holds until the next document, and the
promotion would be the service deciding — the same principle that puts the
SO -> PO transfer/create decision in `scm/shared/po-transfer-shape.ts` rather
than in the C#.

**CLOSED 2026-08-18: the ERP can SAY a partial quantity now.** This paragraph
used to read *"Still open, and NOT fixed by this: the ERP cannot SAY a partial
quantity"* — true when it was written, and the ERP half is the part that was
missing.

`readConvertSourceKeys` now reads the quantity this document took of each source
line (summed, because several target lines can point at one source row — a sofa
build's compartments) against the source line's own quantity, and returns
`details: [{ DtlKey, Qty }]` when any of them is being taken in PART.
`enqueueConvert` puts it on the payload as `Details`.

**Only when it really is partial**, and that restraint is the design, not
timidity: a quantity commits the whole document to the documented
`PartialTransfer` overloads, which `RunTransfer` refuses to fall back from, while
the plain `DtlKeys` shape is the one PROVEN against this book on every conversion
type. Measured on the live book 2026-08-11: **10 of 60,939** sales-order lines
were ever partly transferred, and 6 of 10,351 moved sales orders carried one. So
this branch is rare by construction and must stay that way — a regression that
sent quantities on every conversion would put all six document types onto an
unproven call path at once.

**All-or-nothing per document**, because `PlanTransfer` throws on a key named
with no `Qty` while another on the same document carries one: a line with no
number would silently move its whole outstanding quantity. Every named key gets
a quantity or none do, and `perKey.length === keys.length` is the guard.

Where any of the numbers cannot be read, the ERP sends no quantity at all and the
old shape applies — a readable wrong answer beats an unreadable one.

The C# half is done: `PlanTransfer` reads `Details:[{ DtlKey, Qty }]` the moment
it appears, and `RunTransfer` **refuses** a quantity plan it cannot express rather
than falling back to the primitive — the fallback ships the whole outstanding
quantity, and a live account book holding 5 where the ERP said 3 is worse than a
visible refusal. `FixPartialTransferTransferedQty.FixPartialTransfer` exists in
`AutoCount.Invoicing.dll` because that bookkeeping goes out of sync easily; the
service does not call it and must not create the mess it repairs.

The ERP half is a payload change plus a decision about which quantity is
authoritative, which is why it is registered as divergence **D14** in
`src/services/autocount-writeback.contract.test.ts` rather than guessed at. The
earlier idea — capture the target's own `DtlKey`s via `lineWriteback` and set each
quantity with a follow-up `/edit` — is worse than it looks: it needs a DEFERRED
compose (the keys do not exist until the convert has drained), and editing a
transferred line's quantity is exactly what `CheckTransferDetailQtyNotMatch`
guards against.

### 7c2. What the transfer now REPORTS

Four things `Convert_` never did, added 2026-08-17 and all of them writing to
`C:\Temp\ac-sync-service.log` (readable through `/last-errors`):

- **The master fields go on FIRST**, matching the vendor's own examples — and
  this turned out to be the whole of the outage. See §7c3.
- **`LogTransferApi`** prints every `FullTransfer` / `PartialTransfer` /
  `AddPartialTransferDetail` overload the host's assemblies expose, with
  parameter names, once per document class per service start. A dump nobody can
  re-take is how the header of that file spent a week asserting the transfer API
  does not exist.
- **`IsTransferFromSupported`** as a pre-flight, and
  `TransferHelper.CheckAndGetValidPartialTransferItem` — the vendor's own
  validator — called BEFORE the target document exists, so its refusal arrives
  with the keys still in hand. `/so-to-po` gets the SO-specific twin,
  `CheckAndGetValidSOTransferItem`.
- **`OnSalesDocumentTransferConflict`, `ConfirmOverTransferedQtyEvent` and
  `ShowEditTransferDetailFormEvent` are subscribed** and their arguments read
  back by reflection. **Log only** — nothing answers a confirmation, because
  answering "yes" to an over-transfer prompt would silently accept shipping more
  than was ordered. A delegate that RETURNS a value is not subscribed at all; its
  signature is logged instead.

### What naming the lines COSTS, and what a refusal now tells you

Naming the lines buys the partial shipment above and gives up the only checking
this service does on its own. `DtlKeys()` returns a supplied array **verbatim**,
so neither of the predicates it applies when it chooses the lines itself —

```
h.Cancelled = 'F'      and      (d.Qty - ISNULL(d.TransferedQty, 0)) > 0
```

— is ever evaluated for keys the ERP named. AutoCount is then the first thing in
the chain to look at those lines, and what it says about a line it will not take
is the whole of:

```
AutoCount.Invoicing.InvalidTransferItemException: Invalid transfer item.
```

No key, no document, no reason — and `Serve`'s catch-all returns `ex.Message`
alone, so that sentence is the entire content of the outbox row's `last_error`.
On 2026-08-16 `HC-DO-2608-001` spent all six attempts on it and `HC-DO-2608-002`
five more, and the eleven runs produced no fact between them.

`Convert_` now wraps its whole `switch` and, on any failure, reads the source
lines back out of the book and appends them to the message: per key, the
document it sits on, `Qty`, `TransferedQty`, `Transferable`, the document's
`Cancelled`, the outstanding quantity, and `NOT FOUND` for a key on no row at
all. The columns go through `ExistingColumns` like `/doc-read`'s do, so a book
without one of them loses that field and not the explanation.

It **diagnoses and does not refuse.** Re-applying those two predicates to the
supplied keys as a pre-flight reads as the obvious fix and cannot be justified
from off the host: this file compiles nowhere but the office machine, so a
predicate even slightly stricter than AutoCount's own would turn working
transfers into refusals with nobody able to see it first. The calls and their
arguments are unchanged; only the text a failure carries is better.

### 7c3. The target needs an ACCOUNT before the transfer — PROVEN; D15 CLOSED

**This is the cause of the week the delivery orders spent outside the account
book**, and it was measured on the host on 2026-08-17, not argued from source.
Three compile-and-deploy iterations, verbatim from
`C:\Temp\ac-sync-service.log`:

```
00:42:42  trying FullTransfer from=HC-SO-2608-002 tf=SalesOrder
00:42:42  FullTransfer refused: AppException: Debtor Code is empty.
          - falling back to AddPartialTransferDetail
00:50:13  target debtor before transfer = []          <- SalesHeader moved earlier: NOT enough
00:55:30  target debtor before transfer = [300-C002]  <- doc.DebtorCode set explicitly
00:55:30  trying FullTransfer from=HC-SO-2608-002 tf=SalesOrder
00:55:30  FullTransfer OK
```

and then, by direct SQL against the book:

```
DO  HC-DO-2608-001  300-C002  F
DO  HC-DO-2608-002  300-C002  F
IV  HC-SI-2608-001  300-C002  F
```

`cmd.AddNew()` creates the target with **no `DebtorCode`**, and neither
`SalesHeader` nor `PurchaseHeader` has ever set one — so every conversion ran its
transfer against an account-less document. `AddPartialTransferDetail` reports
that as the contentless `Invalid transfer item.`; `FullTransfer` names it.
`DO-011260`, long treated as a counter-example because it succeeded under the old
ordering, is not one: it came from `qa-convert.ps1`, whose payload carries a
debtor.

**Three things follow, and the third is the one that bites.**

1. **The account is set before the transfer, payload first, book second.** The
   service reads `DebtorCode` / `DebtorName` (sales) and `CreditorCode` /
   `CreditorName` (purchase) from the payload; if none is there it reads the
   SOURCE document's own header out of the book. The fallback is not optional
   politeness — every row already queued in `scm.autocount_outbox` was composed
   without an account, and without it none of them drains.
2. **`SetMaster` READS THE VALUE BACK off the document and logs
   `target debtor before transfer = [...]`.** That exact string, because it is
   what the operator greps. The `00:50:13` line above is why it reads back rather
   than logging what it assigned: moving `SalesHeader` earlier *looked* like the
   fix and the document was still empty.
3. **The sales and purchase arms are NOT symmetrical, on purpose.** On the sales
   side `SalesHeader` runs BEFORE the transfer — the shape proven at `00:55:30`.
   On the purchase side `PurchaseHeader` runs **on both sides of it**: once
   inside the transfer primitive and once after. The trailing call is what makes
   the ERP's `DocNo`, `DisplayTerm`, `Ref`, `Description` and `PurchaseLocation`
   the values that survive, because the transfer copies the SOURCE document's
   master over the target. It is idempotent on this path — every field is a plain
   property assignment through `Set()`, and a conversion payload carries no UDF
   at all, so `ApplyUdf` returns on its first line.

   > **CORRECTED 2026-08-17 (evening).** This bullet used to say
   > `PurchaseHeader` "still runs AFTER it" and that the shape was **unverified
   > on the purchase side**. Both halves are now settled by the host, and the
   > correction is in the opposite direction from a tidy-up: the header runs
   > twice, deliberately.

**CLOSED 2026-08-17 (D15, struck).** `enqueueConvert` sends the account on all
four conversions: `DebtorCode` from `AC_DEBTOR_CODE` on the two sales ones, and
`CreditorCode` / `CreditorName` on the two purchase ones, read off the SOURCE
document's supplier. `dispatchOne` backfills the creditor at drain for rows
queued before the change, exactly as §7c3a does for `so_to_po` — the drain
replays a stored payload and never recomposes.

**THE SALES HALF OF THAT BACKFILL WAS MISSING, AND IT COST DOCUMENTS**
(2026-08-24). D15 closed the ENQUEUE for all four conversions but gave the drain
only the purchase backfill. A sales conversion queued before #2340 therefore
still went out with no `DebtorCode` — and `HC-DO-2608-003` did, failing on
production with the contentless `Invalid transfer item.` while five sales
invoices behind it waited on a parent that could never arrive.

**The message names the wrong thing and `AcSyncService.cs:988` says so:**
`AddPartialTransferDetail` reports a target with no debtor as an invalid ITEM,
not as a missing account — which sends whoever reads it to look at the lines.
`FullTransfer` names it properly; the sales side does not use it (§7f).

`dispatchOne` now backfills the debtor too. It is the cheapest of the three and
the only one that cannot fail: the purchase twins read a document to learn the
account, but `AC_DEBTOR_CODE` is a constant, so there is nothing to read and no
best-effort to fall back from. The `!body.DebtorCode` guard leaves a row composed
after #2340 byte-for-byte as it was stored — this repairs old rows, it does not
override new ones.

**The purchase half was open on two grounds and BOTH were wrong.** They are
written out here because each was recorded as a fact and neither was checked:

| what was recorded | what is true |
|---|---|
| "`scm.grns` and `scm.purchase_invoices` carry no supplier column, so a `CreditorCode` means a `grn -> purchase_order -> supplier` join" | both declare `supplier_id uuid NOT NULL` (`backend/scripts/scm-schema/2990s-full-schema.sql`), both are written on every insert and selected by the live list and detail routes. **One hop**, the same hop `readPoHeader` already makes for `/create-po` |
| "`po_to_gr` has never once succeeded anyway" | true when written, false eight hours later: `HC-GR-2608-001` at 23:09, then `HC-PI-2608-001` |

The join was never built because it was never needed, and the second reason made
nobody go and look at the first. The contract test's fake PostgREST enforces that
schema dump, so if the column really were missing the creditor assertions would
fail with `42703` rather than pass.

**Keep the book fallback even though D15 is struck.** It is the only thing that
answers when the ERP's own lookup returns nothing, and a lookup that quietly
stops being exercised is a lookup someone deletes.

#### 7c3a. `/so-to-po` — the same defect, and the book cannot fix this one

Measured on the host 2026-08-17 09:15, and again at 09:20 when the cron retried:

```
ERROR /so-to-po: System.Exception: CreditorCode required for /so-to-po -
  AutoCount defaults the payment term from the supplier, and without one the
  save dies on FK_PO_DisplayTerm, which names the term and not the supplier
```

`enqueuePoCreate` builds `body` with `composeCreatePo` — which carries
`CreditorCode` — and then **throws it away** when `poTransferShape` says
`transfer`, because `composeSoToPo` returns `{ DtlKeys, Details }` and nothing
else. The create arm has always named the supplier; the transfer arm never named
anything. It read as a clear error only because `SoToPo` already carries a guard
that names it.

**The fix is in two places, and the second is the one that matters today:**

| | |
|---|---|
| `enqueuePoCreate` | puts `CreditorCode` / `CreditorName` on the transfer body. **No join needed** — `readPoHeader` resolved `suppliers.code` two lines earlier for the binding lookup |
| `dispatchOne` | backfills it at drain when the stored body has none. The drain **replays** the stored payload and never recomposes, so the enqueue fix alone leaves every already-queued row failing for ever |

**And the account book cannot answer this one** — this is where the analogy with
§7c3's debtor fallback stops. `/so-to-po`'s source is a SALES order: it carries a
`DebtorCode` and no creditor, and the supplier is a purchase decision that exists
nowhere in AutoCount until we send it. The authority is the ERP's own purchase
order, which the outbox row already points at through `payload.writeback`.

**Reading the service log for this route, and the date that changes it.** Up to
2026-08-17 the request line identified a `/so-to-po` call by its **source sales
order**, not by the purchase order — `composeSoToPo` sent no `DocNo`, so
`Or(DocNo, FromDocNo)` fell through to `FromDocNo`. From the D5 fix below it
names the **purchase order**. Both shapes are in `ac-sync-service.log` and the
date is what tells them apart:

```
10:15:14  /so-to-po  HC-SO-2608-001   before — the SOURCE sales order
...       /so-to-po  HC-PO-2608-001   after  — the purchase order
```

`backend/scripts/which-so-is-so-to-po-retrying.mjs` (Actions → *Which SO is
so_to_po retrying (read-only)*) prints, per row, the sales order the QUEUE names
beside the one the purchase order's own lines imply, and flags a disagreement —
which would be a mislinked `so_item_id`, not a bookkeeping mismatch.

#### 7c3b. The purchase order took AutoCount's number — D5, closed 2026-08-17

The route succeeded for the first time on 2026-08-17 and produced exactly what
D5 predicts. From the host log, verbatim:

```
10:15:13 /so-to-po   HC-SO-2608-001
10:15:14   so-to-po PO-009968: 2 transferred, 2 line(s) costed in phase two
```

`PO-009968` is AutoCount's own counter. The ERP calls that purchase order
`HC-PO-2608-001`, and every other type in the chain already carries the ERP's
number into `AED_HOUZS` — `HC-SO-2608-001/2/3`, `HC-DO-2608-001/2`,
`HC-SI-2608-001`. Owner: 「那 Numbering 你要处理掉啊，怎么可以不一样 Numbering
呢？」

Same cause as the creditor in §7c3a and the same two halves, plus a third on the
service side:

| | |
|---|---|
| `composeSoToPo` | returns `DocNo`. It took the number as its own first, required argument until 2026-08-20, when the field-by-field master was replaced wholesale — see §7c3b-i. `DocNo` now arrives as part of the create payload it is handed, which is why no caller can omit it |
| `dispatchOne` | backfills `body.DocNo` from `row.doc_no` for anything already queued. Cheaper than the creditor's backfill — the outbox row is already KEYED by the ERP's purchase-order number, so there is no join |
| `AcSyncService.SoToPo` | carries the same `RequireDocNo` the two create routes carry, and assigns `po.DocNo` **directly** rather than through `PurchaseHeader`'s `Set()`, which logs and swallows. It also compares the saved `DocNo` against the one asked for and logs a disagreement |

**Deploy the backend first.** It is also the automatic order — merging to `main`
deploys the Worker, and the host binary is a manual `deploy-on-host.ps1` — but it
matters here: `RequireDocNo` refuses a payload without a number, and the backfill
that guarantees one is backend-side.

**`PO-009968` KEEPS ITS NUMBER.** Nothing in this fix renames a document that is
already in a live account book, and nothing should: the SDK's `DocNo` is the
document's identity and `AcSyncService` has no rename path. The purchase order is
otherwise correct — 2 lines, both costed. **The owner decides** between two
options, and neither is ours to take:

1. **Cancel `PO-009968` in AutoCount and let the ERP re-raise `HC-PO-2608-001`.**
   Clean numbering, at the cost of a cancelled document in the book and a
   `linked_ac_docno` to clear on the ERP row first, or the enqueue skips it
   (`enqueuePoCreate` returns early on a linked PO).
2. **Leave it.** One purchase order in the book whose number does not match the
   paperwork, reconciled through `linked_ac_docno` as everything did before D5
   was closed anywhere.

#### 7c3b-i. The third field would have been the third outage — the whole master, 2026-08-20

Two fields had reached the live account book wrong on this one route, and each
was patched on its own: `CreditorCode` (§7c3a) and `DocNo` (§7c3b). They are the
**same defect**. `enqueuePoCreate` builds the nine-field master with
`composeCreatePo` and, on the transfer branch, threw the whole object away —
`composeSoToPo` built its own.

After both patches, **five were still missing**: `DocDate`, `Agent`, `Ref`,
`Description`, `UDF`. The owner hit two of them walking a real purchase chain on
2026-08-19:

> 「为什么 Sales Order to PO，它的 Description2 不对的呢？再来，它的 Purchase
> Location 也不对… 因为它是用 transfer from Sales Order 的嘛，为什么它没有把
> Sales Order 的那些资料带过去呢？」

`Description` is `purchase_orders.notes`. `Agent` is the dangerous one: it
carries the constant `AC_PURCHASE_AGENT` behind `FK_PO_PurchaseAgent`, the same
class of foreign key as the two failures above.

**The fix is structural, not a third field.** `composeSoToPo` now takes the
CREATE payload and spreads it:

```ts
composeSoToPo(master: AcCreatePoPayload, dtlKeys, details)
  -> { ...master, DtlKeys, Details: <the DtlKey override shape> }
```

so a field added to `composeCreatePo` next month reaches a transfer without
anyone remembering this function exists. `enqueuePoCreate`'s hand-merge of
`CreditorCode` / `CreditorName` is gone with it — the master already carries
them.

**The one thing a transfer overrides, and why.** `Details`. A create's detail
NAMES the item being bought (`ItemCode` / `Description` / `Desc2` / `Qty` /
`UnitPrice`) because AutoCount holds no line yet. A transfer's detail addresses a
line AutoCount already made: `AddSOToPOTransferDetail` brought the sales line
across, price and all, and phase two reopens the saved document and applies the
ERP's COST by `DtlKey`. Phase two reads **four** keys — `UnitPrice`, `Qty`,
`Location`, `DeliveryDate` — so those are the only ones sent. A fifth would be
composed, stored, POSTed and dropped by the host, which is the failure this
whole section is made of. Nothing else is excluded.

**`Agent` also needed the SERVICE side, and this is the "carrying is not
landing" trap.** `PurchaseHeader` — the one header function `/so-to-po` and the
four conversions apply — did not read `Agent` at all; only `CreatePo` assigned
it. An `Agent` added to the transfer payload would have satisfied every ERP-side
test and still saved a purchase order without one. `PurchaseHeader` now reads
it, **guarded** (`ContainsKey` + non-empty) because `enqueueConvert` sends no
`Agent` and `Str()` of an absent key is `""`.

**And the alignment is now asserted rather than assumed.** `DtlKeys` and
`Details` are zipped by position, and they are built by different code from
different rows — `poTransferShape` counts ERP purchase-order lines,
`composeDetails` collapses a sofa build into one AutoCount line (D9). Zipped
short, the tail lines keep the CUSTOMER's price and the purchase order pays the
wrong number while looking saved; `SoToPo`'s own guard compares the lines it
CREATED against `DtlKeys` and does not catch it. `AcSoToPoAlignmentError`
refuses instead.

**Which sofa build actually reaches it**: the MIXED-key one, which
`collapseSofaLines` calls "the dangerous one" itself. All-null keys are passed
through and all-distinct keys are left separate — either way the counts match.
Mixed means the book holds the build folded while the ERP's record of that is
incomplete, so the compartments fold to one line while the transfer still names
one source key per ERP row.

**And the refusal is WIRED, which is its own trap.** `noteReadFailure`'s
instanceof list IS the mechanism: an error missing from it is not handled
somewhere else, it is DROPPED — the enqueue answers "not queued", no outbox row,
no console line, nothing to read. Its twin is `acNotSentProblems`, which returns
`[]` for the same absence, so the buyer is told nothing either; the two chains
are pinned against each other in `backend/src/scm/lib/ac-preflight.test.ts`. `AcSoToPoAlignmentError` was missing from that
list for six commits of this change while its own class comment promised "a
readable outbox row instead".

#### 7c3b-ii. Purchase Location — AutoCount has a header one, and the ERP had never sent it

The second half of the owner's 2026-08-19 report, and it is **not** transfer-only
— it was wrong on every purchase order the ERP has ever written.

| | |
|---|---|
| AutoCount | The purchase documents carry `PurchaseLocation`. It is assigned in **two** places, because the purchase side does NOT share one header function: `CreatePo` sets its own master, and `PurchaseHeader` is what `/so-to-po` and the four conversions apply. `PurchaseHeader`'s own comment in `AcSyncService.cs` records that the field "has never been sent" |
| the ERP | `scm.purchase_orders.purchase_location_id` (PR #77) — the PO's own ship-to warehouse, which `/submit` REFUSES a purchase order without unless every line names its own |

So AutoCount was **defaulting** the purchase location on every ERP-written
purchase order, which is exactly「不对」. `readPoHeader` now selects the column
and resolves it to the `dbo.Location` code (the same id → code hop
`withLocations` does for lines), and `composeCreatePo` sends it.

**It is also the LINE default now, and that is the ERP's own precedence read the
only direction it runs**: `warehouse_id ?? po.purchase_location_id`
(`outstanding-po-lines.ts`), and `poWarehouseGap` treats a header warehouse as
covering every line. Before this, a purchase order the ERP considers complete —
header warehouse set, no per-line override — was refused with
`MissingLocationError`. A line with neither is still refused, because then
nobody has said where the goods go.

**Sent OMITTED, never null.** The service's guard on this one key — in both
copies — is `ContainsKey` AND non-empty, because a blank `PurchaseLocation` is
its own foreign key error rather than an empty field. `mastersOf` opens it as a
stock location for the same reason it opens `SalesLocation`: it is applied
through `Set()`, which **swallows**, so a warehouse code `dbo.Location` does not
hold would leave the purchase order looking saved and carrying no location at
all.

**AND FOR EIGHT DAYS IT DID** (#0549, fixed 2026-08-26). `Set()` swallowing was
written down here; what was not, is that the value being swallowed was one this
ERP sends on *every* purchase order. `readWarehouseCode` returned
`scm.warehouses.code` RAW — `KL WAREHOUSE`, twelve characters against a
`LocationCode` of eight — so AutoCount skipped both `PurchaseLocation` and every
line `Location` and saved the order anyway:

```
set skipped: Cannot set column 'PurchaseLocation'. The value violates the
             MaxLength limit of this column.
```

Owner 2026-08-24: *「我的 PO 明明应该是 Bintang Warehouse，但去到 AutoCount 里面
它却变成了 HQ」* — the book's default, showing because nothing was written.

The table at §the create's location ladder has said *"then through
`LOCATION_MAP`"* since it was written. **The document was right and the code was
not**: `withLocations` (the line resolver) and `readWarehouseCode` (the PO
header) both skipped the map. The conversion header was fixed on 2026-08-25, but
that fix reads `warehouse_id` and a purchase order has no such column — its
warehouse is `purchase_location_id` — so the whole PO path was untouched by it.
*A fix for "the same bug" does not reach a path it never runs on.*

**TWO ASSIGNMENTS, AND THE FIRST DRAFT OF THIS FIX HAD ONE.** `CreatePo` does
not call `PurchaseHeader`; it sets `DocNo`, `DocDate`, the creditor, `Agent`,
`Ref`, `Description` and the UDFs itself. Adding `PurchaseLocation` only to
`PurchaseHeader` left the CREATE arm sending a key the host never read — the
same *carrying is not landing* trap §7c3b-i names for `Agent`, walked into in
the same change that named it. The contract test now asserts the key is READ on
**both** routes (`headerKeys(CS_CREATE_PO)` and
`headerKeys(CS_PURCHASE_HEADER)`), which is what caught it.

**STILL OPEN: the PO EDIT cannot change it.** `/edit`'s header allow-list in
`AcSyncService.cs` does not contain `PurchaseLocation`, so moving a purchase
order's ship-to warehouse in the ERP after it has been written does not reach the
account book. Same class as D8. Not fixed here — it needs a service change and a
decision about whether a blank may travel.

#### 7c3c. What the PURCHASE side accepts as a source type, and where a PO keeps its sales link

The owner's question: 「他的 documentation convert from 的那个有做到没有?」 On the
sales side it is complete — `DODTL` / `IVDTL` carry `FromDocType` + `FromDocNo`
and `SO → DO → Invoice` reads correctly in AutoCount. On the purchase side the
answer turned out to be about a **different pair of columns**, and until
2026-08-17 nobody had looked at them.

**1. The general primitive into a `PurchaseOrder` accepts `RQ` and nothing else.
PROVEN**, host log 2026-08-17, verbatim:

```
so-to-po: typed AddPartialTransferDetail("SO") refused (FromDocType must be RQ.)
```

That is `PurchaseOrderPartialTransferDetail`'s own validation, and it enumerates
exactly one type. So `#2302`'s sales-side fix — pass the type and the SDK records
it — has no purchase-side equivalent, and the fallback
`AddSOToPOTransferDetail(Int64)` takes no type argument at all.

**2. The `TransferFrom` enum disagreeing with that message is not a
contradiction; the two are about different gates.**
`AutoCount.Invoicing.Purchase.TransferFrom` carries `SalesOrder = 5`, so the
purchase namespace *can name* a sales source. That enum is the **namespace's**
vocabulary — every purchase target shares it, and `TransferHelper.Create` /
`LoadWantToFullTransferData` take it — while **which subset a given target
accepts is validated inside that target's own `*PartialTransferDetail`
constructor.** The SDK's own surface says the same thing structurally: SO → PO is
shipped as a **parallel** mechanism, never as a member of the general transfer
family.

| general transfer | its SO → PO twin |
|---|---|
| `PurchaseOrder.AddPartialTransferDetail(String, Int64[], Boolean)` | `PurchaseOrder.AddSOToPOTransferDetail(Int64)` |
| `Purchase.TransferHelper.CheckAndGetValidPartialTransferItem(String, Int64[], DBSetting)` | `.CheckAndGetValidSOTransferItem(Int64, DBSetting)` |
| `PartialTransferHelper.GetOverTransferTable(...)` | `.GetOverTransferTableForSOToPO(...)` |
| `DocumentTransferHelper.GetPartialPendingTransferredQtySQL(...)` | `.GetPendingTransferredPOQtyFromSOSQL(...)` |
| `.IsPODetailPartialTransfered(...)` | `.IsSODtlPartialTransferedToPO(...)` |

(`AO → PO` is shipped the same way — `AddAOToPOTransferDetail`,
`CheckAndGetValidAOTransferItem`, `GetOverTransferTableForAOToPO`. Two examples
of one pattern, not one coincidence. Source: `sdk-api-reference.txt`.)

`LogPurchaseTransferVocabulary` now re-takes this from the assemblies on the
first `/so-to-po` of each process — every enum member, the doc-type string
`TransferFromToDocumentType` maps it to, and what `DocumentTypeToTransferFrom("SO")`
answers — so the paragraph above stops being a claim the next reader has to
believe.

**3. A purchase order records its sales source in `FromSODtlKey` /
`FromSODocList`, not in `FromDocType`.** This is the part every earlier report
got wrong, including this guide. Measured in the committed live-book extract
(`backend/scripts/data/ac-fidelity-po-lines.json.gz`, `AED_HOUZS` read-only
2026-08-11, query at `export-ac-fidelity-truth.py:144`):

| | |
|---|---|
| non-cancelled `PODTL` rows | 18,148 |
| carrying a `FromSODtlKey` | **10,338** |
| also carrying a `FromSODocList` | 10,314 |
| purchase orders with at least one linked line | **7,467** of 9,080 |

Not one of those was written by this service — they are AutoCount's own
*Transfer from Sales Order*, raised in its UI before the cutover. The ERP already
depends on it: `backfill-po-ac-dtlkey.mjs` and `repair-dedication-from-autocount.mjs`
both call `PODTL.FromSODtlKey` "the one line-to-line link AutoCount populates".
It is the **opposite** shape from the downstream tables, where `FromDocDtlKey` is
NULL throughout this book and only the document-level pair is real (see
`docs/transfer-from-to-vocabulary.md` §2).

**So "`FromDocType` is NULL on the PO" is not, by itself, evidence of a missing
link** — and it is the only thing anyone has measured. **UNKNOWN, and one SELECT
away:** whether `AddSOToPOTransferDetail` populates `FromSODtlKey` /
`FromSODocList` the way AutoCount's UI does. Nothing in this repo can reach the
book to ask (no `AC_*` secret exists), so the question is answered where the
answer lives: `LogPoSourceLink` reads all six lineage fields off the purchase
order the route just saved and writes them to `ac-sync-service.log`, and
`FromSODtlKey` / `FromSODocList` joined `DetailWanted`, so `/doc-read` returns
them too. **The next `/so-to-po` on the host settles it with no human.**

If they come back empty, the link really is missing and the remedy is a new
question — the SDK exposes no settable `From*` on `PurchaseOrderDetail`
(`sdk-api-reference.txt:467`), so it would not be a payload change. If they come
back populated, the purchase side is already at the sales side's standard, by a
different column, and the register entry closes.

**And a second thing this exposed.** `FullTransfer` is the call PROVEN against
this book, and today's production payloads never reach it: `readConvertSourceKeys`
returns `{ keys }` whenever every source line *has* a `linked_ac_dtlkey`,
**whether or not the conversion is partial**, so `PlanTransfer` always sees named
lines and always chooses `AddPartialTransferDetail`. That call is the right one
for a real partial and the wrong one for a whole document the ERP merely
enumerated, and the service cannot tell the two apart from a row count without
becoming the thing that decides. The fix is the ERP saying which it is — see
§7c1's table — not an inference here. `RunTransfer` logs the choice and the
reason on every conversion so a failure on that path is not another mystery.

#### 7c4. The purchase arms use FullTransfer, and it CANNOT take a subset (D16)

**This is the price of the fix above, and it is unpaid.** What actually moved
`/po-to-gr` was not the creditor alone: it was calling the typed three-argument
`FullTransfer(String[], TransferFrom, FullTransferOption)` directly, with
`AddPartialTransferDetail` demoted to a `catch` fallback. Host log, verbatim:

```
23:09:04  transfer: AddPartialTransferDetail per source document - the ERP named 2 line(s) and no quantity, so FullTransfer (which would move every outstanding line) is not used
23:09:04  target creditor before transfer = [400-H004]
23:09:04  trying purchase FullTransfer from=HC-PO-2608-001 tf=PurchaseOrder
23:09:04  purchase FullTransfer OK
```

The first line contradicts the third on purpose: `RunTransfer` decides the shape
and says "not FullTransfer", and the primitive it then calls tries FullTransfer
first. **FullTransfer moves every outstanding line on the source.** On this run
the ERP had named 2 lines and the PO had exactly those 2 outstanding, so the sets
were equal and nothing was over-received. A real partial receipt — 2 of 5 lines —
would write all 5 into `AED_HOUZS`.

That is the mirror image of D14. There the ERP cannot express a partial
*quantity*; here it expresses a partial *line set* correctly and the service
overrides it. Registered as **D16**, severity high, because the cost lands in a
licensed account book.

**It is deliberately not "fixed" by refusing.** Refusing returns `/po-to-gr` to
the state it spent a week in. Closing it needs the host, and there are two
candidates, neither of which can be chosen from here:

- retry `AddPartialTransferDetail` now that the target has a creditor. The
  `IndexOutOfRangeException` was blamed on `transferMaster: false` and that
  explanation is refuted (below); if the real cause was the empty account, the
  primitive may simply work now. **Never retested.**
- compare the named keys against the source's outstanding lines before allowing
  FullTransfer, and fall through to the primitive when they differ.

Two enum spellings to keep straight, because one of them cost a build:
`AutoCount.Invoicing.Purchase.TransferFrom.GoodsReceive**N**ote` has **no `d`**,
while the SDK class three namespace segments away is `GoodsReceivedNote`. The
members are `PurchaseRequest, RequestForQuotation, PurchaseOrder,
PurchaseInvoice, GoodsReceiveNote, SalesOrder, PurchaseConsignment,
PurchaseConsignmentReturn`.

**`transferMaster: false` was never the cause — CORRECTED.**

`Convert_`'s GR arm carried, for five days, the explanation that
`IndexOutOfRangeException: There is no row at position -1` came from
`transferMaster: false` building a GRN with no supplier, so the purchase detail
constructor's master lookup returned `-1`. **The host log refutes it.** Every
failed attempt logged the flag as `true` and threw anyway:

```
2026-08-16 09:54:26   po-to-gr: fromType=PO transferMaster=true keys=[906268]
2026-08-16 09:54:26 ERROR /po-to-gr: System.IndexOutOfRangeException: There is no row at position -1.
```

The flag was never the cause. The cause is §7c3's cause — the target had no
account before the transfer — and the low-level primitive reports that as a
contentless throw where `FullTransfer` names it. `transferMaster` stays `true`
because that is what has been running and what ran on the build that worked, not
because it fixes anything. The refuted sentence is pinned by a contract-test
assertion so it cannot quietly return.

### 7c5. A conversion carries the WHOLE document — one master, two projections

**The defect: a transfer sent the ERP's number and the account, and nothing else
the document knew about itself.** Owner, 2026-08-19, walking a live chain:
「为什么 Sales Order to PO，它的 Description2 不对的呢？再来，它的 Purchase
Location 也不对… 为什么它没有把 Sales Order 的那些资料带过去呢？」 — asked about
`/so-to-po`, true of all five transfers, and the four conversions had never been
looked at.

What each of the four dropped, before 2026-08-20:

| target | dropped | what AutoCount did about it |
| --- | --- | --- |
| DO (`so_to_do`) | `DocDate`, `Ref`, `DebtorName`, `Attention`, `Phone1`, `Note` | date DEFAULTED to the drain's day; `Ref` BLANKED; the other four had **no slot on this route at all** |
| Sales Invoice (`do_to_iv`) | same six | same |
| GRN (`po_to_gr`) | `DocDate`, `Ref`, `Description`, `SupplierDONo`, `PurchaseLocation` | date and location DEFAULTED; `Ref`, `Description`, `SupplierDONo` BLANKED — **destructively**, see below |
| Purchase Invoice (`gr_to_pi`) | `DocDate`, `Ref`, `Description`, `SupplierInvoiceNo` | same |

**None of it was a refusal**, which is why it survived a week of live documents
and a page whose job is to show stuck ones. `Ref`, `Description`, `SupplierDONo`
and `SupplierInvoiceNo` are assigned **unconditionally** (`AcSyncService.cs`
:2426-2427, :2450-2451, :1226, :1259) and `Str` of an absent key is `""` (:3212).
`DocDate` and `PurchaseLocation` are guarded, so those two genuinely default.

**On the two purchase arms it was destruction, not omission.** `PurchaseHeader`
runs a second time *after* the transfer (:1225, :1258) and the vendor's own
comment says why: *"FullTransfer copies the SOURCE document's master onto the
target… the ERP is master for DocNo, DisplayTerm, Ref, Description and
PurchaseLocation. This call is what makes the ERP's values the ones that
survive."* The ERP sent nothing, so the empty string won over the real values
`FullTransfer` had just copied off the purchase order.

**No caller ever passed a date or a reference.** `enqueueConvert` spread them in
`if (opts.docDate)` / `if (opts.ref)`, and all eight production call sites pass
neither — `delivery-orders-mfg.ts:3576` and `:4216`, `grns.ts:1961` and `:2343`,
`purchase-invoices.ts:1692` and `:1892`, `sales-invoices.ts:1394`,
`si-autocount-source.ts:178`. So the conditional was dead and every conversion
landed under the drain's date.

#### The fix is one master, not five more fields

`AcDownstreamSpec.facts` is now the **only** description of a downstream
document: every AutoCount-named header fact the ERP holds for it, keys always
present, values `string | null`. Both routes are **projections** of it —

- `downstreamEditHeader` → `AC_EDIT_HEADER_KEYS`, the allow-list `Edit()`
  reflects over (`AcSyncService.cs:2990-2995`);
- `downstreamTransferHeader` → `AC_TRANSFER_HEADER_KEYS[type]`, what
  `SalesHeader` / `PurchaseHeader` apply plus the one extra assignment each
  purchase arm makes.

`present()` still strips the blanks at the projection, so an absent value is an
absent key and never a `""`.

**A field added to `facts` reaches the transfer with no edit to `enqueueConvert`,
and one that reaches no route at all fails the build by name** — the test is
`a header fact reaches a route, or the build says which one does not`. That is
the guard, and it is the whole reason this is not a third one-field patch: the
same hole in `/so-to-po` was patched twice, `CreditorCode` on 2026-08-17 09:15
and `DocNo` at 10:15, and five fields were still missing afterwards.

#### The two classes of dropped field, which need different fixes

The transfer route applies a **strictly narrower** set than `/edit`. That splits
every dropped key in two, and reading them as one problem is what would have
made `Agent` a third no-op patch — `PurchaseHeader` has no `Agent` slot, so
adding it to the `/so-to-po` payload would have changed nothing.

- **The service would apply it and the ERP did not send it.** `DocDate`, `Ref`,
  `Description`, `SupplierDONo`, `SupplierInvoiceNo`, `PurchaseLocation`.
  Sending them fixes them, and they are sent now.
- **The route had no slot.** `DebtorName`, `Attention`, `Phone1`, `Note` on the
  sales side. Sending them would have been inert, so **`SalesHeader` was given
  guarded slots for all four** — which is what makes a transferred delivery
  order carry the customer's name instead of whatever AutoCount defaults off the
  fixed `300-C002` account. The host binary must be rebuilt for that half; the
  ERP half lands with the merge and an old binary simply ignores the keys.

#### The purchase location, and where it actually comes from

Our own note on the create side says *"a purchase order has no location of its
own — the ship-to warehouse is per LINE"* (`autocount-writeback.ts:1237`). That
is true of the ERP's purchase order and **false as a claim about AutoCount**,
whose purchase documents carry `doc.PurchaseLocation` and whose own comment
records that the ERP had never sent one. Per document:

- **GRN** — `scm.grns.warehouse_id` exists and the GRN list column it feeds is
  labelled *"Purchase Location"* (`grns.ts:1050`). We have one, AutoCount takes
  one, so it is sent — resolved uuid → `dbo.Location` code, the same hop
  `withLocations` does for lines.
- **Purchase Invoice** — `scm.purchase_invoices` has no warehouse column at all.
  Nothing is fabricated. `PurchaseHeader`'s guard means the absent key leaves
  whatever the transfer copied off the GRN, which is the right answer and not
  ours to overwrite.
- **Purchase Order** — the header location is PR #2523's, not this one's.

#### And the omission is said out loud, at save time

A value the ERP does not have is omitted, never blanked — a blank is a foreign
key error on a master field and a destroyed value on a text one. On its own that
is a quieter version of the same bug, so the omission is **reported through the
channel #2499 built**, not through a second one:

- `enqueueConvert` returns `AcEnqueueOutcome` — the shape `enqueueSoCreate` and
  `enqueuePoCreate` already return — with `problems` composed by
  `acNotCarriedProblems` from `downstreamNotCarried`.
- The four routes spread them into their 201 as **`acNotSent`**, the key the
  frontend's `acNotSentProblemsOf` already reads off any response.
- `DeliveryOrderNewV2`, `GrnNew`, `PurchaseInvoiceNew` and `SalesInvoiceNew`
  call `notifyAcNotSent` before they navigate, so the operator sees it on the
  save rather than five minutes later in a queue behind a permission key they
  do not hold.

**The verdict is the OTHER one, and it gets its own sentence.** These problems
carry `AC_SENT_INCOMPLETE`, not `AC_NOT_SENT`, and `acTitleFor` picks the title
off the problems: *"… saved and sent — but not every field on it reached the
accounts"*. The not-sent wording would be false here, and telling someone their
goods receipt is ERP-only sends them to raise it a second time into a book that
already holds it. Never blocks — the problems are composed after the conversion
is queued, so there is no save left to refuse. Tone stays `info`.

The sentences distinguish *"the ERP document has none"* from *"this transfer has
no field for it"*, because only the first is something the person holding the
document can fix.

The row keeps its own copy too: `acNotCarriedReason(…)` goes into `last_error`
while the status stays `pending` (`acNeedsAttention` branches on status, so it
is visible without being counted as stuck), and `payload.notCarried` is the
durable half, because the drain clears `last_error` on success while the blank
in the book stays true.

**One call site is not wired**: `si-autocount-source.ts:178` returns a string
enum to its callers rather than a response body, so an invoice raised through
that path records its omissions on the outbox row and does not raise a dialog.
Named here rather than left to be discovered.

#### What is still open — D17

The sales arms have **no `SalesLocation` slot** in `SalesHeader` (only `/edit`
does), while the sales *create* route treats the header location as mandatory
(`FK_SO_SalesLocation`). And `scm.delivery_orders` / `scm.sales_invoices` carry
**two** note columns — `note`, mapped to AutoCount's `Note` since `/edit` was
written, and `notes`, mapped nowhere — so which one is the book's `Description`
is the owner's call, not a code change. It costs nothing today: the sales arms
build with `transferMaster: false` (`AcSyncService.cs:1096`), so the `""` written
over `Description` overwrites nothing. Registered as **D17**, severity low.


## 7d. The four documents AutoCount cannot create at all

A DO, GRN, Sales Invoice or Purchase Invoice raised with **no parent** can never
exist in the account book: every construction primitive the SDK offers for these
four — `AddPartialTransferDetail`, `FullTransfer`, `PartialTransfer` — transfers
FROM a source document, so there is no create route to add and none could be
added. (This paragraph said `AddPartialTransferDetail` was the only one; see the
correction under §1.) `recordParentlessCreate` writes a visible `skipped` row for
every one going forward.

**Measured on production, 2026-08-11** (`backend/scripts/check-parentless-downstream.mjs`,
Actions -> *Parentless DO / GR / SI / PI census (read-only)*):

| type | documents | can never sync |
|---|---|---|
| DO | 57 | **1** (`2990-DO-2607-005`, company 2, already CANCELLED) |
| GR | 329 | 0 |
| SI | 0 | 0 |
| PI | 32 | 0 |
| **all four** | **418** | **1** |

So the gap is effectively empty: 417 of 418 downstream documents have a parent,
and the single exception is already cancelled on both sides. **A "must come from
a parent" guard is not needed** — the practice already respects the shape. Two
things the census did surface and neither is this gap: 4 company-2 DOs have **no
lines at all**, and 0 documents of any type are PARTIALLY parented (which would
give AutoCount a document missing its ad-hoc lines).

## 7d2. An edit carries the fields a create carries (D8)

A create sent the salesperson, the sales location, the document date and the
three UDFs. An edit sent none of them — so changing the salesperson, the sales
location, the order date, the branding or the venue on a live order **never
reached AutoCount at all**.

The account book was never the obstacle: `AcSyncService.Edit()` has `Agent`,
`SalesLocation` and `DocDate` in its header allow-list and calls `ApplyUdf`.
This was the ERP declining to speak.

| field | source | shape |
|---|---|---|
| `Agent` | the salesperson, resolved by §7n | header |
| `SalesLocation` | `sales_location` through `LOCATION_MAP`, then kept as-is | header |
| `DocDate` | `so_date` | header |
| `DebtorName` / `Attention` / `Ref` / `Phone1` | `debtor_name` / `ref` / `phone` | header |
| `InvAddr1..4` | the address, packed by §7o | header |
| `BRANDING` / `VENUE` / `ToPONo` | §7o — the lines' brand, the venue, the customer reference | **nested `UDF` object** |

`UDF` is nested because that is the only place the service reads it
(`ApplyUdf` -> `Dict(h, "UDF")`); a flat `SOUDF_*` key at header level is
silently ignored.

### A UDF VALUE IS NOT ALWAYS A STRING — `PDate` is a date column

Every value in that dictionary is JSON text, and `ApplyUdf` used to write all of
them as `System.String` through `Set()`. `PDate` is the only DATE-typed column
the ERP sends and it never landed: the write was refused, `Set()` logged
`set skipped:` with **no key, no value and no route**, and the request still
answered `ok`, so the outbox row went to `sent`. Every other key in the same
payload arrived, so nothing looked wrong.

The column types are the book's own, read out of
`export-ac-fidelity-truth.py:106-107` — the query that produced the committed
extract:

| UDF | how the export reads it | therefore |
|---|---|---|
| `UDF_VENUE`, `UDF_BRANDING` | `LTRIM(RTRIM(...))` | text |
| `UDF_BALANCE` | `ISNULL(..., 0)` | numeric |
| `UDF_PDate` | `CONVERT(varchar(10), ..., 120)` | **date/time** — and one of the 2,500 exported values carries a time (`SO-010311 = "2026-07-22 01:00:00"`) |

`ApplyUdf` now applies each key on a LADDER: the string FIRST and unchanged, so a
key that lands today lands the same way, and a typed value only after the book
has refused the string — `null` then `DBNull` for the present-and-null blank,
`Decimal` for a numeric string, `DateTime` for a date. **A key that lands on no
rung is logged by NAME with every refusal**, which is the half that was missing:
a field that looks wired and writes nothing is what this cost. The `""`-blanks /
absent-leaves-alone asymmetry is unchanged — an absent key is not in the
dictionary at all.

`Set()` itself is untouched and still guards the ~30 other assignments.

**A field the ERP does not have is OMITTED, never sent as null.** The service's
header loop is `ContainsKey`-gated and `Str` turns a present-but-null into `""`,
so `{Agent: null}` does not mean "unchanged" — it means "blank the salesperson
the account book has". Same rule as the line-level Location, one level up.

**That rule was WRITTEN HERE and not applied to eight of the keys** until
2026-08-14. `DebtorName`, `Attention`, `Ref`, `Phone1` and the four `InvAddr`
lines were emitted as `x ?? null` regardless, so every edit of a sales order
blanked whatever the account book held wherever the ERP's column was empty — on
production that is `ref` on 112 of 115 unpushed orders and `address3` /
`address4` on 94. The same shape was in all four `DOWNSTREAM[*].header`
builders.

It is now enforced by CONSTRUCTION rather than by remembering: one `present()`
helper strips every blank key at the single place a header is built, it wraps
`soEditHeader`, the four downstream builders and the PO edit, and
`AcDownstreamSpec.header` is typed `Record<string, string>` so putting a `null`
back is a compile error. **A create and an edit are asymmetric on purpose:** a
create MUST send a `SalesLocation` (there is nothing to preserve and a foreign
key to satisfy, so it falls back to the lines), an edit simply says nothing.

## 7o. Five fields the ERP keeps somewhere other than where the composer looked

The write-back's own recurring bug class, swept end to end on 2026-08-14 —
`docs/autocount-field-alignment-audit.md` has the trace and the production
number for each. The pattern every time: **the ERP holds the value in one
column, the composer reads another, and nothing opens it on the AutoCount side.**

| AutoCount field | reads | why not the obvious column |
|---|---|---|
| `ToPONo` | `po_doc_no` ?? `customer_po` ?? `customer_so_no` (`soCustomerRef`) | PR #140 dropped the Customer PO card, so nothing writes the first two and the operator's reference lands in the third |
| `BRANDING` | header `branding`, else the first live LINE's `branding` (`soBranding`), **through the map only** | the header column is NULL on every ERP-created order; the form has never had the field, and the detail page derives `first_item_branding` from the lines for that reason |

> **`soBranding` is NOT the Branding column's rule, and did not move with it on
> 2026-08-18.** That day the DISPLAY rule (`scm/shared/so-branding-label.ts`)
> changed: SOFA became the company's house brand (`ZANOTTI` / `2990s Sofa`)
> without consulting the line, and MATTRESS became the SKU's branding with the
> manufactured `2990 Mattress` fallback deleted. `soBranding` still reads the
> header then the first live line's stored text, and still passes it through
> `BRANDING_MAP` as the allow-list this section argues for. So there are now
> THREE branding rules in this system and they are meant to differ: the display
> label, `deriveDisplayBrandingByDoc`'s raw text, and this write-back path.
> Do not "align" them without re-reading why the allow-list exists — the whole
> point above is that `mfg_products.branding` is not a brand list, so the value
> the SO list happily shows a human is exactly the value that must not be opened
> as a master in the licensed book.
| `InvAddr3` / `InvAddr4` | `address3` / `address4`, else `postcode` + `city`, then `customer_state` (`soInvoiceAddress`) | only the cutover import ever wrote `address3` / `address4`. FIVE ERP fields into FOUR numbered lines is the one decision here, and it lives in that function's doc comment |
| `SalesLocation` | `sales_location`, else the stock location the LINES resolve to (`soSalesLocation`) | `deriveSalesLocationFromState` returns null for an order with no customer state, and a blank is `FK_SO_SalesLocation` |
| `VENUE` | `venue`, kept as-is when the map does not know it | venue is deliberately free text — "every roadshow hall is a one-off" (mig 0229) — against a 7-entry map |

**THE MAPS ARE SPELLING CORRECTIONS, NOT AN ALLOW-LIST.** `AGENT_MAP`,
`LOCATION_MAP`, `VENUE_MAP` and `BRANDING_MAP` record how the live book spells a
value it already holds (`SUTERA MALL` -> `SUTERA MALL SOLO`). Measured against
the book's own vocabularies, **every target all four can emit is already a
master there** — so dropping what they had not heard of protected nothing and
only deleted it. Two functions now, named after what their `null` means:

| | |
|---|---|
| `bookSpelling(v, map)` | the book's own spelling, or `null` = *the book has never heard of this*. Kept for the AGENT, where `null` genuinely has to refuse: `mfg_sales_orders.agent` is free text holding bare uuids and "Unassigned" in production, and `/ensure-masters` opens an agent under exactly the string it is given (§7n) |
| `bookSpellingOrOwn(v, map)` | the book's spelling, else the ERP's own value verbatim for `/ensure-masters` to open. `null` only when the ERP has nothing at all. Used for **location and venue** |

**A pass-through is only safe where the master gets opened**, which is why
`mastersOf`'s edit blindness (§7e) had to be fixed in the same change.

**AND ONLY WHERE THE SOURCE COLUMN IS A VOCABULARY OF THE RIGHT KIND.**
`BRANDING_MAP` is the one ALLOW-LIST of the four, and production decided that
rather than taste: the first version of this fix passed line branding through,
and the check reported what it would open as brands in the licensed book —
`2990s Sofa` (44 orders), `Accessories` (8), `2990s Mattress` (8), `2990` (3),
`Bedframe` (3), `Happi.S` (2). Four categories and a company name.
`mfg_products.branding`, which the line column is snapshotted from, is not a
brand list. So branding goes through `bookSpelling` alone, `CARRESS` and
`DUNLOP` were added to the map because they ARE real book brands it had not been
told about, and the check prints the would-open list every run so the decision
stays reviewable.

This is finding 1's rule arriving from the other direction: **a value with a
trustworthy writer may pass through, a column with none may not.** Before adding
a fifth caller of `bookSpellingOrOwn`, look at what the column actually holds.

## 7p. The maps are GENERATED, and a matcher proposes what goes in them

*Added 2026-08-14, on the owner's question: "Branding、venue、sales、location、
agent，你都可以做 binding 吧？…很多其实都已经有了。"*

**A pass-through does not fail on a value the book spells differently — it opens
a DUPLICATE.** `/ensure-masters` opens a master under exactly the string it is
given, so `SUNWAY SHOWROOM` becomes a second stock location beside the book's
own `SUNWAY`, and one physical showroom's stock lands in two rows of a licensed
book. That is the cost §7e's "it DOES create a LOCATION" row was already
printing a number for; this section is what turns the number into an answer.

**Eleven of the twelve unknown warehouse codes already exist.** Measured against
production on 2026-08-14 (field-alignment run `31815502403` on `main`, then the
binding report on the PR branch, run `31817727846`):

| ERP warehouse code | the book's short code | the book's long name |
|---|---|---|
| `SUNWAY SHOWROOM` | `SUNWAY` | DUNLOPILLO SUITE SUNWAY |
| `KELANA.J SHOWROOM` | `KELANA.J` | AKEMI SLEEP STUDIO KELANA JAYA |
| `C&C DISPLAY` | `C&C DISP` | CASH & CARRY - FAIR |
| `EM DISPLAY` | `EM DISP` | SARAWAK BEDDING DISPLAY |
| `KL` / `PG` / `SBH DISPLAY` | `KL DISP` / `PG DISP` / `SBH DISP` | ... BEDDING DISPLAY |
| `KL SERVICE` / `PG SERVICE` | `SERV KL` / `SERV PG` | ... RETURNED TO SUPPLIER |
| `SBH WAREHOUSE` | `SBH` | SABAH |
| `SRW WAREHOUSE` | `SRW` | SARAWAK VENUE |
| `CHINA WAREHOUSE` | — | genuinely new; opening it is correct |

### The loop, and why no step of it edits TypeScript

| step | what | where |
|---|---|---|
| 1 | the report PROPOSES a pair, with its reason and its production row count | `backend/scripts/check-autocount-master-bindings.mjs`, run by the read-only `autocount-field-alignment.yml` dispatch |
| 2 | a human CONFIRMS it by moving the pair into the map | `backend/scripts/data/autocount-so-writeback-mappings.json` |
| 3 | the generator writes the compiled map | `node scripts/gen-autocount-master-maps.mjs` -> `backend/src/services/autocount-master-maps.ts`, which `autocount-writeback.ts` re-exports |

`npm run audit:ac-master-maps` (in `ci.yml`) fails if step 3 was skipped, and
`backend/tests/acMasterMaps.test.ts` pins every pair the composer carried on
2026-08-14 so a binding can be ADDED but never silently removed or re-pointed.

**Why generated at all.** The maps used to be object literals in
`autocount-writeback.ts` while the record of WHY each binding is right lived in
the JSON beside it — and the two had drifted in all four dimensions: the TS
carried `ETHAN` and `WEI PIN`, confirmed out of the JSON's own
`agent_map_fuzzy_to_confirm` and never written back; five identity location
entries; and `ZANOTTI` / `NONE` / `CARRESS` / `DUNLOP`. One source, generated
into the other, is the same answer `gen:ac-item-map` already gives.

### What the matcher will and will not claim

`backend/scripts/lib/ac-master-matcher.mjs`. It normalises, then scores on
IDF-weighted token overlap and edit distance, and every proposal carries the
reason — a bare score is not reviewable.

| bucket | means |
|---|---|
| **already mapped** | `bookSpelling` resolves it, or the book already holds the value verbatim and the field passes through. Nothing to do |
| **confident** | NORMALISATION ALONE explains the difference: case, punctuation, spacing, word order, a `SOLO` suffix, `DISP`/`DISPLAY`, `SERV`/`SERVICE`, a dropped `WAREHOUSE`/`SHOWROOM`. Nothing is inferred |
| **ambiguous** | the same normalisation lands on TWO masters (`AEON BIG SUBANG` and `AEON BIG SUBANG SOLO`). A person picks |
| **likely** | a shared DISTINCTIVE word — one naming at most two masters in the whole book — or a near-typo of the whole string. A person decides |
| **no match** | nothing distinctive is shared. Opening a new master is correct |

**`DISPLAY` is aliased, never dropped.** The book holds `KL` and `KL DISP` as
two separate stock locations; treating the word as noise would bind a showroom's
display stock onto the main warehouse, which is the same damage in the opposite
direction.

**The matcher runs its own worked examples before it reports anything**
(`selfTest`, and `backend/tests/acMasterMatcher.test.mjs`). A matcher whose rules
rotted would bucket everything as no-match, which reads exactly like a book that
holds nothing — and acting on that opens duplicates.

**Two things it deliberately refuses to decide.** `BRANDING_MAP` stays an
allow-list: matching may propose an addition, never a pass-through (§7o). And
`agent_excluded` is a record of a decision, not a gate — the report NAMES a
staff name that reads as a test account and is not on that list (`Test Sales
Director`, on a live writable order as of 2026-08-14) instead of adding it.

**One caveat the report prints about itself:** `scm.staff` has no `company_id`,
so a staff name that no company-1 document has ever named cannot be attributed
to this company. Those are counted and listed, never bucketed as work.

## 7q. What the cutover EXTRACTED is what the write-back SENDS BACK

*Added 2026-08-15, on the owner's rule:* **"他抽取了什么东西，就代表什么东西都是要
进来的 … 既然我抽出来了，就代表我是需要的。"** Whatever the one-time import pulled
OUT of AutoCount is what the write-back has to put back. That makes the gap
CHECKABLE rather than a matter of taste, because the extract is committed:
`backend/scripts/data/ac-fidelity-so-headers.json.gz` (13,015 rows, 18 header
fields) and `ac-fidelity-so-lines.json.gz` (60,939 rows, 13 line fields), both
written by `backend/scripts/export-ac-fidelity-truth.py` straight off the live
`AED_HOUZS` book.

**Re-derive the counts from the files rather than trusting this table.** Every
number below came from reading the two `.gz` files on 2026-08-15.

| extracted | sent before | now |
|---|---|---|
| `UDF_BALANCE` — non-zero on **2,339 of 13,015** headers | no | **yes**, create + edit |
| `DeliverPhone1` — on **120 of 13,015**, and genuinely different from `Phone1` on **37** | no | **yes**, create + edit |
| `SODTL.DeliveryDate` — **NULL on 11,886 of 60,939 lines**, across 2,268 whole documents | no | **yes**, including the blank |
| `UDF_PAYEMENT` — the free text the cutover parsed into `account_sheet` + `approval_code` (`import-ac-outstanding-so.mjs:16`; the misspelling is AutoCount's) | no | **yes**, create + edit |
| `SODTL.UOM` | no | **still no — and that is correct**, see below |
| `Cancelled` — `T` on 5 of 13,015 | the separate `/cancel` op (§7f) | unchanged |
| `Seq`, `DtlKey`, `TransferedQty`, `TransferedPOQty` | AutoCount's own | never ours to send |

### BALANCE — three ERP columns, and the obvious one is wrong

`SO.UDF_BALANCE` is the customer's outstanding amount. It is not the document
total: measured against the lines' own `Qty x UnitPrice`, it is LESS on 2,222 of
the 2,339 non-zero headers and equal on 114.

The two sides are the same quantity by CONSTRUCTION, not by resemblance — **the
cutover turned one into the other.** `import-ac-outstanding-so.mjs:294` computed
`paid = total - UDF_BALANCE` and wrote that as a payments-ledger row, so
`total - SUM(payments)` reproduces `UDF_BALANCE` for every imported order.

Which ERP column, therefore, matters more than usual, and the trap is live:

| candidate | verdict |
|---|---|
| `scm.mfg_sales_orders.balance_sen` | **NO.** `recomputeTotals` writes `balance_sen = local_total_sen = total_revenue_sen = grandTotal` on every edit, so it never reflects a payment. It looks right because the cutover's own `UDF_BALANCE` landed in it (`check-migration-fidelity.mjs:95`) — and the first edit of any order overwrote that with the gross total |
| the view's `balance_sen_live` | close — `local_total - SUM(payments)`, what the SO list, the mobile list and delivery planning render. It MISSES the legacy header deposit that never reached the ledger. **Since mig 0301 (2026-08-16) it is SIGNED** — the `GREATEST(…, 0)` floor was removed so an over-collected order shows red instead of a comfortable RM 0.00 |
| **`soOutstandingCenti`** (`scm/shared/so-outstanding.ts`) | **YES — this is the one the write-back sends.** Clamped at 0 on purpose: AutoCount is a licensed ledger and the ERP must not push a negative into it. `autocount-read.ts:79` calls THIS |
| `soBalanceCenti` (same module) | **NOT for the write-back.** The SIGNED figure, for humans: the SO detail page, the list's Balance column and the PDF, which paint a negative red (owner 2026-08-16: 「需要可以超收 negative 边红色」). It answers 0 whenever `total_revenue_sen` is 0, because that column is unset on 2,687 of production's 2,824 live orders and a bare subtraction would paint RM 9.26m of false over-collection |

> **The two names are the point.** `soOutstandingCenti` (floored) is what SUMS
> and what leaves the building; `soBalanceCenti` (signed) is what a person
> reads. They are deliberately not interchangeable, and the guard that used to
> REFUSE an over-collection outright was removed on 2026-08-16 — over-collection
> is legal now, so the money is recorded and the balance simply goes negative.
> Before that, the refusal fell on the person holding the customer's cash, and
> the observed workaround was to re-price a line upward until the payment fit
> (HC-SO-2608-002: an RM 250 line edit 76 seconds before the payment).

Paid is the payments ledger PLUS the header `deposit_sen` **only when no
`is_deposit` ledger row exists** — modern orders write the deposit as a ledger
row, so adding the column on top would double count, and legacy orders would be
under-counted without it. `paid_sen` is deprecated and read by nothing.

Three rules the composer keeps:

- **Zero is a value.** `udf()` drops a falsy entry, so a settled order is sent as
  the string `"0.00"` (`acUdfMoney`). Dropping the key would leave a paid order
  showing a debt in the account book forever.
- **No total means NO KEY.** `readSoOutstandingCenti` answers `null` when
  `total_revenue_sen` is absent, because zero would declare a real debt settled
  in a licensed ledger. The SO detail page reads the same absence as `0` — it is
  drawing a screen, this is writing a ledger.
- **Negative is not expressible.** The book holds a negative `UDF_BALANCE` on 47
  of the 13,015 headers; the ERP clamps at zero on both its own paths (the view's
  `GREATEST`, the detail route's `Math.max`) and keeps an overpayment as customer
  credit instead. The write-back sends what the ERP holds.

**IT GOES STALE ON A PAYMENT, and that is the open half.** Recording a payment is
not one of §6's enqueue anchors, so the balance in AutoCount is the one the
document last carried when something else was edited. Sending it is strictly
better than never sending it; keeping it live needs a payment-side hook.

### DeliverPhone1 — two contacts, two columns

Owner 2026-08-15: *"我们的电话号码 … 应该是有一个 Delivery Contact，一个是
Contact."* They are not interchangeable, and getting them crossed puts the
customer's number in front of a driver.

| AutoCount | ERP |
|---|---|
| `Phone1` | `mfg_sales_orders.phone` |
| `DeliverPhone1` | `mfg_sales_orders.emergency_contact_phone` |

**The pairing is the cutover's own, read backwards** — not an inference from the
field names. `import-ac-outstanding-so.mjs:302` kept `DeliverPhone1` only when it
DIFFERED from `Phone1` (otherwise the second number out of a slash-separated
`Phone1`) and inserted it as `emergency_contact_phone` (`:390`, `:412`). It is a
live field: the SO header PATCH allow-list carries it, the SO detail page renders
it as "Emergency contact", and `so-to-do-fields.ts` copies it onto the delivery
order beside `phone`.

The CREATE never needed the C#'s help and had it anyway —
`Or(Str(p,"DeliverPhone1"), Str(p,"Phone"))` makes the delivery number a copy of
the customer's, which is the cutover's rule and the right default. **The EDIT is
where it was lost:** nothing falls back there, so a delivery number changed after
the order was written back never reached the book at all. Blank still omits.

### The line delivery date — and the BLANK

The owner reported a line arriving in the book carrying the DOCUMENT date when
the ERP holds none, and said it should be blank, as the cutover left it. All
three halves of that check out:

| question | answer |
|---|---|
| does the book hold blanks? | **yes — 11,886 of 60,939 lines are NULL**, and 2,268 documents are entirely blank. Only 309 non-null lines equal their document's date, so the book does not routinely default |
| can the SDK be told null? | **yes.** The reflected surface types it `DeliveryDate:Nullable\`1` on all six detail classes |
| what was happening? | the ERP never sent the key at all — `SO_ITEM_COLS` did not select `line_delivery_date`, so `soLine` left it undefined — and the service's `if (dd.HasValue)` could not tell an absent key from a null one. The value was AutoCount's own default |

Both sides changed, and they had to:

- the ERP now selects `mfg_sales_order_items.line_delivery_date` /
  `purchase_order_items.delivery_date`, and **always sends the key on a create** —
  a date, or an explicit `null`;
- `AcSyncService` guards on `ContainsKey` instead of `HasValue`, so a
  present-and-null assigns `(DateTime?) null` and blanks the line.

**This is the one key sent present-and-null, and it does not break the omission
rule — it is why the rule exists.** Everywhere else a null blanks the book
because `Str()` turns it into `""`. `DeliveryDate` goes through `Date()`, which
answers null for absent AND null alike, so an omitted key could only ever mean
"leave AutoCount's default". An **EDIT** omits the key again when the ERP has
none (`composeEdit`), because there a blank would erase a date an operator may
have set in AutoCount itself — the same create/edit asymmetry as `Location`.

### UOM is in the extract and is NOT a gap

`SODTL.UOM` is `UNIT` 43,498 / `SET` 12,770 / `.` 3,332 / blank 1,315 / `PCS` 16,
plus the typos `UMIT` 6 and `unit` 2. It is unsent, so it reads as a gap. It is
not one, and sending it would lose documents.

**AutoCount's UOM is a property of the ITEM, echoed onto the line.** Checked
against the book's own `ItemUOM` rows (`ac-item-costs.json.gz` +
`ac-utd-stock-cost.json.gz`), **59,582 of the 59,624 lines carrying a UOM carry
one the item's master row holds** — the 2 exceptions are the `unit` / `UNIT` case
typo. Only 3 items in the snapshot have more than one UOM at all.

**The ERP has nothing to add.** `mfg_sales_order_items.uom` and
`purchase_order_items.uom` are written `(it.uom as string) ?? 'UNIT'` at every
create path, so the column is a default rather than a fact — and **363 of the 758
distinct item codes on those lines have no `UNIT` row at all**, their only UOM
being `SET`. Sending the ERP's value would put `UNIT` on a line whose item only
has `SET`, against a column the detail foreign-keys to `ItemUOM`, and take the
whole document with it — the same shape as `FK_SODTL_Location` in §7m.

The UOM is set where it belongs: `/ensure-masters` gives a NEW item
`NewUom(uom, 1m)` + `BaseUom`, so the line inherits it, and an item the book
already holds keeps its own. Owner 2026-08-15: every SKU already carries a UOM.

### Desc2 is NOT the Further Description — two columns, and this section covers only the first

> **CORRECTED 2026-08-15.** This section was headed *"Desc2 is the Further
> Description"* and it is not. `Desc2` and `FurtherDescription` are **separate
> columns on the same detail class** — both appear in every `SET:` list in
> `backend/scripts/autocount-service/sdk-api-reference.txt`:
>
> | column | type | carries | who writes it |
> |---|---|---|---|
> | `Desc2` | `nvarchar(100)` | the build text — fabric, size, legs, gap | this section |
> | `FurtherDescription` | `nvarchar(MAX)` | the **photographs**, as RTF | §7q2 below |
>
> The owner's instruction quoted next is about the PHOTOGRAPHS, and what shipped
> under this heading was the variant text. Both are wanted; neither answers the
> other. Conflating them points a photograph at a 100-character column, which is
> why the correction is worth its space.

Owner 2026-08-15: *"照片那一边是从 Further Description 那边抽出来的，所以你录入的
时候，也是要录入回 Further Description"* — the photographs; see §7q2. The cutover
also parsed **`Desc2`** to get the ERP's variants —
`import-ac-outstanding-so.mjs` turns a bedframe's `Desc2` into
`variants.fabricCode` / `gap` / `divanHeight` / `legHeight` / `totalHeight` /
`specials` — so the specification has to go back.

`Desc2` was already being sent, so this was missing CONTENT, not a missing field.
`composeDescription2` emitted `Col / Fabric / Seat / Leg` and read colour off
`fabricColor`, which is the GRN-family editors' key. A bedframe keeps its colour
in `fabricCode` / `colourLabel` and its build in `gap` / `divanHeight`, so an
ERP-created bedframe reached the account book with an EMPTY Further Description
— while the book's own text carries `COL` on 6,741 of its 15,950 populated
values, `DIVAN` on 5,778 and `GAP` on 2,620, its three commonest labels.

**The fix is deleting the second opinion, not improving it** (COE lesson 4).
`composeDescription2` now calls `buildVariantSummary` from
`scm/shared/variant-summary.ts` — the same pure, frontend-mirrored function that
renders Description 2 on every SO, PO, DO and GRN line, whose vocabulary is
already the book's (`DIVAN`, `GAP`, `LEG`, `SEAT`). The account book reads what
the paperwork reads, and a new attribute reaches AutoCount the day it reaches the
screen.

Two things survive unchanged, and both are load-bearing:

- **a stored `description2` still wins, verbatim** — the ECHO path. Both cutover
  importers wrote the book's original text onto every migrated line, and D9 hands
  the composer a collapsed sofa whose `description2` is the build text the
  collapse has already decided and gated (§7b);
- one visible difference on a SOFA: the fabric SERIES is no longer printed beside
  a known colour. That is `buildVariantSummary`'s rule — the series shows only
  when the colour is still KIV — and it is what the SO line already prints.

**A new refusal comes with it: `Desc2TooLongError`.** `SODTL.Desc2` /
`PODTL.Desc2` are `nvarchar(100)` and the live book is AT that ceiling — the
longest of its 15,950 values is exactly 100 characters and none is over. A richer
Desc2 can reach it, SQL Server refuses the Save, and the whole document is lost
behind an unreadable 500. So an over-long line is refused into a `skipped` row
naming it, using the same `AC_DESC2_MAX` the sofa collapse already refuses on.
Truncating is not the alternative: Desc2 IS the specification the factory builds
from, and half a specification is a wrong instruction rather than a short one.

### 7q2. `FurtherDescription` — the photographs, and why the host converts them

The owner's instruction in §7q is this one: the photographs on our sales-order
lines were pulled OUT of AutoCount's `FurtherDescription` at cutover
(`backend/scripts/import-so-line-photos.mjs`), so putting them back means writing
that same field.

**What the live book actually stores was measured, not assumed** — three lines
read on 2026-08-15, `docs/autocount-further-description-photos.md` §4.2. Every
one stores the picture as `\wmetafile8`, a Windows metafile; none as
`\jpegblip` or `\pngblip`. Four consequences, and each one is a line of code:

| measured | what the writer must do |
|---|---|
| the form is `\wmetafile8` | a JPEG cannot go in verbatim. The conversion needs GDI, which exists on the AutoCount host and in no Cloudflare Worker, so **the ERP sends JPEG bytes and `AcSyncService.cs` renders them** |
| `picwgoal`/`picw` = 96 on all three | `dpi = 96`; `picw`/`pich` are pixels, the `*goal` pair twips |
| a caption `Image on <M/D/YYYY h:mm:ss AM>` precedes each `{\pict` | the field is **not pictures alone**. A writer that emits pictures only DESTROYS that text, so the caption is part of what is written |
| `nvarchar(MAX)`, `chars x 2 = bytes` | no 100-character ceiling here — that one belongs to `Desc2` |

**The `/edit` line payload accepts two shapes, and neither is ever sent as null:**

```
FurtherDescription : "<rtf>"              verbatim — for the write probe, and for
                                          a value read back out of the book unchanged
Photos : [ { Jpeg: "<base64>", Caption? } ] the JPEGs; the host renders the RTF
```

Same `ContainsKey` rule as every other line field: **a key the ERP does not own
is OMITTED, never nulled.** Unlike the others it is deliberately NOT wrapped in
`Set()` — `Set()` logs and swallows, which is right for a cosmetic field and
wrong here, because a silently-skipped write would leave the ERP believing the
photographs arrived while the line still holds what it held before.

**The field is ONE string and is replaced wholesale — there is no append.** So a
composer must send every photograph the line should end up with, not just the new
ones, or it destroys the rest. That rule and its three cases (unchanged → omit;
operator ADDED → re-emit everything; operator REMOVED → do not act, raise it) are
`docs/autocount-further-description-photos.md` §6.3.

**PROVEN 2026-08-15 — the bytes we emit are the bytes the book holds.** The
conversion was extracted into a standalone harness and compiled with the real
`csc.exe` (`Framework64\v4.0.30319`, `/r:System.Drawing.dll`, exit 0), then run
against a 240x159 JPEG — the dimensions of the manifest's first line. It
produced:

```
picw/goal  = {\pict\wmetafile8\picw240\pich159\picwgoal3600\pichgoal2385
wmf header = 010009000003
caption before pict = True
```

Both lines are **character-for-character what the live book stores on `DtlKey`
34553** (`docs/autocount-further-description-photos.md` §4.2, which read
`\picw240\pich159\picwgoal3600\pichgoal2385` and a value beginning
`010009000003`). The dpi arithmetic, the twips conversion, the mapping mode and
the caption ordering are therefore all confirmed against a real measurement
rather than against the code that produced them.

**AND AUTOCOUNT RENDERS IT — PROVEN on the live book, 2026-08-15.** This
paragraph used to say the opposite: that matching bytes were necessary and not
sufficient, that the entry screen and the report's `XRRichText` are different
renderers, and that the route was "built and unrendered". The probe (§5.2) has
now been run, and **both** renderers draw it.

Scratch sales order `ERP-FDPROBE-1`, one line, written through
`POST /edit` with `Photos`, then read with all four of §5.2's observations:

| | what was looked at | result |
|---|---|---|
| i | the line's Further Description editor, entry screen | **the picture renders** — right way up (the probe image says `TOP` at the top and `BOTTOM` at the bottom), at its stated `240 x 159`, with the `Image on 8/15/2026 10:21:09 PM` caption above it |
| ii | *Preview* of the printed sales order, report `0. Sales Order` | **the picture renders** — under the item, after the `PROBE` Desc2 line. This is the `XRRichText` path, and it was the real risk |
| iii | `/further-description` on the same `DtlKey` | `chars=389549`, `truncated=False`, `pict=1`, `wmetafile8=1` — AutoCount stored **our own bytes**, unchanged, rather than rewriting them |
| iv | the Save | no dialog, no truncation |

So the return path is complete end to end: the ERP sends JPEG bytes, this host
renders them to a metafile, AutoCount stores them verbatim, and the picture
appears both on screen and on the document the customer receives.

The scratch order was **cancelled, not deleted** (Void), per the owner's rule.

### 7q3. `POST /doc-read` — reading a document back, because every other route writes

Until this route existed, this service could create, convert, edit and cancel
documents in the live book and had **no way to say what actually landed**. Two
things made that stop being tolerable on 2026-08-15:

- `qa-convert.ps1` reported `/po-to-gr` as `status=0 ... (500)`. The body was
  never read, so the failure had a symptom and no cause — and a 500 with no
  cause cannot be fixed, only guessed at.
- The owner's standing questions are all questions about what the BOOK holds,
  not about what we sent: does an edited processing date reach AutoCount, does a
  line's delivery date, is the convert's Transfer link really there. Checking
  our own payload cannot answer any of them.

```
POST /doc-read   { "DocType": "SO"|"PO"|"DO"|"GR"|"IV"|"PI", "DocNo": "..." }
  -> { ok, docType, header: {...}, lines: [{...}], missingColumns: [...] }
```

**It discovers the columns rather than naming them**, the same discipline
`/further-description` uses. The wanted lists are what we would LIKE to see;
the query asks `sys.columns` which of them exist and selects only those,
reporting the rest in `missingColumns`. So "AutoCount has no such field" comes
back as an ANSWER — which is itself the answer to *does payment update into
AutoCount* if no payment column exists on that document — rather than a SQL
error that reads like a broken service.

The line list deliberately includes `FromDocType` / `FromDocNo` / `FromDtlKey`.
That is where AutoCount records that a line came from another document, and it
is what the entry screen's *convert from* / *convert to* reads — so it is the
evidence for whether a conversion really linked the two, as opposed to producing
a standalone document that merely looks right.

READ-ONLY and mechanically so: SELECTs on one connection, no SDK session, no
transaction, and the table names come from a fixed map, never from the caller's
string.

### 7q4. `POST /picture-census` — the one query that makes a wholesale rewrite safe

`FurtherDescription` is replaced **wholesale**; there is no append. So if a line
we rewrite holds TWO pictures and the composer sends one, the second is
destroyed and nothing says so.

The photo manifest reports one picture per line for all 554 of its rows — but
the manifest is the output of an extractor nobody kept (§2.1 of the photos
doc), so it cannot rule out that the extractor took only the first. This route
asks the BOOK instead, in one aggregate over the whole detail table:

```
POST /picture-census   { "Table": "SODTL" }
  -> { ok, table, linesWithAValue, maxPictures, linesOverOne }
```

`maxPictures = 1` closes it outright. Anything higher is a finding, and the
composer needs a read-before-write on those lines before it may touch them.

Read-only: one `SELECT`, no SDK session, table from the same allow-list
`/further-description` uses.

## 7e. The masters a document names are opened first

A document naming a master AutoCount does not have does not fail politely: it
fails on a FOREIGN KEY and the whole document is lost. That is not a theory —
the live book answered `FK_SODTL_Location` to a create whose lines carried no
stock location, and the same shape waits behind every new SKU and every new
salesperson the ERP opens.

So the drain sends `/ensure-masters` FIRST, for `create_so`, `create_po` and
`edit` — the three operations that can introduce one. A conversion cannot (it
transfers lines the book already holds) and neither can a cancel, so neither
pays for the call.

`mastersOf(body)` reads the PAYLOAD that is about to be sent, never the
database: the payload is the snapshot of what the user's save produced, and a
master derived from anything else could differ from the one the document
actually references. It dedupes by item code and **skips a retired line**, which
is addressed by a DtlKey AutoCount itself issued and therefore names nothing new.

**AN EDIT KEEPS ITS HEADER ONE LEVEL DOWN, and `mastersOf` used to miss it
entirely.** A create payload is flat; an edit is
`{DocType, DocNo, Header{…, UDF{…}}, Lines[]}`, so `body.Agent`,
`body.SalesLocation`, `body.CreditorCode` and `body.UDF` were all read at a level
where an edit has none of them and only the line items were ever opened. That was
harmless for exactly as long as the edit sent nothing the book already lacked —
and it stopped being harmless the moment venue and location were allowed through
unmapped, so both landed in the same change (2026-08-14). Every key is now read
through one accessor that falls back to `body.Header`.

One thing had to come with it: **a PO edit carries no `CreditorCode` at all**
(`composePoState` sends only `CreditorName` and `Description`), and that field
was the sales/purchase discriminator. It now also reads `DocType`, because
opening an agent in the wrong table reports success and refuses the document
anyway — the 2026-08-12 finding, in one line.

**If the masters cannot be opened, the document is NOT sent.** A row that
half-populated a live account book is worse than a row that waited. **A creditor
whose NAME disagrees is the opposite case: it is reported and the document goes**
— §7e1.

The service side is idempotent by construction — each master is looked up and
created only when the lookup comes back empty — and it is deliberately narrow:

| | |
|---|---|
| It never EDITS an existing master | An item's costing method or a debtor's credit limit is Finance's, not the sync's. Existing masters are reported as `existed` and left alone |
| It DOES create a LOCATION | Owner 2026-08-11: open everything. Created EMPTY — a code and a description. Everything a warehouse really needs (addresses, payment accounts, defaults) stays for a human. **`EnsureMasters`'s own header comment used to deny this**; the code was right and the text was corrected on 2026-08-14. What the decision costs, re-measured that day: **19 of 25 `scm.warehouses` codes are in neither `LOCATION_MAP` nor the book's location list**, so the first document naming one opens a new stock location in a licensed book. That is the LINE path and it has behaved this way since go-live; the header's `SalesLocation` falls back to the code its own line already carries, so it opens nothing extra |
| The ERP never ASKS for a DEBTOR | `EnsureMasters` HAS a Debtors branch (`AcSyncService.cs:574-592`) and would open one if sent; the narrowing is the ERP's — `mastersOf` emits no `Debtors` array (`autocount-outbox.ts:1496-1499`, `:1576-1583`). Houzs writes every order against ONE fixed AutoCount debtor and overwrites the name field. Opening an AR account per customer would invent accounting nobody asked for |
| It DOES create a CREDITOR | Opposite reason: a purchase order names a real supplier, `CreatePo` applies `CreditorCode` unconditionally, and a supplier the book does not have fails the same foreign key a missing item does |
| It REPORTS a creditor the book holds under ANOTHER NAME | Added 2026-08-18, §7e1 below. `mismatched[]` on the response; never part of `ok` |
| It DOES add a BRANDING / VENUE option | Owner 2026-08-11. **Read, append, write back the whole set** — see below |

### The dropdown lists are edited by READ-APPEND-WRITE, never by Add()

`AutoCount.UDF.List` exposes `GetItems()` and `SetItems()`, so the current
options are read first and the new value appended to them. The obvious call —
`UDFList.Add(name, new[]{ value })` — is NOT used: whether it appends or
REPLACES is not something the reflected signature says, and if it replaces it
deletes every other option in a live book, roughly 95 of them on VENUE. The
read-modify-write shape makes that impossible rather than unlikely.

**A list that does not exist is not created.** An unknown list NAME is a
spelling mistake on our side, not a missing option, and inventing the list would
hide it — it comes back as a `failed` entry naming the list.

Only `BRANDING` and `VENUE` are treated as dropdowns. `ToPONo` is free text and
has no option list to open.


## 7e1. A creditor code that RESOLVES is not a creditor code that is RIGHT

*Added 2026-08-18.*

`EnsureMasters` used to ask `CreditorExists(acc)`, which was
`da.GetCreditor(acc) != null`. It fetched the creditor, read a boolean off it and
**discarded the `CompanyName` it had in its hand** — the one fact that can tell a
right code from a wrong one. So a code resolving to the WRONG company was
byte-for-byte indistinguishable from a code resolving to the right one, at every
layer, and nothing refused it because nothing ever looked.

That is not hypothetical. `HC-PO-2608-001` / `HC-GR-2608-001` / `HC-PI-2608-001`
are in `AED_HOUZS` against creditor `400-H004`, which the book holds as **HAO HUA
FURNITURE**, for an ERP purchase order that names **HOOKKA INDUSTRIES SDN. BHD.**
The owner has confirmed those are different companies, and no creditor named
HOOKKA INDUSTRIES exists in the book at all.

**What changed.** `CreditorExists` is now
`CreditorFound(da, acc, out string bookName)`:

| it answers | meaning | what happens |
|---|---|---|
| `false` | the book does not hold the account | a creditor is opened, exactly as before |
| `true`, `bookName` a string | the book holds it under this name | `existed`, and the name is COMPARED |
| `true`, `bookName` null | it exists and the name could not be read | `existed` + `nameUnverified[]`. NOT compared, and an unmeasured comparison is never counted as agreement |

The property is read by **reflection**, not by `e.CompanyName`:
`sdk-api-reference.txt` was dumped with `DeclaredOnly` and does not cover
`CreditorDataAccess` at all, so `GetCreditor`'s return type is not established in
this repo and the file compiles nowhere but the host. Reflection compiles against
whatever the SDK turns out to expose, and a property that is somehow absent
degrades to *not compared* rather than to a false MISMATCH on every document.

**IT REPORTS AND IT MUST NEVER REFUSE.** The ERP routinely holds a shorter
trading name than the book's registered one, so a refusal would block legitimate
documents in bulk — and the thing underneath is an accounting decision a human
makes against the AutoCount masters, not something a sync may decide. `ok` stays
`failed.Count == 0`; a mismatch does not touch it.

**Spelling is not a disagreement.** `AcSyncService.NormParty` folds case and every
non-alphanumeric character away before comparing, so `HOOKKA MANUFACTURING SDN.
BHD.` and `HOOKKA MANUFACTURING SDN BHD` are the same party and say nothing. A
guard that fires on punctuation is a guard nobody reads. It is the same fold
`census-autocount-party-codes.mjs` applies on the ERP side, so the two agree by
construction. The comparison is also SKIPPED when the payload's `CompanyName` is
just the code — `mastersOf` falls back to the code when a PO carries no
`CreditorName`, and comparing a code against a company name is meaningless.

**Where it surfaces.** `AcCallResult.mismatches` (`parseAcMismatches` drops any
entry missing one of the three strings — a blank `book` would assert something
about the account book nobody measured), and the drain prints one line per entry
before it checks `ok`, because a payload can name several masters and fail on an
unrelated one:

```
MISMATCH creditor:400-H004 erp=HOOKKA INDUSTRIES SDN. BHD. book=HAO HUA FURNITURE — PO HC-PO-2608-002 sent anyway
```

**An empty `mismatches` is NOT "clean".** A host running a build older than this
field does not send it at all, and the ERP cannot tell the difference. `GET
/health`'s `builtAt` / `mvid` is the only thing that says which build answered.

**This repo cannot compile C#.** `deploy-on-host.ps1` compiles with `csc` on the
host and REFUSES to swap an exe that did not compile, then health-checks and rolls
back to a hash-verified backup if the new one does not answer — that is the gate
this change is proven by, and it has already caught a typo this way.

## 7f. A cancel that reached AutoCount is final

The 2.2 SDK has **no un-cancel**. `CancelDocument` is a COMMAND, not a flag we
could write back to false, and a whole-file grep of the reflected surface for
`uncancel`, `set_Cancelled` and `Cancelled:Boolean` returns nothing — pinned by
a test, so it is a checked premise rather than an assumption.

So an ERP un-cancel has no push. Allowing one would leave the document live here
and cancelled there, with nothing able to close the gap — the exact divergence
the owner named (*"一边取消一边没取消"*).

Once `linked_ac_docno` is set, leaving CANCELLED is refused with **409
`cancel_is_final`**:

| route | refuses |
|---|---|
| `PATCH /mfg-sales-orders/:docNo/status` | any transition out of CANCELLED |
| `PATCH /mfg-purchase-orders/:id/reopen` | the reopen itself |

A document with **no** `linked_ac_docno` is untouched — nothing was ever pushed
for it, so nothing can diverge, and the reopen the Commander asked for in
2026-06 still works exactly as before. **Raise a new document instead.**

## 7g. Numbering — every document the ERP creates carries the ERP number

| type | number in AutoCount |
|---|---|
| SO, PO | the ERP's, sent as `DocNo` on the create |
| DO, GR, SI, PI | **the ERP's**, sent as `DocNo` on the conversion |

It was not always so. A create sent its `DocNo` and AutoCount took it; a
conversion sent none, so AutoCount auto-numbered the four converted types — and
four of the six documents carried a number nobody in this building would
recognise, with every reconciliation forced through `linked_ac_docno` instead of
the number printed on the paperwork. The service was ready for it the whole
time: `SalesHeader` and `PurchaseHeader` both apply `DocNo` when the payload
carries one.

Two consequences worth knowing:

- **Supplying our own `DocNo` does NOT advance AutoCount's counter.** Anything
  raised in AutoCount's own UI keeps issuing `SO-0000NN` in parallel, forever.
  That is desirable — the number says which system authored the document — but
  it is now a decision rather than an accident.
- **Nothing enforces that the two series cannot collide.** They cannot today
  only because the shapes differ (`DO-2608-004` against `DO-000021`). A
  collision detector is still open work.

### The collision that DID happen, and it was not the one this section predicted

**2026-08-20. Three documents refused by AutoCount with `Primary Key Error`, and
the whole queue stuck behind them.** The bullet above watches the wrong pair:
the ERP's series against AutoCount's own. What collided was the ERP's series
**against itself** — against numbers the ERP had already put in the book.

What was PROVEN, by extending the read-only health check and dispatching it
(`.github/workflows/autocount-outbox-health.yml`, runs 32381771391 and
32382073444):

| fact | reading |
|---|---|
| `sentAs="HC-SO-2608-001"` | the payload carries the ERP number VERBATIM. No prefix is stripped anywhere on the outbound path. |
| `erpRaised=2026-08-20T12:37` | the ERP document was raised **that day** — it is a NEW document, not the original. |
| `erpLink=null` | it carries no `linked_ac_docno`, so the ERP believes the book does not have it. That belief is why it was enqueued at all. |
| `sentBefore=0` | the outbox holds no `sent` row for that number either. The queue has no memory of the earlier send. |

Against that: `backend/scripts/data/ac-live-proof.json` records `HC-SO-2608-001`
and `HC-SO-2608-002` written into `AED_HOUZS` on 2026-08-14, and
`HC-PO-2608-001` on 2026-08-17 — the latter attested by a `FullTransfer` that
named it as its source, which cannot name a document the book does not hold.

So the ERP's monthly counter re-issued numbers the account book had already
taken, and every retry asks the book to create a document number it already has.
**A prefix is not the protection.** `HC-` distinguishes the ERP's series from
AutoCount's; it does nothing about the ERP's series meeting its own history,
which is what happens whenever the ERP's documents are cleared while the book
keeps theirs.

**UNKNOWN, and only the office host can answer it:** what `AED_HOUZS` holds
under those numbers right now. The health check prints the statement that
settles it rather than guessing —
`SELECT DocNo, Cancelled FROM SO WHERE DocNo IN (…)`. That answer decides the
remedy and the two remedies are opposites: if the book's document IS this
document, the fix is to record the link and never send; if it is a DIFFERENT
document, recording the link would point a new ERP order at somebody else's
accounting document, and the fix is a number. `check-autocount-outbox-health.mjs`
prints `erpRaised` for exactly this reason.

**Do not reach for `repair-outbox-sent-by-hand.mjs` here.** That tool is right
when the ERP's document and the book's document are the same document and only
the queue is out of step. It is wrong — and expensive — when the numbers merely
coincide.

The parent travels separately (`payload.fromDoc`, resolved at drain) and must
never be confused with this: `DocNo` is the CHILD's number, `FromDocNo` is the
parent's.
## 7h. Editing a MIGRATED sofa order — why it was refused, and what fixes it

An operator opens an existing sofa order, changes something, saves. The edit is
**refused**, and the reason is line identity.

`backfill-ac-line-keys.mjs` matches on `(AutoCount DocNo + ERP item code)`,
translating AutoCount's `ItemCode` through the cutover mapping. For a sofa that
translation lands on `9028-1S` — but the cutover **split** each sofa into
compartment rows, so what the ERP holds is `9028-1A(LHF)`, `9028-2A(RHF)` and
friends. The pair never matches. Every migrated sofa line kept a NULL
`linked_ac_dtlkey`, which is the whole of the *"589 PO lines with no AutoCount
match"* in the migration record, and `composeEdit` reads the key off the
COLLAPSED build — a build with no key has no identity to address, so the whole
document is refused.

**Refused, not corrupted.** That is the guard working: the alternative was
appending a duplicate set of lines into a live account book.

`backfill-ac-sofa-line-keys.mjs` (workflow: **Backfill AutoCount line keys
(SOFA)**) closes it by reproducing the D9 collapse the write-back itself uses:
group the compartment rows into builds, resolve the build to the `<model>-1S`
code the mapping knows, match THAT against AutoCount's lines, and give **every
compartment row of a build the same DtlKey** — which is exactly the shape
`composeEdit` requires.

**Where the counts disagree it assigns nothing** and names the document. A wrong
key is worse than a missing one: missing is refused loudly, wrong silently edits
a different line in a live book.

## 7n. The salesperson — two ERP columns, one Agent

**This is what the go-live failed on.** 2026-08-13, two re-queued sales orders,
four attempts each, and the live book answered:

```
Foreign Key Error (Constraint Name=FK_SO_SalesAgent)
```

`composeCreateSo` read `mfg_sales_orders.agent` and nothing else. `agent` is a
legacy free-text column filled only from `body.agent`, **which no SO form
sends** — so it was empty on every order created since the cutover. An empty
Agent reaches the service as `""` (`Set(() => so.Agent = Str(p, "Agent"))`, and
`Str` turns an absent key into the empty string), and `""` is not a row in
`dbo.SalesAgent`. `/ensure-masters` could not save it either: `mastersOf` only
emits an `Agents` entry when the payload names one, so an empty agent opened
nothing and the create died on the foreign key. Nothing was written — the FK
rejects the document before it lands — so there was no residue to clean up.

The ERP's REAL identity is `mfg_sales_orders.salesperson_id` -> `scm.staff`,
stamped at create. The SO detail page had been hiding the gap for months:
`salespersonNameOf(salesOrder.agent, salesOrder.salesperson_id)` falls back to
the id, so a name appeared on screen while the column behind it was empty.

**Both halves were fixed, and they are not redundant.**

| half | where | what it does |
|---|---|---|
| stamp at the source | `scm/lib/so-agent.ts`, used by `createSalesOrderCore` and the header PATCH | `agent` is written from the stamped salesperson's `scm.staff.name` whenever the caller does not supply one — header, goods lines and SERVICE lines alike |
| fall back at compose | `resolveAcAgent` in `services/autocount-writeback.ts` | an order that ALREADY exists with an empty `agent` still resolves, through `salesperson_id`. `SO_HEADER_COLS` carries the column and `readSalespersonName` turns the id into the name, the same division `withLocations` draws for the line-level warehouse |

### The order of preference, and what is deliberately NOT trusted

1. `agent` through `AGENT_MAP` — the book's own spelling of a rep it already has
2. the salesperson's name through the same map
3. the salesperson's name **as itself**, opened by `/ensure-masters`
4. nothing -> `MissingAgentError`

Step 3 is D10's rule applied to people: an unmapped item code stopped refusing a
document on 2026-08-13 and is opened instead, and `AGENT_MAP` is a snapshot of
the book's spellings rather than an allow-list — every rep hired since it was
built would otherwise be unwritable.

**The raw `agent` text never passes through unmapped.** That column has no
writer keeping it honest: production rows hold bare `scm.staff` UUIDs
(`useStaffLookup` carries a `UUID_RE` for exactly that) and placeholder text
like "Unassigned" (HC-SO-2607-008, the order that produced the confirm gate's
salesperson rule). `/ensure-masters` opens an agent under EXACTLY the string it
is given, so passing either through would write permanent garbage master data
into a licensed book. `scm.staff.name` is a real person by construction, which
is why only it is trusted unmapped.

### Both empty: the CREATE is refused, the EDIT is not

A create with no resolvable salesperson raises `MissingAgentError` and lands a
`skipped` row through `noteReadFailure` — the same shape as
`MissingLocationError`, one level up. Sending `""` instead is what produced the
incident, and the document cannot land either way, so the refusal loses no
successful write: it converts four silent 500s in `C:\Temp\ac-sync-service.log`
into one row an operator can read and the §9 re-queue tool can retry.

An **edit** is never refused for this. The account book already holds a value
and `/edit` applies only the keys it is GIVEN, so omitting `Agent` leaves it
alone — the same asymmetry the stock Location runs under.

**No create-time gate was added** (unlike the stock location's
`so-location-gate.ts`). The confirm gate already demands `salesperson_id` OR
`agent` before an order may be CONFIRMED, and only non-draft orders are
enqueued, so the both-empty shape is unreachable from the UI. The composer's
refusal is the backstop for the paths that are not that gate — imports, the 2990
mirror, an API caller passing `{salespersonId: null}` explicitly.

### A PURCHASE order has no agent — so it names a CONSTANT

`scm.purchase_orders` still has no agent column and the ERP has no
purchase-agent concept. That is not the problem; sending `null` for it was.
`readPoHeader` hardcoded `agent: null`, and `CreatePo` assigns `po.Agent`
unconditionally while `Str` turns both an absent key and a present-null into
`""` — so all **60** unpushed purchase orders were queued to fail
`FK_PO_PurchaseAgent` (§7m row 4), unproven on the live book only because no PO
has been pushed yet. **Omitting the key would not have helped.**

Fixed 2026-08-14: `readPoHeader` supplies `AC_PURCHASE_AGENT`, and
`composeCreatePo` floors the field at it so a null cannot come back. `OTHERS` is
the value the FK chain was debugged with on 2026-08-12 and it exists in
`AED_HOUZS`; `mastersOf` routes it to `PurchaseAgents` because the payload
carries a `CreditorCode`.

**Which purchase agent the book's reports group by is still an OWNER decision.**
`AC_PURCHASE_AGENT` in `services/autocount-writeback.ts` is the single place it
is written down. Attributing POs to a real buyer would need a column on
`scm.purchase_orders` and a picker, and that is the open half.

### And its CREDITOR is refused rather than sent blank

`CreatePo` assigns `CreditorCode` **directly** — not even wrapped in `Set` — so
a supplier row with a blank `scm.suppliers.code`, or a PO with no `supplier_id`,
sends `""` into `FK_PO_Creditor` and loses the whole document. `mastersOf` opens
a creditor only for a non-empty code, so the empty case was the one nothing
covered. `composeCreatePo` now raises `MissingCreditorError` — the same shape as
`MissingAgentError`, and 0 of 60 purchase orders are in that shape today, so it
is the guard for the first one rather than a repair.

## 7l. Where this module sits

This guide covers **how to call the write service**. For the shape of the whole
relationship — the four channels, which documents are created versus converted,
how a SKU crosses, what is automatic and what never will be — read
**`docs/autocount-integration-map.md`** first. It is the map; this is one road on it.

## 7m. The master-data foreign key chain — read this before debugging a refused document

**A document is refused as a WHOLE when any master it names is missing.** The
live book enforces foreign keys the old evaluation book did not, and they are
discovered **one at a time**: satisfying one only reveals the next, so "I fixed
the error and retried" buys exactly one attempt. Four have been hit so far, each
against `AED_HOUZS`, each with the evidence beside it.

| # | Constraint | Named by | Opened by | Found |
|---|---|---|---|---|
| 1 | `FK_SO_SalesAgent` | SO header `Agent` | `ensure-masters` → `Agents` — but only when the payload NAMES one, which is the 2026-08-13 go-live failure (§7n) | 2026-08-11 |
| 2 | `FK_SODTL_Location` | SO **line** `Location` | `ensure-masters` → `Locations` | 2026-08-11 |
| 3 | `FK_Item_ItemGroup` | a NEW item being opened | `ensure-masters` → `Items[].ItemGroup` | 2026-08-12 |
| 4 | `FK_PO_PurchaseAgent` | PO header `Agent` | `ensure-masters` → **`PurchaseAgents`**; every PO now names `AC_PURCHASE_AGENT`, §7n | 2026-08-12 |
| 5 | `FK_SO_SalesLocation` | SO **header** `SalesLocation` | `ensure-masters` → `Locations`; a blank falls back to the lines and an order with none is refused (§7o) | 2026-08-12 |
| 6 | `FK_PO_Creditor` | PO header `CreditorCode` | `ensure-masters` → `Creditors`; a blank code is REFUSED, never sent (§7n) | not hit — 0 POs are in that shape |

**#3 — an item cannot be opened without a group.** `ItemGroup` is a foreign key,
not a label, so a brand-new SKU arriving from the ERP is refused on its very
first document. The service now defaults to `OTHER`, which exists precisely for
this. The groups the live book holds, by item count:

```
BEDFRAME 645   MATTRESS 517   SOFA 114   ACC 99   BEDLINES 85
DINING 55      DIFFUSER 39    OTHER 4    CARPET 2  TRANS 1
```

Everything lands in `OTHER` until somebody maps the ERP's own `item_group`
vocabulary onto these. **That mapping is an owner decision, not a guess** — it
decides where a new product shows up in AutoCount's own reports.

**#4 — a PURCHASE agent is not a sales agent.** Different table
(`dbo.PurchaseAgent`), different foreign key, different SDK command
(`AutoCount.GeneralMaint.PurchaseAgent.PurchaseAgentCommand`, whose shape mirrors
`SalesAgentCommand` exactly). Opening `OTHERS` as a sales agent does **nothing**
for a purchase order naming it. This one is worth remembering because
`ensure-masters` cheerfully reported `agent:OTHERS` as *already existing* while
`/create-po` was failing on it — the report was true and irrelevant.
`mastersOf` now routes the agent by whether the payload carries a
`CreditorCode`, which is the one field only a purchase document has.

**Values known to exist in `AED_HOUZS`**, for a throwaway test document:

| Field | Use |
|---|---|
| `DebtorCode` | `300-C002` |
| `CreditorCode` | `400-N002` (NICOLLO SDN BHD, 3,326 POs) |
| `Agent` / `PurchaseAgent` | `OTHERS`, `KINGSLEY`, `MK`, `WW`, `ALEX`, `SIANG` |
| `Location` / `SalesLocation` | `KL`, `HQ`, `KELANA.J`, `C&C DISP`, `C&C K.J`, `EM DISP` |
| `ItemGroup` | `OTHER` for anything unclassified |

**How to read a refusal.** The HTTP response carries only a 500; the constraint
name is in `C:\Temp\ac-sync-service.log` on the host. Read the log, not the
status code — `FK_PO_PurchaseAgent` and `FK_PO_Creditor` are the same 500 and
completely different problems.

## 7z. HOW TO CALL THE SERVICE — read this before concluding you cannot

Three facts, because a session that did not have them concluded from this
repository that the service was unreachable and that the whole QA had to be run
by a person standing at the office machine. None of that is true.

**1. Call the HOSTNAME, never the ZeroTier IP.**

```
POST https://autocount.houzscentury.com/<route>
```

A direct call to `10.147.17.100:8900` **will be refused** — 400, or 403 with a
forged `Host` — and that is not a fault to debug. The listener prefix is
`http://localhost:<port>/`, so http.sys serves loopback only. **cloudflared runs
ON that host and connects from loopback**, which is exactly why the tunnel path
works where a direct one cannot. Verified from an ordinary workstation
2026-08-11.

**2. The key is the `X-API-KEY` header**, its value being the host's
`C:\Tempc-svc-key.txt` — the same value as the `AC_SYNC_KEY` Worker secret,
which is already set. No key gets 401; a service with no key file configured
refuses everything with 503 (fail-closed, `#2025`).

**3. `it-houzs.dev` is a DIFFERENT relay** — the legacy read middleware. It has
never fronted AcSyncService and never will. Finding `/health` 404 there proves
nothing about this service.

**What this means for who can do it:** anyone, from anywhere. No ZeroTier, no
office visit, no SQL password — the HTTP path needs the API key, not the
database. The office machine is needed for exactly one thing: **rebuilding the
exe** (`docs/autocount-service-deploy.md`), because it compiles against licensed
assemblies. Even that is not exclusive — `build-local.ps1` compiles the source
on any workstation with AutoCount 2.2 installed, which is how a CS0234 was
caught before it shipped.

## 7p. The line photographs reach the account book

**Shipped 2026-08-18 (ERP half). The AutoCount half was proven 2026-08-15** on
scratch order `ERP-FDPROBE-1`: the ERP sends JPEG bytes, the host renders a
metafile into `FurtherDescription`, and the picture appears on the entry screen
AND in the printed preview — the `XRRichText` path, which was the real risk.
Read back: `truncated=False`, `pict=1`, `wmetafile8=1`, our own bytes kept
unchanged. What was missing after that was only this side: nothing composed a
`Photos` key.

| | |
|---|---|
| Contract | `Photos: [{ Jpeg, Caption? }]` per LINE, base64 |
| Route | **`/edit` only.** `AcSyncService.Edit()` reads it; `CreateSo` does not. A newly created order carries its pictures on its first edit |
| ERP source | `scm.mfg_sales_order_items.photo_urls` — R2 keys in the `SO_ITEM_PHOTOS` bucket, written by `import-so-line-photos.mjs` at the cutover |

**The payload carries KEYS, not bytes.** `scm.autocount_outbox` is append-only:
storing base64 would write tens of KB per save of every photographed order,
forever. The snapshot records what the save MEANT — these pictures, on this
line — and `dispatchOne` materialises the bytes from R2 in the moment it sends,
the same division `fromDoc` already runs under.

**A picture the bucket cannot answer sends NO `Photos` key at all.** Not a short
list: the service REPLACES `FurtherDescription` with what it is given, so three
of five pictures would delete two from the book. And it never fails the edit —
a photograph must not cost a price change its trip to the ledger.

Keyed, live lines only. A cancelled line is being zeroed and must not be written
to; a keyless line is refused by `composeEdit` long before this matters.

**PO line photographs exist and are NOT sent yet** (`import-po-line-photos.mjs`
wrote them). The sales order is the shape with live-book evidence behind it; the
purchase order is a second rollout that needs its own.

## 8. Configuration

| Name | Kind | Notes |
|---|---|---|
| `AC_SYNC_URL` | `[vars]` in `wrangler.toml` | Base URL of AcSyncService. **Config, not a secret** — a hostname and a port. Absent = the drain is a no-op and says `ac_service_not_configured`. **Present since 2026-08-11** (`https://autocount.houzscentury.com`), so this is no longer a gate |
| `AC_SYNC_KEY` | **wrangler secret** | The service's `X-API-KEY`. `wrangler secret put AC_SYNC_KEY`, never in `wrangler.toml` |
| `scm.app_config` / `scm.autocount_writeback` | DB row | The runtime toggle (§4) |

The AutoCount service reads its own key from `C:\Temp\ac-svc-key.txt` on the
host and its SQL connection string is injected at build time, so no credential
lives in this repository.

---

## 9. Operating it

### The page — `/autocount-sync` (added 2026-08-15)

**Start here. It is the only reader of this queue that does not require a GitHub
account.** Owner, 2026-08-15: *"你确保有完整的记录，就是我可以看得到 ... 如果它是
在排队、skip、planning 还是 fail 等等，fail 的话是什么原因？everything 都要呈现出
来，要不然我就不知道."* Until that date the queue's only reader was the workflow
below, whose output is an Actions log.

| | |
|---|---|
| Desktop | `frontend/src/pages/AutoCountSync.tsx`, route `/autocount-sync`, Sidebar section **System**, next to System Health. An eight-column REGISTER since 2026-08-21 — see below |
| Mobile | `frontend/src/mobile/MobileAutoCountSync.tsx`, menu group **System**. Keeps its CARDS: a table does not fit 375 px |
| Shared logic | `frontend/src/lib/autocountOutbox.ts` — the hook, the filter shape and the words; and `frontend/src/lib/autocountRegister.ts` — the columns, the account book's verdict on a document number, the day buckets, the two lenses and the footer. Two files, ONE layer: both are imported by both surfaces and by nothing else, and the split is the 2,000-line file cap, not a design |
| Endpoint (read) | `GET /api/scm/autocount-outbox` — `backend/src/scm/routes/autocount-outbox.ts` |
| Endpoint (re-send) | `POST /api/scm/autocount-outbox/:id/requeue` — same file. **It SENDS, it does not only queue** (2026-08-23). It used to write a fresh `pending` row and stop, leaving the five-minute drain to send it — so the button put the document into Waiting and the operator watched a clock. It now dispatches the row it just created through `sendOutboxRowNow` and reports the result in `sent_now`, kept apart from the re-queue's own verdict: a document can be queued fine and refused by the account book a second later. |
| Endpoint (send now) | `POST /api/scm/autocount-outbox/:id/send-now` — same file. Dispatches synchronously, but only accepts a row that is ALREADY `pending`, which a `failed` row never is. That is why the two endpoints exist and why the re-queue one had to grow the send: the button an operator gets on a failed row is Send **again**. |
| **Both send the ANCESTORS first** | `sendAncestorsFirst` in the same file, over `lib/autocount-cascade.ts`. AutoCount builds a conversion only by carrying an earlier document into it, so a child whose parent is not in the book cannot go — and left alone the row WAITS, which is right for the sweep and useless to a person: the parent is `failed` at six of six attempts, so nothing re-sends it and the child waits forever (`HC-SI-2608-002` was waiting on `HC-DO-2608-003` exactly like this). Pressing either button is the moment to CAUSE the parent. One helper, so the two buttons cannot come to differ — `check:duplicated-decisions` caught them differing by two response fields and that was the fix, not an allowlist entry. |
| Permission (read) | `scm.autocount.read` **or** `settings.manage` (Owner / IT Admin pass on `*`) |
| Permission (re-send) | `scm.autocount.requeue` **or** `settings.manage`. **Not** `scm.autocount.read` — see below |

**Mounted with NO `scmAreaGuard`** (`backend/src/scm/index.ts`, and therefore
listed in `SCM_UNGUARDED_PREFIXES` in `backend/src/scm/lib/scm-areas.ts` — the
two move together or the mirror test fails in both directions). An L2 area key is
a PAGE key and this page belongs to no SCM area: it spans sales orders, purchase
orders and all four conversions at once, so any area key here would be an
arbitrary owner. Authorization is entirely the two flat keys above, checked
against the REAL caller inside the route — stricter than the coarse `scm.access`
umbrella `/api/scm/*` already applies, and it has to be, because this endpoint
quotes what the licensed account book said about every document the company
pushed. Same reasoning as `/hr`.

> **2026-08-19 — three neighbours rejoined that list, and they have no user to
> read an error.** `/pos-cart`, `/personal-quick-picks` and `/sales-analysis`
> were removed from `SCM_UNGUARDED_PREFIXES` on 2026-08-18 (#2422) together with
> their mounts, on the finding that no screen in this repo calls them. The
> finding was right; the conclusion was not. Their screen is the **2990 POS**
> (`pos.2990shome.com`, repo `wenwei4046/2990s`), which has built against this
> API since the 2026-07-21 cutover — a repo-wide "find usages" here cannot see
> it, because neither repo compiles against the other. Restored in #2459, and
> each route file now opens with an `EXTERNAL CLIENT` banner naming that repo
> and its call sites.
>
> **Why it matters to THIS guide:** an unguarded prefix has no L2 area key, so
> `areaForPath` returns null and the freeze treats it as *stays frozen* — a
> staged per-module lift can never name it. That is the intended behaviour and
> is unchanged. But unlike the AutoCount page above, these three answer a
> **tablet in a showroom** with no operator able to read a 503 and no way to ask
> for an exception. If a company is frozen while its POS is live, that is the
> surface that goes quiet first. Five other POS routers (`/pos-pools`,
> `/delivery-fees`, `/fabric-tier-addon`, `/sofa-quick-picks`,
> `/model-free-gifts`) were restored in the same PR but DO carry area guards
> (`scm.procurement.products`), so those can be lifted per module.

It answers the owner's question in his order: a one-line verdict, then the two
filter strips (which carry the counts), then the list, with every row's reason on
the row itself.

**Company-scoped on every one of its seven statements.** `company_id` is the
whole tenant boundary here and an unscoped AutoCount report has already cost this
project most of a day (#2201).

#### Rebuilt 2026-08-16 — what the screen is now

The first version put the five counts on TILES and the reason in the ERP's own
words. The owner reviewed a mockup and asked for five changes; all five live in
`frontend/src/lib/autocountOutbox.ts`, so both surfaces get them from one place.

| | |
|---|---|
| **Two filter strips, counts on the chips** | Status (Everything / Needs attention / Waiting / In AutoCount / Not accepted / Held back / Replaced — *"Sent again" until 2026-08-17*) and Document (Sales orders / Delivery orders / Invoices / Purchase orders / Goods received / Supplier invoices). Both are `<FilterPills>`, the same component the Sales Order list uses. The tiles are gone: the counts were the only useful thing about them and a tile cannot be clicked. |
| **The reason, in three parts** | A headline, one sentence, and a **To fix** line, keyed by the server's `reason_kind` (`AC_REASON_COPY`). The headline is never behind a click — that was the owner's specific complaint. A `failed` row gets `AC_FAILED_COPY`, because the server deliberately does not classify those. *(The sentence and the To fix line moved behind opening the row the same day — see the section below.)* |
| **Who was asked** | `acReplySource` labels the quote **AutoCount replied** (the row went through `dispatchOne`), **AutoCount was not asked** (every `skipped` row — all of them are decided at enqueue time or before `callAcService`, so no held-back document has ever reached the account book), or **The last send attempt reported** for a `pending` row, where the note may be either and nothing the server sends tells them apart. |
| **Send again, per row** | Offered only where the server's `can_requeue` says a re-send can mean anything, and driven by `useAcRequeue` — one hook, both surfaces. Since 2026-08-23 pressing it SENDS immediately and pushes the missing ancestors first, in order (SO → DO → SI, PO → GR → PI); the reply carries `sent_now` and `ancestors_sent`. |
| **No coding words** | The page no longer prints the config key, the raw `op` values, the raw state values, or the server's `remedy` strings — those name columns, tables and an SDK primitive. The remedy still ships in the API response and is still what the health-check log prints. Plurals are spelled out in `AC_DOC_TYPE_PLURAL`, never built by appending an "s" — "Goods received" has none. *(NOT SUFFICIENT — the row below is the correction.)* |

#### Corrected the same day — the machinery was arriving from the SERVER

The row above says "no coding words" and it was true of every string this
codebase writes for the screen. The owner then read two on the live page anyway,
because neither is one of those strings:

| what he read | where it came from |
|---|---|
| `AddPartialTransferDetail is the SDK's only primitive`, in prose, on a held-back invoice | `recordParentlessCreate`'s own `last_error`. The identifier had been taken out of the page's copy hours earlier and came back through the server. |
| `Invalid transfer item. \|\| source SO lines as the book holds them: 905348 … Qty=1.00000000 TransferedQty=0.00000000 Transferable=T docCancelled=F …` | `AcSyncService.cs`'s transfer arm, added the same day. Genuinely valuable — it is what refuted the standing diagnosis for HC-DO-2608-001 and -002 — and not to a warehouse clerk. |

So the rule is structural now rather than a promise about wording, and it is
`acWhatWasSaid` in the shared layer. **`docs/autocount-sync-reasons.md` §0 is the
contract**; the short version:

| | |
|---|---|
| **Nothing the server wrote is the page's own voice** | It appears only under the label saying who wrote it. The split into "sentence" and "evidence" is on `AcSyncService`'s own ` \|\| ` separator — a mark the writer put there, not a pattern guessed at — and the branch is on WHO spoke, never on what the note says. |
| **A second, collapsed, labelled disclosure** | `AC_TECHNICAL_LABEL`, rendered by `TechnicalNote` on both surfaces (`data-ac-technical`). Holds the per-line dump, and holds the ERP's whole internal note where the page already says the same thing in plain words. `unrecognised` is the exception both ways: there the page has NO words, so the quote stays in view and the row still arrives open. |
| **The headline did not move** | Still on the row, unclicked, on every problem row. He rejected a design with the reason behind a click and moving machinery must not re-take it. |
| **The distinction did not move** | **AutoCount replied** / **AutoCount was not asked** is still on every quote. |
| **A reason is read by the owner** | `acParentlessCreateReason` moved into `autocount-outbox-status.ts`, beside the `no-source-document` needle it must keep containing, and `backend/tests/autocountSyncReasonsCatalogue.test.ts` pins both halves. Rewording the writer does not clean the queue — `scm.autocount_outbox` is append-only and `last_error` is never rewritten, so the render rule is what fixes rows already in the table. |
| **A refusal that names no field says so** | `AC_FAILED_COPY.toFix` no longer reads "Put right whatever AutoCount named". `Invalid transfer item.` names nothing, and those lines were measured correct against the live book the same day (`autocount-sync-reasons.md` §4). It now covers both cases and, for the second, says who to tell. |
| **History is folded** | `acSplitReplaced(groups, state)` takes documents whose newest send is `requeued` out of the list into *"N replaced documents, kept as a record"*, closed on arrival (`useAcReplacedGroup`), on both surfaces — except under the **Replaced** filter, where they ARE the list. His screen was fifteen rows with six of them history and two documents appearing twice. *(Was `acSplitSuperseded(rows, state)` over ROWS until 2026-08-17 — see the section below.)* |
| **A load failure is the page's sentence** | `AC_LOAD_FAILED_LINE`, with the transport's words quoted under it rather than spliced into it. Same for the `Send again` throw path, whose text used to end `: ${e.message}`. |

#### Simplified the same day — the row is ONE LINE

The rebuild above was approved from a mockup and then read against a real
backlog. Owner, 2026-08-16: *"这一个东西下面的地方太复杂了，你尽量简单化一点。一个
sales order 那么宽，那如果我有一千个 sales order 的时候，我不是完蛋？"* Every problem
row was printing a headline, a sentence, a **To fix** line and a quoted machine
reply at once. At thirteen rows that reads well; the sales order list alone is
2,726 documents.

| | |
|---|---|
| **The page opens on Needs attention** | `AC_DEFAULT_STATE` in the shared layer, honoured by the desktop URL default and the mobile `useState`. Everything is one chip away and, when chosen, travels as `?state=all`. An unknown `?state=` falls back to the default, not to everything. |
| **One line of reason, and it is the opener** | `acRowDetail(row, reasonCleared)` splits a row into `line` (always on screen) and the rest. `line` is the `AC_REASON_COPY` headline, or `AC_REQUEUED_LINE` for a re-sent refusal, or the `AC_REPLY_LABEL` for a row with a note but no copy. `copy.explain`, `copy.toFix`, `AC_REQUEUED_NOTE` and the quoted reply sit behind it. *(Since the correction above, the quote is an `AcSaid` on `detail.said` rather than a `showSaid` boolean — each surface used to rebuild the answer from the row itself, which is how the two come to disagree about one row.)* |
| **A document in the account book has nothing to open** | `acRowDetail` returns `expandable: false` for `state === 'sent'`, even when the row carries a note. Those are the majority of a long list and they are now silent. |
| **One line of detail, not five fragments** | `acRowStandsAt(row, maxAttempts)` is the kind, then where it stands, then the timestamp — ordered so truncation loses the timestamp first. It replaced four separate spans per row on desktop and three on mobile. |
| **Which rows are open** | `useAcExpandedRows()`, in the shared layer rather than inside the row, because the list is windowed and an unmounted row would forget. `acOpensItself(row)` keeps ONE row open on arrival: `reason_kind === 'unrecognised'`, where the quoted note is the entire answer. |
| **The strips stay put** | Desktop: a `sticky` block parked at `var(--page-header-offset)` — the value `PageHeader` publishes — at `z-[5]`, deliberately below the header's `z-10`/`lg:z-20`. Mobile: they were already inside `.hdr`, which `mobile.css` pins. |
| **The list is windowed** | `<MobileVirtualList>` on BOTH surfaces — the component `DataTable` and eight mobile screens already use, not a second mechanism. Below its own 40-row threshold it renders every row exactly as a plain `.map` did. |

**Measured in `frontend/perf-lab` (`?scenario=autocount-sync&rows=400`,
`&surface=mobile` for the phone), 2026-08-16, 400 rows:**

| | before | after |
|---|---|---|
| desktop, in AutoCount | 79.8 px | **36.5 px** |
| desktop, held back (collapsed) | 233.0 px | **64.3 px** |
| desktop, not accepted (collapsed) | 311.3 px | **69.8 px** |
| desktop rows in the DOM | 400 | **25** |
| mobile 375 px, in AutoCount | 102.0 px | **53.5 px** |
| mobile 375 px, held back (collapsed) | 335.5 px | **83.8 px** |
| mobile 375 px, not accepted (collapsed) | 387.1 px | **88.5 px** |
| mobile cards in the DOM | 400 | **20** |

> **The lab's rows CHANGED on 2026-08-16** (`frontend/perf-lab/main.tsx`), so a
> re-measure is comparable per row TYPE and not row-for-row against the table
> above. `i % 5` now yields five kinds instead of three: in AutoCount, held back
> (`missing-location`), **not accepted carrying `AcSyncService`'s `\|\|` dump**,
> **held back parentless carrying the SDK sentence the queue still holds**, and
> **superseded**, the last with `HC-DO-2608-001` / `-002` repeating. It carries
> the real strings because a lab measuring a row nobody has measures nothing —
> `?rows=15` reproduces the screen the owner read the four defects off.

The lab scenario is the harness: it renders the REAL page with the queue stubbed
at `fetch`, so everything above the network — the cache, the headers, the error
path — is the real code and a height measured there is a height the app
produces. Re-measure with
`document.querySelectorAll("[data-ac-row]")[i].getBoundingClientRect().height`.

**A phone cannot hold the state, the number and where it stands on one visual
line at 375 px**, so a quiet card there is two short lines rather than the
desktop's one. What is the same on both: nothing to open, and no reason block.

**THE ANSWER TO Send again LANDS ON THE ROW THAT WAS PRESSED**, in all three
directions it can go, and that is the part worth guarding:

| what came back | what the row shows |
|---|---|
| `accepted: true` | the server's sentence, in green, and the page re-reads the queue — an accepted re-send makes a NEW row, so patching the one on screen would be a lie. **The old refusal comes OFF the row at the same moment**, before the re-read lands: *"To fix: go and change it in AutoCount"* on a document that has just been sent back to the queue is a false instruction, and a round trip is long enough to act on it |
| `accepted: false` | the server's `message`, in amber, plus `reason` verbatim underneath when the composer refused it again, and the old refusal stays — nothing changed. **This is the branch that gets forgotten**, and forgetting it is "the button does nothing" wearing a success path: most refusals ("AutoCount already accepted this one") are the whole reason somebody pressed |
| the call threw | *"Nothing was sent — the request did not get through: …"*, in red, old refusal kept. A refusal and a throw are different facts |

Not a toast: a toast about `HC-SO-2608-004` is gone by the time the reader has
found `HC-SO-2608-004`.

**Two vocabularies, both keyed by the outcome code, and neither is a copy of the
other.** `AC_REQUEUE_MEANING` (server) says WHAT HAPPENED and is printed
verbatim — it is already plain English, it lives beside the code that produced
the outcome, and a second dictionary on the page is how the two come to disagree
about what `already-sent` means. `AC_REQUEUE_TODO` (`frontend/src/lib/autocountOutbox.ts`)
is the OTHER column of `docs/autocount-sync-reasons.md` §1 — WHAT TO DO NEXT —
which the API does not carry at all, and it renders as a **To do** line under
the sentence. A code with no entry shows nothing rather than a bare hyphenated
key, so a new outcome still reads correctly the day it ships.

#### Corrected 2026-08-17 — the unit was the SEND, and the badge was an order

He read the page a third time and found two more, both display and neither a
fault in what the ERP writes.

**「为什么在 AutoCount 里面一张 Sales Order 会出现两次呢?」** Under **In AutoCount →
Sales orders**, `HC-SO-2608-002` was FOUR of six rows — three changes and the
create. `AED_HOUZS` holds exactly one of it, verified by direct SQL. The queue is
append-only and writes one row per intended operation (0277), so that document IS
four rows for good; the list was one row per SEND and the header read *"6 of 17
documents"* over it.

| | |
|---|---|
| **One row per document** | `acGroupByDocument(rows)` in the shared layer, keyed on `doc_type + doc_no` — the pair `autocount_outbox_doc_idx (company_id, doc_type, doc_no)` was created to answer with. Not `doc_no` alone (six types, one number can belong to two, and folding them would LOSE a document); not `doc_id` (0277 declares it nullable and untyped so a row survives its document being reworked). |
| **The newest send draws the row** | `group.current`. Under a status filter that is the newest send MATCHING the filter — the honest answer to the question the filter asked. |
| **The audit trail is kept** | *"N earlier sends for this document"* (`acEarlierSendsHeading`, `data-ac-send`), folded on arrival, on both surfaces. 0277 exists so "what did we tell AutoCount, when, and what did it answer" is a SELECT a year later; nothing is dropped. |
| **Both strips count documents** | the type chips over the loaded page (`acDocTypeCounts` takes groups now), the status chips at the SERVER. The route's six `count: 'exact', head: true` queries became TWO paged scans — `id, doc_type, doc_no, status` for the company, plus the ids matching `REQUEUED_LIKE` — reduced to distinct `doc_type + doc_no`. Fewer round trips than before, no `last_error` downloaded, and the state per row still comes from the shared `acOutboxState`. |
| **The counts do not sum to the total** | on purpose. A document that arrived and was later edited into a refusal is counted by **In AutoCount** AND by **Not accepted**, because both are true of it and both chips list it. `total` is distinct documents. |
| **A partial count says so** | the scan stops at `AC_DOC_SCAN_MAX` (20,000) and answers `counts_complete: false`; the page adds *"the numbers on the chips are at least this many and possibly more"* to the amber banner. An undercount must never read as a count. Past that cap this wants a `count(distinct …)` in SQL, which PostgREST cannot express — the open item is recorded in `docs/autocount-sync-reasons.md`. |

**「你写 Send Again,明明都已经进去了,为什么还要 Send Again？」** The badge read **SENT
AGAIN** — the same two words as the **Send again** BUTTON beside it — on seven of
seventeen rows, on exactly the rows where pressing it is the one thing a reader
must not do, and the row's own body then said *"Already sent again under a newer
row · this row is history"*.

The state is **Replaced** now, on the badge and the chip; the status line is
*Replaced by a newer send*; the headline is *Replaced by a newer send — nothing to
do on this one*. The rule, which is what the next person needs rather than the
words: **a state is something that happened TO the record and is never named with
the imperative of a control beside it.** `AC_SEND_AGAIN_LABEL` is unchanged.
`docs/autocount-sync-reasons.md` §0a is the contract and
`frontend/src/lib/autocountOutbox.test.ts` asserts the strings carry neither the
button's words nor `re-queue` / `supersede` / `row`.

**`docType` is no longer sent to the server**, though the endpoint still accepts
it. The type strip has to carry a count for every type, and a response already
narrowed to one type makes every other chip read zero — so the type is applied on
the client (`acRowsOfType` / `acDocTypeCounts`) while `state` and `docNo` stay
server-side. Consequence, stated on screen when `truncated` is true: the STATUS
counts are exact and whole-company, the TYPE counts are of the DOCUMENTS loaded.

**IT WAS READ-ONLY UNTIL 2026-08-16.** This paragraph read: *"There is no
re-queue button … Putting that behind a button is a decision the owner has not
made."* He has made it, and `POST /:id/requeue` is the backend half.

**The button climbs the SAME ladder as the workflow**, `requeueOneRow` in
`backend/src/scm/lib/autocount-requeue.ts`, extracted out of `requeueSkipped`'s
loop for the purpose. Two ladders would be two answers to "may this document be
sent again", and the looser one writes a second copy of a document into a
licensed account book. What the by-id path adds is three answers a backlog sweep
cannot produce:

| code | why |
|---|---|
| `already-sent` | AutoCount ACCEPTED this document. Refused before anything is read or composed — the C# create has no duplicate guard on the ERP document number, and an accepted sales order cannot simply be deleted there. This is the refusal the workflow never needed: it selects `skipped`, and `failed` only behind `includeFailed`. |
| `row-pending` | the drain is already going to send it, so a second press could only add a duplicate five minutes later |
| `row-not-found` | no such row **in this company**. Answered identically for an unknown id and for the other company's id |

**No `includeFailed` opt-in here, and that is not a loosening.** The flag exists
because the workflow sweeps a whole backlog blind; a person pressing a button on
one row has already read that row's reason. What the flag never protected
against — a `sent` row — is refused outright, which the flag could not do.

**`can_requeue` on every list row** says whether the button belongs there at all
(`acRowIsRequeueable`), and it is a HINT computed by the server so the page holds
no policy; the POST re-checks everything. It is true for a `create_so` /
`create_po` row whose state is `failed` or `skipped`, and — since 2026-08-16 —
for a TRANSFER row (`so_to_do`, `po_to_gr`, `do_to_iv`, `gr_to_pi`, `so_to_po`)
whose state is `failed` and never one whose state is `skipped`. Neither ever
carries the re-queue marker. The asymmetry is the whole rule below: a `skipped`
transfer was refused by the DOCUMENT and a `failed` one by the SERVICE.

**The answer is a structured outcome, never an exception string** — `accepted`,
a stable `code`, and a plain-English `message` from `AC_REQUEUE_MEANING`, which
lives beside the code that produces it so a new outcome cannot render on the
owner's page as a bare hyphenated key. Every code, with its trigger, whether a
re-send can ever fix it and what a person should DO, is
`docs/autocount-sync-reasons.md`; `backend/tests/autocountSyncReasonsCatalogue.test.ts`
fails if the two ever disagree.

**A refusal is HTTP 200.** `already-sent` and the rest are legitimate answers, not
client errors. Only the four things wrong with the CALL carry a non-200: 403 (no
permission), 409 (company unresolved), 404 (`row-not-found`), 500
(`read-failed`).

The workflow below is unchanged and remains the way to work a whole backlog, and
the only way to get a DRY RUN.

**Filters are in the URL** (`?state=`, `?docType=`, `?docNo=`, and since
2026-08-21 `?range=` and `?sort=`) on desktop; the mobile shell has no router, so
they are component state there. An unreadable value on any of the five falls back
to its default rather than travelling — the server refuses an unknown `state`
with a 400, and a hand-edited URL must not turn this page into an error message
or an empty register.

#### Rebuilt as a REGISTER, 2026-08-21 — eight columns, and the one that pays for the table

The owner reviewed a mockup at the size the queue actually is — the sales order
slice alone is 2,726 documents and the whole register will be a few thousand —
and chose the dense-table direction over the card list. **Every column reads a
field the payload already carries; no endpoint changed and none needs to.**

| # | column | content | field |
|---|---|---|---|
| 1 | Status | the state pill (In AutoCount / Waiting / Not accepted / Held back / Replaced) | `state` |
| 2 | Document | the ERP's own number, monospace | `doc_no` |
| 3 | Type | Sales order / Delivery order / … | `doc_type` via `AC_DOC_TYPE_LABEL` |
| 4 | What was sent | the operation in plain words | `op` via `acOpLabel` — the map that already existed, not a second one |
| 5 | **In the book as** | what AutoCount answered with, **flagged when it differs from column 2** | `ac_doc_no` |
| 6 | Sends | `×N` when the document went more than once, blank at one; the cell IS the opener for the send history | the group length from `acGroupByDocument` |
| 7 | When | arrived, or last tried; the default sort, newest first | `sent_at ?? created_at` |
| 8 | (action) | Send now / Send again, only where the server says one is possible | `can_send_now` / `can_requeue` |

**Column 5 is why the table exists.** `HC-PO-2608-001` was written into
`AED_HOUZS` and the account book filed it under its own `PO-009968` — see §7g,
where supplying our own `DocNo` is described along with the fact that AutoCount's
series keeps running in parallel. Nobody saw it for three days, because no screen
held the ERP's number and the book's number up against each other. `acBookNumber`
now does, and gives four answers rather than two:

| verdict | when | how it reads |
|---|---|---|
| `same` | the book used the number on the paperwork — the normal case since §7g | the number, quiet |
| `different` | the book used a number of its own | the number in warning ink, plus a **Different number** flag, ON the row, unclicked; the whole sentence is the cell's `title` on desktop and printed on the card on mobile |
| `not-recorded` | `state` is `sent` and no `ac_doc_no` came back | a dash, with a note saying the book has it and we kept no number |
| `not-yet` | it is not in the book at all | a dash, and nothing else — the Status column has already said it |

The comparison is trimmed and case-folded. **A mismatch it misses is cheaper than
one it invents**: a flag that fires on a healthy row teaches everyone to ignore
the flag, and then the real one is invisible too.

**Deliberately NOT columns**, so the next reader does not "restore" one:

| dropped | why |
|---|---|
| Tries | reads as a dash on nearly every row. It is not lost — `acRowStatusLine` prints it INSIDE the problem row's reason block, where "Tried 3 times, will keep trying up to 6" is a sentence that says whether the queue is still working on it |
| the reason SENTENCE | a paragraph in a cell wrecks the row height for every row. The headline stays on the row when there IS a problem; the rest opens under it |
| raw `op` / `reason_kind` / `remedy` | column names and an SDK primitive. They stay in the API and out of the operator's table |
| Company | the endpoint is already scoped to the active company, so the column would be identical on every row |

**The rest of the shape:**

| | |
|---|---|
| **The rulings that did not move** | A problem row keeps its plain-language headline ON the row, unclicked — he rejected a design that hid it behind a click. The page still opens on Needs attention. A document already in the account book still has nothing to open, mismatch flag included: the flag is on the row, not behind a control the row does not have. Nothing the server wrote is in the page's own voice. |
| **Day separators** | *"Today · 21/08/2026"* / *"Yesterday · 20/08/2026"* / *"19/08/2026"*, from `acRegisterItems`, which returns ONE flat list of separators and documents. Flat because the register is windowed — a separator outside the virtualiser either scrolls away from its own day or forces the whole table back into the DOM. **The date is numeric and the approved mockup's *"21 Aug"* was not built**: a month abbreviation needs a twelve-name list, `check-duplicated-decisions` refuses a third home for one (`routes/finance.ts` and `routes/projects_print.ts` hold the other two), and neither is importable from the frontend. Off `fmtDate` instead, which is THE date format everywhere else in this app — so the separator, the *When* cell and every other date on screen are one rule with one implementation. |
| **The footer** | *"Showing 1–N of M documents"* (`acShowingLine`) and *"Sorted by When, newest first"*. A windowed list draws its scrollbar from estimates, so the scrollbar cannot honestly answer "am I looking at all of it"; this can. The existing partial-count caveat is unchanged and still shows when `counts_complete` is false. |
| **Two new lenses, both client-side** | a date range (All time / Today / Last 7 days / This month) beside the document chips, and the sort. Both narrow the LOADED page and neither re-asks the server, for the same reason `docType` does not: the route pages by recency and cannot answer "how many in August" without every other chip reading zero. **All time is the default** — a register that opened on This month would hide a document stuck since July from the one screen whose job is finding it. |
| **Sticky heading** | the column heading row lives INSIDE the same pinned block as the filter strips, at `var(--page-header-offset)`. Two sticky boxes at separately-derived offsets overlap the first time either changes height; one box cannot get out of step with itself. |
| **Column widths** | one `gridTemplateColumns` string (`AC_COLS`) shared by the heading and every row — two class names that agree today are two things to keep in step. The minimums total 998 px as of 2026-08-21, which keeps the register inside a 1280-wide laptop's content area with no sideways scrollbar. That total is a budget: widening one track means narrowing another, and *In the book as* is the widest fixed track because a clipped flag is a flag nobody trusts. |
| **Windowing is unchanged** | still `<MobileVirtualList>`, the component `DataTable` and eight mobile screens already use. |

**MOBILE KEEPS ITS CARDS** — eight columns do not fit 375 px, and a table that
scrolls sideways on a phone is a table nobody reads. That is a presentation
difference and it is allowed. What crossed over is everything that is a VERDICT
or a CONTROL, all from the shared layer: the mismatch flag (with the whole
sentence on the card, because a phone has no hover), the day separators, the date
range, the sort and the closing line. A flag the owner only gets at his desk is a
flag he does not get on the floor, which is where he uses this screen.

**`frontend/src/lib/autocountRegister.ts` is a SECOND FILE in the same shared
logic layer, not a second layer.** Everything in it is imported by both surfaces
and by nothing else. It is separate only because `autocountOutbox.ts` is 1,767
lines against this repo's 2,000-line cap, and the repo's own instruction at a
ceiling is a new module, never a bigger number (`scripts/file-size-ceilings.json`,
CLAUDE.md). Its pure exports are pinned by
`frontend/src/lib/autocountRegister.test.ts`.

**Measured in `frontend/perf-lab` (`?scenario=autocount-sync&rows=400`,
`&surface=mobile` for the phone), 2026-08-21, 400 rows, desktop at 1440x900 and
mobile at 375 px.** Each shape was measured under its OWN status filter, so the
row being measured is inside the mounted window whatever the sort is doing:

| | before | after |
|---|---|---|
| desktop, in AutoCount | 36.5 px | **37.0 px** |
| desktop, in AutoCount, **sent four times** | 62.8 px | **37.0 px** |
| desktop, in AutoCount, **different number** | 36.5 px, saying nothing | **37.0 px, flagged** |
| desktop, held back (collapsed) | 64.3 px | **64.8 px** |
| desktop, not accepted (collapsed) | 69.8 px | **64.8 px** |
| mobile 375 px, in AutoCount | 53.5 px | **53.5 px** |
| mobile 375 px, in AutoCount, different number | 53.5 px, saying nothing | **131.4 px, flagged** |
| mobile 375 px, held back (collapsed) | 83.8 px | **83.8 px** |
| mobile 375 px, not accepted (collapsed) | 88.5 px | **88.5 px** |

Read that table for what it says and not for a headline. **The quiet row did not
get shorter and was never going to** — it was already 36.5 px, which is one line
of text, and the 2026-08-16 pass is what bought that. What the register bought is
two different things: a document sent four times is now ONE line instead of two
(the *Sends* cell is its own history opener, so folding the audit trail no longer
costs a second row), and a misfiled document is now visible at all. The mobile
mismatch card is the only thing that grew, by 78 px, on rows that in production
should be rare — since §7g the ERP supplies its own number and the two agree.

> **THE LAB'S SENT ROWS CHANGED on 2026-08-21, and the before/after above was
> re-measured on both sides of the change.** The fixture had every arrived
> document coming back as `SO-000NN` — the pre-§7g shape, from when AutoCount
> auto-numbered — so the new flag fired on **every** sent row and the lab
> measured a page production does not have. Arrived rows now echo the ERP's own
> number, and ONE row carries the real mismatch (`HC-PO-2608-001` →
> `PO-009968`). One loud row in four hundred is the thing worth measuring; a flag
> that fires on all of them is wallpaper.

The lab scenario renders the REAL page with the queue stubbed at `fetch`, so
everything above the network is the real code and a height measured there is a
height the app produces. Re-measure with
`document.querySelectorAll("[data-ac-row]")[i].getBoundingClientRect().height`.

**Test hooks are contract, not styling.** `data-ac-row` (one document),
`data-ac-doc` (the cell holding the ERP number — needed because a healthy row
prints that number TWICE, here and in column 5, so "the element with this text"
stopped identifying a row), `data-ac-why` (the headline that is the opener),
`data-ac-book-flag` (the mismatch), `data-ac-day` (a separator), `data-ac-send`
(one earlier send), `data-ac-technical` (the collapsed disclosure).


### One taxonomy, three readers

The classification of a `skipped` row lives in
`backend/src/scm/lib/autocount-outbox-status.ts` — the states, the skip kinds
with their remedies (`AC_SKIP_KINDS`; read the array rather than a count typed
here, it has grown twice), `REQUEUE_NOTE_PREFIX`, and `MAX_ATTEMPTS`. The route
reads it, `backend/src/scm/lib/autocount-requeue.ts` re-exports the prefix from
it, and the health script reads its plain-node mirror
`backend/scripts/lib/autocount-skip-kinds.mjs`, because that script runs under
node against postgres.js and cannot import TypeScript. The mirror is refereed by
`backend/src/scm/lib/autocountOutboxStatus.canonical.test.ts`, which compares
values AND behaviour and fails on any drift.

**A STOPPED HOST IS ITS OWN KIND (2026-08-23).** When `AcSyncService` was not
running, the tunnel answered instead and the ERP stored Cloudflare's own body —
`error code: 502` — as the reason. `JSON.parse` fails on that string, so the raw
body became the message, and the page rendered it under the masters heading:
"masters not opened". Four documents were reported as an AutoCount MASTER-DATA
problem when the account book had never been asked anything.

`callAcService` now recognises a gateway status with a non-JSON body and says
"the AutoCount host did not answer (HTTP N) — the request never reached it",
and the taxonomy carries the kind so the page files it under the host rather
than under masters. **The remedy is a different building**: nothing about the
item map or the account book changes the answer while the service is stopped.

**Edit the TypeScript module, then the mirror.** A second opinion about what
`refused, nothing sent (MissingLocationError)` means is exactly how an operator
was once sent to backfill DtlKeys for an item-map problem (#2094).

**Turn it on or off** (on only after the write freeze lifts, and never before
someone has watched a single document land): Actions ->
**AutoCount write-back (on/off)** -> Run workflow
(`.github/workflows/set-autocount-writeback.yml`). It writes
`scm.app_config['scm.autocount_writeback']` for you. Takes effect within 30
seconds (the cache TTL). Queued rows stay `pending` while it is off and drain
when it is turned back on. **Do not hand the owner the SQL** — this workflow is
what replaced it (repo rule: never ask the owner to run a query).

**What to watch — the page above, or this check for a headless read.** Actions ->
**AutoCount write-back queue — health (read-only)** -> Run workflow. It reports
the queue by status, the FAILED rows in full (each one is a document that is in
the ERP and not in the account book), the age of the oldest pending row, and the
`skipped` backlog split by REASON. **The script prints the reason AND its
remedy — read `AC_SKIP_KINDS` in
`backend/src/scm/lib/autocount-outbox-status.ts` for the current set, do not
learn the taxonomy from here.** (It moved out of
`backend/scripts/check-autocount-outbox-health.mjs` on 2026-08-15 so the page and
the script could not disagree; that script now imports the mirror.) An
unrecognised reason is printed rather than counted away, and a skip that has
already been re-queued (below) is reported separately rather than counted as
backlog.

**IT RUNS EVERY DAY NOW, AND IT IS SILENT UNLESS SOMETHING IS STUCK**
(2026-08-24, docs/bugs/0534). The workflow was manual-only and its header refused
a cron in as many words; that paragraph is kept verbatim above the schedule
because it is the reason the schedule is shaped this way. Both its conditions
changed: the write-back went live, and on 2026-08-21 the shop-floor service
stopped answering — 13 documents piled up over two days and the owner found out
by noticing the account book was short.

`ALARM=1` (set only on the schedule) makes the run exit non-zero for exactly two
things: an OUTSTANDING failed row, and a pending row older than
`ALARM_PENDING_MINUTES` (default 60, twelve times the drain interval). Everything
else passes silently, so a quiet day sends no mail. The failure e-mail GitHub
sends is the alarm; the `::error::` line it quotes names the document and the
remedy. A `skipped` row deliberately does not alarm — it is a statement about the
document's shape, it does not change on its own, and firing daily forever on one
hand-keyed receipt is the noise the header refused.

**A failed row whose ERP document no longer exists is history, not backlog.** The
FAILED heading claims each row is "a document that is in the ERP and NOT in
AutoCount", and a go-live wipe makes that false without touching this table: the
export log is KEPT while the documents it names are deleted. Measured minutes
after a wipe on 2026-08-24: one such row, `HC-DO-2608-003`. It is printed under
its own heading and excluded from both the outstanding count and the alarm.

**AND IT IS COVERED BY A PARSE CHECK NOW** (docs/bugs/0535). An edit to this
script dropped one character and shipped; the daily run then failed on
`ReferenceError` while an operator waited on the report. `backend/tests/
opsScriptsParse.test.ts` runs `node --check` over every `scripts/*.mjs` —
these scripts are imported by nothing, so nothing else was looking at them.

**THE BOOK'S NAME FOR AN ITEM IS ITS OWN COLUMN NOW** (migration 0326,
docs/bugs/0539). `supplier_material_bindings.supplier_sku` was read by two
questions — the bold "Supplier Code" printed on the PO / GRN / PI, and the
ItemCode written into the account book — and the second reader was attached to
purchasing's column on 2026-08-11 (#2031).

`scripts/ac-item-code-census.mjs` measured the cost over all 3,076 bindings with
the real resolver: **1,874 IN BOOK, 1,063 WOULD OPEN** an item the book does not
hold, **139 REFUSED**, every refusal `ambiguous: … none belongs to supplier`.
The rule the working rows follow is exact — a value that IS an ItemCode the book
holds wins outright (`index.acCodes.has(bound)`), with no supplier comparison
and nothing opened. Hookka's 50 working bedframes carry `HOK-1019 (SK)`; the 139
refusals carry `1007-(K)`, which the book has never held.

`bindingsFor` now prefers `ac_item_code` and falls back to `supplier_sku` while
it is empty. **The fallback is not a shim to delete**: the column starts NULL on
every row, so removing it would stop resolving the 1,874 that land correctly
today. Seeding the column is a separate step with its own dry run.

**A TRANSFER SENDS NO ItemCode, AND IS NO LONGER REFUSED OVER ONE** (2026-08-25,
docs/bugs/0541). Owner: 「如果它是 by convert 的，那肯定是先跟 Sales Order 的 SKU
进行 convert … SKU 可能就不用看了」.

`AddSOToPOTransferDetail(Int64)` takes a source line KEY and nothing else —
AutoCount copies the sales line's own item into the purchase line — and
`composeSoToPo` already matched that: DtlKey, UnitPrice, Qty, Location,
DeliveryDate, every ItemCode discarded. But the enqueue composed a full CREATE
payload first, which resolves every line's ItemCode and throws `ItemCodeError`,
and only then threw the codes away. A purchase order that needs no item code was
being refused over one — and 139 bindings resolve to `ambiguous: … none belongs
to supplier`, so on a transfer every one of them blocked a document over a value
that would never be sent.

`ComposeOptions.forTransfer` stops that refusal on the transfer path and nowhere
else: **the create path is unchanged**, because there the ItemCode really is
sent and really does open or name an item in a licensed book. Two details are
load-bearing — `readPoEnqueueShape` is read BEFORE `composeDetails` (whether an
ItemCode matters is the shape's decision), and an unresolved line is KEPT rather
than dropped, because a short `Details` array misaligns the DtlKey zip and puts
a wrong quantity on a live purchase order.

**`GET /api/scm/autocount-outbox/host-log`** (2026-08-25, docs/bugs/0537) returns
the last N lines of AcSyncService's own log from the office machine —
`?lines=` (default 200, the host clamps it) and `?onlyErrors=1`. Same permission
keys as Send again, because the log carries document numbers, account codes and
the book's own refusals.

It exists because `Invalid transfer item.` names nothing, and the sentence that
settles such a failure — `target debtor before transfer = [...]` — is written by
the service into a file on that machine. The host has served that file over HTTP
since it was written; a grep on 2026-08-25 found the only file in this repo
naming `/last-errors` was the C# that serves it, and all four read-only host
routes were dead code from the ERP's side.

It goes through `callAcRead` (`services/autocount-host-read.ts`), NOT
`callAcService`: read routes are deliberately not `AcOp`s, and
`autocountHostRead.test.ts` pins the two vocabularies disjoint. Every `AcOp`
names something an outbox ROW can be — a document with a status, attempts and a
retry policy — and a log read is none of those.

**`GET /api/scm/autocount-outbox/book-doc`** (2026-08-26, docs/bugs/0550) is the
second of those four routes to be wired up: `?docType=SO|PO|DO|GR|IV|PI` and
`?docNo=`, returning the header, every line, and `missingColumns` — the wanted
columns the book does not have, passed through rather than dropped, because
*"AutoCount has no such field"* is itself the answer to several of the questions
this route exists for. Same permission keys again; it returns debtor codes,
prices and addresses out of a licensed account book.

**IT ANSWERS THE ONE QUESTION NOTHING ELSE HERE CAN.** Every other route reports
what the ERP SENT or what the host SAID BACK, and neither is evidence about the
book. `Set()` on the host swallows a refused assignment and still reports
success, so *sent* has never meant *landed* — #0549 is eight days of purchase
orders carrying no warehouse with the queue, the page and the log all green.
Owner 2026-08-26: 「我 edit 了之后，怎么没输入回去给 AutoCount 呢?」 — a question
about the book, which no reading of our own payload can answer.

`DetailWanted` is chosen for exactly these questions: `FromDocType` /
`FromDocNo` / `FromDocDtlKey` / `FullTransferFromDocList` on the downstream side
and `FromSODtlKey` / `FromSODocList` on a PO answer *is the convert-from link
there*; `Location` answers *which warehouse did this line really get*.

`BOOK_DOC_TYPES` lives in `autocount-host-read.ts` beside `AC_READ_ROUTE`, and
the test pins it against `AcSyncService.DocTypes` read out of the C# source with
`?raw` — so a type the host drops fails a test here rather than becoming a 400
for a document the book can read.

**A PENDING ANCESTOR IS SENT, NOT RE-QUEUED** (2026-08-26, docs/bugs/0542).
`sendAncestorsFirst` always went through `requeueOutboxRow`, which refuses a
pending row outright — `row-pending`, and rightly, since the sweep is already
going to take it. So on the shape the cascade meets most, a chain where every
document waits on the one above it, every ancestor came back `row-pending` and
nothing was sent: the button did exactly what the operator could see, nothing.
Owner: 「顺着点完…就没问题。但…直接去点 Sales Invoice…就不行」— pressing each row
by hand worked because that sends its own pending row directly, which is
precisely what the cascade omitted. Failed and skipped ancestors still take the
re-queue path.

**AN ANCESTOR IN THE BOOK CAN STILL BE THE WRONG VERSION OF ITSELF**
(2026-08-27, docs/bugs/0551). The walk used to stop at the first ancestor
carrying a `linked_ac_docno`, reasoning that presence propagates upward — which
it does: a document only reaches the book by way of its parent. **Freshness does
not.** A sales order edited after its delivery order was raised is in the book,
sits above a document that is also in the book, and is still not what the
operator is looking at; the conversion then carried the old lines into a live
account book with nothing reporting it. Owner: 「如果我 edit 了之后直接开 DO/SI，
然后我的 edit 还没进到 AutoCount，我点 send now，它也会把这个最新 version send
进去了…对吗?」

`ancestorsNeedingSend` replaces `ancestorsMissingFromBook` (deleted, not kept —
one question, one home) and walks to the TOP of the chain, classifying each
ancestor `missing` (not in the book) or `stale` (in the book, holding an unsent
edit). **"Stale" is an unsent edit, not a diff against the book**: the ERP
already queues an edit on every change, so an edit still in the queue IS the
statement that the book is behind — no second call to the host, no second opinion
about what "different" means. `pending` and `failed` both count; from the
operator's side both mean *AutoCount does not have my change*. The step carries
the EDIT's row id rather than the newest row, because a re-queued create is
newer and sending that would leave the change behind; `unsentEditFor` returns the
OLDEST unsent edit, since two edits are two changes in order. Order stays
outermost-first, which matters most when a `stale` ancestor sits above a
`missing` one — refreshing the order *after* transferring it would leave the
delivery carrying lines the order no longer has.

**AND THE PAGE NOW RENDERS IT** (2026-08-28, docs/bugs/0552). The server had
returned `ancestors_sent` since the cascade was written and a grep found no
reader in `frontend/src` at all: a press on an invoice could write a sales order
and a delivery order into a licensed account book on the operator's behalf and
report one line about the invoice. It lands on the pressed ROW under `Sent
first`, one line per document, worded once by `acAncestorLine` so the desktop
table and the mobile cards cannot drift — the same argument `AC_SEND_NOW_LABEL`
and `useAcRequeue` already make. The `reason` is carried through rather than
flattened, because *AutoCount did not have it yet* and *AutoCount had an older
version* are different things to be told. **Ancestors that FAILED are shown too**,
which is the point: the dangerous shape is a pressed row that succeeded above an
ancestor that did not, and reporting only the press reads as "all done". A throw
lists nothing — what was sent is unknown, and a list there would be an
invention.

**A PURCHASE ORDER WAITS FOR ITS SALES ORDER RATHER THAN BECOMING A CREATE**
(2026-08-26, docs/bugs/0543). `poTransferShape` decides transfer-or-create on
whether the sales-order lines carry an AutoCount DtlKey — and that key is
written back only when the sales order reaches the book. A purchase order raised
in the same minute sees NULL keys, so "the account book has no key for these
lines" was read as permanent. Measured: HC-PO-2608-007 from HC-SO-2608-008 went
as `create_po` at 16:55 on 2026-08-25 and the book holds no link between them;
the five before it transferred, because they were raised long enough afterwards.
A race, not a rule — and a create is the one answer that cannot be taken back.

A third shape, `wait`: keyless AND the source sales order is not in the book yet
→ queued as `so_to_po` with `fromDoc` on that sales order, which the drain
already holds until the parent has its number, and the keys are filled at drain
by `lib/autocount-so-to-po-keys.ts` — the same shape as the CreditorCode, DocNo
and DebtorCode backfills, and for the same reason. Keyless while the sales order
IS in the book stays a create; so does for-stock, and so does a purchase order
drawing on two sales orders, which has no single anchor to wait on. The backfill
is all-or-nothing: a partial set would send a purchase order that looks complete
and is short some lines.

**It also splits the queue by OPERATION, and that is a different question.**
*Added 2026-08-20 (#2417).* A status total says whether the QUEUE works; it says
nothing about whether an `edit` has ever changed a document in the account book,
and `edit` is the operation the ERP performs most once it is master. The check
groups `scm.autocount_outbox` by `op` as well, printing per operation the row
count, the `sent` / `failed` / `skipped` / `pending` split, the last `sent_at`,
and the newest `host_built_at` behind it — that column exists since migration
`0304`, and it is there because an operation whose last success ran under a host
build nobody runs any more has not been proven against the one that is running.

**An operation with NO row of any status is printed, as `NEVER ENQUEUED`.** That
is the load-bearing part: an operation the queue has never held is the strongest
form of "never proven", and a table that simply omits it reads like a clean bill
of health. The gap is not hypothetical — `docs/generated/autocount-coverage.md`
records that no `edit` has been demonstrated to CHANGE a document in the book,
while ERP call sites across the mfg route files enqueue it. The script carries its own list of the operations it expects
(`ALL_OPS` in `backend/scripts/check-autocount-outbox-health.mjs` — read it there,
not here), and any `op` present in the table but absent from that list is printed
too, so a newly added operation cannot be invisible to one of that table's two
readers.

An empty queue is reported as EMPTY, not as healthy: the table is append-only,
so zero rows means nothing was ever enqueued. **What that MEANS depends on the
switch**, and the script says which — it reads
`scm.app_config -> scm.autocount_writeback` and branches on it.

> **CORRECTED 2026-08-14.** Two claims here were stale. (1) This paragraph ended
> *"…which is the correct state while the toggle is off"* unconditionally. PR
> #2094 (`2b1cf249`) made the note depend on the flag the script had already
> read: *"It said empty was 'the correct state while scm.autocount_writeback is
> off' no matter what the flag said — correct until the flag was turned on,
> misleading after."* See `check-autocount-outbox-health.mjs:143-152`.
> (2) The `skipped`-reason list above named three remedies. `AC_SKIP_KINDS`
> carries **eight** entries covering four distinct refusal classes —
> `KeylessLineError`, `SofaCollapseError`, `ItemCodeError`, `MissingLocationError`
> — plus compose-failure, masters-not-opened, no-source-document and
> no-AutoCount-shape. Before #2094 the check matched on the shared prefix
> `refused, nothing sent`, so three of the four classes were reported as a
> DtlKey problem; an operator holding a `MissingLocationError` was sent to
> backfill line keys.
>
> **UPDATED 2026-08-15.** The stale "FOUR different classes" header comment this
> note used to point at went with the list when it moved into
> `backend/src/scm/lib/autocount-outbox-status.ts`. Each kind now also carries a
> stable `kind` key, which is what the page filters on, so a reworded message
> changes what the operator reads and not what a URL means.
>
> **UPDATED 2026-08-16 — and the "eight entries" above is now wrong too, which
> is the point.** Enumerating every reason a row can be `skipped` or `failed`
> for `docs/autocount-sync-reasons.md` found that the table did not cover the
> writers: `MissingAgentError`, `MissingSalesLocationError` and
> `MissingCreditorError` had no needle at all (the first of those is what the
> live book answered on go-live day, `FK_SO_SalesAgent`), the merged-conversion
> needle `AutoCount has no shape` was copied from a doc COMMENT and matched
> nothing any writer produces, and four more reasons — the DtlKey-subset
> refusal, cancel-before-send, edit-before-counterpart and the mislinked GRN —
> were never in it. All eight now are. **Do not type the new count here.** The
> open item recorded in `docs/autocount-sync-reasons.md` §5 is that these
> needles are strings typed twice, with nothing checking them against the code
> that writes them, which is precisely how the wrong one survived.

The cron also logs `[cron ac-writeback]` per sweep, and at ERROR level whenever
a row reaches `failed` — a failed row means a document
exists in the ERP and does not exist in AutoCount, which is the exact divergence
this mechanism exists to prevent.

```sql
SELECT status, count(*) FROM scm.autocount_outbox GROUP BY status;
SELECT doc_type, doc_no, op, attempts, last_error
  FROM scm.autocount_outbox WHERE status = 'failed' ORDER BY created_at DESC;
```

**Do not paste those into a console for the owner.** The repo rule is that a
production fact is a script plus a `workflow_dispatch` workflow, never a query
handed to a human. Actions -> **Cancel parity check (read-only)** answers the
question that matters — is the outstanding set the same on both sides, and did
the ERP ever ask for the cancels it made — and prints the outbox breakdown as
its section 5.

### Re-queueing a document the write-back refused

`backend/src/scm/lib/autocount-requeue.ts` +
`backend/scripts/requeue-autocount-skipped.mjs` + Actions -> **AutoCount
write-back — re-queue a refused document (DRY-RUN gated)**.

Every refusal above names a remedy — set the stock location, add the binding
that disambiguates the item code, backfill the line keys. Applying the remedy
used to change nothing, because a `skipped` row is terminal and no route path
re-attempts a create (§7). This is the "ask again".

**TWO WAYS IN, ONE LADDER.** Since 2026-08-16 the page's per-row button
(`POST /api/scm/autocount-outbox/:id/requeue`, §8) is the other caller. Both go
through `requeueOneRow`, so every safety property described in this section
holds identically for the button; the differences are only that the button
always applies, works one row at a time, and can be pointed at a `sent` or
`pending` row, which it refuses. Everything below is about the workflow, which
remains the only way to sweep a backlog or to get a DRY RUN.

| input | |
|---|---|
| `doc_no` | one ERP document (`HC-SO-2608-002`) |
| `doc_type` | `ALL` / `SO` / `PO` / `DO` / `GR` / `IV` / `PI` when no `doc_no` is given |
| `apply` | `1` writes. Anything else is a DRY RUN |
| `include_failed` | `1` also re-sends what AutoCount refused. REQUIRED for `DO` / `GR` / `IV` / `PI`: those four have no create, so their only re-sendable row is a `failed` transfer, and the script refuses the scope rather than reporting an empty sweep |

**A CREATE re-composes; it never resurrects.** The stored payload of a skipped
create is `{}` and, even when it is not, it is the PRE-FIX document — the whole
point is that the document changed. The tool calls the same `enqueueSoCreate` /
`enqueuePoCreate` the route calls. It runs under `tsx` and imports them from
`src/`, which is this repo's existing answer to "the logic is TypeScript and the
script is `.mjs`" (`recompute-2990-so-allocation.mjs` and three others do the
same, for the same stated reason). A second composer written in `.mjs` is the
one thing that could put a document into the live book that the real composer
would have refused.

**A TRANSFER is the exact opposite, and that is not an inconsistency.** It has no
create to compose, so its recorded payload IS the instruction — 0277's own rule
that the payload is a snapshot, never recomposed — and re-sending that snapshot
is what a retry means. It is also why re-sending one copies no route logic into
this module, which was the third of the three original objections to doing it at
all. The operator is told which of the two happened: the outcome code is
`requeued-as-recorded`, not `requeued`, and its sentence says a change made since
the refusal is not included.

**A HELD-BACK CONVERSION IS OFFERED TOO, AND ITS SEND RE-READS THE DOCUMENT**
(2026-08-24). Owner: 「我的 GR PO 所有文件都要有 Send Now 的 button」and 「点击
Send Now 的话，如果它之前上面的 documentation 没有进去，它就要补调进去」.

`acRowIsRequeueable` used to answer FAILED ONLY for a transfer, on the reasoning
that a `skipped` row never left the building so its refusal cannot be a service
refusal. True about the ROW, and the wrong question. `skipped` is what the CREATE
PATH concluded about the document, and for the commonest skip — "there is no
earlier document to carry across" — the create path was not looking at the lines
(§0524). Eight production documents (`HC-GRN-2608-002..005`,
`HC-PI-2608-002..005`) carried that sentence with a parent on every line, and no
button meant the wrong claim was permanent and invisible.

So a skipped transfer is offered, and `parentedAfterAll` re-resolves the parent
from the child's own lines through `reresolveConvertSource` — the SAME resolver
`POST /grns` and `POST /purchase-invoices` use, so there is one definition of
"has a parent" rather than a second one that can disagree with it. When it
answers, `enqueueConvert` composes a real conversion and the outcome is
`requeued-with-parent`, a third code because it is a third promise: not "we tried
again" but "this is going across AS a conversion of the document above it". When
it answers nothing, the old refusal stands — a document genuinely keyed in by
hand gets the same sentence it always did, which is more than a greyed-out row
ever told anyone.

Every duplicate guard the failed-row path applies is applied here in the same
order: a target carrying `linked_ac_docno` is refused, and a live row for the
same operation is refused. The ancestor cascade needed no change and now works
through this, because `sendAncestorsFirst` routes every missing ancestor through
`requeueOutboxRow` — so `PI -> GR -> PO` composes even when the GR's own row was
itself recorded parentless.

**The DRY RUN is not a prediction.** `captureWrites` hands the real enqueue the
real client for reads and a recorder for writes, so the dry run executes the
identical code path and simply does not let the row land. An insert of a
`pending` row means it would queue; an insert of a `skipped` row means
`noteReadFailure` refused it again and carries the reason AS IT STANDS NOW —
which is the useful part, because clearing one cause usually reveals the next
(§7m). APPLY probes first and only then writes, so a still-refused document
never grows the backlog by a duplicate `skipped` row.

**What is re-queueable, and the rest are reported, not hidden:**

| op | why |
|---|---|
| `create_so` / `create_po` | recoverable here and nowhere else, from either terminal state |
| `edit` | the document IS in AutoCount, so the documented remedy (fix, then save again) really does re-queue it. Re-composing it here would also silently drop any line `retire` entries the original save carried (§7a), which a `{}` payload cannot recall |
| `cancel` | either the document was withdrawn before it ever reached AutoCount, so there is nothing there to cancel, or the ERP holds the wrong AutoCount number for it (`grn-mislinked`) and a re-send would name the wrong document in a live book |
| a **`failed`** transfer | RE-QUEUEABLE since 2026-08-16. The ERP composed it, the queue sent it, and the SERVICE refused — a refusal that stops being true when the service is replaced, which a host rebuild does |
| a **`skipped`** transfer | still refused, and the shapes are properties of the DOCUMENT, which no rebuild touches: a parentless DO/GR/IV/PI can never exist in AutoCount (§7d), and a DtlKey-subset refusal is fixed by the line-key backfill and re-raising the document. A MERGED conversion was the third of these until 2026-08-18 and is now sent (§7); rows recorded before that date stay refused, because nothing was ever composed for them to re-send |

**THE DISCRIMINATOR IS RECORDED, not asserted.** Two facts the queue already
writes, which agree by construction and are BOTH required:

- `recordConvertSkipped` hard-codes `status: 'skipped'` and
  `payload: { body: {} }`, and it is the single writer behind all three
  unrecoverable shapes. Such a row never reached the drain, so the service has
  never seen the document and cannot be what refused it.
- Only `dispatchOne` writes `failed`, and only a `pending` row reaches it —
  which for a transfer op is only ever `enqueueConvert`'s success path.

Requiring both is what makes it safe against a path nobody has written: a
`failed` row with an empty payload has nothing to send, and a `skipped` row with
a real payload was still never dispatched. Nothing here is a human ticking a box.
The full argument, including why the host's `mvid` is NOT the gate (it answers
"was the service replaced", which is a different question, and no row records
it), is `docs/autocount-sync-reasons.md` §6.

**`sent` has no exception and the LADDER holds it**, not only its two callers —
`requeueOutboxRow` refuses a `sent` row before climbing and `requeueSkipped`'s
select cannot return one, so the rung inside `requeueOneRow` is unreachable from
both of today's entry points and is tested directly for exactly that reason.

**Idempotent, by three independent things.** A `skipped` row is written with
`dedupe_key: null` (`enqueueAcOp`) and 0277's unique index covers only
`status = 'pending' AND dedupe_key IS NOT NULL`, so a fresh enqueue never
collides with the skip it is replacing; the tool refuses to touch a document
that already has a non-skipped outbox row; and a re-queued skip is annotated, so
a second run recognises its own work. A document carrying `linked_ac_docno` is
never re-queued — `enqueueSoCreate` guards that itself, and the tool checks it
too so the report can say WHICH silent refusal an operator is looking at.

**The audit trail.** The old row keeps `status = 'skipped'` — 0277's CHECK
admits four statuses and each would be a lie here (it was never sent, never
failed, and `pending` would hand the drain a row with an empty body) — and its
`last_error` is prefixed `[re-queued <ISO> -> outbox <new row id>]` with the
original reason kept whole behind it. The health check reads that prefix and
reports those rows under RE-QUEUED instead of counting them as backlog.

### Sending a WAITING document NOW — the manual push

The owner asked for it by name: 「自动的 可是我要可以manual push」 — keep the
automatic sync, and let a person push. A `pending` row previously had no control
at all, and the only option was to wait up to five minutes for the sweep.

`POST /api/scm/autocount-outbox/:id/send-now` -> `sendOutboxRowNow`
(`scm/lib/autocount-requeue.ts`). Offered on the page where the server sets
`can_send_now` (`acRowCanSendNow`), on BOTH surfaces.

**It is not a wider `can_requeue`, and must not become one.** The two predicates
are disjoint by construction: *Send again* is only ever offered on a row that has
STOPPED, *Send now* only on one still WAITING. A re-queue INSERTs a fresh row —
which for a pending row would be a second create of one document, correctly
refused as `row-pending`. A send-now dispatches THE ROW THAT IS ALREADY THERE,
through the same `dispatchOne` the cron calls, with the same payload, masters,
write-back and attempt accounting. What is manual is the TIMING and nothing else.

| decision | answer, and why |
|---|---|
| does it spend an attempt? | **Yes, and it must.** An attempt is a real call on a licensed account book, and `attempts` is read by the page, the health check and the give-up rule as "times we asked AutoCount". A manual call that did not count would make all three untrue on a table whose own `COMMENT` calls it an audit trail. The cost is on screen before the press — the row already says *"Tried 3 times, will keep trying up to 6"*. |
| what stops a double send? | **`claimed_at`, migration 0315.** See below — this is the part that had to be built, not reused. |
| who may press it? | `scm.autocount.requeue` or `settings.manage` — the SAME keys as Send again, deliberately. Both do the one thing the key is about, and a second key would mean holding the right to send a refused document but not a waiting one. |
| does the answer reach the operator? | Yes, on the row that was pressed, through the same note path as Send again — accepted, refused, or never answered. `useAcRequeue` gained a `sendNow` that shares its busy flag, notes map and throw branch with `sendAgain`, so the two cannot drift. |

#### The claim, and the hole it closes

`drainAutoCountOutbox` SELECTs pending rows and calls `dispatchOne` on each.
Nothing between those steps marked a row in-flight: no lock, no lease, no
conditional update, and `mark()` carries no status predicate. That was safe for
one reason only — there was exactly ONE dispatcher and a single caller cannot
race itself. **A button is the second dispatcher**, and it spends that luck.

Migration 0315 adds `claimed_at`, and both dispatchers now take it:

- `claimOutboxRow` is a single `UPDATE … WHERE id AND status='pending' AND
  claimed_at IS NULL … RETURNING`. One statement, so it is atomic: a second
  claimant blocks on the row lock and, when let through, re-checks its predicate
  against the row as it now stands and matches nothing.
- The sweep claims every row before dispatching it and skips what it cannot take.
- `mark()` clears the claim on every outcome, which is why it lives there rather
  than at each of `dispatchOne`'s four returns.
- `releaseExpiredClaims` runs once per sweep. A Worker can be killed mid-send
  (`ctx.waitUntil` is not guaranteed to finish) and a claim that outlived its
  holder would strand the document — queued, visibly waiting, and dead. The lease
  is `AC_CLAIM_LEASE_MS`, deliberately longer than the cron period so a slow but
  LIVE send is never stolen from.

It is NOT a status. The row stays `pending` while claimed, because it is still
pending; 0277's CHECK admits four statuses and a fifth would be a lie to every
reader of the table.

### When a SENT document's counterpart has been cancelled by hand

Nothing above covers this, and 2026-08-17 proved it. `HC-PO-2608-001` landed in
the book as `PO-009968` (the transfer arm sent no `DocNo` — D5, §7c3b), a human
then cancelled `PO-009968` in `AED_HOUZS`, and the ERP could not re-send the
order through ANY path:

| path | why not |
|---|---|
| `enqueuePoCreate` | `if (header.linked_ac_docno) return false;` — the column still named the cancelled document |
| an ERP-side save | `enqueueEdit` returns false for a document with no `linked_ac_docno`, so CLEARING the column does not make a save re-send it either |
| `requeueSkipped` / the per-row button | the row is `sent`, and both refuse that — correctly |
| `PATCH /:id/confirm` | short-circuits on an already-`SUBMITTED` PO before it reaches the enqueue |

Those four guards are right and stay. What was missing is a way to express the
one case where a re-send IS correct, and it needs a HUMAN fact the ERP cannot
see: the counterpart is cancelled. `backend/scripts/reraise-hc-po-2608-001.mjs`
+ Actions -> **Re-raise HC-PO-2608-001 into AutoCount (PLAN by default)** is that
tool, and it is deliberately scoped to ONE document by constant rather than
generalised — clearing `linked_ac_docno` on a document that IS in the book makes
the next drain write a duplicate into a licensed system, so the blast radius of
a mistake is the whole reason the scope is a constant and not a parameter.

Two properties worth copying if this ever has to be done again:

- **It clears AND queues.** Clearing alone leaves the document unlinked and
  unqueued, which is worse than the state it started in: the ERP then believes
  the order is not in AutoCount and nothing will ever send it.
- **The verification asserts the DEFECT.** It re-reads on a fresh connection and
  requires `payload->'body'->>'DocNo'` on the queued row to equal the ERP's
  number. That field's absence is what produced `PO-009968`, so its presence is
  the only pre-drain evidence the fix carried. Where the document actually LANDS
  is still not knowable from the ERP — a `sent` row means AutoCount answered.

### The cancel-parity check — the owner's rule 3, made testable

`backend/scripts/check-cancel-parity.mjs` + `.github/workflows/cancel-parity-check.yml`.

His rule: a cancel applied on one side only splits the outstanding set, and the
acceptance test is that his own rule — NOT converted to DO and NOT to IV,
cancelled excluded — computes IDENTICALLY on both sides. The check computes it on
both and prints every document outstanding on ONE side only, sorted by cause: the
ERP cancelled it and AutoCount still holds it open; AutoCount cancelled it and the
ERP still holds it open; a conversion that was not mirrored; a document that
exists on one side only. It then asks the outbox whether the ERP ever ASKED for
each cancel it made, because "the ask failed" and "there was no ask" are
different faults with different fixes.

On the AutoCount side the rule is one predicate, not two: `SODTL.TransferedQty`
counts a transfer to a Delivery Order and a direct transfer to an Invoice alike,
so it is `Cancelled='F' AND EXISTS (a line with Qty - TransferedQty > 0)`.

The AutoCount half is a committed snapshot
(`backend/scripts/data/ac-cancel-parity.json.gz`) because no one machine can
reach both systems — the account book is behind ZeroTier, production Postgres is
reachable only from a runner. Refresh it on the shop's network first:

```
AC_CRED_FILE=<cred file> python backend/scripts/export-ac-cancel-parity.py
```

The check prints the snapshot's age and marks it STALE past
`AC_SNAPSHOT_MAX_AGE_DAYS`, so a disagreement caused by the days in between can
never be mistaken for a cancel divergence.

---

## 10. Tests

| File | Covers |
|---|---|
| `src/scm/lib/downstream-lock.test.ts` | The owner's rule: one live child locks; a cancelled child does not; another document's children do not |
| `src/scm/lib/autocount-outbox.test.ts` | The toggle (off / absent / per-company / `all`), each of the six flows, cancel-and-edit against a still-queued create, the drain's sent / retry / give-up / refusal / waiting paths, the salesperson fallback of §7n end to end (including that `/ensure-masters` is then asked to open that agent), and — over a fake PostgREST that answers 42703 for a column the table does not have — that a failed read is never composed into an empty document. Also **§7o end to end**, which is where it has to be tested: most of that defect was in the SELECT LIST, and a column list is only exercised by a read. Per field: the value reaches the payload, `mastersOf` is asked to open the master it names, and an edit does not blank what the book holds. **§7q the same way** — the BALANCE off the payments ledger and NOT off the `balance_sen` the fixture deliberately seeds to the gross total, the legacy-deposit rule both ways, `"0.00"` on a settled order, no key at all when the order has no total, `DeliverPhone1` off `emergency_contact_phone` while `Phone` keeps the customer's, and the line delivery date present-and-null on a create against omitted-when-absent on an edit |
| `src/scm/lib/autocount-requeue.test.ts` | Re-queueing a refusal: a document whose cause is unfixed stays refused (and APPLY adds no second `skipped` row), a fixed one queues a FRESHLY COMPOSED create carrying the location the operator just set, one already in AutoCount is never re-queued, and running twice does not double-queue — with 0277's pending-dedupe index enforced by the fake so the backstop is proved and not asserted. **And the by-id path**: a `sent` row is refused with nothing written, refused BEFORE the document is read (so a deleted order cannot change the answer) and refused with the switch off too; another company's row answers `row-not-found` while the same row in the caller's own company goes through; a `failed` row's replacement starts at zero attempts while the dead row keeps its six. **And the transfer path**: a `failed` conversion is queued again with the recorded payload byte for byte (same `DtlKeys`, same parent, same dedupe key) and the old row annotated; each of the three unrecoverable shapes — parentless, merged, DtlKey subset — is refused through BOTH entry points, on the row's status and not on its wording; a `skipped` transfer carrying a real payload is still refused, and a `failed` one with an empty payload is too; and `already-sent` is asserted against the LADDER for all seven ops, which is the only way to reach that rung |
| `tests/autocountSyncReasonsCatalogue.test.ts` | `docs/autocount-sync-reasons.md` against the code, both directions — every re-queue outcome and every skip kind has a row, and the file describes no outcome the code can no longer return. Also that the `Invalid transfer item.` entry sends the reader to rebuild the AutoCount service rather than to press the button again |
| `src/scm/shared/so-outstanding.test.ts` | **§7q.** The outstanding-balance rule the SO detail page and the BALANCE UDF now share: the ledger is the paid amount, a legacy header deposit counts once and only when the ledger has no `is_deposit` row, and an overpayment is 0 rather than negative |
| `src/scm/lib/so-agent.test.ts` | What lands in `mfg_sales_orders.agent` (§7n): a create with a salesperson stamps the NAME, an explicit `body.agent` still wins, a blank one is not a supplied one, and a dead `scm.staff` lookup costs the agent text and never the save |
| `src/services/autocount-writeback.test.ts` | The master maps, sen -> decimal, Desc2 from variants, sofa parent collapse, `DtlKey` addressing, the client's retryable/not-retryable read of a response, and the agent resolution of §7n including the both-empty refusal and the UUID / "Unassigned" text that must never be opened. Plus §7o's composer half: `bookSpelling` vs `bookSpellingOrOwn`, the address packing, the customer-reference chain, branding off the lines with no `BEDFRAME` pseudo-brand, the sales-location fallback, and the two new refusals (`MissingSalesLocationError`, `MissingCreditorError`) |
| `src/services/autocount-sofa-collapse.test.ts` | **D9**, driven by 658 real `Desc2` values out of the licensed book (`autocount-sofa-corpus.ts`, generated, CI-guarded). Echo is character-for-character on all 551 decodable builds; parse -> collapse -> parse is stable; the composer is *known* to spell some real builds wrong and **none escape the gate**; every refusal path emits no line at all |
| `src/services/autocount-item-code.test.ts` | **D10**, driven by the real 1561-row cutover map. No corpus line resolves to the WRONG item; a collapsed code refuses without a supplier and resolves with one; an unmapped line throws rather than falling back to `material_code`; one bad line refuses the whole document |
| `tests/acMasterMatcher.test.mjs` | **§7p.** The master-data matcher, on the real book vocabularies out of `scripts/data/`: all eleven warehouse codes the book already holds land as CONFIDENT with the right short code, `CHINA WAREHOUSE` as NO MATCH, `AEON BIG PUCHONG` never confident against the three `AEON BIG` venues it is not, `KL DISPLAY` kept off `KL`, and every differently-spelled `agent_map` pair a human already confirmed reproduced as a PROPOSAL |
| `tests/acMasterMaps.test.ts` | **§7p.** Every pair the four maps carried at HEAD on 2026-08-14, pinned — the proof that generating them changed nothing, and the ratchet that lets a binding be added but never silently removed or re-pointed. Plus that every key is in the shape `bookSpelling` looks up |
| `tests/autocountWritebackWiring.test.ts` | That every hook is still attached to its route |
| `tests/soAgentStampWiring.test.ts` | That no SO write puts `body.agent` into the column raw — every stamp site is the resolved value, and a reassigned salesperson carries the agent with it |
| `tests/autocountWritebackCells.test.ts` | That the ERP can reach EVERY document type `AcSyncService` handles — the expected set is read out of the C# `switch` rather than hand-listed — plus the DO/GRN/SI/PI edit hooks, the SO/PO paths the anchor test missed (price override, both amendment applies, `bulk-supplier-date`, `convert-from-so`, the SI partial transfer), the SO->PO create hole, the four parentless-create records, and that no route expresses an edit as cancel-then-create |

The corpus fixture carries **input only** — no expected pieces, no expected
output. The tests run the real decoder and the real collapse over the real text,
so the fixture cannot encode a bug as an expectation.

---

## See also

- `docs/autocount-field-alignment-audit.md` — every field, traced ERP column ->
  composer -> master opened? -> C# assignment, with the BROKEN and AT RISK list
  and the numbers behind each. Read it before adding a field to a payload
- `docs/autocount-cutover-ledger.md` — the one-time import that came the other way
- `backend/scripts/autocount-service/AcSyncService.cs` — the AutoCount half
- `backend/scripts/autocount-service/sdk-api-reference.txt` — the reflected SDK surface
- `docs/modules/sales-order.md`, `docs/modules/purchase-order.md`
