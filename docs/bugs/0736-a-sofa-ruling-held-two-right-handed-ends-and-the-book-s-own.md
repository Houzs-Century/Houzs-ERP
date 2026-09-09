## A sofa ruling held two RIGHT-handed ends, and the book's own Desc2 says the same on other documents [high]

**Symptom.** The owner, 2026-09-09, reading the corrections file:
「HC-PO-010041 9058 L(LHF) + 1NA + 1A(RHF) 一个left 一个right才对」.

`sofa-compartment-corrections-2026-09.json` held that build as
`L(RHF) + 1NA + 1A(RHF)` — the chaise AND the end piece both right-handed. A
sofa has one left end and one right end, so this is wrong on its face, without
the drawing.

**Root cause (traced, not guessed).** The entry was recorded on 2026-09-04 from
the owner's own reading of the slip. The chaise half of that reading was right;
only the handedness was wrong, and nothing downstream could catch it. The
decoder emits `A`, `NA`, `L` and `CNR` and has never had an opinion about
whether a build's two ends face opposite ways, so a same-handed pair is as
acceptable to it as any other list.

**This is not one bad row.** The book's own `Desc2` states the same shape on
documents nobody has corrected. Read from the live snapshot cut 2026-09-09
08:18 MYT (`backend/scripts/data/ac-reconcile-truth.json.gz`):

| document | the book's Desc2 | reads as |
|---|---|---|
| `PO-009679` | `{SIZE:2ER+C+1ER+(28")}/{COL:CH141-12 METAL}` | `2A(RHF) + CNR + 1A(RHF)` — two RIGHT ends |

For `PO-009679` the other two sources agree with each other and against the
book: the extracted slip photo
(`line-photos/po/PO-009679__880127_1.jpg`, in the `ac-reexport` worktree) shows
the hatched arm on the **left** of the long leg with the corner at its right,
and the sales order `HC-SO-010955` already holds
`2A(LHF) + CNR + 1A(RHF)`.

So on the compartment HANDEDNESS specifically, the book's text is not reliable
and the drawing plus the sales order are. That is narrower than, and does not
contradict, the owner's standing 「autocount怎么写我们就怎么写」 — every other
field is still copied from the book.

**Fix.** `HC-SO-013312 / HC-PO-010041` corrected to `L(LHF) + 1NA + 1A(RHF)`.
The superseded reading is kept inside the entry's `why` rather than deleted,
because `scripts/lib/sofa-rulings.mjs` takes the LAST match
(`docs/bugs/0722-the-sofa-ruling-lookup-prefers-the-oldest-ruling-so-a-build.md`)
and the file's rule is supersede-never-erase.

**Offered and DECLINED.** A machine check for "two same-handed ends" was
proposed to the owner the same day and he said no. Recorded here so the next
session does not re-propose it as a new idea.

**Ref.** PR for `fix/sofa-010041-left-right`, 2026-09-09.
