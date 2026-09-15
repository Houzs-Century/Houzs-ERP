## Purchase orders raised from a sales order kept swapped values and no line keys in AutoCount, and nothing could correct them [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** HC-SO-004928's edit was refused by AutoCount, *"The quantity of
the item code NB-NBG06(SS+S) is less than the quantity it was partially
transferred to Purchase Order"* (outbox health run 34850891130). In the book,
read-only on 2026-09-14, the sales line 345768 (CROWN, qty 1) has 2 transferred:
HC-PO-2609-032's purchase line 927705 holds 2 CROWN and line 927709 holds
1 STAR-(SS). The ERP has 1 CROWN and 2 STAR-(SS), and so does the sales order.

**How wide (measured).** Every line of an `HC-PO-` purchase order in the book
was paired with our row whose sales line is the purchase line's
`PODTL.FromSODtlKey`. The book was read at 2026-09-14T13:57Z and the ERP
read-only straight after, through a local harness using
`conversion-line-key-plan.mjs`.

- **Quantity differs:** HC-PO-2609-032 (both lines), HC-PO-2609-063
  (8030-1A(RHF) 2 in the book against 1; 5543 LONG PILLOW 1 against 2),
  HC-PO-2609-009 (JAGER-(Q) 1 against 2).
- **Unit cost of two lines swapped:** HC-PO-2609-010, -020, -022, -034, -055,
  -068, -072, -073, -080, -086, as well as -032 and -063.
- None of these book lines has been received (TransferedQty 0, no later
  transfer).

The pairing would stamp 83 keyless purchase lines and finds 22 already keyed
correctly.

**Root cause (traced).** Two defects already in the ledger made this, and both
left the documents in the book alone:

- 0889: the transfer zipped keys with values from an unordered read.
- 0890: `persistLineKeys` refused to store a transferred line's key.

A value in the book can only be corrected by an edit that names the line by its
key, and the lines had none. Even with keys, nothing sends a document's current
state by name:

- the re-queue ladder takes no edits;
- `requeue-amendment-ac-edits.mjs` sends only amended documents;
- `requeue-keyed-conversion-edits.mjs` sends only DO / GR edits refused for a
  keyless line;
- `rebuild-ac-document.mjs` clears the lines, which a transferred document
  refuses.

**Fix.**

- `stamp-conversion-line-keys.mjs` gains a purchase-order lane. It pairs
  `purchase_order_items.so_item_id` -> that sales line's key against the book's
  `PODTL.FromSODtlKey`, only for a document a sent `so_to_po` row names. It
  reuses the same pairing rule, plan digest, confirm and fresh-connection
  verify.
- `export-ac-conversion-line-keys.py` exports that lane. It refuses a snapshot
  whose `FromSODtlKey` names no sales line in the book.
- `trg_po_item_qty_guard`, the one trigger on `purchase_order_items`, fires only
  on `UPDATE OF qty` (read on production 2026-09-14).
- New `resend-ac-document-edits.mjs` (workflow *Send named documents to
  AutoCount again*). It queues the Worker's own `enqueueEdit` for named SO / PO /
  DO / GR documents. Plan composes and rolls back; apply needs CONFIRM and
  verifies on a fresh connection. Once keyed, the edit sends each line's quantity
  and cost under its own key.

**Not fixed here.** The keys and the re-sends are production operations, run
after merge. Whether AutoCount accepts moving HC-PO-2609-032's CROWN from 2 to 1
in the same save that moves STAR-(SS) from 1 to 2 is UNTESTED.

**Ref.** fix/ac-po-line-keys, 2026-09-14.
