## A 3S sofa decodes to 2+1 by rule and the book's drawing said 1+1+1 [medium]

<!-- area: AutoCount sync + write-back -->

**白话.** 账本那一行只写了「3S(28")」——三个位，没写怎么分。我们有一条老板自己定
的规矩：座深不是 24" 的 3S 就拆成 2+1。所以 ERP 出来是 2+1。可是同一行**图**画的是
1+1+1，三张单人位。老板说以图为准，所以这一张单改成 1+1+1。**规矩没有改**，只有这
一张单按图改过来。

**Symptom.** The shop floor, relayed by the owner on 2026-09-08:

> "So013475 item 2 matching incorrect. Autocount drawing is 1+1+1. ERP 2+1.
> please check & correct it, this urgent bill"

**Root cause (traced).** The book's line for `HC-SO-013475` item 2 is DtlKey
`924983`, `DSL-8030 SOFA`, and its Desc2 is:

```
3S(28") Clr: HR805-30 -Wrap bottom to nylon  -Fully covered to bottom (replace legs)
```

`scripts/lib/parse-sofa.mjs` turns a `3S` at any seat depth other than 24" into
`2A(LHF)+1A(RHF)` — the rule is in the decoder with the owner's own attribution,
`3S→2A+1A(owner 定规:座深≠24" 必拆)`. Run over the live row, the decoder still
answers that today:

```
from line 2 Desc2: pieces [2A(LHF), 1A(RHF)]  confidence medium
     why: ... 3S→2A+1A(owner 定规:座深≠24" 必拆)
```
(probe run `34199176419`, `probe-sofa-absent-pieces.mjs`, section D)

So the ERP was not wrong about the TEXT. The text does not say how the three
seats are split, and the DRAWING attached to the same line does —
`so-items/HC-SO-013475/4b274c15-0260-4861-a47b-9748ab8cd792/ac-924983-1.jpg`,
three separate seats. This is the class `sofa-compartment-corrections-*.json`
exists for: a per-document owner ruling that overrides the decoder where the
drawing is the only source.

**This is NOT a licence to re-decode every 3S.** The rule is the owner's and it
stands; only this document was ruled on. A sweep that rewrote every `3S` in the
book would change hundreds of live builds on the strength of one slip.

**Fix.** One entry added to
`backend/scripts/data/sofa-compartment-corrections-2026-09.json` —
`HC-SO-013475`, model `8030`, pieces `1A(LHF)+1NA+1A(RHF)`, seat `28`,
`desc2Match: "3S(28\")"` so line 1 of the same order (a different build,
`2S(35")`) is not touched. Applied by
`apply-sofa-compartment-corrections.mjs`, run `34199823824`: 2 lines updated, 1
added, 0 removed, no PO / GRN / DO / invoice line downstream, money unchanged at
RM 0.00 on both columns, verified on a fresh connection as the multiset
`1A(LHF)+1A(RHF)+1NA`.

It went into the existing `-2026-09.json` rather than a new `-2026-09-08.json`
because a fourth file whose name also contains `2026-09` would make the `FILE=`
substring filter select two rounds at once —
`scripts/lib/sofa-corrections-source.test.mjs` pins that, and it failed RED on
the first attempt, which is how the collision was found rather than shipped.

**What this MOVED, and what it deliberately did not.** The reconcile's own
count of disagreements was **40 before and 40 after** — runs `34199669066` and
`34199937397`, every cell of the summary table identical. The one axis that
moved is the one that should: `SO VARIANT sofa compartments` went `2 DIFFER on a
PROCEEDED order` to `3`, and the third is this document, because the ERP now
deliberately disagrees with the book's TEXT. That axis is not part of the 40.

**The sweep this belongs to, measured rather than assumed.** The whole-population
compartment audit (`check-sofa-bedframe-completeness.mjs`, run `34199783580`,
`all_so=1`) reports 50 sofa lines on 35 sales orders whose compartments disagree
with the decoded Desc2 — but 4 of those 35 are documents the owner has ALREADY
ruled on, so the disagreement there is the ruling working. On the PROCEEDED
population (run `34199639532`) **every** flagged document is an owner ruling:
the live backlog outside the corrections file was zero, and `HC-SO-013475` — not
yet proceeded when it was reported — was the exception nobody's audit was
looking at.

**Ref.** `fix/staff-reported-flow`, 2026-09-08. Runs `34199176419` (evidence),
`34199573796` (dry run), `34199823824` (apply), `34199669066` / `34199937397`
(reconcile before / after), `34199639532` + `34199783580` (the class sweep).
