## Shortening the stored text to fit AutoCount would have repriced live orders [high]

<!-- area: AutoCount sync + write-back -->

**Symptom (the one that was nearly created).** Six lines on three sales orders
carry a Description 2 over AutoCount's `nvarchar(100)`, so those documents cannot
reach the accounts. The owner cut the wordings by hand and a repair was built to
write them into `variants.specials`. The plan was run against production —
**and it must not have been applied.**

**Root cause of the near-miss.** `variants.specials` is not free text. It is the
list of PICKED special-order codes, and it is priced **by name**:

```
mfg-pricing.ts        reads variants.specials in 10 places
mfg-pricing-recompute reads it in 5
po-pricing            reads it in 1

const hit = findOption(pool, p);        // matched by NAME
if (hit) total += hit.sellingPriceSen ?? 0;
// "Unknown picks contribute 0"  — the function's own comment
```

Renaming `HB Fully Cover` to `HB FC` makes it an unknown pick, so its surcharge
becomes **zero** — and `recomputeOneLine` runs when the document is saved
(`mfg-sales-orders.ts` imports it). Shortening the stored text to fit a column
in another system is therefore **a price change on a live sales order**.

The owner approved the wordings. He did not approve a repricing, and a fix that
quietly moves money is not a fix.

**What stopped it.** The repair's own plan refused: two of six edits would still
have been over the column, so it exited 1 and wrote nothing. That refusal is why
there was time to look at what the other four would have done.

**Fix — abbreviate on the way OUT, never in the data.**
`composeDescription2` now passes its result through `abbreviateDesc2`, and only
that string is shortened. The ERP keeps `HB Fully Cover`; the screen and the PDF
keep it; pricing keeps finding it.

Three rules make it safe:

* **A string that already fits is returned unchanged.** Nothing that reaches
  AutoCount today reaches it differently tomorrow.
* **It stops at the LEAST abbreviation that fits** — a line needing one phrase
  shortened does not lose the others.
* **It NEVER truncates.** Still over after every abbreviation, the caller refuses
  exactly as before. Half a specification is a wrong instruction, not a short
  one.

**A rule written and removed the same hour.** A bare `Drawer` → `Dwr` reached
into an add-on's PROSE as well as a picker's name — `HC-SO-007678`'s note came
out as *"one Dwr on the left and one Dwr on the right"*. Every rule now names a
whole phrase somebody picked, and a test pins it.

**Verified.**

* `desc2AbbreviatedOnTheWayOut.test.ts` — **7 tests**: a fitting string is
  unchanged; `HC-SO-012312` (115) and `HC-PO-2609-017` (104) come under; it stops
  at the least abbreviation; it never truncates; it never reaches into prose; and
  a longer phrase is not eaten by a shorter one inside it.
* `src/services` + `src/scm` — **3,461 passed**, 249 files. Typecheck clean.

**STILL REFUSED: `HC-SO-007678`'s two lines.** Their 106-character overflow is
`variants.extraAddonNote` — the note on an extra add-on CHARGE, not a duplicate
of anything. It is prose, so no abbreviation reaches it, and it is attached to
money, so it is not mine to rewrite.

**Ref.** feat/abbreviate-desc2-on-the-way-out, 2026-09-10.
