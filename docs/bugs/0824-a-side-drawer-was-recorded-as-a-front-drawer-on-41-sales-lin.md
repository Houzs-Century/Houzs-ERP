## A side drawer was recorded as a front drawer on 41 sales lines, and the customer got a delivery order saying Front [high]

**Symptom.** Purchasing, 2026-09-12, on `HC-SO-003434` / `HC-DO-2609-058`
(customer Chris Tang, HC4681): *"this cus req sidedrawer… but the SO in ERP
suddenly mention Front Drawer while the DO only write front Drawer"*. The owner:
「明明写的是 side drawer，怎么会换成 front drawer 呢？…这种数据怎么可以这样子呢？」

The line's own preserved book text is `Sidedrawer/PC151-01/Divan12/gap10`, and its
`variants.specials` reads `["Front Drawer"]`. The delivery order printed what the
line said, so a customer who asked for a side drawer was handed paperwork for a
front one.

**Root cause (traced to the line).** `scripts/lib/parse-bedframe.mjs`:

```js
if (/LEFT\s*DRAWER|DRAWER\s*(?:AT\s*)?LEFT/i.test(s)) …   // needs a SPACE
if (/RIGHT\s*DRAWER|…/i.test(s)) …
if (/FRONT\s*DRAWER|…/i.test(s)) …
if (/DRAWER/i.test(s) && !…) o.specials.push("Front Drawer"); // unqualified drawer = front
```

The hand tests all demand a space. The book writes it as ONE word —
`Sidedrawer`, `sidedrawer`, `Leftside Drawer`, `2SIDE DRAWER` — so none of them
matched and every one fell through to the last rule, which files an unqualified
drawer as **Front**. The phrase map (`special-order-phrase-map.json`) has a veto
for `left drawer` / `right drawer`, also space-bound, and no entry for "side" at
all.

**Measured on production, 2026-09-12** (company 1, read-only):

- sales lines whose text mentions a drawer: **147**
- of those, the book asks for a SIDE drawer: **44**
- what we decoded: Front **129**, Left 8, Right 5
- **MISMATCH — book says side/left/right, we say FRONT: 41 lines over 29 sales orders**
- it propagated: 16 purchase lines, 12 goods-received lines, 22 delivery lines carry `Front Drawer`

Split of the 41 by what the customer actually wrote: **9** ask for both sides (a
pair), **5** name the left, **3** name the right, **24** say only "side drawer".

**The catalogue has no neutral option.** `scm.special_addons` holds `Front Drawer`
(RM130), `Left Drawer` (RM160) and `Right Drawer` (RM160) and nothing else — so a
side drawer MUST be resolved to a hand. Owner 2026-09-12 on the money: 「我们的卖价
都是跟着 salesprice 去放的，所以没有影响卖价」 — the price difference does not reach
the customer. The defect is the SPEC, not the charge.

**Fix (this PR).** The decoder reads a hand written with no space and on either
side of the word (`Leftside Drawer`, `add on right side drawer`, `Add left hand
side drawer`, `drawer at the right`), and a side drawer whose hand nobody stated
becomes **`Side Drawer (side unknown)`** — marked so a repair tool can find it and
a human can answer it, never silently filed as Front. Eleven phrasings, every one
transcribed from a real production line, are pinned in
`tests/bedframeDrawerSide.test.mjs`.

**The data repair is separate and follows.** Its sources, in priority order:

1. **the supplier's own record** — the 2026-09-11 export states the hand on 99
   bedframe rows (Front 47, Right 26, Left 26). Matched to our purchase lines: 37
   comparable, **9 agree and 28 differ** (6 Front→Right, 3 Front→Left, 19 where we
   recorded no drawer at all);
2. **the slip's photo** — 24 of the 41 lines carry one, and they are readable;
3. **the salesperson**, for what neither answers.

A drawer is part of `variants.specials`, which composes `computeVariantKey`, so
the repair moves an inventory bucket and must carry the stock with it wherever
goods are already in (`docs/bugs/0722`).

**The side is read AS YOU LOOK AT IT**, never as the sleeper lies — owner
confirmed 2026-09-12 on two documents, one slip drawing and one photo of an
installed bed, both RIGHT. Recorded in
`backend/scripts/data/drawer-side-owner-rulings.json`.

**Ref.** fix/drawer-side, 2026-09-12.
