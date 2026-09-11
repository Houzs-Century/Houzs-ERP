## The repair told a reader to set the flag it was already running under [low]

**Symptom.** `repair-delivery-dates-from-book.mjs` run with `INCLUDE_BLANKS=1`
printed, on the same line as the count it had just filled:

```
SO LINES  scanned=15500  to fix=510  blank=288 (left blank: MRP gates on this, needs INCLUDE_BLANKS=1)  operator-overridden=2
```

Both halves of that are wrong under the flag: the 288 were not left blank, and
the instruction is to set a flag the run already had. Seen in Actions run
34569351426, whose own step log two lines above reads
`INCLUDE_BLANKS=1 - blank ERP delivery dates WILL be filled from the book`.

**Root cause.** The note was a string constant concatenated unconditionally,
while the BEHAVIOUR it described was conditional on `INCLUDE_BLANKS`. Nothing
tied the two together, so the flag changed the writes and not the sentence.

It is a log string and it changed no data — but it is output the OWNER reads to
decide whether to run the apply, and this repo has a standing rule that a
verdict a reader cannot question must not say the opposite of what happened.
The same shape as the "check that answers a different question" trap in
CLAUDE.md, one layer out: here the check was right and the REPORT was wrong.

**Fix.** The note is now derived from the flag, and is empty when the count is
zero (so a clean run says nothing rather than saying nothing happened):

```
INCLUDE_BLANKS=false  n=288 -> "blank=288 (left blank: MRP gates on this - re-run with INCLUDE_BLANKS=1 to fill them)"
INCLUDE_BLANKS=true   n=288 -> "blank=288 (filled from the book)"
both                  n=0   -> ""
```

Verified by evaluating both branches directly. It is no longer reproducible
against production: after runs 34567236846 and 34569433132 there are no blank
delivery dates left where the book has one, so `n` is 0 on every real run now —
which is exactly why the evidence is the expression and not a run.

**Ref.** `docs/deliv-date-close-out`, 2026-09-11. The repair itself is
docs/bugs/0810-the-erp-s-delivery-dates-went-stale-because-the-autocount-pu.md.
