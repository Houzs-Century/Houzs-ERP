## A sofa was refused for a seat size it does not have, and for a special order that need not travel [high]

**Symptom.** The owner asked 「看下是不是全部都有解决办法了额」 — is there a way out
for every remaining document. Eleven sales orders were refused on the sofa
grammar. Measured against production with `check-sofa-refusals.mjs`
(run on 2026-09-10), six of those refusals were not about the sofa at all.

**Root cause 1 — `3S` was withheld for a case these documents are not in.**
`tokenFor` returned `null` for `3S`, and the reason was correct as far as it
went: `3S (28")` decodes to the two-piece build `[2A(LHF), 1A(RHF)]` — a
DIFFERENT sofa — on all ten models the refusals name. But bare `3S` decodes to
`[3S]` on all ten, and production says `HC-SO-001640` `[3S]` and `HC-SO-001472`
`[3S, 1S, 2S]` both carry **`seat size NONE`**. Withholding the token refused the
case it was safe for, for the other case's reason.

The protection has not been dropped, it has MOVED to where every other spelling
in this file is judged: `tokenFor` proposes `3S`, and `decodesTo` — which sees
the real seat size — refuses the sized case. `sofaPlainSeatSpelling.test.ts`
asserts both halves over all ten models.

**Root cause 2 — the special order blocked documents in three disguises, and the
owner had already ruled it need not travel.** 「Special Order 可以不进 ... 最重要是
每一张单都可以进到就行了」 was applied to LENGTH only. Measured, the special was the
whole obstacle in two more shapes:

- `composeSofaDesc2` refuses a special containing `+` or `/` — it would read as a
  second structure segment — and the refusal then said **"cannot spell
  [2A(LHF), STOOL]"**, naming the pieces and blaming them (`HC-SO-001526`,
  `HC-SO-001445`).
- The decoder reads specials from a FIXED vocabulary, so `ALL` and `DAYBED` never
  come back and the round trip failed on a build that was otherwise perfect
  (`HC-SO-008302`, `HC-SO-004716`).

The compose is now one `attempt` tried twice — once with the ERP's specials, then
once with `Special Order: Refer to ERP` — so the pointer covers every way a
special can block a document, not only length. **The refusal reported is the
FIRST attempt's**, because the honest diagnosis is what is wrong with the
document as it stands, not with a rewrite of it.

**Fix.** Six refusals clear: `HC-SO-001640`, `HC-SO-001472` (spelling);
`HC-SO-001445`, `HC-SO-008302`, and one run each of `HC-SO-001526` and
`HC-SO-004716` (pointer).

**Proved RED on the unfixed tree**: with both changes reverted, 7 of the tests in
`autocount-sofa-collapse.test.ts` fail. Green after: 3,503 passed across
`src/services` + `src/scm`.

**What this does NOT fix, and it is a different fault:** five documents whose
sofa is split across ERP lines that are not adjacent. The account book already
says which lines are one line — they share a `DtlKey` — and the collapse forms
its runs by adjacency instead. That is `docs/bugs/0776` [planned].

**Ref.** `fix/sofa-spelling-and-special-pointer`, 2026-09-10.
