## The AutoCount Sync page flagged every migrated document as filed under a different number [medium]

**Symptom.** The owner, looking at System · AutoCount Sync on 2026-09-08, saw all
three documents on the page carrying the amber DIFFERENT NUMBER flag —
`HC-SO-013361` "in the book as `SO-013361`", and the same for `HC-SO-013393` and
`HC-SO-013394`. Not one of them is a mismatch.

**Root cause (traced).** `acBookNumber` in
`frontend/src/lib/autocountRegister.ts` compared the account book's number
against the ERP's document number as plain strings and called anything unequal
`different`, flagged. That is right for a document the ERP CREATED — the ERP
sends its own number as the document number — and wrong for every document that
came the other way. A migrated document is numbered `HC-` + its AutoCount number
BY CONSTRUCTION: `backend/scripts/import-ac-outstanding-so.mjs:342` builds
`docNo: "HC-" + acDoc`, and `backend/scripts/check-migrated-numbering.mjs`
already asserts that exact equality across the corpus. So on a migrated document
the two strings ALWAYS differ, by exactly the company prefix, and the comparison
could only ever answer "mismatch".

Observed, not reasoned: read against production through the read-only DSN
(`Desktop/.db-align/connection.txt`, `SET default_transaction_read_only = on`).
Houzs Century's whole queue was 32 rows over 3 documents, and
`scm.mfg_sales_orders.linked_ac_docno` for all three is the ERP number minus
`HC-`. Blast radius is not three rows: 2,877 outstanding documents came across
in the cutover, so this was set to fire on very nearly everything staff touch
after go-live.

The file's own comment says what that costs, four lines above the bug: *"a false
flag on a healthy row teaches everyone to ignore the flag, and then the real one
is invisible too."* The real one is `HC-PO-2608-001`, which the account book
holds as `PO-009968` and which went three days unnoticed — the incident this
column was built for.

**Fix.** A fifth verdict, `prefixed`: quiet, unflagged, and still showing the
book's number, because that is the string somebody has to type into AutoCount.
The rule is derived from the pair rather than from a list of prefixes — the ERP
number must END with the book number and the part in front must end at a `-` —
so `2990-` works without being written down, a bare suffix (`13361`) does not
qualify, and `HC-PO-2608-001` → `PO-009968` still shouts. Four tests in
`frontend/src/lib/autocountRegister.test.ts`, proved RED on the unfixed tree
(2 failures: `expected 'different' to be 'prefixed'`, `expected true to be
false`).

**Ref.** fix/outbox-archive-payment, 2026-09-08.
