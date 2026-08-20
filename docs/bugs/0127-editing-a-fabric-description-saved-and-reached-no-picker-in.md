## Editing a fabric description saved, and reached no picker in the system [medium]

**Symptom** — owner, 2026-08-13: *"Description 好像是直接可以更改。如果可以更改的话，
到时候可以 save 得到吗？"* It saved. The Fabric Converter table showed the new text
at once; every fabric picker on every Sales Order kept the old one indefinitely,
and nothing reported a problem.

**Root cause (traced, not guessed)** — the description is the ONLY place a
colour's NAME is written: `colourLabelOf(code, description)` takes everything
after the code, which is how `PC151-01 SAND` comes to be called *SAND*. But the
name a salesperson reads when picking fabric comes from the MIRRORED row in
`scm.fabric_colours`, not from the `scm.fabric_trackings` cost ledger. That
mirror is written in exactly two places in
`backend/src/scm/routes/fabric-tracking.ts` — at create (`:133`) and at CSV
import (`:296`) — and never again: the description PATCH did not touch it, and
**both mirror upserts carry `ignoreDuplicates: true`**, so even re-running the
sync skips a colour that already exists. There was no path by which the edit
could ever have arrived.

**Fix** — the PATCH's `.select()` returns `fabric_code` alongside `id` (the row
has just been proven to be this company's, so no second read is needed) and
updates `scm.fabric_colours.label` in place through the SAME `colourLabelOf`, so
the two cannot derive different names, scoped to the company and to the
`colour_id` that IS this fabric's code. Best-effort and REPORTED, never fatal:
the cost ledger the operator was editing has already been written, so a library
hiccup must not turn a saved edit into an error. The response gains `pickerLabel`
(what the picker will now say) and, on failure only, `pickerWarning`.

**The class, for next time** — an edit that appears to work and reaches nobody is
worse than one that refuses, and a denormalised mirror with two write sites and
no equality assertion is the standing invitation. Nothing in the tree fails if
the ledger and the mirror diverge again; this fix does not add such a test, and
that gap is the residue. Also unfixed and named in the PR: the Series cell has
the same disease for a different reason — the picker groups by
`seriesOf(fabric_code)`, so editing the stored `series` column cannot move
anything, and no amount of syncing will fix it.

**Ref** — 2026-08-13, PR #2081 (`fix/fabric-description-reaches-picker`). Entry
written 2026-08-14 from the merged diff. **Module guide: none exists.** No file
under `docs/modules/` quotes `backend/src/scm/routes/fabric-tracking.ts`, and the
working-agreement checker's own path→module index maps it to no guide. Per
CLAUDE.md that is the gap to close rather than a licence; writing
`docs/modules/fabric-library.md` is outside a write-up PR and is named here so it
is not lost.

---
