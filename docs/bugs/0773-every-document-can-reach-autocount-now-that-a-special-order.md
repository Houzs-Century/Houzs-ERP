## Every document can reach AutoCount now that a special order may point at the ERP [medium]

**Symptom.** Four documents could not reach the account book because a line's
Description 2 was over AutoCount's `nvarchar(100)`, and no abbreviation could
reach the length. Measured off production 2026-09-09 (`too-long-for-the-book`,
run `34396774391`):

| document | line | characters |
| --- | --- | --- |
| `HC-SO-007678` | 2 | 207 |
| `HC-SO-007678` | 5 | 212 |
| `HC-SO-2609-037` | 1 | 123 |

The length is free prose on a paid add-on — "Customer would like to customize the
front divan with one drawer on the left and one drawer on the right." — which no
phrase rule shortens, so the previous entry
(`docs/bugs/0770-shortening-the-stored-text-to-fit-autocount-would-have-repri.md`)
handed these back to the owner.

**Root cause (not a defect — a wrong assumption about what AutoCount is FOR).**
The composer treated the SPECIAL segment as load-bearing in the account book. The
owner settled it on 2026-09-10:

> 「反正我们没有用 Auto Call 的 PO 那些,用 Auto Call 只是因为我要平行跑这个系统。
> Special Order 可以不进,也可以随便进,**最重要是每一张单都可以进到就行了**。」
> 「你可以写说 "Special Order: Refer to ERP"。」

AutoCount is a parallel run. The factory builds from the ERP and the PDF, so the
special order is not load-bearing THERE — and a document that reaches the book
with a pointer is worth more than a document that reaches nothing with the full
text.

**Fix.** A third and last rung on the abbreviation ladder, in
`backend/src/services/autocount-desc2-abbrev.ts` and mirrored in the sofa
composer:

1. it fits — send it unchanged;
2. apply the owner's abbreviations, stopping at the least change that fits;
3. **replace the special-order segment with `Special Order: Refer to ERP`.**

Measured on the real strings: **207 -> 91, 212 -> 96, 123 -> 73**, and
`HC-SO-012312`'s 115 still goes at 98 with all three of its customisations
intact, because rung 3 only runs when rung 2 has not already fitted it.

Three properties hold it honest:

- **A POINTER IS NOT A TRUNCATION.** Half a specification reads as a complete
  instruction and builds the wrong furniture; a sentence saying where the
  specification lives cannot be mistaken for one. Nothing is ever cut.
- **SEGMENT-BOUNDED.** A `FREE - <campaign>` segment prints after the special
  one; cutting to the end of the string would silently delete it.
- **THE ERP KEEPS EVERY WORD.** Nothing writes `variants.specials`, which is
  priced BY NAME — that was the near-miss in `docs/bugs/0770`.

On the SOFA path the decode gate needed one deliberate rule: `parseSofa` reads
specials from a fixed vocabulary and will never read the pointer back as one, so
the gate asks the only thing that matters about a pointer — **is it there** — and
still compares the pieces, the size and the colour exactly. A caller claiming to
have pointed at the ERP without saying so in the text is refused.

**Two pre-existing tests changed their input, and that is recorded rather than
quietly done.** Both used an over-long SPECIAL to prove the refusal path; the
pointer now fits those inputs, so each was re-asked about a length the pointer
cannot reach — the fabric colour — and the behaviour they gave up is asserted in
a new test beside them.

Tests: `backend/src/services/desc2AbbreviatedOnTheWayOut.test.ts`,
`backend/src/services/autocount-sofa-collapse.test.ts`,
`backend/src/scm/lib/autocount-outbox.test.ts`. Backend `src/services` + `src/scm`:
3,495 passed across 249 files.

**Ref.** `feat/special-order-refer-to-erp`, 2026-09-10.
