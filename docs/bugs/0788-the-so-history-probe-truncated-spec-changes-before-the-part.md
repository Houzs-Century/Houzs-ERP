## The SO history probe truncated spec changes before the part that changed [medium]

**Symptom.** Reading HC-SO-012312's trail on 2026-09-10 to find out whether the
two amendments applied that morning had removed "Right Drawer" from two HILTON
bedframes, every spec row printed as

```
line_HILTON (A)-(Q)_spec: PC151-01 / DIVAN 10" + NO LEG / GAP... -> PC151-01 / DIVAN 10" + NO LEG / GAP...
```

— byte-identical on both sides, and therefore no answer at all.

**Root cause (traced).** `short()` in `backend/scripts/check-so-history.mjs`
clipped every value at 60 characters. `buildVariantSummary`
(`backend/src/scm/shared/variant-summary.ts`) emits the SPECIAL segment LAST,
after fabric code, divan, leg, gap and total height — so on a bedframe the first
60 characters are the part that rarely moves and the answer is always past the
cut. The probe was printing the half of the string that cannot differ.

**Fix.** `LONG_TAIL_FIELDS` names the fields whose answer lives in the tail —
`spec`, `specs`, `description2`, `variantSummary`, matched with or without a
`line_<code>_` prefix — and those print to 400 characters; everything else keeps
its 60. Matched on the FIELD NAME, not on the value's length: this prints into a
CI log, and a jsonb blob of custom specials or a customer address has no business
being dumped whole, so widening stays a decision about which fields carry a tail.

Proved by dispatch against the same order, not by a unit test — the script has no
importable pure part and the assertion that matters is what a production row
prints. Run pasted in the PR body.

**Ref.** diag/so-history-full-values, 2026-09-10.
