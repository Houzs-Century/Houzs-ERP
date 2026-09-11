## The label and the build it names were both counted, so a sofa read one seat too big [high]

<!-- status: fixed -->

<!-- area: AutoCount sync + write-back -->

**白话.** 账本上有些沙发，销售写了「3S」之后又用括号写清楚「(2+1)」——同一张沙发，
写两遍，第二遍是解释第一遍。我们的读单程式把两遍都算成货：先算一张 3 人位，再算一张
2 人位加一张单人位。结果一张沙发被读成两张。三张**已经 proceed、工厂在做**的单
（MRS ONG、JACK GUN、TAN RU YI）因此在对账报告上显示「和账本不一样」。

**ERP 本身是对的，错的是我们读账本的程式。** 如果照报告「跟账本改」，反而会凭空多做
一张沙发出来。已修好读单程式；ERP 的单据一行都没有动。

**Symptom.** The 2026-09-08 reconcile (`SHOW=400`, run `34212598908`) reported
`SO VARIANT sofa compartments — 8 DIFFER on a PROCEEDED order`. Three of those
eight were the same shape — the book appearing to ask for pieces the ERP does
not hold:

```
SO-009335 DtlKey 639683 (ERP HC-SO-009335 8050-1A(LHF)):
  AutoCount "2S+1A(LHF)+1A(RHF)" vs ERP "1A(LHF)+1A(RHF)" — MISSING 2S
SO-010458 DtlKey 722365 (ERP HC-SO-010458 8051-2A(LHF)):
  AutoCount "2A(LHF)+1A(RHF)+2S+1S" vs ERP "2A(LHF)+1A(RHF)" — MISSING 1S, 2S
SO-011114 DtlKey 764705 (ERP HC-SO-011114 9058-2A(LHF)):
  AutoCount "2A(LHF)+1A(RHF)+2S+1S" vs ERP "2A(LHF)+1A(RHF)" — MISSING 1S, 2S
```

All three are PROCEEDED with a purchase order already raised: `HC-SO-009335`
IN_PRODUCTION (MRS ONG), `HC-SO-010458` READY_TO_SHIP and already RECEIVED
(JACK GUN), `HC-SO-011114` IN_PRODUCTION (TAN RU YI).

**Root cause (traced).** The rule was already in the decoder, with the owner's
own attribution — `scripts/lib/parse-sofa.mjs`:

```
// a label followed by a parenthesised BUILD is just a title: the bracket
// wins (owner 2026-08-10: "2R(1+1) 就是 1A+1A"; "2 seater (1EL+1ER)").
```

Both of its regexes were anchored `\)\s*$`, so the rule only fired when the
bracket ENDED the segment. It fires on the owner's examples written clean and
misses every spelling the shop floor actually uses — proven by running the two
patterns over the live segments:

```
"2 seater ( 1EL + 1 ER)  change"   RX1 misses   RX2 misses
"3S (2+1)(32'Inch)"                RX1 misses   RX2 misses
"3S(28'Inch)(2+1)"                 RX1 misses   RX2 misses
"2R(1+1)"                          RX1 FIRES    RX2 FIRES
```

Three things defeat the anchor, and all three are ordinary: a SIZE bracket
after the build (`3S (2+1)(32'Inch)`), a size bracket before it
(`3S(28'Inch)(2+1)`), and residue the special-order strip leaves behind
(`2 seater ( 1EL + 1 ER)  change`). With the rule stood down, the label decodes
as pieces and the bracket decodes as pieces, and the line carries both.

**The clarification is what broke it.** The ERP's own `description2` on
`HC-SO-010458` and `HC-SO-011114` reads `3S(32’Inch)` and `3S(28’Inch)` — no
`(2+1)`. The bracket was added in AutoCount AFTER the cutover import, by a
salesperson making the build explicit. The ERP therefore holds the build the
standing 3S rule produced and is correct; the annotation meant to remove doubt
is what made our reader see the sofa twice.

**PROVEN, not inferred, that the ERP is right.** `probe-sofa-absent-pieces.mjs`
run `34213198537` read all three documents on a fresh connection. Every ERP
line carries a `linked_ac_dtlkey` — there are no keyless compartments hiding the
"missing" pieces (the failure class of `0704`) — and each purchase order holds
the same multiset, dedicated:

```
HC-SO-009335  8050-1A(LHF) dtl=639683 · 8050-1A(RHF) dtl=639683 · 8050-1S(R) dtl=639684
              -> HC-PO-009776 holds the same three, all dedicated
HC-SO-010458  8051-2A(LHF) dtl=722365 · 8051-1A(RHF) dtl=722365 · 8051-STOOL qty 2 dtl=722366
HC-SO-011114  9058-2A(LHF) dtl=764705 · 9058-1A(RHF) dtl=764705 · STOOL dtl=764706
```

The stools are their OWN book lines (DtlKey 722366 / 764706), which is the
second confirmation that `(2+1)` was never a set: the loose items in these
orders are already modelled as separate lines.

The drawing agrees. `so-items/HC-SO-009335/09f13a3c-.../ac-639683-1.jpg` shows
two seats labelled `1ER + 1EL`, a hatched arm at each outer end — two pieces,
by the owner's own notation where a hatched end block is the ARM and not a
piece. There is no third seat on that slip.

**Fix.** `scripts/lib/parse-sofa.mjs`. The rule keeps its shape and its
attribution; what changes is what is allowed to follow the bracket.

- A SIZE bracket is taken out before the title test — and only for that test,
  so `o.size` still comes off the raw Desc2 (asserted: 32 and 28 are unchanged,
  as are all three fabric codes).
- The trailing tail may hold no digit, so a real extra piece — `3S (2+1) 1S` —
  refuses the rule and keeps today's reading. Dropping a piece silently is
  worse than leaving a line for a human.
- A size is DIGITS plus an optional UNIT, spelled out rather than approximated
  by "starts with a digit". The first draft used the loose test and cost
  `(1R+1NA)30"+C+(1R)32"` its second arm — caught by the corpus diff below, not
  by review.

**Blast radius, measured over the whole committed book.** Every sofa line in
`ac-reconcile-truth.json.gz` decoded with the old decoder and the new one:

```
sofa lines decoded: 10108   unchanged: 10079   MOVED: 29   threw: 0
```

29 lines across 8 distinct Desc2 texts, and every one is this same class — a
label counted on top of the build it names. Four of the eight also rise from
`conf=medium` to `conf=high`. Examples:

```
"[ 3S (2EL+1ER (26")) / Col: HARRING GD8371 02# BEIGE"
  BEFORE 2A(LHF)+1A(RHF)+2A(LHF)+1A(RHF)   AFTER 2A(LHF)+1A(RHF)
"4S (60cm)  (2s+2s) / Colour: PT006-13"
  BEFORE 2A(LHF)+2A(RHF)+2S+2S             AFTER 2S+2S
"3S(2+L )(28")/Col:BO315-3 Beige"
  BEFORE 2A(LHF)+1NA+2NA+L(RHF)            AFTER 2A(LHF)+L(RHF)
```

**No ERP row was written by this change.** Nothing was inserted, updated or
deleted; there is no apply workflow and no outbox row, so stock, MRP readiness
and the money columns cannot have moved. The write-back is out of scope by the
owner's ruling of 2026-09-08 (「写回autocount的你不需要理了」).

**Pinned.** `scripts/lib/parse-sofa.test.mjs` gains two tests carrying the three
verbatim live strings, the seat/colour non-movement, the `(1R)` regression, and
`3S (2+1) 1S` standing the rule down. Both fail RED on the unfixed tree. The 712
-row generated corpus suite (`autocount-sofa-collapse.test.ts`, 71 tests) and
the 171 script-lib tests stay green.

**Ref.** `fix/sofa-proceeded-eight`, 2026-09-08. Runs `34212598908` (reconcile,
before), `34213198537` (ERP evidence on a fresh connection).
