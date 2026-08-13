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
| AutoCount | `backend/scripts/autocount-service/AcSyncService.cs` | A .NET 4 HTTP service running ON the AutoCount host, driving the licensed 2.2 SDK. NINE POST routes (`/create-so`, `/create-po`, `/so-to-do`, `/po-to-gr`, `/do-to-iv`, `/gr-to-pi`, `/cancel`, `/edit`, `/ensure-masters`) plus `GET /health`. Reflected SDK surface in `sdk-api-reference.txt` — there is no published reference. |
| ERP | `backend/src/scm/lib/autocount-outbox.ts` + `backend/src/services/autocount-writeback.ts` | An outbox: routes enqueue, a cron drains, the returned AutoCount document number is recorded back onto the ERP row. |

AcSyncService's routes, and the outbox `op` that targets each:

| Route | `op` | ERP flow |
|---|---|---|
| `/create-so` | `create_so` | SO create |
| `/create-po` | `create_po` | PO create |
| `/so-to-do` | `so_to_do` | SO -> Delivery Order |
| `/po-to-gr` | `po_to_gr` | PO -> Goods Receipt |
| `/do-to-iv` | `do_to_iv` | DO -> Sales Invoice |
| `/gr-to-pi` | `gr_to_pi` | GRN -> Purchase Invoice |
| `/cancel` | `cancel` | cancel — all six types (SO, PO, DO, GR, IV, PI) |
| `/edit` | `edit` | edit — all six types: header, lines, variant/SKU changes |
| `/ensure-masters` | **none** | opens the items and salespeople a document names, BEFORE it is sent. It is called INLINE by the drain (`autocount-outbox.ts:1767-1780`), never queued — 0277's `op` CHECK admits only the eight ops above |

There is deliberately **no create route for DO / GRN / Invoice / Purchase
Invoice**, and there cannot sensibly be one. The 2.2 SDK's only construction
primitive for those four is `AddPartialTransferDetail(fromDocType, dtlKeys)` —
you build one by transferring a SOURCE document's lines — so a parentless one
cannot be expressed at all. The ERP CAN create all four parentless (a manual
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
| PO edit | `mfg-purchase-orders.ts` | `queueAcPoEdit` from the header PATCH, line add/edit/delete, `bulk-supplier-date` (per PO that moved), `convert-from-so`, and `po-amendments.ts` approve |
| DO edit | `delivery-orders-mfg.ts` | `queueAcDoEdit` from the header PATCH and line add/edit/delete |
| GRN edit | `grns.ts` | `queueAcGrnEdit` from the header PATCH and line add/edit/delete |
| SI edit | `sales-invoices.ts` | `queueAcSiEdit` from the header PATCH, line add/edit/delete, and `POST /:id/items/from-do/:doId` (the partial transfer) |
| PI edit | `purchase-invoices.ts` | `queueAcPiEdit` from the header PATCH and line add/edit/delete |
| PO create (from SOs) | `mfg-purchase-orders.ts` | `convertSosToPosCore`, per bucket, when the inserted status is not DRAFT — this is what `POST /from-sos` and the MRP agent both ride |
| DO / GRN / SI / PI created parentless | the four routers' `POST /` | `recordParentlessCreate` — a `skipped` row, because AutoCount has no create for these |
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

### Two cases that need care

**Create then edit before the drain runs.** `enqueueEdit` first looks for a
still-PENDING create for the same document and REPLACES its payload. Queueing an
edit behind a stale create would push the pre-edit order into the live book and
then correct it, which is visible to whoever is looking at AutoCount.

**Cancel before the drain runs.** `enqueueCancel` marks the pending create
`skipped` and queues nothing. Creating a document in a live account book only to
cancel it is not a no-op to the people using that book.

### What each side is composed FROM

| Payload field | ERP source |
|---|---|
| SO header | `scm.mfg_sales_orders` — `debtor_name`, `agent`, `sales_location`, `ref`, `phone`, `address1-4`, and `branding` / `venue` / `po_doc_no` into UDF |
| SO lines | `scm.mfg_sales_order_items`, including `linked_ac_dtlkey` (migration 0273) — the AutoCount line an edit addresses |
| PO header | `scm.purchase_orders` — `po_number`, `po_date`, `notes`. **The creditor is a JOIN**: the table is supplier-keyed, so `CreditorCode` / `CreditorName` come from `scm.suppliers.code` / `.name` through `supplier_id`. It has no `agent` and no `ref` at all, so a create sends null for both and an edit omits `Ref` entirely rather than blanking AutoCount's |
| PO lines | `scm.purchase_order_items`, same `linked_ac_dtlkey` |

Every column these reads name is listed once at the top of
`scm/lib/autocount-outbox.ts`. That is deliberate: PostgREST does not ignore a
column a table does not have, it fails the whole query with **42703**, so a
phantom column silences an entire flow (see `BUG-HISTORY.md`, 2026-08-10).

---

## 7. What the ERP can express and AutoCount cannot

The SDK's only transfer primitive is
`AddPartialTransferDetail(fromDocType, fromDocKeys)` — **ONE source document**.
The ERP can merge several SOs into one DO, batch several POs into one GRN, and
so on. Those have no AutoCount shape.

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

### Known limitation — adding a line to a document AutoCount already has

A genuinely new line on an existing AutoCount document is refused too, because
the ERP cannot yet tell it apart from a legacy line whose key was never stored.

`AcSyncService` accepts an explicit `IsNewLine: true` marker on a line for
exactly this case. **The SO side now sets it; the PO side does not.** The SO
line-add routes pass the rows they just inserted as `newLineIds`
(`mfg-sales-orders.ts:266-284`, `:8157`, `:8208`), and `composeEdit`
(`autocount-writeback.ts:696-710`) marks a keyless line `IsNewLine` ONLY when
every keyless line on the document is one of those declared-new rows — the
positive evidence the guess would otherwise lack. The PO routes pass nothing, so
a genuinely new PO line is still refused. Setting `IsNewLine` on a guess re-opens
the duplicate-append defect one line at a time.

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

**Still open, and NOT fixed by this: partial QUANTITY on a line.**
`AddPartialTransferDetail(fromDocType, dtlKeys, bool)` takes line keys, not
quantities, so a DO shipping 2 of a 5-unit line still produces an AutoCount DO of
5 on that line. Naming the right lines does not fix the wrong number on them. The
shape of a fix exists — the conversion captures the new document's own `DtlKey`s
via `lineWriteback`, so a follow-up `/edit` could set each quantity — but it needs
a DEFERRED compose (the keys do not exist until the convert has drained), which
`enqueueEdit` cannot express today.

## 7d. The four documents AutoCount cannot create at all

A DO, GRN, Sales Invoice or Purchase Invoice raised with **no parent** can never
exist in the account book: `AddPartialTransferDetail` is the SDK's only
construction primitive for these four, so there is no create route to add and
none could be added. `recordParentlessCreate` writes a visible `skipped` row for
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
| `Agent` | `mfg_sales_orders.agent` through `AGENT_MAP` | header |
| `SalesLocation` | `sales_location` through `LOCATION_MAP` | header |
| `DocDate` | `so_date` | header |
| `BRANDING` / `VENUE` / `ToPONo` | `branding` / `venue` / `po_doc_no` | **nested `UDF` object** |

`UDF` is nested because that is the only place the service reads it
(`ApplyUdf` -> `Dict(h, "UDF")`); a flat `SOUDF_*` key at header level is
silently ignored.

**A field the ERP does not have is OMITTED, never sent as null.** The service's
header loop is `ContainsKey`-gated and `Str` turns a present-but-null into `""`,
so `{Agent: null}` does not mean "unchanged" — it means "blank the salesperson
the account book has". Same rule as the line-level Location, one level up.

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

**If the masters cannot be opened, the document is NOT sent.** A row that
half-populated a live account book is worse than a row that waited.

The service side is idempotent by construction — each master is looked up and
created only when the lookup comes back empty — and it is deliberately narrow:

| | |
|---|---|
| It never EDITS an existing master | An item's costing method or a debtor's credit limit is Finance's, not the sync's. Existing masters are reported as `existed` and left alone |
| It DOES create a LOCATION | Owner 2026-08-11: open everything. Created EMPTY — a code and a description. Everything a warehouse really needs (addresses, payment accounts, defaults) stays for a human |
| The ERP never ASKS for a DEBTOR | `EnsureMasters` HAS a Debtors branch (`AcSyncService.cs:574-592`) and would open one if sent; the narrowing is the ERP's — `mastersOf` emits no `Debtors` array (`autocount-outbox.ts:1496-1499`, `:1576-1583`). Houzs writes every order against ONE fixed AutoCount debtor and overwrites the name field. Opening an AR account per customer would invent accounting nobody asked for |
| It DOES create a CREDITOR | Opposite reason: a purchase order names a real supplier, `CreatePo` applies `CreditorCode` unconditionally, and a supplier the book does not have fails the same foreign key a missing item does |
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
| 1 | `FK_SO_SalesAgent` | SO header `Agent` | `ensure-masters` → `Agents` | 2026-08-11 |
| 2 | `FK_SODTL_Location` | SO **line** `Location` | `ensure-masters` → `Locations` | 2026-08-11 |
| 3 | `FK_Item_ItemGroup` | a NEW item being opened | `ensure-masters` → `Items[].ItemGroup` | 2026-08-12 |
| 4 | `FK_PO_PurchaseAgent` | PO header `Agent` | `ensure-masters` → **`PurchaseAgents`** | 2026-08-12 |

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

**Turn it on or off** (on only after the write freeze lifts, and never before
someone has watched a single document land): Actions ->
**AutoCount write-back (on/off)** -> Run workflow
(`.github/workflows/set-autocount-writeback.yml`). It writes
`scm.app_config['scm.autocount_writeback']` for you. Takes effect within 30
seconds (the cache TTL). Queued rows stay `pending` while it is off and drain
when it is turned back on. **Do not hand the owner the SQL** — this workflow is
what replaced it (repo rule: never ask the owner to run a query).

**What to watch — run the check, do not read the tail.** Actions ->
**AutoCount write-back queue — health (read-only)** -> Run workflow. It reports
the queue by status, the FAILED rows in full (each one is a document that is in
the ERP and not in the account book), the age of the oldest pending row, and the
`skipped` backlog split by REASON — a refusal needs a line-key backfill, a
merged conversion needs a human, a parentless document can never exist in
AutoCount at all. An unrecognised reason is printed rather than counted away,
and a skip that has already been re-queued (below) is reported separately rather
than counted as backlog.

An empty queue is reported as EMPTY, not as healthy: the table is append-only,
so zero rows means nothing was ever enqueued, which is the correct state while
the toggle is off.

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

| input | |
|---|---|
| `doc_no` | one ERP document (`HC-SO-2608-002`) |
| `doc_type` | `ALL` / `SO` / `PO` when no `doc_no` is given |
| `apply` | `1` writes. Anything else is a DRY RUN |

**It re-composes; it never resurrects.** The stored payload of a refusal is `{}`
and, even when it is not, it is the PRE-FIX document — the whole point is that
the document changed. The tool calls the same `enqueueSoCreate` /
`enqueuePoCreate` the route calls. It runs under `tsx` and imports them from
`src/`, which is this repo's existing answer to "the logic is TypeScript and the
script is `.mjs`" (`recompute-2990-so-allocation.mjs` and three others do the
same, for the same stated reason). A second composer written in `.mjs` is the
one thing that could put a document into the live book that the real composer
would have refused.

**The DRY RUN is not a prediction.** `captureWrites` hands the real enqueue the
real client for reads and a recorder for writes, so the dry run executes the
identical code path and simply does not let the row land. An insert of a
`pending` row means it would queue; an insert of a `skipped` row means
`noteReadFailure` refused it again and carries the reason AS IT STANDS NOW —
which is the useful part, because clearing one cause usually reveals the next
(§7m). APPLY probes first and only then writes, so a still-refused document
never grows the backlog by a duplicate `skipped` row.

**Only the two CREATES are re-queueable, and the rest are reported, not hidden:**

| op | why |
|---|---|
| `create_so` / `create_po` | recoverable here and nowhere else |
| `edit` | the document IS in AutoCount, so the documented remedy (fix, then save again) really does re-queue it. Re-composing it here would also silently drop any line `retire` entries the original save carried (§7a), which a `{}` payload cannot recall |
| conversions | a parentless DO/GR/IV/PI can never exist in AutoCount (§7d), a merged conversion has no shape (§7), and re-expressing a DtlKey-subset refusal would mean copying `enqueueConvert`'s call-site into a script |

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
| `src/scm/lib/autocount-outbox.test.ts` | The toggle (off / absent / per-company / `all`), each of the six flows, cancel-and-edit against a still-queued create, the drain's sent / retry / give-up / refusal / waiting paths, and — over a fake PostgREST that answers 42703 for a column the table does not have — that a failed read is never composed into an empty document |
| `src/scm/lib/autocount-requeue.test.ts` | Re-queueing a refusal: a document whose cause is unfixed stays refused (and APPLY adds no second `skipped` row), a fixed one queues a FRESHLY COMPOSED create carrying the location the operator just set, one already in AutoCount is never re-queued, and running twice does not double-queue — with 0277's pending-dedupe index enforced by the fake so the backstop is proved and not asserted |
| `src/services/autocount-writeback.test.ts` | The master maps, sen -> decimal, Desc2 from variants, sofa parent collapse, `DtlKey` addressing, and the client's retryable/not-retryable read of a response |
| `src/services/autocount-sofa-collapse.test.ts` | **D9**, driven by 658 real `Desc2` values out of the licensed book (`autocount-sofa-corpus.ts`, generated, CI-guarded). Echo is character-for-character on all 551 decodable builds; parse -> collapse -> parse is stable; the composer is *known* to spell some real builds wrong and **none escape the gate**; every refusal path emits no line at all |
| `src/services/autocount-item-code.test.ts` | **D10**, driven by the real 1561-row cutover map. No corpus line resolves to the WRONG item; a collapsed code refuses without a supplier and resolves with one; an unmapped line throws rather than falling back to `material_code`; one bad line refuses the whole document |
| `tests/autocountWritebackWiring.test.ts` | That every hook is still attached to its route |
| `tests/autocountWritebackCells.test.ts` | That the ERP can reach EVERY document type `AcSyncService` handles — the expected set is read out of the C# `switch` rather than hand-listed — plus the DO/GRN/SI/PI edit hooks, the SO/PO paths the anchor test missed (price override, both amendment applies, `bulk-supplier-date`, `convert-from-so`, the SI partial transfer), the SO->PO create hole, the four parentless-create records, and that no route expresses an edit as cancel-then-create |

The corpus fixture carries **input only** — no expected pieces, no expected
output. The tests run the real decoder and the real collapse over the real text,
so the fixture cannot encode a bug as an expectation.

---

## See also

- `docs/autocount-cutover-ledger.md` — the one-time import that came the other way
- `backend/scripts/autocount-service/AcSyncService.cs` — the AutoCount half
- `backend/scripts/autocount-service/sdk-api-reference.txt` — the reflected SDK surface
- `docs/modules/sales-order.md`, `docs/modules/purchase-order.md`
