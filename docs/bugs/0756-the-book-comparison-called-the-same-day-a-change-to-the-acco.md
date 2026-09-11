## The book-comparison called the same day a change to the account book [medium]

**Symptom.** The first production run of `check-ac-writeback-vs-book.mjs`
(run `34338641949`) reported **217** values where the ERP had written something
different into the live AutoCount book. Several were `DocDate`, and they read
like this:

```
HC-SO-006772  book=SO-006772  DtlKey=(header)  DocDate
    the book held : "2025-06-17"
    we sent       : "Tue Jun 17 2025 00:00:00 GMT+0000 (Coordinated Universal Time)"
```

That is the same day. The report was telling the owner his account book had been
changed when nothing about it had.

**Root cause (traced).** The payload carries whatever the composer's `Date`
serialised to — `"Tue Jun 17 2025 00:00:00 GMT+0000 (Coordinated Universal
Time)"` — while the exporter writes the book's value as `"2025-06-17"`. The
check did `String(body.Header[k]).slice(0, 10)`, which yields **`"Tue Jun 17"`**,
and compared that against `"2025-06-17"`. They can never be equal, so EVERY
`DocDate` an edit carried was counted as a divergence.

The `slice(0, 10)` was written for an ISO string and is correct for one. Nothing
established that the payload holds an ISO string; that was assumed from the
column's name.

**Fix.** `isoDay()` parses either shape to `YYYY-MM-DD` before comparing — an
ISO prefix by regex, anything else through `new Date`, and `null` when it is not
a date at all (so an unparseable value is never silently scored as a match).
The honest count is **214**.

**The second half of the fix, which the arithmetic did not cover.** "Different
from the book" and "we damaged your book" are not the same claim, and one number
for both is wrong in the alarming direction. The run now splits every difference
by `created_by` (a named person editing in the ERP is the write-back working as
designed; the ERP is master for a document a person raised) and by whether the
book already had the document (an ERP-created number is the same on both sides;
a migrated one is `SO-0xxxxx` in the book and `HC-SO-0xxxxx` here). The
dangerous cell — UNATTRIBUTED × MIGRATED — is printed on its own line with every
member listed. It is **2**, both `Desc2` on `HC-SO-010298`.

**The lesson, which is this repo's own.** A verdict computed over the wrong
comparison still reads as a verdict. The shape census added in the same file
exists for exactly this: it prints the keys actually present on each payload
shape, so "zero differences" can be told apart from "we compared nothing".
The DocDate bug was caught only because the *output was read*, not because any
gate objected — the script, its syntax, the release-discipline audit and the
docs check were all green while it was producing a false statement about a live
account book.

**Ref.** `fix/ac-writeback-vs-book-classify`, 2026-09-09. Sibling: `0753`.
