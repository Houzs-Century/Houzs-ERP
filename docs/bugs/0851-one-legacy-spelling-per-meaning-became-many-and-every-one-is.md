## One legacy spelling per meaning became many, and every one is its own stock bucket [medium]

**Symptom.** Nobody reported it, because nothing looks wrong: every document
renders the words somebody typed. It surfaced only when the options census
(`check-special-coverage-census.mjs`, prod run 34728515268, 2026-09-13) was asked
how many document lines carry a value the catalogue does **not** hold.

**Measured on production, company 1:**

| | |
|---|---|
| distinct values carried that the catalogue does not hold | **200** |
| document lines carrying one of them | **1,491** |
| of those values, ones the rules can place on a catalogue option | 128 |
| ones the rules can place on nothing (genuine free text) | 72, on 272 lines |

Grouped by what the phrase mapper says they MEAN — by the rules that already
govern this data, not by eye:

| the option it really is | spellings | lines |
|---|---|---|
| **Nylon Fabric** | **32** | **595** |
| HB Fully Cover | 28 | 288 |
| Seat Base Fully Cover with no Leg | 11 | 105 |
| HB Straight | 12 | 62 |
| Change 8030 Backcushion | 18 | 61 |
| Divan Full Cover | 15 | 47 |
| eight smaller groups | 1–8 each | 97 |

A value that genuinely means two things — `HB & DIVAN BOTTOM FULLY COVER` — is
counted in both its groups, so the rows do not sum to 1,219.

**Why it matters, and it is not cosmetic.** `specials` composes
`computeVariantKey`. The same sofa with the same nylon bottom is therefore
sitting in **32 different stock buckets** according to which words were typed.
MRP allocates at the `(warehouse, item_code, variant_key)` bucket
(`scm/lib/inventory-movements.ts:137`), so one option's stock is shredded and
each fragment reads as a separate, smaller pool.

**Root cause.** The AutoCount migration stamped the slip's raw `Desc2` phrases
straight into `variants.specials` instead of resolving them to picker codes.
That was the right call at the time — the catalogue did not exist yet in its
current form, and dropping the words would have lost the instruction — but the
codes arrived later and the old values were never folded onto them.

**Owner decision, 2026-09-13:** 「3 统一nylon」 — the nylon family only. The other
13 groups stay as they are until he says otherwise, and the authorisation lives
in `backend/scripts/data/legacy-specials-unify.json` with the words he used, so
the next session cannot invent a wider scope from a transcript.

**Fix.** `unify-legacy-specials.mjs` (+ workflow) folds an authorised spelling
onto its catalogue code across all six documents and merges the stock buckets in
the same transaction. A value is folded only when the phrase mapper decodes it to
**exactly one** code and that code is authorised; a value decoding to two is
reported and never folded, because picking one of two meanings is inventing a
spec. The original words are not lost — `description2` and the `账本原文:` remark
are untouched.

**The existing tool is NOT the tool for this, and that is worth writing down.**
`align-line-specials-to-catalogue.mjs` does this shape of repair, and two things
rule it out: its allow-list holds exactly **one** line, and it has no concept of
stock at all — no `inventory_lots`, no `variant_key`, no `computeVariantKey`
anywhere in the file. Folding 595 lines with it would strand the goods, which is
`docs/bugs/0722`. It stays as it is: for a single line with no stock it is
correct, and its money guard is stronger than this tool needs.

**Ref.** chore/unify-legacy-specials, 2026-09-13. Related: `docs/bugs/0722`
(why the stock moves with the line), `docs/bugs/0844` (the two refusals the
shared gate exists for), `docs/bugs/0845` (reading only half a rule table).
