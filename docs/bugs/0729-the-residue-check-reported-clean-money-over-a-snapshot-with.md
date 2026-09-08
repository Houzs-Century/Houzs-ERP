## The residue check reported clean money over a snapshot with no money in it [high]

**Symptom.** Run 34261381499 printed `GOODS RECEIPT MONEY — no priced pair
differs from the book`, while `check-po-gr-tally.mjs` on the same database and
the same day reported **4 goods receipts differing on the document total**. Two
instruments, one question, opposite answers.

**Root cause (traced).** `check-po-gr-residue.mjs` read the book's line
subtotals out of `backend/scripts/data/ac-convert-edges.json.gz`. That snapshot
is the CHAIN cut and its `line_fields` are `docNo, dtlKey, seq, itemKey, qty,
transferedQty, transferedPoQty, transferable, fromDocType, fromDocNo,
fromDocDtlKey, fromSoDtlKey` — **there is no `subTotal`**. So `L.subTotal` was
`undefined`, `r[undefined]` was `undefined`, `Number(undefined || 0)` was `0`,
every pair's book total came out zero, and the guard `if (b == null || b === 0)
continue` skipped every single pair. The section compared nothing and printed
the words that mean "I compared everything and it agreed".

This is the repo's own named failure — *a verdict computed over nothing must
never read as a pass* — and it was found the way that class is always found: by
two instruments disagreeing, not by reading the code.

**Fix.** The money is read from `ac-reconcile-truth.json.gz`, which is the
snapshot the reconcile itself compares against and which does carry `subTotal`.
`moneyReadable` is asserted from the loaded field list rather than assumed, and
when it is false the check says **NOT MEASURED** in those words instead of
printing a count. The clean-result sentence now names the snapshot it measured
against, so a reader can tell a real zero from an empty one.

Two smaller corrections in the same pass, both found by reading the check's own
output against run 34257834858:

- it printed one line per ERP **row** where a sofa is one book line and several
  compartment rows, so `PO-009881` appeared four times and the total said "17
  lines" for seven book lines. It groups by book line now, which is the grain
  the fraction comparison already used;
- it asked whether a purchase-order line carried the same DtlKey as the
  goods-receipt line, which is a question that can only ever answer "no" — a
  GRDTL key is not a PODTL key — and read as a finding. Removed; the book states
  no source LINE on that edge at all.

**What it changed about the answer.** Nothing was hidden by the bug: the four
money differences were already counted by the tally, which is the instrument the
owner reads. What the residue check owed was the REASON, and it was silently
owing nothing at all.

**Ref.** fix/po-gr-transfer-chain-2026-09-09, 2026-09-09.

**And once it could see, it disagreed the other way — measured, run 34261651815.**
It named **six** unequal pairs where the tally names four. The two extra —
`GR-000997|PO-001696` and `GR-000815|PO-001068` — are sofas: one book line
against several compartment rows here, and this probe sums rows while the
reconcile compares the document total. Rather than reimplement the reconcile's
total (a second implementation of "different" is what
`docs/bugs/0708-two-tools-answered-the-same-pairing-question-differently-twe.md`
cost), section 3 is now labelled what it actually is — a **ratio probe**. It
prints the SHAPE; the tally owns the LIST, and the header says so.

The shape is the part worth having: three of the six are **exactly 4/3** —
`GR-005363` RM 3,525.00 vs RM 4,700.00, `GR-005367` RM 1,575.00 vs RM 2,100.00,
`GR-005368` RM 1,258.50 vs RM 1,678.00. That is **RM 2,119.50** of supplier
discount the importer dropped by taking `PODTL.UnitPrice` (undiscounted) where
the book's own money is `PODTL.SubTotal` (discounted).
