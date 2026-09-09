## The colour label spelt `Clr` swallows the piece beside it, so a correct sofa reads as a difference [medium]

<!-- status: open -->

<!-- area: AutoCount sync + write-back -->

**白话.** `HC-SO-007293` 这张沙发，**ERP 里是对的，账本里也是对的，是我们读账本的
程式读漏了。** 账本写的是「2S+L」（两人位加一张贵妃椅），ERP 里存的正好就是两人位加
贵妃椅。可是我们的程式不认得账本上「Clr:」这个写法的「颜色」两个字，就把紧挨着它的
那个「L」当成颜色的一部分吃掉了，剩下「2S」，於是报告说两边不一样。**这张单不用改。**
真正要改的是读账本的程式，但今晚不改：一改会连带重读账本里另外 119 行沙发，其中一张
是老板今天早上才亲自定过的，改不得。

**Symptom.** The reconcile reports `HC-SO-007293` on the sofa-compartment axis:

```
SO-007293 DtlKey 498788 (ERP HC-SO-007293 9028-2A(LHF)):
  AutoCount "2S" vs ERP "2A(LHF)+L(RHF)" — MISSING 2S | EXTRA 2A(LHF), L(RHF)
```

Read as written, that says the ERP invented a chaise the customer did not order.
It says the opposite.

**The book's own words, from the committed snapshot** (`ac-reconcile-truth.json.gz`,
`exported_at=2026-09-08T00:03:44.762Z`), `SO-007293` DtlKey 498788:

```
"2S+L Clr: B0315-21 Pearl"
```

`2S+L` is a two-seat arm and a chaise. The ERP holds `9028-2A(LHF)` +
`9028-L(RHF)`. **Those are the same sofa.**

**Root cause — our reader, not either document.** Fed the build text alone, this
repo's OWN decoder returns exactly what the ERP holds:

```
parseSofa("2S+L", "9028") -> pieces ["2A(LHF)", "L(RHF)"]
```

Add the colour tail and the `L` disappears:

```
parseSofa("2S+L Clr: B0315-21 Pearl", "9028")
  -> pieces ["2S"],  why: [... 'note "LCLR"' ...]
```

`scripts/lib/parse-sofa.mjs:283` knows the colour label as
`/col(?:our|or)?\s*[-:：]\s*([^\/\n]+)/gi` — `COL:`, `COLOR:`, `COLOUR:`, `COL-`.
It does **not** know `Clr:`. So `Clr` is never consumed as a label, the tokeniser
glues it to the `L` standing in front of it, and the pair leaves as the note
`LCLR`. The piece is not mis-read; it is eaten by a label the decoder cannot see.

The same document decodes correctly the moment the label is spelt a way the
decoder knows — `"2S+L Col: B0315-21 Pearl"` returns `2A(LHF)+L(RHF)` and the
colour as well.

**Why the one-line fix was NOT taken on cutover day.** Teaching the label the
`Clr` spelling is two characters of regex. Its blast radius was measured, not
estimated: a patched copy of the decoder was run over every sofa-category line
in the committed snapshot — **10,108 lines carry a Desc2, and 120 of them decode
DIFFERENTLY** with the change. Most go from unreadable to readable, which is the
improvement this fix is for. Two of them are why it must not ship tonight:

| document | what changes |
| --- | --- |
| `SO-013475` | today `pieces []`; with the fix `pieces ["2S"]` **and** the colour reads `"HR805-30 -Wrap bottom to nylon"` — an INSTRUCTION pulled inside the colour. This is the sofa the shop floor reported and the owner ruled on 2026-09-08. |
| `SO-003951` | `1EL/T(35")+ 2ER(35")` today reads as nothing; with the fix it reads as `["2S"]`, which is not what that slip says either. |

So the change turns 120 book lines into new answers on go-live day, some of them
wrong in a new way, and one of them on a document the owner personally decided
this morning. That is a re-decode, not a repair, and it belongs to a lane that
can measure each of the 120 against a drawing.

**What this means for the tally.** `HC-SO-007293` is a **reader gap, not work.**
The ERP is right, the book is right, and no row on that document should be
touched — cutting the ERP back to the reader's `2S` would destroy a correct
reading, which is the one direction the compartment axis must never move
(「一律跟账本。除了sofa compartment而已啊」). The order is NOT PROCEEDED, so
nothing is being built from it in the meantime.

**What a fix must do.** Teach `parse-sofa.mjs` the `Clr` spelling of the colour
label, and in the SAME change re-measure all 120 affected lines — the two named
above are known to need a drawing, not a regex. The measurement harness is three
lines: decode every sofa-category Desc2 in `ac-reconcile-truth.json.gz` with the
old and new decoder and diff the results.

**RE-MEASURED 2026-09-09, and the blast radius is now known PER DOCUMENT TYPE —
which is what decides who may ship it.** The measurement above said "120 lines
decode differently" without saying on which documents. Re-run against the
current decoder and the 2026-09-09 book cut
(`ac-reconcile-truth.json.gz`, `exported_at=2026-09-09T00:18:49.235Z`), over
every sofa line of every one of the six types, with `Clr` added to BOTH colour
regexes at `scripts/lib/parse-sofa.mjs:279` and `:283`:

```
target old: []
target new: ["2A(LHF)","L(RHF)"]          <- HC-SO-007293 is fixed by the change
scanned 30893 sofa lines with a Desc2 across all six types
lines whose decode CHANGES: 1362
by document type: {"SO":299,"PO":224,"GR":230,"DO":215,"IV":171,"PI":223}
of those, the COMPARTMENTS change on: 96 (the rest are colour only)
compartment changes by type: {"SO":20,"PO":16,"GR":16,"DO":16,"IV":12,"PI":16}
```

**So the two-character regex moves 44 lines on DELIVERY ORDERS, SALES INVOICES
and PURCHASE INVOICES.** The sales-order / purchase-order / goods-receipt lane
that re-measured this is under a standing control that no other document type's
figures may move on its merges, so it cannot be the lane that ships this — not
because the fix is wrong, but because it is not that lane's number to move. It
needs a change that owns all six types at once and can re-measure each of the 96
against a drawing, exactly as the paragraph above asks.

**A ruling file cannot stand in for it either, and the reason is worth writing
down.** Recording `2A(LHF)+L(RHF)` for `HC-SO-007293` in
`sofa-compartment-corrections-*.json` WOULD take the document out of the differ
column — but the reconcile prints a matched ruling as *"the owner read the slip
HIMSELF and set the sofa build against the book's own words"*
(`lib/variant-report.mjs`). He did not; our reader has a gap. Buying a clean
number with a sentence that puts a decision in his mouth is the wrong trade, and
this line exists so nobody makes it later.

**Still true, and still the point:** the ERP is right, the book is right, no row
on `HC-SO-007293` is to be touched, and the order is NOT PROCEEDED.

**Ref.** `fix/so-last-6-and-gr-transpose`, 2026-09-08. Measured against the
committed snapshot; no production read was needed to establish any of it.
