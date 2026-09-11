## Match up lines could not repair a sofa, because it compared one ERP row to one book row [high]

**Symptom.** `HC-GRN-2609-008` sat HELD BACK with *"The ERP cannot tell which
lines AutoCount already has"* — 8 of 8 lines keyless. Pressing **Match up
lines** repaired nothing, and the hands-free relink sweep, run in `apply` on
2026-09-11 ~01:20 UTC, reported `stamped 0` on all five held-back documents with
no cause it could name. The handoff of that day filed the cause as UNKNOWN with
a hypothesis ("LIKELY these are SOFAS") that nothing had checked.

**Root cause.** The hypothesis was right and the mechanism is one line of code.
`composeEdit` folds a sofa build's compartments into a SINGLE AutoCount detail
(`collapseSofaLines`, `autocount-writeback.ts:983`) and sends it under
`<model>-1S`. `planLineRelink` — the other half of the same relationship — is a
strict one-to-one matcher that never imported that module at all: it compares
each ERP row's own item code to a book row's, and claims a matched book line
with `taken` so no second row can have it. A build the ERP holds as eight
compartments therefore met a book holding one line: `8060-CNR` never equalled
`8060-1S`, and even the row that might have matched would have consumed the
line and left the other seven with nothing to claim. Every line refused,
nothing stamped, and the refusal text named item codes rather than the fold —
which is why five runs of the sweep produced no usable clue.

**The fold is a FALLBACK, and the ordering is the load-bearing part.** The book
does not always take the fold. `autocountRelinkSweep.test.ts` carries a live
delivery order whose `9028` compartments are three separate book lines under
their own compartment codes, and the one-to-one pass matches all three exactly.
A first draft of this fix folded first and broke that case — three provable
stamps lost to a guess. So pass 1 is unchanged, and only a row it could find NO
book line for is offered to the fold.

**`<model>-1S` is the folded code, not a compartment to fold.** `1S` is in
`SOFA_COMPARTMENTS` (a one-seater is a real compartment), so a row already
carrying `<model>-1S` is already at the book's grain — a sales order holds one
row per build, and two builds of one model are two rows that Desc2 tells apart.
The first draft folded those too and broke both pre-existing `a repeated code
...` tests, which is exactly what they are for.

**It refuses on the same rule as the rest of the planner.** A missing key is
refused loudly by `composeEdit`; a WRONG key is not refused at all — it silently
edits somebody else's line in a live account book on the next save. So the fold
proves or refuses: the build's own kept compartments answer first (one AutoCount
line has one DtlKey, so a single distinct value across them IS the key the rest
are missing), then a single unclaimed `<model>-1S`. Where that code appears
twice the whole group is refused, because telling two builds of one model apart
needs the composed build text this planner does not read.

**Tests.** Six in `autocount-relink-lines.test.ts`, all RED against the unfixed
tree: every compartment takes the one line's key; compartments adopt the key
their kept siblings carry; two unclaimed lines of one model refuse the build; a
refused build still leaves the document's ordinary lines repaired; an ordinary
hyphenated code is not treated as a build; and the book's own per-compartment
lines win over the fold. 102 tests pass across the four relink/collapse suites;
`typecheck` clean.

**Not fixed here.** Why a September conversion produces a keyless GRN at all —
`readConvertTargetLines` is best-effort and degrades to "no keys stored" on a
read failure, which is what leaves these documents needing a repair in the first
place. That is the upstream half and it is still open.

**Ref.** 2026-09-11.
