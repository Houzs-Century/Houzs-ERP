## A sofa whose text is a suffix of its neighbour's had no address at all [high]

<!-- area: AutoCount cutover — sofa compartments -->

**Symptom.** The owner ruled on 2026-09-08 that `HC-SO-012025` holds TWO
DIFFERENT sofas: the first `1A(LHF)+1NA+CNR+1A(RHF)`, and the second — the slip
marked `9050 G` — a plain `1S`. There was no way to write the second one. Every
needle that reaches it also reaches the first, so the correction would have been
written onto both, which is the one thing `lib/sofa-desc2-match.mjs` exists to
prevent.

**Root cause (measured, not inferred).** The account book states the same build
text TWICE on `SO-012025`, and the two differ by ONE LEADING SPACE:

```
DtlKey 829179   " bottom to Nilon  \n30 inch , all adjustable arm rest  \ncolour :GD2502# 18- GREY"
DtlKey 829180   "bottom to Nilon  \n30 inch , all adjustable arm rest  \ncolour :GD2502# 18- GREY"
```

The ERP explodes each into one row per compartment, and every added row inherits
its lead's text verbatim — so four rows carry the leading space and four do not
(prod, read-only probe run `34242061732`). The second sofa's text is therefore a
strict SUFFIX of the first's, and a substring search is one-directional: the
first sofa can be addressed exactly, the second cannot be addressed at all.

While the two were believed to be identical sofas this cost nothing. The file's
own rule says two lines with the same text are two identical sofas and both take
the build, and `lib/sofa-build-plan.mjs` splits them for exactly that. The moment
he ruled them DIFFERENT, the second had no address.

`normaliseDesc2` makes it worse rather than better, and correctly so: it folds
runs of whitespace, which is precisely the discriminator here. The two texts are
equal once normalised, which is why the ambiguity guard does not fire — it sees
ONE distinct text across all eight rows and hands back all eight.

**Fix.**

1. `desc2Exclude` on a correction: the rows carrying that text, BYTE-EXACTLY,
   are not this build. Byte-exact and never normalised, because the
   discriminator IS a space. It narrows the candidate pool before anything else
   looks at it, so an excluded row can never be reached, counted towards
   ambiguity, or treated as surplus.
2. **An exclusion that matches NO row is a REFUSAL** (`exclusion-missing`), not
   a quiet no-op. If a re-import ever trims that space the discriminator is
   gone, and the failure mode without this brake is silent: the second sofa's
   `1S` written onto the four-piece sofa as well.
3. The same rule in `lib/sofa-rulings.mjs` as in the writer, so the reporter and
   the writer cannot disagree about whose build a line is. Without it the newest
   ruling wins for BOTH sofas and the reconcile reports the four-piece sofa as
   one the owner ruled a single seater.
4. The first sofa's entry is re-needled onto `" bottom to Nilon"`. Its build is
   unchanged and he confirmed it; only the address moved.

**Two things this bought on the way, both measured.**

*The verifier narrowed differently from the writer.* APPLY run `34245004498`
wrote the correct and complete state and then failed its own check:

```
FAIL HC-SO-012025: pieces are [9050-1A(LHF) | 9050-1A(RHF) | 9050-1NA |
                               9050-1S | 9050-CNR], expected [9050-1S]
```

Those five rows ARE the two sofas he ruled. `verifyOnFreshConnection` re-reads
the whole document and narrows with `it.needle`; the exclusion half of the
address was never put on the verify item, so it compared one build's target
against both builds' rows and both builds' money. The exclusion now travels with
the needle.

*A half-write the applier would have made.* Dry-run `34243747163`, with the
owner's five-piece reading of `HC-SO-011733` written live:

```
HC-SO-011733: REFUSED - a surplus line is referenced downstream:
  9058-CONSOLE: 1 PO line(s), 0 DO line(s)
HC-PO-008783  9058  1NA+1A(RHF)+CNR+1NA+2A(LHF)+CONSOLE
                 -> 2A(LHF)+CNR+1NA+1NA+1A(RHF)
```

The sales-order half refuses and the PURCHASE half plans anyway — the factory
document loses the console while the customer document keeps it, which is what
docs/bugs/0719 forbids. That reading is HELD rather than applied, with the one
question it leaves open written beside it.

**What this does NOT fix, and it is the next repair.** The compartment rows a
correction ADDS carry no `linked_ac_dtlkey`, so the reconcile cannot see them as
part of their build. `HC-SO-012025`'s first sofa is now correct in production and
still reads CANNOT BE COMPARED, because its ERP side is one keyed row and three
keyless ones (reconcile run `34246640657`: "SO-012025: ERP line … has no
AutoCount line", three of them). The same gap is what holds `HC-SO-013384`'s
second sofa, whose two builds' texts are BYTE-IDENTICAL and which therefore has
no address of any kind until every compartment row is keyed —
`backfill-ac-sofa-line-keys.mjs` refuses to stamp them precisely because two
identical builds of one model do not force which is which.

**Ref.** `fix/so-sofa-six-rulings`, 2026-09-08. Applied and verified on a fresh
connection in prod run `34245773441`; sales-order tally `34246359341` moved
CANNOT BE COMPARED from 43 to 42 and the differ count from 7 to 6.
