## A sofa correction went silently inert when the fabric renumbering rewrote the text it selects on [high]

<!-- status: fixed -->

<!-- area: AutoCount sync + write-back -->

**白话.** 老板亲自看图定下来的沙发件数，我们是靠单据上的一段字（颜色那一段）去认「是
哪一张沙发」。2026-08-11 布料编号改过一次，`BO315-7` 变成 `BO315-07`，那段字就跟着变
了。结果我们那条对照记录再也认不出自己那张沙发 —— 系统不会报错，只会说「这张单上没有
这个建时」，看起来像那条记录已经没用了，其实是它坏了。老板的答案就这样一直没写进去。

**Symptom.** `HC-SO-013327` carries the owner's own ruling. The apply run
against production (dry-run `34220106079`, 2026-09-08) reported:

```
HC-SO-013327: no line matches "Col:BO315-7 Peach" (no line carries this text,
exactly or normalised) — skipped, the build is not on this document
HC-PO-010081: no line matches "Col:BO315-7 Peach" ... — skipped
```

Both halves of the pair were skipped. The wording is the problem as much as the
skip: **"the build is not on this document" reads as an entry that has become
obsolete**, which is a reason to delete it. The entry was correct and the needle
was stale.

**Root cause (traced).** `apply-sofa-compartment-corrections.mjs` selects a
build's rows with `selectBuildRows(rows, desc2Match)` — a substring match
against the ERP rows' own `description2`. The entry's needle was
`Col:BO315-7 Peach`, written when the document said that. The 2026-08-11 fabric
renumbering rewrote **this document's** `description2` to the zero-padded
spelling. Read off production, not inferred — probe run `34220446190`:

```
1  8069-1A(LHF)  colourLabel=BO315-7 [superseded by BO315-07 on 2026-08-11]
   Desc2: Size:24”/Col:BO315-07 Peach/Bottom wrap nylon/Seater depth +1”
```

`BO315-7` never appears in the document any more, so the needle could not match
its own build, and the entry stopped doing anything. This is the same
renumbering already recorded as having cost 166 sofa lines their colour when a
matcher answered the DEAD library row; here it cost a build the owner's answer.

**It is document-specific, and that was measured rather than assumed.** Eight
other entries carry a single-digit colour suffix in their needle, and the same
run matched them — `HC-SO-013329` still selects on `Col:BO315-4 Sand`. Only the
documents the renumbering actually rewrote drift, so a blanket rewrite of every
needle would have been a guess.

**Fix.** The needle is narrowed to `Peach` — the part of the label the
renumbering does not touch, still unique on this document because its only other
sofa line reads `Col:BO315-12 Deep Grey`. Proven by re-running the same
dry-run (`34220862044`), which planned the build instead of skipping it, and
then by the apply (`34221548817`).

**What is NOT fixed here, deliberately.** The failure is silent by shape: a
needle that stops matching is indistinguishable, in the log, from an entry whose
document genuinely no longer holds the build. A guard could compare each entry's
needle against the document's current `description2` and report a needle that
matches NOTHING as a DEFECT rather than as a skip. That is a change to the
corrections tooling rather than to this document, and it is recorded here so the
next lane starts from the measurement.

**Ref.** `fix/apply-sofa-rulings`, 2026-09-08. Dry-runs `34220106079` (inert) and
`34220862044` (planning); evidence `34220446190`; apply `34221548817`.
