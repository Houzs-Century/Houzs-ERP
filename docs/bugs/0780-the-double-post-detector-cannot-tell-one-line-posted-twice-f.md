## The double-post detector cannot tell one line posted twice from two lines each posted once [high]

**Symptom.** `check-duplicate-movements` against production (run 34450169671)
reported four HARD double-posts, all goods receipts, all created 2026-09-10 —
the same day — under its own heading *"these post exactly ONE movement per
bucket — count > 1 is a doubled post (the 'GR 两次' case). INVESTIGATE each."*

That was reported to the owner as a live defect in the posting path: stock
inflated, happening today, no database backstop to stop the next one.

**It is a false positive. Nothing was double posted.** The trace (run
34452823201, `diag-grn-double-post-2026-09-10.mjs`) reads every movement beside
the receipt's own lines:

```
HC-GRN-2609-032   2 movement row(s)   IN 1 AKEMI ARMOUR MATT (K) | IN 1 AKEMI ARMOUR MATT (K)
                  2 receipt line(s):  AKEMI ARMOUR MATT (K) x1 | AKEMI ARMOUR MATT (K) x1
```

Two lines, two movements, one each. `HC-GRN-2609-028` carries two ARMOUR lines
and two BASTION lines and posted six movements for six lines.
`HC-GRN-2609-012` carries four separate `JAGER-(Q)` lines and posted twelve
movements for twelve lines. Every receipt agrees with itself.

**Root cause (traced).** The detector groups movements by
`(source_doc_type, source_doc_id, warehouse, product, variant, batch,
movement_type)` and calls `count > 1` a doubled post. **A receipt line is not in
that key.** A document that legitimately carries the same product on several
lines — two mattresses received as two lines, which is normal — produces one
movement per line and therefore more than one row in a single bucket. The
grouping cannot distinguish that from one line posted twice, and it never
looked at `grn_items` to find out.

**And the second detector agreeing was not corroboration.**
`check-stock-vs-autocount` labelled the same three cells `DOUBLE-POSTED
DOCUMENT` — but it takes that label FROM the same bucket rule, so the two are
one measurement reported twice. Two tools agreeing is only evidence when they
are independent, and "no shared code" is not the same as "no shared premise".

**My own diagnostic repeated the bug in its output** before this fix: it
compared the net movement against `items.find(i => i.item_code === code)`, the
FIRST matching line, so a receipt with two lines of one item printed
`net 2 <- RECEIPT LINE SAYS 1`. The evidence that refuted the theory was on the
same screen as a flag restating it. It now compares against the SUM of that
item's lines and prints how many lines there are.

**Fix.** The diagnostic compares against the line SUM. The detector itself is
NOT changed here: making its bucket line-aware means reading each document type's
item table, that is a real change to a shipped checker, and the honest first step
is that its verdict is written down as unreliable for any document type where one
product may appear on several lines. Its heading currently instructs the reader
to treat every hit as a defect.

**What this cost, and the lesson.** The owner was told a live stock bug was
happening today. He answered 「可能是还没sync进autocount？」 — and he was right
about the half I had actually measured, because the ERP-higher-than-AutoCount
reading is a post-cutover receipt that has not reached the book, not inflated
stock.

CLAUDE.md's rule is *ask what a successful result would ALSO be true of*. A
bucket with two rows is ALSO true of a document with two lines. I ran the
detector, believed its verdict, and escalated it before running the one query
that separates the two readings — the receipt's own lines, which is the first
place anybody would look.

**Ref.** fix/grn-double-post-false-positive, 2026-09-10.
