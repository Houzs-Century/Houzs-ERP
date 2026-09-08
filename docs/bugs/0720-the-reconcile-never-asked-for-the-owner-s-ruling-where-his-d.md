## The reconcile never asked for the owner's ruling where his drawing is the only source [high]

**Symptom.** The owner, three times on 2026-09-08, about the sofa report he was
being handed: 「这个很多我刚刚都给过你答案了啊」, 「你不是会解析照片了吗？为什么
还需要我呢」, 「你确定你读不出？…现在说剩下109不会？」. He had read his own order
slips, given his answers, and watched them be written into the ERP — and the
next run of the sales-order tally still listed those same sofas under **CANNOT
BE COMPARED — your drawing decides these**. Every run asked him again for
answers he had already given.

**Root cause (traced).** `backend/scripts/lib/variant-reconcile.mjs`, the
compartment axis of `compareLine`. The owner's rulings were consulted on exactly
ONE of the two branches:

```js
if (book.compartments === null) {
  cell.verdict = UNREADABLE;          // <- his ruling was NEVER asked for here
  cell.book = "(cannot be read from Desc2)";
  cell.detail = book.why.join("; ");
} else {
  ...multisetDiff...                  // <- and only here, on a DIFFER
  const ruling = erpNo && deps.sofaRuling ? deps.sofaRuling(erpNo, erpLines) : null;
```

So the lookup ran only where the account book's Desc2 DECODED into pieces and
the two sides then disagreed. The branch it never ran on is the one where the
book's text does **not** state the build at all — which is precisely the case
his standing rule 「一律跟账本。除了sofa compartment而已啊」 reserves for his
drawing, and therefore precisely the case where a ruling he has already given is
the only thing that can answer.

The result is stable and self-renewing: a sofa he has personally read, ruled and
had written into the ERP still has an undecodable Desc2 for ever, so it reports
as unanswerable for ever.

Measured against the 2026-09-08 book snapshot
(`backend/scripts/data/ac-reconcile-truth.json.gz`, exported 00:03:44Z) and the
two corrections files: of the 109 documents the tally called "cannot be
compared", **20 already carried his own written ruling** —
`HC-SO-000814`, `002861`, `008942`, `011008`, `011733`, `011957`, `012025`,
`012107`, `012277`, `012636`, `012828`, `012877`, `012929`, `013000`, `013312`,
`013320`, `013328`, `013384`, `013385`, `013389`.

The observation that would have refuted this — and did not — was cheap: cross
the tally's unanswerable list against the `docs` arrays in
`sofa-compartment-corrections-2026-08.json` and `-2026-09.json`. Nothing had
ever crossed them, because the report's own vocabulary said those documents had
no answer, and the corrections file said they did.

**Fix.** Ask for the ruling on the UNREADABLE branch too, with the SAME lookup
(`deps.sofaRuling`, which `lib/sofa-rulings.mjs` already builds and which
already excludes the `_held` list) and the SAME strictness the DIFFER branch
uses. A build he ruled and the ERP holds as an exact multiset now reads `RULED`;
anything else stays `UNREADABLE` and therefore keeps locking.

This is a NARROWING of "we could not tell", not a widening of "it matches", and
three of the four tests exist to prove that:

- a ruling the ERP has **not** been moved to leaves the cell `UNREADABLE` and
  now names the answer it is failing to match;
- no ruling at all leaves it `UNREADABLE` with no mention of the owner;
- an ERP carrying **no** compartments cannot be rescued by a ruling.

The first test — ruled, held exactly, expect `RULED` — was proved RED on the
unfixed tree (`AssertionError ... actual 'UNREADABLE', expected 'RULED'`), and
the three controls passed both before and after, which is what shows the
permissive answer is still unreachable for a build nothing decided. All 27 tests
in `scripts/lib/variant-reconcile.test.mjs` pass, and all 190 across
`scripts/lib/*.test.mjs`.

**Related.** `docs/bugs/0714` fixed the same class on the DIFFER branch alone
and this branch was missed; the two are now consistent.

**Ref.** `fix/so-close-37-and-109`, 2026-09-08.
