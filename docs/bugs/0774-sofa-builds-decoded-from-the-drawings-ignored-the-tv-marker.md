## Sofa builds decoded from the drawings ignored the TV marker, so every sketch with the TV above the run was recorded mirrored [high]

**Symptom.** The owner, 2026-09-10, on `HC-SO-013503`: 「这个当初应该是没看TV 是Left和
right倒反了 sofa的单全部你根据照片重新看下有没有那个相同的问题 纠正direction 要根
据看TV」. The order's printed layout showed the chaise on the LEFT; his customer's
own sketch has it on the RIGHT. A mirrored sofa is not a cosmetic defect — the
factory builds the arms on the wrong ends and the piece cannot be turned round.

**Root cause (traced, not inferred).** The build was never in the text. Read from
the book: `SO-013503`'s `Desc2` is `fully cover replace the leg | Nilon bottom |
Col :COVE 16 | after push back fully cover` — fabric and finishing only. The
compartment list came ENTIRELY from reading the drawing, and the drawings were
decoded before the TV rule was settled on 2026-09-09
(`sofa-handedness-is-mirrored`). Handedness was taken as "the arm on the
drawing's left is the left-hand-facing piece", which is true only when the TV is
drawn BELOW the run.

**Measured, one drawing at a time, before anything was changed.** 112 sofa lines
in company 1 carry a drawing; all 112 were extracted from the book's
`SODTL.FurtherDescription` and read.

| TV drawn | count | what it means |
|---|---|---|
| BELOW the run | 37 | recorded correctly |
| **ABOVE the run** | **21** | **recorded MIRRORED** |
| no TV / on a side wall | 9 | owner's ruling 2026-09-10: 「如果没有tv的就当作tv在下面」 — treated as below, left alone |

The rule did not break once across those 67 at-risk drawings, which is why the
repair is mechanical rather than a re-reading: reverse the piece order and swap
every `(LHF)`/`(RHF)`.

**Two thirds of the population never needed opening, and finding that first is
the part worth copying.** A build whose mirror equals itself cannot be harmed —
both ends are the same piece, so one left and one right are needed either way. Of
the 112, **42 are mirror-proof and 70 at risk**; the check is
`reverse(pieces) with LHF<->RHF swapped === pieces` and it costs nothing.

**Fix.** `data/sofa-compartment-corrections-tv-direction.json`, 20 builds, applied
through the existing `apply-sofa-compartment-corrections.mjs` — the gated path
that pairs rows by code and UPDATEs in place, refuses a build whose downstream
moved real stock, and leaves the money alone.

**The correction had to be written TWICE, and the repo's own test is what said
so.** Every one of the 20 documents already carried a build in an earlier round,
so leaving the old entry in place would have left two disagreeing answers with
file order deciding which won. `sofa-corrections-source.test.mjs`'s *"no two
builds give the same document different pieces"* caught exactly that on
`HC-SO-013497` and its message names the remedy — *"Correct both, or the round
that runs last silently wins."* 21 old entries were corrected in place, each
carrying a `SUPERSEDED 2026-09-10` note saying why.

**Two things deliberately NOT folded in.**

- `HC-SO-013503` uses the OWNER'S OWN answer, `1A(LHF)+1NA+1A(RHF)`, not the
  mechanical mirror `1A(LHF)+1NA+L(RHF)`. His drawing's first piece is a plain
  arm, not a chaise — a SECOND mistake that the mirror does not fix. Piece type
  and handedness are different errors and mixing them hides one inside the other.
- `HC-SO-012025` is HELD, not applied: that document carries TWO sofa lines and
  the drawing round never recorded which line the build belongs to. Guessing
  would put one sofa's build on another.

**A pre-existing test failure is NOT mine.** `the 1ELT build says L(LHF) on BOTH
its documents` fails on `origin/main`'s loader with this branch's data files
absent from `CORRECTION_FILES` — 3 builds where it expects 2, across the 2026-08,
2026-09 and drawings rounds. Verified by swapping main's loader in and re-running.

**Ref.** fix/sofa-tv-direction, 2026-09-10.
