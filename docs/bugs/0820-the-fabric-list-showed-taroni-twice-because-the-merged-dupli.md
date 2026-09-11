## The fabric list showed TARONI twice because the merged duplicate row was never switched off [low]

**Symptom.** The fabric list carries two TARONI entries and one of them can
never be picked from. The owner, shown the duplicates, ruled: 「这种有异样的
fabric 全部 merge 起来，然后打开呀。它只要有启用，就有打开」.

**Root cause (traced).** `scm.fabric_library` held exactly two ids that differ
from themselves trimmed while the trimmed twin existed beside them —
`GARFIELD ` and `TARONI `. GARFIELD's merge was done on 2026-08-11 and left its
own receipt in the row's label:

> `GARFIELD  [MERGED into GARFIELD on 2026-08-11 - superseded, not deleted]`

TARONI's never was. `repair-fabric-colour-padded-series.mjs` moved the three
stranded colours onto the clean rows (applied 2026-09-11, verified below), which
left `TARONI ` holding **zero** colours and still **active** — a second entry for
a fabric that has 15 colours on the other row.

Measured on production after that repair:

```
library rows trimming to TARONI:  "TARONI" active,  "TARONI " active
colours by row:                   TARONI 15,        "TARONI " 0
colours still on a padded series with a clean twin: none
```

**Why this could not be done a day earlier, which is the part worth keeping.**
Switching a padded row off was DANGEROUS until today. `GET /fabric-colours`
began hiding a colour whose SERIES is retired (owner: 「inactive的就不需要了」)
and compared TRIMMED ids — so retiring `TARONI ` would have hidden the live
`TARONI`'s 15 colours. That regression shipped, hid 9 sellable GARFIELD shades
in production, and was fixed per-CODE in
docs/bugs/0817-a-retired-whitespace-twin-trimmed-onto-its-live-sibling-and.md
and docs/bugs/0818-a-retired-tombstone-row-hid-the-live-fabric-it-had-been-merg.md.
Both are merged and DEPLOYED — deploy run 34595512433 (`bfb67cce7`), `backend`
and `frontend` both success, and `git merge-base --is-ancestor` confirms it
carries both merge commits. Re-measured after that deploy, the reported case is
back:

```
HR805: 7 colours, all active, HR805-90 among them; the CODE has a live row,
       so nothing about it is retired
```

**Fix.** `backend/scripts/retire-merged-padded-fabric-series.mjs` +
`.github/workflows/retire-merged-padded-fabric-series.yml` — plan by default,
`CONFIRM="RETIRE MERGED SERIES"`, fresh-connection SHAPE verification. It writes
the same tombstone GARFIELD got and switches the row off.

It is written as a RULE, not as one id, and it REFUSES rather than guesses. A
padded row is retired only when a row exists at the trimmed id **and that row is
active** (otherwise switching this one off takes the fabric out of the catalogue
entirely) and **this row holds no colours** (a row with colours on it is an
unfinished merge, and moving them is the other script's job). Both refusals are
printed, not skipped silently.

The verification checks the pair BOTH ways — the padded row is off and carries
its merge note, AND the clean twin is still active with colours to offer. A row
count would have been satisfied by a repair that switched off the wrong one of
the two, which is exactly the mistake this class of bug keeps producing.

Plan against production:

```
Active duplicate series rows (padded id, clean twin present): 1
   company 1  "TARONI " -> off, label gains "[MERGED into TARONI on 2026-09-11 - superseded, not deleted]"
```

**Ref.** `fix/finish-fabric-series-merge`, 2026-09-11. Finishes the merge begun
in docs/bugs/0816-a-discontinued-fabric-kept-offering-every-shade-because-noth.md.
