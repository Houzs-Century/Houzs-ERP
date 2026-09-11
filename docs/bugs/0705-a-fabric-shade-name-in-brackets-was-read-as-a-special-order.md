## A fabric shade name in brackets was read as a special order the factory must build [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** On go-live day the variant reconcile reported, on the axes the
owner reads as build instructions, that the book asks for a special order the
ERP line does not carry — on PROCEEDED orders, the only column the report calls
WORK. Run `34198407570` (2026-09-08 15:15 Malaysia):

```
SO VARIANT specials — 2 DIFFER on a PROCEEDED order, 3 ERP blank on a proceeded order
      SO-009093 ... AutoCount "YELLOW" vs ERP "(blank)"
      SO-011356 ... AutoCount "BEIGE"  vs ERP "(blank)"
      SO-010214 ... AutoCount "FOSSIL" vs ERP "(blank)"
PO VARIANT specials — 3 DIFFER on a PROCEEDED order, 5 ERP blank on a proceeded order
      PO-009880 ... AutoCount "YELLOW" vs ERP "(blank)"
      PO-009753 ... AutoCount "BEIGE"  vs ERP "(blank)"
      PO-009784 ... AutoCount "PEARL"  vs ERP "(blank)"
      PO-007479 ... AutoCount "FOSSIL" vs ERP "(blank)"
```

Read as a backlog that says: seven confirmed orders are being built without an
option the customer asked for. There is no such option. `YELLOW` is the mill's
name for `BO315-26`.

**Root cause (traced).** The book's own Desc2, from the committed snapshot
`ac-reconcile-truth.json.gz` (exported 2026-09-08T00:03:44Z), DtlKey 630195:

```
BO315-26 (YELLOW)/28"/2L
```

`parse-sofa.mjs` reads the colour correctly — `unlabelledColour` confirms
`BO315-26` against the LIVE fabric library after stripping the bracket, which is
why the colour axis AGREES on all seven lines. It then leaves the bracket in the
text. The bracket→`+` rewrite frees `YELLOW` into its own structure token, no
arm of the phase-1 grammar claims it, and the catch-all at
`scripts/lib/parse-sofa.mjs` (`!/\d/.test(t) && t.length >= 3 && ...`) pushes it
to `rider`, which `addSpecial`s every entry. So the decoder answered
`specials: ["YELLOW"]`, and `variant-reconcile.mjs` correctly reported that the
ERP line does not carry it.

Observed, not reasoned — the decoder run against the real string:

```
BO315-26 (YELLOW)/28"/2L   ->  colour="BO315-26" size="28" specials=["YELLOW"] conf=medium
```

**Sized over the whole corpus, not over the offenders.** All 1,979 distinct sofa
Desc2 in that snapshot: **49** carry a bracketed suffix on a fabric code. **48
are shade names** — PEARL, FOSSIL, SAND, BEIGE, YELLOW, PEACH, CREAM, METAL,
KHAKI, FEATHER, DEEP GREY, DARK GREY, LIGHT BROWN, RUMMA — and **1 is a real
instruction**, `HARRING GD8371 (PLS FOLLOW DRAWING)`. Only 7 surfaced on the
go-live tally because a verdict needs the ERP line to carry no specials at all;
the other 41 were absorbed as `AGREE` or `BOOK_BLANK`.

`(FEATHER)` was already known and already half-handled: `unlabelledColour`
carries a hard-coded `\((?:feather|foam)\)` strip so the code can be confirmed —
and then leaves it in the text, so it became a special anyway. One shade name
had been special-cased without the class being seen.

**A second, smaller reading of the same shape.** `STOOL(25 X 40INCH)` (SO-011756)
states a stool's length by its width. The size regex took the second number, so
the seat-size axis reported `AutoCount "40"" vs ERP "30""` — one of only five
seat-size differences on the whole sales-order side. Correcting the ERP to the
book there would have written a stool's WIDTH into a build instruction.

**Fix.** `backend/scripts/lib/parse-sofa.mjs`:

- `isTradeName()` — at most two plain alphabetic words, no digits, and matching
  neither `SPECIAL_WORD` nor `INSTRUCTION_TOKEN`. `unlabelledColour` now reports
  the bracket, and `parseSofa` takes it out of the text before the structure
  pass can free it into a token. The bracket qualifies only when the code
  **confirms to the SAME library row without it** — so the bracket demonstrably
  contributes nothing to the colour's identity, and a bracket that is genuinely
  part of a code can never be dropped.
- a footprint guard: an adjacent `N x M inch|cm` pair is removed before the seat
  size is read, so the axis is BOOK-BLANK — the honest answer — rather than 40".

The bias is deliberate and stated in the code: a dropped instruction is a sofa
built wrong, a kept shade name is a noisy line on a report. Anything that is not
recognisably a name stays a special.

Measured over the same 1,979 Desc2 after the change: shade names read as
specials **49 → 2**, and the 2 are both spellings of `(PLS FOLLOW DRAWING)`,
which is the one that must survive. Footprints read as a seat size **1 → 0**.

**THE FIRST VERSION OF THIS FIX SHIPPED A GUARD THAT NEVER FIRED, and that is
the more useful half of this entry.** It asked the wrong question: *did the code
fail to confirm WITH the bracket, and confirm only once it was stripped?* Under
an exact-match test stub that is exactly what happens, and all four new tests
went green. Against the live library it is false every time —
`fabric-colour-match.mjs` strips brackets ITSELF on rung 1 of its candidate
ladder (`noParen`), so `findColour("BO315-26 (YELLOW)")` returns `BO315-26`
directly and the stripped branch is never reached.

Measured, not assumed: the same reconcile was re-run on the branch carrying that
version — run `34200092543`, 2026-09-08 15:35 — and reported the same three
phantom specials as the run before it. Only the footprint half moved (seat size,
not proceeded: `3 differ` → `2`), which is what proved the branch's code was
running at all and the colour guard simply did nothing.

The stub was the whole defect. The tests now build the index with the REAL
`buildFabricColourIndex`, from the same rows `check-ac-erp-reconcile.mjs` reads
out of `scm.fabric_colours`, with a `knownColour` byte-identical to the
reconcile's — so a stub can never again answer a question production does not
ask. This is the repo's own named trap, *"the check that answers a different
question"*, in its purest form: the assertion passed, and it was not about the
system.

**Tests, proved RED on the unfixed tree** (`scripts/lib/parse-sofa.test.mjs`,
run by `working-agreement.yml` via `node --test scripts/lib/*.test.mjs`): four
new cases, three of which failed before the change and all of which pass after —
`161 pass, 0 fail` across `scripts/lib`. The second is the one that matters most: three real book
strings that carry a shade name AND a genuine request on the same line
(`BO315-21 (PEARL)/30"/2S ( PLS FOLLOW THE INSTRUCTION )`,
`BO315-22 (FEATHER)/32"/2L(Replace to 9028 headrest)`,
`BO315-23 (BEIGE)/32"/2L (No armrest)`) — the name has to go and the request has
to stay. If that one ever goes red the guard has widened into dropping real
requests.

**No production row was written for this.** The defect is in what the book was
READ as, not in what the ERP holds, so it needed no repair script and no
migration. It does change what a future import writes, in the same direction.

**The class, for next time.** A decoder that recognises the value it wants and
leaves the rest of the text standing hands that remainder to whatever runs next.
Here the remainder had a home — a catch-all that turns any unclaimed word into a
factory instruction — so the leftovers of a SUCCESSFUL colour read became work
orders. When a reader consumes part of a string, it owns removing that part.

**Ref.** fix/line-variants-tally, 2026-09-08.
