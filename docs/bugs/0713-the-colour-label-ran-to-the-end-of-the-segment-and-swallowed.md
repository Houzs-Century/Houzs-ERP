## The colour label ran to the end of the segment and swallowed the build [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 账本上写沙发的那一行，有的用斜线分段，有的（比较新的单）不用斜线，改成
**空两格**分段。我们读账本的程式只认斜线，所以碰到空两格那种写法，「颜色：」后面
**整行都被当成颜色吃掉了** —— 沙发是几件、几寸、要做什么特别处理，全部不见。
结果两件事：一是那张单变成一件式 `-1S` 的空壳，要人看图补；二是对账的时候系统说
「账本没有要求任何特别处理」，其实账本白纸黑字写着「底部包尼龙布」。
修好之后，账本里 **72 行**重新读得出沙发件数，**274 行**把账本本来就写着的特别要求
拿回来了；**没有一行**原本读得对的变样。

**Symptom.** Two shapes, both on the 2026-09-08 cutover reconcile.

1. Sofa lines sitting on the bare `{model}-1S` placeholder whose AutoCount text
   plainly states a build. `SO-009072` holds
   `colour : HR805 -31 ( 30 inch )  1EL  + C + 1 NA + 1ER` and decoded to
   **nothing at all**.
2. Four PROCEEDED sales orders reported on the specials axis with the BOOK
   holding nothing and the ERP line carrying the request — `SO-010121`,
   `SO-010123`, `SO-013384`, `SO-013385`. The reconcile was told the book asked
   for nothing; the book asks for `wrap bottom to umbrella fabric`.

**Root cause (traced).** `backend/scripts/lib/parse-sofa.mjs`, the labelled
colour pass. It captured `[^\/\n]+` — everything to the next slash or newline:

```js
d2 = d2.replace(/col(?:our|or)?\s*[-:：]\s*([^\/\n]+)/gi, (_, val) => {
  if (!o.color) o.color = val.trim(); return " ";
});
```

and the special-order sweep above it DELETED the same span
(`col(?:our|or)?\s*[-:：][^\/\n]*` -> `" "`) before it ever looked for an
instruction. On a slash-separated Desc2 that is right: the next slash ends the
field. **A large and growing part of the book has no slashes** — the fields are
separated by a DOUBLE SPACE — so the label ran to the end of the line and took
the build, the seat size and every instruction with it.

Observed rather than reasoned: run over the committed snapshot
`backend/scripts/data/ac-reconcile-truth.json.gz` (exported 2026-09-08), **382
of 10,696** sofa Desc2 carry a colour label whose captured value contains a
double space. `parseSofa` on `SO-010121`'s own text returned
`color: "tbc  wrap bottom to umbrella fabric"`, `specials: []` — the colour is
not a colour, and the instruction is gone.

**Fix.** The label still runs to the end of its segment; it now STOPS EARLY where
what follows identifies itself as something other than a colour —

- a piece list, every `+`-separated token of which is a known compartment token;
- a seat size (`( 30 inch )`, `32 inch per seat`), which is never part of a
  shade's name and is moved out of the value even when it is glued on with a
  single space;
- an instruction from `SPECIAL_WORD`, the vocabulary the sweep already speaks.

The cut is POSITIVE, never speculative: a double space alone does not end the
colour, because a shade's own name contains one (`COL- BEETEX     HARRING 8371
04#COFFEE`, `SO-006112`, where the tail is more colour). What is cut off is
handed back to the pipeline carrying the book's own separator, and a gap next to
a `+` is treated as sloppy typing inside one chain rather than a field boundary
(`1EL  + C + 1 NA + 1ER` is one build). `PERSET` joins `PERSEAT` in the noise
vocabulary — "30 inch per set" is a unit, and it was becoming a special order the
factory would be asked to build the moment it stopped being eaten.

Pinned by three tests in `backend/scripts/lib/parse-sofa.test.mjs`, all **proved
RED on the unfixed tree** (2 failing, the other 8 passing) before the change:
the build survives, the specials survive, and the wide-gap colour is NOT
truncated — that third one passed before and after, which is what makes it a
regression guard rather than a restatement of the fix.

**Measured over the whole committed corpus — 2,239 distinct (model, Desc2)
pairs, 10,111 sofa lines, both `recl` settings:**

| | pairs | lines |
| --- | --- | --- |
| a build that decoded before and **no longer does** | **0** | **0** |
| a build that decoded before and now decodes **differently** | **0** | **0** |
| decoded to nothing before, decodes now | 6 distinct texts | **72** |
| specials recovered | 71 | **274** |
| colour value corrected (a size or an instruction taken out of it) | 5 distinct texts | **42** |
| specials **lost** | **0** | **0** |

All 41 newly recovered special strings were read by hand: 40 are factory
instructions the book states (`wrap bottom to Nilon` x107, `fully cover replace
the leg` x25, `no hole on sitting area` x8), and the one that was not — `PERSET`
— is the reason for the noise-vocabulary line above. Two of the 40 read as
truncated (`wrap bottom t`, `PO-008244`); the BOOK is truncated there, and this
migration copies rather than computes.

**What this does NOT do.** It does not touch a single production row. The six
recovered builds are sitting on `SOFA UNPARSED` placeholder lines today, and
`backend/scripts/redecode-collapsed-sofa-lines.mjs` is the tool that gives them
their compartments back — it re-derives from the book's own words and selects
exactly the rows this now decodes. **That has not been run. UNTESTED.**

**Ref.** `fix/sofa-1s-placeholder`, 2026-09-08. Evidence is the committed
snapshot plus `node --test backend/scripts/lib/parse-sofa.test.mjs`; the corpus
before/after is reproducible from `ac-reconcile-truth.json.gz` and
`autocount-erp-mapping-1561.csv`, both in the tree.
