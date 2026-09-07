## One colour spelling defeated the fabric matcher and was about to erase a live colour [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Two findings that looked unrelated until they were put side by
side, both on reconcile run 34130727594 and PO dry-run 34131447837:

- `HC-SO-008447 FENRIR-(Q)` — the book says `KS-08sea pink`, the ERP colour is
  blank. Counted in the 11 SO colour ERP-blanks on proceeded orders.
- `PO-009922 FENRIR-(Q)` — the ONE line in 538 that `refresh-po-variants` would
  have ERASED, and it is the same colour: the ERP holds `KS-08 SEA PINK` and the
  re-parse resolved nothing, so the null patch would have deleted the whole
  colour block.

Same model, same colour, one order. One member of a 538-line population behaving
unlike the rest is the finding, not the noise.

**Root cause (traced, not guessed).** Proved by running the matcher, not by
reading it — `buildFabricColourIndex` over a three-row library:

| spelling | before |
|---|---|
| `KS-08sea pink` | **NO MATCH** |
| `KS-08 SEA PINK` | MATCH |
| `KS-08` | MATCH |
| `KS08sea pink` (no hyphen) | MATCH |

Every other spelling of that colour resolves. The one that fails is **hyphen
plus missing space**, and it fails because two rungs each stop for a different
reason:

- the bare-code rung `/[A-Z]{1,4}\s?\d{2,4}\s?-?\s?\d*/` cannot cross the `-`
  between `KS` and `08`, which is why removing the hyphen makes it work;
- rung 3 `dropTrailingName` peels a trailing name only after `[\s-]`, and the
  character before `SEA` is the digit `8`, so `KS-08SEA` is never shortened.

So the two rungs that would each have caught it were blocked by the other half
of the same spelling.

**Fix.** Rung 3b: a candidate spelling with a space inserted at a digit→letter
boundary, pushed among the faithful forms. It only ADDS a candidate — it cannot
make an ambiguous key resolve, because two active rows claiming one key is still
refused by `claimIndex`.

Pinned in `backend/tests/fabricColourMatch.test.ts`, proved RED first: with the
rung removed, 1 of 42 fails on `KS-08sea pink`; with it, 42 pass. The second test
in that block guards the widening — `GD2502-04-OAK` and `CH141-13 deep grey`
must still have their trailing name peeled, not glued on.

**Why this matters more than one line.** The erase in `0670` was going to be
accepted as a small, known loss. It was not a loss to accept; it was a defect to
fix, and fixing it takes that erase to zero instead of trading it away.

**Ref.** fix/variants-specials-close, 2026-09-07.
