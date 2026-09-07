## The SO-line census hid 70 of its 85 unjudgeable documents, so it could not answer the one question it was dispatched to answer [medium]

**Symptom.** `topup-ac-so-lines.mjs` was written to find, among other things, the
4 x `HOK-SQUARE PILLOW` at RM 0.00 that `HC-SO-012128` carries in AutoCount and
the ERP document did not. Its first production run (34160962831) named 31
missing lines across 20 documents — and `HC-SO-012128` was in NONE of them, nor
in the printed part of the UNJUDGEABLE list. The run could neither confirm the
line was already there nor say it could not judge it.

**Root cause (traced).** The UNJUDGEABLE listing was capped at a literal 15 with
a `... and 70 more` tail that names nothing:

```
for (const u of unjudgeable.slice(0, 15)) log(...);
if (unjudgeable.length > 15) log(`   ... and ${unjudgeable.length - 15} more`);
```

85 documents hold an ERP line with a NULL `linked_ac_dtlkey` and are therefore
not compared at all — correctly, because the key is the match and a document
missing one cannot be judged without guessing. But 70 of those 85 were unnamed,
so "is document X unjudgeable?" had no answer, and the report read as if X had
been checked and found clean. A summary that hides the members of its own
exception set turns a REFUSAL TO JUDGE into an apparent PASS — the same shape as
"a verdict computed over nothing must never read as a pass".

**Fix.** The list respects `TOP` (default 60) like every other section, prints
`book N lines (M at RM 0.00) vs ERP K, J of them with no AutoCount key`, and
marks `<- SHORT` where the book side is longer than the ERP side — the candidate
misses hiding behind the missing keys — with a count of those at the top. The
remedy for the whole class stays `backfill-ac-line-keys.mjs`, which is what puts
the keys on and shrinks this set.

**Ref.** fix/ac-so-line-census-blindspot, 2026-09-08.
