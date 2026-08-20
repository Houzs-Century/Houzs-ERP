## AutoCount Sync listed one row per SEND and called the count documents, so one sales order appeared four times [medium]

**Symptom.** Owner, 2026-08-16, on the live page: 「为什么在 AutoCount 里面一张
Sales Order 会出现两次呢?」 Under **In AutoCount → Sales orders** he had six rows
and `HC-SO-2608-002` was FOUR of them — three "Change to the sales order"
(16/08 4:31pm, 4:31pm, 4:30pm) and one "New sales order" (15/08 1:25am) — over a
header reading *"6 of 17 documents"*.

**Root cause (traced, not guessed).** Nothing is duplicated. `AED_HOUZS` holds
exactly one `HC-SO-2608-002`, verified by direct SQL against the live book.
`scm.autocount_outbox` is append-only and writes ONE ROW PER INTENDED OPERATION
(migration 0277's own words), so a document that is created and then edited three
times is four rows, permanently — the queue is right and the screen had the wrong
unit. Both surfaces mapped `d.rows` straight onto cards, `acDocTypeCounts` counted
rows, and the route's `counts` were six `count: 'exact', head: true` queries over
rows. Every number on the page said "documents" over a count of sends.

**Fix.** `acGroupByDocument` in the shared layer folds the sends into the document
they belong to, keyed on `doc_type + doc_no` — the pair
`autocount_outbox_doc_idx (company_id, doc_type, doc_no)` was created by 0277 to
answer "has this document been written to AutoCount, and as what". The newest send
draws the card; every earlier send is kept behind *"N earlier sends for this
document"*, because the audit trail is what the queue is for. `acDocTypeCounts`
counts documents, and the route replaced its six head-counts with two paged scans
that count distinct `doc_type + doc_no` — fewer round trips than before, and the
state per row still comes from the shared `acOutboxState` rather than a second
opinion. A scan that hits `AC_DOC_SCAN_MAX` answers `counts_complete: false` and
the page says the numbers are a floor, rather than letting an undercount read as a
count. **Ref** PR #PLACEHOLDER, 2026-08-17.
