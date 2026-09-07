## The table export was a picture of the screen, not a template [high]

<!-- area: Sales orders + pricing -->

**Symptom.** The owner exported the SKU page, edited it, and imported it back to
CREATE 163 new sofa SKUs. The system could not read the file it had just
written. `docs/bugs/0656` made the failure say which button to press; he pushed
back, and he was right:

> 「为什么你是帮我 convert 我要根本解决问题 我的文件 import 都没问题」
> 「正常我都是 export 了 edit 那个 sheet 的…**因为要有 template**」

That last clause is the whole defect. **The export is his template.** A template
that cannot be read back is not a template.

**Root cause, traced.** Three things stood between the file and the importer, and
only the first was a naming problem.

1. **The headings are what a person reads** — the code column is headed the way
   the screen shows it, `Description`, `Model` — while the importer looked for
   its own key names and found none. Hence "No rows had a code" over 163 rows
   that all had one.
2. **No category.** The screen was already filtered to sofa, so the column that
   would have said so was never written. Obvious to a reader, absent to a parser.
3. **No price tier.** The grid renders the prices of whichever tier the P1/P2/P3
   toggle is on and writes those numbers with nothing recording which tier they
   are. `getValue` also returns **-1** where a seat height has no price, so the
   file says `-1` and means ABSENT — read as a number it would create a SKU
   priced at minus one sen.

(2) and (3) are not read failures. **They are facts the file does not contain**,
and no amount of cleverness at the import end can recover them.

**Fix — both ends, because only both ends make a template.**

* **Export.** The sofa grid now carries `category` and `price_tier`, written under
  the importer's OWN key names. A sheet exported from today answers both
  questions by itself and nothing has to be asked or guessed. This is the owner's
  own proposal: 「就是说我们 import 或者 export，它都会多加一个 column，也就是它是
  P1、P2 还是 P3 之类的」.
* **Import.** `mapGridHeaders` translates the display headings onto the
  importer's keys, and `-1` is read as absence. A heading with no meaning to the
  importer passes through untouched rather than being blanked — blanking would
  have destroyed the two columns just added, since they are already spelled the
  way the importer reads them.
* **The size columns map to the `_sen` keys**, not the ringgit ones, because the
  grid's numbers are already sen (47250 = RM 472.50). No conversion runs, so no
  rounding step exists to lose half a ringgit in.
* **An old file still says what it is missing** — which of the two facts, and
  that re-exporting supplies them. They are never inferred: a price filed under
  the wrong tier is worse than one not filed.

**A gate was right and I was not.** `audit:vocabulary` refused the first alias
map, because writing the code column's heading as one underscored token spells a
term the catalogue retired (the field is `item_code` here). The map is now keyed
on the LABEL as a person reads it, spaces and all — which is also more honest
about what it holds: foreign strings being translated, not our own field names.

**Verified.**

* `Products.import.test.ts` — **14 tests**, over the owner's real header row
  verbatim: the code, name and model land on the importer's keys; a bare seat
  height becomes that size's `_sen` column; `-1` is absence and only `-1`; an
  unknown column is left alone; and a sheet carrying the two new columns asks for
  nothing while his old one asks for both.
* **His actual file, through the whole path: 163 rows read, 163 carrying a code.
  Before this change that number was 0.** One row, verbatim from the run:
  `{"code":"PANTTI LATEX-1B(RHF)","name":"SOFA PANTTI LATEX 1B(RHF)","base_model":"PANTTI","price_24_sen":"75000",…,"status":"ACTIVE"}`
  — and the `-1` in its 37 column is simply absent, as it should be.
* Both typechecks clean; `audit:vocabulary` clean; the file-size ratchet satisfied
  by keeping the helpers in their own module.

**Formats, since the owner asked for all of them.** Import accepts `.csv`,
`.xlsx` and `.xls` and dispatches by extension; the table export writes `.xlsx`,
the round-trip export `.csv`. Both exports now carry the tier.

**UNTESTED in the browser** — no live import has been run against this build.

**The lesson.** An export built by pointing at the visible columns inherits every
assumption the screen was allowed to make — the filter you can see, the toggle
you just set. That is fine for a picture and fatal for a template, and which one
it is was decided by the person using it, not by the person who wrote it.

**Ref.** fix/sku-import-reads-the-table-export, 2026-09-07. Follows
`docs/bugs/0656-the-sku-import-could-not-read-the-page-s-own-table-export-an.md`.
