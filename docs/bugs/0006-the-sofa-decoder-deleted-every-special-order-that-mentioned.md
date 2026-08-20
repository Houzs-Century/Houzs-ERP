## The sofa decoder DELETED every special order that mentioned the bottom [high]

**Symptom** — 53 AutoCount sofa lines say `bottom use umbrella fabric` /
`bottom upgrade to umbrella fabric` / `wrap bottom to umbrella fabric`. Not one
of those instructions existed anywhere in the ERP — not as a picker code, not as
free text, not as a remark. The factory sheet for those orders simply did not
carry the request. `seed-sofa-special-addons.mjs` had already counted the 53 and
opened a code for them; the code had nothing pointing at it because the phrase
never survived the decode.

**Root cause** — Two holes in `parse-sofa.mjs`, both traced by re-running the
three committed exports, not guessed. (1) The preprocessing line
`d2.replace(/bottom[^\/\n]*|.../, " ")` deletes from the word `bottom` to the
end of its segment, and it runs BEFORE specials are collected — the phrase is
gone before anything can read it. (2) Everything else was collected on the
`rider` path inside the structure loop, and that loop **breaks at the first
segment that yields pieces**. A phrase sharing the structure's segment was
caught; the identical phrase alone in its own segment (`/BACK CUSHION CHANGE
8030`) was never visited.

**Fix** — A special-order sweep that runs on the ORIGINAL text before the
pipeline strips anything and writes ONLY to `o.specials`: split on `/`, newline
and `*`, and any chunk carrying an instruction word is pushed verbatim. The
structure parse is untouched by construction. Deduped on letters-and-digits
(`nilon` = `nylon`) so one instruction written three ways — swept phrase,
rule token, glued rider — is carried once, in its fullest wording.

Measured over all three exports in both recliner states (716 lines x 2):
**0 piece-list changes, 0 confidence downgrades, 0 size/colour/`why` changes,
0 phrases lost**; 96 lines that carried no special now carry one, and 57 lines
regain an umbrella-fabric instruction that had been 0.

**Also shipped** — `backfill-sofa-special-orders.mjs` + workflow, which maps the
recovered phrases onto migrated SO and PO lines as `scm.special_addons` picker
codes, free text verbatim where the owner has not opened a code. Six more golden
cases in `backend/tests/parseSofaGrammar.test.ts`.

**The class, for next time** — a `strip` and a `collect` over the same text are
order-dependent, and the strip was written first for a different reason (keeping
`bottom...` out of the structure tokens). Collecting must never depend on
surviving another rule's cleanup: read what you need off the original, then let
the cleanup run. The same shape hid inside the loop — `break` on success means
every later segment is unread, so anything you also want from those segments has
to be gathered outside the loop.

**Ref** — 2026-08-10, PR feat/sofa-special-order-backfill.
