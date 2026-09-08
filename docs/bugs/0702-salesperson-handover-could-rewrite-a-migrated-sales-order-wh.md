## Salesperson handover could rewrite a migrated sales order while the lock was on [high]

**Symptom.** `scm.migrated_so_lock = '1'` says migrated sales orders are
view-only, and on the Sales Order screen they are. Run a salesperson handover
(a resignation or a transfer) over a list that includes migrated orders and
every one of them is reassigned anyway — `salesperson_id` and `agent` both
rewritten, an audit row recorded, and an AutoCount enqueue fired. No refusal,
because nothing asked.

**Root cause (traced).** The lock is enforced by a router-level factory mounted
twice in `backend/src/scm/index.ts` — `migratedSoReadonly()` on
`/mfg-sales-orders/*` (`:327`) and `migratedSoAmendmentReadonly()` on
`/so-amendments/*` (`:346`). `/so-handover/*` (`:351`) carries the area guard
and nothing else, and `backend/src/scm/routes/so-handover.ts:178` runs
`sb.from('mfg_sales_orders').update(updates).eq('doc_no', docNo)`.

A third mount of the same factory would NOT have closed it, which is why this
was not a one-line oversight to spot: `soDocNoFromPath` resolves the document
number from the PATH, and `POST /so-handover/apply` carries a LIST of document
numbers in the BODY. The factory would find no doc number, answer "not
migrated", and wave every write through — a guard reading as applied while
enforcing nothing.

Found by ENUMERATING the write endpoints the `scm.sales.orders` freeze area
opens, from the committed route inventory `docs/generated/route-capability-matrix.csv`
rather than by reading the mounts: 43 write endpoints across 8 prefixes, of
which the lock's two mounts cover 27. `/so-handover/apply` is the only one of
the remaining 16 that writes a sales-order table at all — `scan-so.ts` names
`mfg_sales_orders` / `mfg_sales_order_payments` four times and every one is a
SELECT, and `slips.ts` and `scan-payment.ts` never name them.

The field it rewrites is not incidental: `salesperson_id` and `agent` are two of
the fields `sync-ac-delta`'s header lane copies back from AutoCount, so the two
defects in this batch met on the same column.

**Fix.** The handler asks the decision per order, through the same
`migratedSoReadonlyState(c, isMigrated)` the router guard and the SO detail
screen use — one function, so the button, the endpoint and this route cannot
disagree. `isMigrated` is REQUIRED and answered off the row the handler already
reads (`linked_ac_docno`, the import's own stamp and `soIsMigrated`'s
predicate). A refused order goes into the existing per-order `skipped` array
with the lock's own sentence, so the operator is told which orders did not move
and why — this route already reports per order precisely because a handover that
half-applied in silence is how an order vanishes from both reps' lists.

Pinned by four call-site assertions in
`backend/src/scm/routes/so-handover.test.ts`.

**Ref.** fix/sync-human-edit-guard, 2026-09-08.
