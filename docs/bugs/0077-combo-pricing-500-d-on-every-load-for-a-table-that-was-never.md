## Combo Pricing 500'd on every load, for a table that was never created here [medium]

**Symptom** - opening Products -> Combo Pricing puts
`GET /api/scm/sofa-combos/anchors 500` in the console every time. Nothing staff
do is blocked, which is why it went unreported: combos create and edit normally.

**Root cause (traced, not guessed)** - `scm.sofa_combo_anchor` **does not exist
in this database**. Verified against PRODUCTION on 2026-08-12:
`to_regclass('scm.sofa_combo_anchor')` returns NULL, while `sofa_combo_pricing`
is present and carries 270 rows for company 1 (173 of them supplier-scoped).
R8 (the anchor mirror) came across from 2990 with its route AND its frontend
query (`useSofaComboAnchors`, `staleTime: 30_000`) but without its table, so the
handler has 500'd on every Combo Pricing page load since it was vendored.

Combo writes survive by accident, not by design: `loadComboAnchor` destructures
`{ data }` and drops `error`, so a missing table reads as `null` = "not
anchored" and the write proceeds unmirrored.

**What migration 0114 already knew, and the half it got wrong.** 0114 records
the same to_regclass check and concludes "no migration needed; the route scoping
is a harmless no-op". The table fact was right. The conclusion was scoped to the
question being asked - whether the MULTI-COMPANY SCOPING change was safe, which
it was. Nobody asked whether the ENDPOINT works without the table.

**Fix** - `GET /anchors` returns `{ anchors: [] }` when, and only when, the error
is `42P01` (relation does not exist). An absent table means nothing is anchored,
which is what an empty list says; a 500 answers the caller's question no better.
Every other error still surfaces as 500, so a genuine permission or connection
fault cannot hide behind the branch. The feature stays dark. Creating the table
remains open and is the owner's call - see `docs/modules/combo-pricing.md` section 6.

**Lesson** - **"no migration needed" answers a schema question, not a code
question.** When a table is deliberately skipped, every route that names it has
to be checked, because the code that reads a table does not stop existing when
the table does.

**Ref** - `docs/sofa-combo-anchor`, 2026-08-12

---
