## A dead fabric row's obituary travelled into the account book's sofa build [high]

**Symptom.** Five sofa orders could not reach AutoCount, and two different
refusals were the same fault wearing two faces. Read off production 2026-09-09
(`too-long-for-the-book` run `34396774391`), this is what the write-back was
trying to send:

```
LR + 2EL / COL: BO315-3 [superseded by BO315-03 on 2026-08-11] / BOTTOM USE UMBRELLA FABRIC / Nylon Fabric
```

- **Over the column** — `HC-SO-008460` at 112 characters, `HC-SO-012513` at 113,
  `HC-SO-012629` at 117, against a field that holds 100. **`[superseded by
  BO315-03 on 2026-08-11]` is 39 of them**, and it is not a specification.
- **Round trip refused** — `HC-SO-004725` and `HC-SO-007958`:
  `colour decodes as "J9226-2 BUTTERCREAM  superseded by J9226-02 on 2026-08-11",
  expected "J9226-2 BUTTERCREAM [superseded by J9226-02 on 2026-08-11]"`. The
  brackets do not survive the decoder, so the text and the expectation could
  never agree.

**Root cause (traced).** The fabric library renumbered itself on 2026-08-11 and
left each old row in place with the note written into the row's own LABEL. A line
still pointing at the dead row therefore renders 39 characters of bookkeeping in
the middle of the build. `buildVariantSummary` has stripped it since the day that
was found — and `liveColour`, the helper that does it, was a **local const inside
that function**, so it protected exactly one renderer.

A sofa does not go through that renderer. `composeSofaDesc2` builds its Desc2 by
its own path, and `collapseRun` handed it `v.colourLabel` raw. The comment above
`liveColour` even names `HC-SO-012513` at 113 and `HC-SO-012629` at 117 — the fix
was written with these documents in view and could not reach them.

**Fix.** `liveColour` is lifted to module scope and exported, in both mirrors of
`variant-summary.ts`, and `collapseRun` applies it. It is applied to the
**expectation as well as to the text**, because `colour` is the one value handed
to both `composeSofaDesc2` and `decodesTo` — which is why one change closes both
faces of the fault instead of trading a length refusal for a colour mismatch.

Four tests in `backend/src/services/autocount-sofa-collapse.test.ts`, **proved
RED** on the unfixed tree.

**Also in this change, and a separate fault:** the length gate at the top of
`collapseRun` refused a document on its STORED `description2` — the ERP's own
line summary, which is never what a sofa sends. `HC-SO-013339` is refused today
at 107 stored characters without the composer being asked at all. The gate moved
into the ECHO branch, which is the only branch that sends that string. This does
NOT promise the document then goes: the composed text has its own gate, and a
long specification is long whichever renderer writes it. It removes a refusal
that never consulted the text being sent.

**Ref.** `fix/sofa-desc2-live-colour`, 2026-09-09.
