## The give-away census counts book LINES against ERP ROWS, so a sofa document reads level while it is short [medium]

**Status: OPEN — measured, NOT fixed.** No write path is changed here. The
numbers below are all from committed snapshots and the census's own run, and
they correct two claims that were being repeated without one.

**Symptom.** `topup-ac-so-lines.mjs` was built (0680) to repair exactly two
documents: `HC-SO-012128`, owed 4 x `HOK-SQUARE PILLOW` at RM 0.00 marked
`FOR CONPESSANTION WRONG ITEM DELIVERY`, and `HC-SO-004188`. Its first census
against production — run **34163471709**, 2026-09-08 **05:31 (+08)**, DRY-RUN,
company 1 — **reaches neither**, and wrote `TO WRITE: 0 line(s)`.

**Root cause (traced, three separate things).**

**1. The comparison is book LINES against ERP ROWS, and a sofa is not one row.**
The census reports `HC-SO-012128` as *"book 2 line(s) (1 at RM 0.00) vs ERP 2"*
and files it UNJUDGEABLE rather than SHORT, because the two counts are equal.
They are equal by coincidence. The book's 2 lines are the `HOK-5530 SOFA`
(DtlKey 833309) and the pillow line (DtlKey 924549); the sofa's `Desc2` reads
`(1EL+1ER)28inch`, and a sofa line is DECOMPOSED into one ERP row per
compartment — so 1 book sofa line legitimately becomes 2 ERP rows and the pillow
line becomes none. **2 = 2 while 4 pillows are missing.** Any document holding a
sofa is mis-compared this way; the count carries no information there.
(PROVEN for the book side, from `ac-outstanding-so.json.gz`; the ERP side is
LIKELY — it needs a read that names the 2 rows.)

**2. `HC-SO-004188` is not short at all any more.** The census names 14
documents holding a book line with no ERP row and 004188 is not among them, so
its 4 book lines — including `AK-ULTIMATE MATT (Q)` x1 and `AK-SK + MICROFIL PIL`
x2, both at RM 0.00 — all match. **0680's symptom line for that document is
stale and should not be re-quoted.**

**3. "The importer drops zero-priced lines as a class" is REFUTED, and the
give-away backlog is 9 units, not 18 lines.** Measured on the committed
`ac-outstanding-so.json.gz` (exported 2026-09-07 17:37):

- **10,839 of 14,041** book lines carry `UnitPrice` 0 — **77%**. A zero price is
  the NORM in this book, not an exception, so it cannot be the thing that drops
  a line. If it were a drop class the hole would be five figures, not 21 lines.
- The census found **21** book lines with no ERP row across **14** documents:
  18 at RM 0.00 (**9 units of goods**) and 3 priced (RM 600.00, reported for an
  owner decision, never written).
- Of the 18 zero-priced, **13** were refused as *"no ERP product for the binding
  target"*. **12 of those 13 carry a BLANK ItemCode AND quantity 0** — AutoCount
  spacer rows, not goods; one of them is pure instruction (`SO-000814`,
  `LEG: FOLLOW DISPLAY`). Refusing them is correct, and counting them as owed
  goods overstates the backlog by a factor of three.
- The 13th is `SO-011384`: blank ItemCode, **quantity 4**, price 0 — 4 units the
  book never gave a code, so nothing can be bound without a ruling.
- The other 5 are bedframes (1 + 2 + 2 across `SO-007362` / `SO-010602` /
  `SO-011752`), refused because their gap/divan/leg/colour decoding is owned by
  `import-ac-outstanding-so.mjs` + `lib/parse-sofa.mjs`.

The arithmetic closes exactly: **5 bedframe units + 4 blank-code units = 9**, the
census's own "9 units of goods". So the real give-away backlog is **5
identifiable units** plus **4 units on an uncoded line**, not 18 lines of free
goods.

**Note this is not the qty-0 defect.** `Math.round(num(l.Qty)) || 1` — which
imported a book qty-0 row as ONE unit — is fixed and gone. Zero QUANTITY and
zero PRICE are different things, and the 12 spacer rows above are zero-quantity.

**Fix.** None here. Naming the remedies rather than claiming them:

- The line-vs-row comparison needs to fold a sofa's compartment rows back to one
  book line before comparing counts — `lib/sofa-piece-fold.mjs` already does
  exactly this fold for the stock reconcile.
- `HC-SO-012128` stays unrepairable while its 2 ERP rows carry no
  `linked_ac_dtlkey`. `backfill-ac-line-keys.mjs` matches on (DocNo + ERP item
  code); whether it can reach these rows is **UNTESTED** — it has not been run
  for the non-sofa lane in this round.
- The 85 UNJUDGEABLE documents are the real blind spot, not the 14 named ones.
  Under-repair-never-duplicate is the right default and must stay; the fix is to
  make them judgeable, never to relax the match to fuzzy — the PO side already
  bought 183 near-duplicates that way.

**Ref.** fix/display-sofas-as-the-book-holds-them, 2026-09-08.
