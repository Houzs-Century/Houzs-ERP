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
| `/cancel` | `cancel` | SO / PO cancel |
| `/edit` | `edit` | header, lines, and variant/SKU changes |

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
| SO edit | `mfg-sales-orders.ts` | `queueAcSoEdit` from the header PATCH, line add/edit/delete, and `tbc-update` / `tbc-swap` / `tbc-swap-sofa` |
| PO edit | `mfg-purchase-orders.ts` | `queueAcPoEdit` from the header PATCH and line add/edit/delete |

A **variant or SKU change IS a line change** — AutoCount takes it as `Desc2` +
`ItemCode` on the same `DtlKey` — so the `tbc-*` routes need no operation of
their own. Those three run inside `runScmPgCommand`, so their enqueue sits
OUTSIDE the transaction and fires only on a 2xx.

`tests/autocountWritebackWiring.test.ts` pins every one of these anchors so a
refactor cannot silently unhook the queue.

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

**Nothing in the ERP sends `Retire` yet** — it needs a soft-cancel flag on the
ERP line first. `scm.mfg_sales_order_items.cancelled` exists and is read in ~85
places, but no code ever sets it and production has zero such rows; the line
delete routes still hard-delete. See
`docs/autocount-line-retirement-plan.md` for what has to change before that flag
can be turned into a retirement, and why doing it halfway is worse than the hard
delete it replaces.

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
   onto every compartment row. If it still decodes to exactly the compartments
   the ERP holds, the build has not been edited and the original text *is* the
   faithful answer. Measured on the real corpus: **551 of 551 decodable builds
   echo character-for-character**, whitespace excepted.
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

Both files are generated and CI-guarded — `npm run audit:ac-item-map` and
`npm run audit:ac-sofa-corpus` run in `backend-typecheck`, so refreshing an
export without regenerating cannot leave the composer resolving against last
month's book while the suite stays green.

---

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

The corpus fixture carries **input only** — no expected pieces, no expected
output. The tests run the real decoder and the real collapse over the real text,
so the fixture cannot encode a bug as an expectation.

---

## See also

- `docs/autocount-cutover-ledger.md` — the one-time import that came the other way
- `backend/scripts/autocount-service/AcSyncService.cs` — the AutoCount half
- `backend/scripts/autocount-service/sdk-api-reference.txt` — the reflected SDK surface
- `docs/modules/sales-order.md`, `docs/modules/purchase-order.md`
