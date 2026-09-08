## 674 line photos sit where the owning line is chosen by position, and not one of those groups can be told apart by colour [medium]

**Not a defect report — a MEASUREMENT that settles a deferred decision.**
`docs/bugs/0672` site 9 recorded that `planRepoint`
(`scripts/lib/line-photo-keys.mjs`) groups by `(document, AutoCount DtlKey)` and,
where the book gives no line key of its own, sends the picture to
`firstRow(group)`. The recommendation on file was explicit: **look at the number
before deciding.** Nobody had. The number did not exist in any instrument —
`probe-line-photo-coverage.mjs` counts rows and never groups,
`probe-line-photo-gap.mjs` groups by DtlKey ALONE (`:83`) rather than by
`(doc, key)`, and `probe-link-identity.mjs` counts group cardinality but never
joins `photo_urls`.

**PROVEN — `probe-pairing-colour-and-photo-ambiguity.mjs` (new, read-only), run
34180583537, 2026-09-08 10:35 local, conclusion `success`, company 1:**

| | sales order | purchase order |
|---|---|---|
| lines carrying a book line key | 14,807 | 1,309 |
| `(document, key)` groups | 14,343 | 1,137 |
| groups holding MORE THAN ONE row | **310** (2.2%) | **109** (9.6%) |
| of those, groups actually holding a photo | 252 | 104 |
| photos in them | **512** | **162** |
| groups whose rows can be told apart by COLOUR | **0** | **0** |
| multi-row groups that are one model decomposed into compartments | **310 of 310** | **109 of 109** |
| book line keys carried on MORE THAN ONE document | **0** | **0** |

**674 photos, and colour discriminates in ZERO of the 356 groups that hold one.**

**The decision, and it is the opposite of what a colour rule would have given.**

- A colour-based discriminator was the obvious candidate and it is now
  **provably useless here**: 0 of 356. Refusing every group it cannot separate
  would drop all 674 photos.
- **No photo at all is the worse failure.** The factory builds from the
  photograph — that is the whole reason the sofa slip is scanned — while a photo
  on a sibling row of the SAME document is visible to a human and moves neither
  money nor stock.
- **Every one of the 419 multi-row groups is ONE model decomposed into its
  compartments** (`decomposeGroup`, the module that owns that rule). So the
  "wrong line" is another compartment of the SAME sofa on the SAME document,
  photographed by the same slip. There is one picture per book line and the book
  holds one line per sofa; there is no second photo it could be stealing.
- **Nothing spans two documents: 0 keys on either arm.** That was named up front
  as the finding that would change the answer, and it did not occur.
  `planRepoint` cannot cross a document by construction — `doc` is in its group
  key and its candidates come from `onDoc.get(doc)` — but the count is taken
  anyway, because the OTHER instruments (`probe-line-photo-gap.mjs:83`) group by
  key alone and would not have shown it.

**So: keep the current default. No code changed.** `firstRow(group)` stays, and
the `isOneModel` refusal added by `docs/bugs/0684` stays as the outer guard —
which is doing real work, since it is the only thing standing between a photo and
a genuinely unrelated product.

**What would change this answer,** written down so the next reader does not have
to re-derive it: a key appearing on two documents (currently 0), a multi-row
group that is NOT one model (currently 0 of 419), or a second distinct photo
arriving for one book line. Re-run the probe; all three are on its face.

**One thing the run did NOT settle, and it is a defect somebody should close.**
`import-so-line-photos.mjs:176` and `import-po-line-photos.mjs:153` both log the
ambiguous candidates' `variants` — and neither SELECT projects `variants`
(`:55` and `:56`). Every one of those log lines has always printed `null | null`.
`docs/bugs/0684` justified leaving site 10 unguarded on the grounds that "each is
logged with its candidates' variants"; that evidence is empty. Given the 0-of-356
measurement above the guard is still not the answer, but the LOG should say what
it claims to say. Not fixed here — it is another agent's lane.

**Ref.** fix/do-colour-guard-attribution, 2026-09-08.
