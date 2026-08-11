# Module: ERP -> AutoCount write-back (SCM)

After go-live the ERP is master and every document it creates must appear in
AutoCount. This is the ERP half. The AutoCount half already exists and was
proven against the live `AED_HOUZS` book on 2026-08-07.

> **It ships OFF.** `scm.app_config` key `scm.autocount_writeback` is seeded
> `'off'` by migration 0277, and `AC_SYNC_URL` is unset. With either of those
> two, nothing is queued and nothing is sent.

The one-time IMPORT that came the other way (AutoCount -> ERP) is a different
thing entirely and is recorded in `docs/autocount-cutover-ledger.md`.

---

## 1. The two halves

| Half | Where | What it is |
|---|---|---|
| AutoCount | `backend/scripts/autocount-service/AcSyncService.cs` | A .NET 4 HTTP service running ON the AutoCount host, driving the licensed 2.2 SDK. Eight POST routes. Reflected SDK surface in `sdk-api-reference.txt` — there is no published reference. |
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
| `/ensure-masters` | `ensure_masters` | opens the items and salespeople a document names, BEFORE it is sent |

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
| SO create | `scm/routes/mfg-sales-orders.ts` | after `recordSoAudit(... 'CREATE')`, before `c.json({ docNo }, 201)` |
| PO create | `scm/routes/mfg-purchase-orders.ts` | after `recordPoCreate(...)` |
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
`scm.purchase_order_items.linked_ac_dtlkey` (migration 0273).

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
`skipped` outbox row whose `last_error` starts `refused, nothing sent:` and names
the offending line. Nothing is POSTed.

```sql
SELECT doc_type, doc_no, last_error, created_at
  FROM scm.autocount_outbox
 WHERE status = 'skipped' AND last_error LIKE 'refused, nothing sent:%'
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
exactly this case, and **nothing in the ERP sets it**. Before anything does, the
ERP needs positive evidence that a keyless line is new rather than unbackfilled —
the honest signal is a document whose every other line is keyed AND whose backfill
is known to have covered it completely. Setting `IsNewLine` on a guess re-opens
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
order, and **both refuse the WHOLE document rather than send part of it.**

### D10 — `material_code` is not `ItemCode`

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
| It never creates a LOCATION | A new warehouse is a business decision with stock consequences. A create naming an unknown one is refused on the ERP side instead (`MissingLocationError`, section 7b) |
| It never creates a DEBTOR per customer | Houzs writes every order against ONE fixed AutoCount debtor and overwrites the name field. Opening an AR account per customer would invent accounting nobody asked for |

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

## 8. Configuration

| Name | Kind | Notes |
|---|---|---|
| `AC_SYNC_URL` | `[vars]` in `wrangler.toml` | Base URL of AcSyncService. **Config, not a secret** — a hostname and a port. Absent = the drain is a no-op and says `ac_service_not_configured` |
| `AC_SYNC_KEY` | **wrangler secret** | The service's `X-API-KEY`. `wrangler secret put AC_SYNC_KEY`, never in `wrangler.toml` |
| `scm.app_config` / `scm.autocount_writeback` | DB row | The runtime toggle (§4) |

The AutoCount service reads its own key from `C:\Temp\ac-svc-key.txt` on the
host and its SQL connection string is injected at build time, so no credential
lives in this repository.

---

## 9. Operating it

**Turn it on** (after the write freeze lifts, and never before someone has
watched a single document land):

```sql
UPDATE scm.app_config SET value = '1', updated_at = now()
 WHERE key = 'scm.autocount_writeback';
```

**Turn it off** — set `value = 'off'`. Takes effect within 30 seconds (the cache
TTL). Queued rows stay `pending` and drain when it is turned back on.

**What to watch.** The cron logs `[cron ac-writeback]` per sweep, and logs at
ERROR level whenever a row reaches `failed` — a failed row means a document
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
