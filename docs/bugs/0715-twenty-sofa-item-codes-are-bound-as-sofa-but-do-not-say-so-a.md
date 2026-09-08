## Twenty sofa item codes are bound as SOFA but do not say so, and a bare -1S is what that looks like [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 有十六张单，我们这边写着「2379-1S」（一个位的沙发），账本那边写的却是
两件、三件的真沙发。第一个想法是「读账本的程式看不懂 2379 这款的写法」——
**查过了，不是**：把这十六行的原文拿去跑我们的解码程式，十四行里有十二行今天就
读得出正确的件数。

真正可疑的地方在**货品编号**。账本给沙发的编号有两种写法：`DSL-8051 SOFA` 这种
带「SOFA」字样的，和 `THL-2379` 这种不带的。对照表里 `THL-2379` 的分类**写明是
SOFA**，可是编号上看不出来。程式里有几个地方是**看编号有没有「SOFA」这个字**来
决定要不要拆件的，`THL-2379` 一律不算沙发，就直接把对照表给的 `2379-1S` 原封不动
搬过来了。

**这一条还没有下结论。** 还差一步：要看生产资料库里那十六行有没有「SOFA
UNPARSED」这个记号。有记号 = 程式试过读不懂；没有记号 = 根本没人叫它读。这一步
要跑 probe 才知道，还没跑。

**Symptom.** Reconcile run `34213899437` reports the sofa-compartment axis as 8
DIFFER on proceeded orders and 34 on not-yet-proceeded. Sixteen of the offenders
have the ERP collapsed to a bare `1S` against a real build in the book, and
nearly all are model `2379`:

```
SO-005013 (2379-1S)  book "1A(R)(LHF)+1NA+1A(R)(RHF)"   ours "1S"
SO-006752 (2379-1S)  book "1A(R)(LHF)+2NA+1NA+2A(RHF)"  ours "1S"
SO-002961 (2379-1S)  book "2A(LHF)+1A(RHF)"             ours "1S"
SO-006890 (2379-1S)  book "1S+2S+3S"                    ours "1S"
SO-001895 (7219-1S)  book "2S+2S"                       ours "1S"
```

**What was RULED OUT — the decoder.** The obvious theory is that model `2379`
writes its builds in a shape `parse-sofa.mjs` cannot read, which would make this
one parser fix rather than sixteen judgements. It is wrong. The sixteen
documents' own AutoCount Desc2, read out of the committed snapshot
`backend/scripts/data/ac-reconcile-truth.json.gz` and run through the real
decoder, produce **12 correct builds out of 14 distinct texts, today, with no
change to anything**:

```
"60cm 3RR/ COL:TBC"        -> 1A(R)(LHF)+1NA+1A(R)(RHF)   high
"60cm/R+2+3/Col:TBC"       -> 1A(R)(LHF)+2NA+1NA+2A(RHF)  medium
"3s(18\")/Col: Armani …"   -> 2A(LHF)+1A(RHF)             high
"1+2+3(60cm)/col:kiv"      -> 1S+2S+3S                    high
"2+2.5S"                   -> 2S+2S                       medium
"2s+1s/60cm/colour (2s):…" -> 2S+1S                       high
```

Those are the same piece lists the reconcile prints as the BOOK column. **The
decoder is not the variable, and this is not a sofa-compartment judgement the
owner has to make.**

**Root cause (the part that IS proven).** The AutoCount item code behind every
one of these lines is `THL-2379` / `THL-7219` — **not** `DSL-8051 SOFA`,
`AMN-SF9028 SOFA`, `HOK-5536 SOFA`. The word "SOFA" is not in the code. The
binding says it is a sofa anyway:

```
THL-2379,2379-1S,NEW,SOFA,400-T002
THL-7219,7219-1S,NEW,SOFA,400-T002
```

Counted over `backend/scripts/data/autocount-erp-mapping-1561.csv` (1,577 rows):
**86 rows are `category=SOFA`, and 20 of them carry no "SOFA" word in the
AutoCount code** — `THL-2376/2379/2391/5133/5135/5142/5150/5152`,
`THL-7179/7202/7212/7218/7219/7221/7223/7226/7233/7238/7251`, `TNS-9838 DB`.
**Every one of the 20 maps to `{model}-1S`**, the bare one-seat compartment,
because the binding needs one representative ERP code and that is the one it
picked. The mirror case exists too and is already known: `AMN-SOFA PILLOW` and
`THL-SOFA PILLOW` carry the word and are category `ACC`
(`check-ac-erp-reconcile.mjs:250` documents that trap).

Two readers decide "is this a sofa?" from the CODE rather than from the
binding's CATEGORY:

- `backend/scripts/import-ac-outstanding-so.mjs:81` — `const isSofa = (c) =>
  /SOFA/i.test(c || "")`
- `backend/scripts/check-ac-erp-reconcile.mjs:258` — `const isSofaCode = (s) =>
  /SOFA/i.test(String(s ?? ""))`

**UNKNOWN, and what settles it.** Whether the sixteen rows were produced by that
code test, by the decoder's placeholder branch, or by a piece SKU that was never
minted (`fullyOk` also requires every `{model}-{piece}` to exist in
`scm.mfg_products`) is **not decided by reading the source**, and the three leave
different fingerprints on the row:

| what the row holds | which cause |
| --- | --- |
| `remark` carries `SOFA UNPARSED` | the decoder tried and refused |
| no marker, and the book states a build | nothing ever asked the decoder |
| decodes, but `{model}-2S` etc. absent from the master | a catalogue gap |

`backend/scripts/probe-sofa-collapsed-1s-cause.mjs` +
`.github/workflows/probe-sofa-collapsed-1s-cause.yml` measure exactly that
split, print the AutoCount code behind every row of the no-marker class, and list
which `{model}-*` piece codes the product master actually holds. It is READ-ONLY
— SELECTs only, no DDL, no transaction, no APPLY input — and it reads the book
from the committed snapshot rather than from `description2`, which is
server-generated on write (`docs/bugs/0639`).

**IT HAS NOT BEEN DISPATCHED. UNTESTED.** A `workflow_dispatch` workflow is only
triggerable once its file is on `main`, so this ships first and is run second —
and per the working agreement it is not "shipped" until a run reports success.
**No conclusion about which reader produced these rows should be drawn, and no
data repair should be written, until that run exists.**

**Not fixed here, deliberately.** Changing `isSofa` in the importer repairs
nothing already imported — the import has run. The repair is a separate script
under the four release-discipline rules, and it needs the probe's answer first to
know which rows it is entitled to touch. `redecode-collapsed-sofa-lines.mjs`
cannot do it: it selects on the `SOFA UNPARSED` marker, which this class does not
carry.

**Ref.** `fix/sofa-1s-placeholder`, 2026-09-08. Reconcile run `34213899437` for
the offender list; the binding count and the 12-of-14 decode are reproducible
offline from the two committed data files named above.
