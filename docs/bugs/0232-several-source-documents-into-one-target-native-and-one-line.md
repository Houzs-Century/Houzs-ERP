## Several source documents into ONE target — native, and one line was blocking it [high]

<!-- area: AutoCount sync + write-back -->

**Owner 2026-08-16:** a delivery order from several sales orders, an invoice from
several DOs, a goods-received note from several POs, a purchase invoice from
several GRNs — AutoCount does all four, and the write-back could do none of them.

**PROVEN on the live book:**

```
5b-multi TWO SOs -> ONE DO
  DO-011310 has 2 lines from 2 parents:
  ZZQA-SO-20260816-095955 + ZZQA-SO-20260816-095955-B
```

Two sales orders, one delivery order, and each line's `FromDocNo` points back at
its OWN parent.

**Two things were in the way, and the second only appeared once the first was
removed.**

1. **`FromDocNo` was demanded unconditionally.** `DtlKeys()` already returned an
   explicit `DtlKeys[]` verbatim without checking it against `FromDocNo`, so the
   keys could always have spanned documents — the route simply refused to accept
   a payload that did not name one parent. `FromDocNo` is the FALLBACK, used to
   find the outstanding lines when the ERP does not name them, and it is now
   optional when they are named.

2. **A MIXED key array is refused by AutoCount.** Handing
   `AddPartialTransferDetail` lines from two documents in one array answers:

   ```
   AutoCount.Invoicing.InvalidTransferItemException: Invalid transfer item.
   ```

   The array must be lines of ONE source document. The merge is still native —
   the TARGET accepts the call repeatedly — so the keys are grouped by the
   document they actually belong to and the transfer is invoked once per group.

**The grouping is read from the book, not taken on trust,** and the count is
asserted: a key that exists on no document of that type refuses the whole
request rather than quietly transferring a smaller set than the caller asked for.

**A test-ordering trap this produced, worth keeping.** The merge test first used
a line of the MAIN sales order, so the single-source `/so-to-do` that ran after
it failed with our own guard — `no transferable lines on SO ...` — which reads
exactly like a regression in the thing that had just been proven working. It was
the test eating its own fixture. The merge now owns its own sales orders. When a
step that passed a minute ago starts failing, suspect the fixture before the
code.

**Ref:** this PR, 2026-08-16.
