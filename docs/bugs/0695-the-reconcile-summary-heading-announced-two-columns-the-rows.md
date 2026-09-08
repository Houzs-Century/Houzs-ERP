## The reconcile summary heading announced two columns the rows never printed [medium]

**Symptom.** Run 34187812364 (2026-09-08 12:47 +08) printed an 18-column heading
over 16-cell rows:

```
type  book  scope    erp  absent  phantom   both  lineCnt   item    qty  price  money  decided  no-price  ERP-RM0  non-MYR  same-goods  same-money
GR   11623    400    521       0        0    400        0      2      0      0      9        0         0      100        0
IV   10292     47     43       6        0     43        0      0      0      0      0        0         0        0        0
```

`same-goods` and `same-money` are the two columns #3186 added to hold the counts
it reclassifies. The heading names them; every row stops at `non-MYR`. So the
run reported `GR item 36 -> 2` and gave the reader nothing to check it against —
the 34 documents that moved, and WHY they were allowed to move, were invisible in
the one place the owner reads.

**Root cause (traced).** The heading and the row were **two independent string
literals** with nothing relating them. #3186 edited the heading successfully and
its edit to the row array did not apply — the file has CRLF line endings and the
patch matched on `\n`, so the replacement silently found nothing and reported
success. The row object DID gain the fields (`guessedPairing`, `lineShape` are
both in `summary.push`, and `notWork` sums them), which is why nothing else
looked wrong: only the two `padStart` cells were missing.

Nothing could have caught it. No test rendered the table, and no code knew the
heading and the row were supposed to have the same number of parts.

**Fix.** Not a repair of the instance — removal of the class. One
`SUMMARY_COLUMNS` array now carries `{label, width, get}` per column, and BOTH
the heading and every row are rendered from it, so a new column is one entry and
cannot be added to one and not the other. The render loop additionally asserts
`cells.length === SUMMARY_COLUMNS.length` and throws with the run id in the
message.

Proved by rendering the real shape offline before shipping: **18 heading columns,
heading length 146, row length 146, aligned true.**

**The wider lesson, which cost three separate silent no-ops in one session.**
`node -e` string `.replace()` against a CRLF file matches nothing and returns the
original, and `fs.writeFileSync` then reports success. Three edits in this work
failed exactly that way; two were caught by reading the file back, this one was
not, and it reached production output. **Use the Edit tool, or match on
`\r?\n`, and read back what you wrote** — a patch tool that cannot fail loudly
is a patch tool that lies.

**Ref.** fix/reconcile-summary-columns, 2026-09-08.
