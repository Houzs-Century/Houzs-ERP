## Pairing rows by code fixed a mirrored sofa's ends and left its corner on the wrong side [high]

**Symptom.** `apply-sofa-compartment-corrections` corrected 20 mirrored sofa
builds on production (run 34441508244) and its verification passed on every one.
Nine of them are still the wrong sofa: the two ends face the right way and the
CORNER — or the console — is where the un-mirrored reading put it.

`1A+1NA+CNR+1A` and `1A+CNR+1NA+1A` are not the same product. The corner turns
the run at a different point, and the factory builds what the sequence says.

**Root cause (traced).** The applier's own documented rule:

> MATCH FIRST, THEN UPDATE IN PLACE. Existing rows are paired to target pieces by
> code; a pair is UPDATEd, never dropped and re-inserted, so the row id survives
> — and with it the `purchase_order_items.so_item_id` dedication.

That is correct, and it is why a middle piece never moves. A mirror changes the
END codes (`L(LHF)` becomes `1A(RHF)`), so those rows are found and rewritten. A
middle `CNR` or `CONSOLE` has the SAME code on both sides of the mirror, so it
pairs with itself and stays exactly where it was. Its own dry run printed the
whole mechanism on `HC-SO-012752` and nobody read it as a defect:

```
change 1A(LHF) -> L(LHF)
keep   1NA
keep   2NA
keep   CONSOLE          <- the console did not move to the other side
change L(RHF) -> 1A(RHF)
```

**Why the verification passed anyway, which is the part worth keeping.** It
asserts the piece MULTISET and both money columns — its own summary line says
`piece multiset and both money columns`. A reordering does not change a multiset,
so the check was true and the sofa was wrong. This is CLAUDE.md's *check that
answers a different question*: ask what a successful result would ALSO be true
of, and a multiset is true of every permutation.

**Fix.** `backend/scripts/reverse-sofa-middle-order-2026-09-10.mjs`. A mirror is
"reverse the sequence and swap every hand"; the hands and the ends are already
done, so what remains is exactly the middle, reversed. The script asserts that
relationship for all nine documents BEFORE opening a connection and exits
non-zero if any target is not its own middle reversed.

**It moves `line_no`, never `item_code`, and that is the whole safety argument.**
Permuting the codes across rows would leave a purchase order's `so_item_id`
pointing at a row that is now a different compartment — the dedication would
silently name the wrong piece. Moving the ROW takes its code, its money and its
id along with it. The first and last rows are never touched, which is what keeps
the money still: the cutover put the whole build's price on the lead row, so
leaving row 1 in place means no price changes position. `line_no` is unique per
document, so the moving rows are parked on negative numbers inside one
transaction before taking their new ones.

**Verification asserts the SEQUENCE this time**, not just the multiset, plus the
unchanged code multiset, the row count and both money columns, on a fresh
connection.

**Ref.** fix/sofa-middle-order, 2026-09-10.
