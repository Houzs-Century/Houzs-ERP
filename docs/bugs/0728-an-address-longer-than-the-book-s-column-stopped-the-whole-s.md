## An address longer than the book's column stopped the whole sales order [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-SO-2609-006` spent all six attempts and never reached the
account book. AutoCount's own words, on the row:

> `Cannot set column 'InvAddr1'. The value violates the MaxLength limit of this
> column.`

**Root cause.** AutoCount's four invoice-address columns are **40 characters**,
measured on the book the same day rather than assumed:

```
SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_NAME='SO' AND COLUMN_NAME LIKE 'InvAddr%'
-- InvAddr1 40, InvAddr2 40, InvAddr3 40, InvAddr4 40
```

`soInvoiceAddress` mapped `address1 -> InvAddr1` through `tidy`, which collapses
whitespace and **does not measure anything**. A customer whose street line runs
past forty characters therefore could not have a sales order in the accounts at
all — and the refusal is per DOCUMENT, not per field, so nothing about that
order reached the book.

**Fix — re-flow, do not cut.**

* **An address that already fits is returned untouched.** This is the rule that
  makes the change safe to ship: re-flowing every address would rewrite the line
  breaks of every document on its next edit, for the sake of the few that
  overflow. Only an overflowing address is re-packed.
* **The words are re-packed across the four lines at word boundaries.** This is
  the address a delivery is printed from; a truncated one sends goods to the
  wrong place. A single word wider than a line is hard-split, because nothing
  else can be done with it.
* **What still does not fit is REPORTED.** Four lines of forty is 160
  characters; an address that overruns that is a data problem, and
  `fitAddressLines` returns the tail rather than dropping it quietly.

**Verified.**

* `autocountWritebackAddress.test.ts` — **10 tests**: a fitting address comes
  back identical (including nulls and a line exactly at the limit); an
  overflowing one loses **not one word and keeps their order**; every line is
  within the column; a 40-word address names its overflow; a 90-character single
  word is broken rather than dropped; and the ordinary address is unchanged.
* `autocount-outbox`, `autocount-convert-lines` and the writeback contract —
  **183 passed**, 7 skipped.
* `npm --prefix backend run typecheck` clean.

**UNTESTED against the live book** — `HC-SO-2609-006` has not been re-sent under
this build.

**THE CLASS IS BIGGER THAN THIS FIELD, and it is open.** Every AutoCount column
has a width and the ERP measures **none** of them. This one was found because a
document stopped; the next could be a customer name, a reference, a remark. The
honest state is that `AC_ADDRESS_LINE_MAX` is the only width this repo knows,
and it knows it because somebody went and looked. A census of the widths the
write-back can reach, and a guard that fits every string to its column, is the
real remedy and is not built.

**Ref.** fix/the-address-must-fit-the-book, 2026-09-09.
