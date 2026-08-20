## `/po-to-gr` is broken on its own, and calling it "blocked behind SO-to-PO" was wrong [high]

<!-- area: AutoCount sync + write-back -->

**Correction first.** This thread twice reported `PO->GR` as blocked by the
SO-to-PO defect, on the reasoning that the only PO available to convert was the
unusable one. The log refutes it: **eight** `/po-to-gr` failures are recorded,
and one is against a healthy `/create-po` purchase order, on the CURRENT build:

```
2026-08-15 22:22:39 ERROR /po-to-gr: System.IndexOutOfRangeException: There is no row at position -1.
  at System.Data.RBTree`1.GetNodeByIndex(Int32 userIndex)
  at System.Data.DataRowCollection.get_Item(Int32 index)
  at AutoCount.Invoicing.Purchase.GeneralPurchasePartialTransferDetail..ctor(
        PurchaseDocument document, String fromDocType, Int64[] fromDocDtlKey,
        Boolean transferMaster, Boolean mergeTrans...)
```

Two more of the eight are from 2026-08-12, same exception, same frame.

**What it means.** "There is no row at position -1" is a master lookup that
returned -1 — not found — being used as a row index. The GRN's partial-transfer
constructor is reaching for a purchase-side master row that is not there. That
is the same family as `FK_SODTL_Location` (the line warehouse),
`FK_SO_SalesLocation` (the header sales location) and `FK_PO_DisplayTerm` (the
payment term, defaulted from the supplier): **a master the payload does not
carry.** It differs only in that it names no constraint, just an index.

**`transferMaster = true` does NOT cure it.** #2043 added that flag precisely
because `false` produced this shape, and the comment above the call says so. The
flag was already deployed when the 2026-08-15 failure fired, so the remaining
cause is something else on the purchase side.

**Not yet traced, and deliberately not guessed.** The constructor's arguments
are in the frame — `fromDocType`, `fromDocDtlKey[]`, `transferMaster` — so the
next step is to log those three at the call site and read which lookup is
empty. `/last-errors` now makes that a single call rather than a remote-desktop
session.

**Consequence.** `PO->GR` has never succeeded, so `GR->PI` has never been
reachable either. Of the five conversions, `SO->DO` and `DO->IV` are proven with
their Transfer links; the three purchase-side ones are not.

**The lesson.** "Blocked by X" is a causal claim and needs the same evidence as
any other. Both times it was asserted from the order things failed in, not from
the log, and the log was one call away.

**Ref:** this PR, 2026-08-16.
