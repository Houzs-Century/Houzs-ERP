## `Desc2` was documented as being AutoCount's Further Description; they are two different columns [medium]

<!-- area: AutoCount sync + write-back -->

**Not a runtime defect today — it is a naming defect that was about to become
one, found while building the writer for the field it names.**

**Symptom.** `docs/modules/autocount-writeback.md` §7q was headed *"Desc2 is the
Further Description"* and quoted the owner's 2026-08-15 instruction — *"照片那一边
是从 Further Description 那边抽出来的，所以你录入的时候，也是要录入回 Further
Description"* — directly above a section that then changed how `Desc2` is
composed. `backend/src/scm/lib/autocount-outbox.test.ts` carried the same
sentence over its describe block. Read together, the two say the owner asked for
photographs and got variant text.

**Root cause (traced, not guessed).** They are separate columns on the same
detail class. `backend/scripts/autocount-service/sdk-api-reference.txt` lists
`Desc2:String` and `FurtherDescription:String` in the `SET:` list of all six
detail classes (lines 444, 452, 460, 468, 476, 484). The cutover read them with
two different scripts for two different purposes: `refresh-so-variants.mjs`
parsed **`Desc2`** for the ERP's variants, and `import-so-line-photos.mjs`
pulled the **photographs** out of `FurtherDescription` (its own line 2 says so).
`Desc2` is `nvarchar(100)` and at its ceiling; `FurtherDescription` is
`nvarchar(MAX)` and held 458,878 bytes on one measured line.

**Why it was about to bite.** Nothing wrote `FurtherDescription`, so the wrong
name cost nothing. The moment something does, the conflation points a
photograph at a 100-character column — and the `Desc2TooLongError` refusal that
exists for that ceiling would fire on a picture, reading as a truncation bug.

**Fix.** Both sites corrected in place, with the correction kept visible rather
than the old sentence deleted; a table in §7q gives each column its type, its
content and its owning section, and the writer itself is documented in a new
§7q2.

**Ref:** this PR, 2026-08-15.
