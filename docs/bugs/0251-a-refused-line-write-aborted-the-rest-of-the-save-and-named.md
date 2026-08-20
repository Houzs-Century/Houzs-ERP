## A refused line write aborted the rest of the Save and named nothing [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner: a rejected price edit silently swallowed a line add. The
banner said only what the price refusal said; the new line was never mentioned
and never written.

**Root cause (traced).** The page Save chain ran each stage under `Promise.all`
and let the FIRST rejection reject the whole chain: the sibling writes stayed
in flight while the catch tore the edit lease down, the later stages never ran,
and the operator got one message that identified no line.

**Fix.** `runSoLineWrites` settles every stage (`Promise.allSettled` for the
independent deletes/PATCHes; strictly sequential for the ADDs) and reports every
refusal by item code, plus what happened to the work that did not go out. The
ADDs are sequential deliberately: `POST /:docNo/items` is read-modify-write
twice over — `soMainMixIntroduced` (`mfg-sales-orders.ts:854`) returns
`mix(after) && !mix(before)` from a read of the current lines, so a sofa and a
bedframe posted concurrently would BOTH pass the guard that exists to reject
that pair; and `line_no` is `SELECT max(line_no) ... LIMIT 1` then `+ 1`
(`:8032`). Adds that landed are dropped from the staging list; the refused ones
stay on screen.

**Ref.** feat/so-multi-add-lines, 2026-08-16.
