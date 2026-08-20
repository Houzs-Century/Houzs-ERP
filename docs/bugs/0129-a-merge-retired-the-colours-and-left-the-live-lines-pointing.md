## A merge retired the colours and left the live lines pointing at them [high]

**Symptom** — live documents naming `scm.fabric_colours` rows that are already
`active = false` and appear in no picker. The census named one on production
before the repair existed: `BO315-2-FEATHER` — 3 `scm.mfg_sales_order_items`,
3 `scm.purchase_order_items`, 3 `scm.inventory_movements`, 3 `scm.inventory_lots`,
and 1 `scm.fabric_colours` row, already inactive.

**Root cause (traced, not guessed)** — a merge has two halves: retire the losing
colour, and repoint everything that names it. The 2026-08-11 normalisation did
the first against a sweep that knew FOUR document arms out of the fifteen a later
source audit found, so it superseded colours and left live documents pointing at
rows nothing offers any more. The reason nobody caught it is structural: a
duplicate DETECTOR can never report these, because a retired row is not a
duplicate — it is a merge that already happened.
`merge-duplicate-fabric-colours.mjs` excludes inactive rows by construction
(`const live = cols.filter((c) => c.active !== false)`), so it will never list
one. They have to be looked for from the other end — *which retired colours are
still NAMED* — and nothing asked that question.

**Fix** — `backend/scripts/repair-superseded-colour-refs.mjs` +
`.github/workflows/repair-superseded-colour-refs.yml`. The destination is READ
out of the loser's own label, verbatim (`[MERGED into BO315-02 on 2026-08-11 …]`,
and the `[superseded by X on …]` wording that also exists in prod); a row whose
label does not record what absorbed it is REFUSED and listed rather than sent
somewhere plausible, and the target must exist, be ACTIVE, and sit in the same
series. Stock moves in the same transaction as the documents because
`variant_key` materialises the colour into the physical bucket at post time and
is compared, never recomputed — repointing the lines alone is what leaves a sofa
unable to match its own on-hand. One transaction per colour, each ending in a
re-count that must reach zero or the transaction throws; a failure rolls back
that colour and the others stand; verification runs on a fresh connection.
Nothing is deleted and nothing is re-activated.

**The count this PR corrected, and where the wrong one still lives** — PR #2082,
merged the same morning, is titled *"Merge the 68 duplicate colours that sit
inside one series"*. This PR's body states that the detector producing that
figure did not exclude already-retired rows and that the live pair count is
**3** — the other 65 were already retired, and their stranded references were
invisible to both tools. The 68 is still on `main` in two places; see the #2082
entry below.

**The class, for next time** — when a cleanup has two halves, the tool that finds
work for the first half is structurally blind to the residue of the second. Ask
the question from the other end, and do it in the same pass — not because someone
noticed, but because the shape of the operation guarantees there is something to
find.

**Ref** — 2026-08-13, PR #2084 (`fix/superseded-colours-still-referenced`). Entry
written 2026-08-14 from the merged diff. No module guide covers
`backend/scripts/`, and none covers the fabric library at all.

---
