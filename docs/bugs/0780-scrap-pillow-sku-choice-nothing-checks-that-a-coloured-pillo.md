## Scrap pillow SKU choice: nothing checks that a coloured pillow sits on the CUSTOM SKU [medium]

<!-- area: Cutover + migrated data -->
<!-- status: open -->

**Symptom.** The owner, 2026-09-10: *"并且你要确保我的 scrap pillow 是选对的:
1. 有颜色的是选 custom scrap pillow 2. 没有颜色是选 random。另外,你之前查回去一下
我的 AutoCount 记录,之前 SKU 我不确定你有没有选对,可能你选错了。如果 proceed 了
这个单呢,custom SKU below 一定会写有颜色的;还没有 proceed 的呢,那可能就没有"*

In plain terms: a scrap pillow whose colour the customer chose belongs on the
CUSTOM item; one with no colour belongs on the RANDOM item; and the colour is
only required once the order has been PROCEEDED — an unproceeded order may
legitimately be blank, which is his standing rule of 2026-09-04:
"还没proceed还没确认的就可以直接放空的". He suspects the cutover picked the wrong
one on some lines.

**Root cause (traced, and it is a MISSING RULE rather than a broken one).**
Nothing in this system ever enforced, or even measured, the pairing. Traced in
the tree rather than guessed:

- `REQUIRED_VARIANT_AXES_BY_CATEGORY` (`backend/src/scm/shared/so-variant-rule.ts`,
  mirrored for scripts in `backend/scripts/lib/variant-axes.mjs`) declares
  required axes for **`bedframe` and `sofa` only**. A pillow is `accessory`, so
  no colour axis is required of it at confirm time or at Processing-Date time,
  and no gate can therefore notice a coloured pillow on the wrong item.
- Until PR #3507 landed on 2026-09-10 there was nowhere on the Sales Order to
  TYPE a custom pillow's colour at all — the owner's first message in the same
  thread. So for the whole migrated corpus the colour lives in free text, not
  in a field.

**And AutoCount does not have the split at all, which is what makes this a
cutover question.** Measured on the committed snapshots, offline, with no
production access:

- `backend/scripts/data/align-skus-houzs-century.json` (AutoCount item export,
  2026-08-05, 1,242 rows): **zero item CODES** contain `(CUSTOM)` or
  `(RANDOM)`. **Three item NAMES** contain `(CUSTOM)` —
  `AMN-SQUARE PILLOW` → `AMN-SQUARE PILLOW (16"x16") (CUSTOM)`,
  `DSL-SQUARE PILLOW`, `HOK-SQUARE PILLOW`. **No name anywhere says RANDOM.**
- `backend/scripts/data/ac-live-item-master.json.gz` (AutoCount live,
  2026-09-09, 1,591 items): 32 codes mention PILLOW; none says CUSTOM or RANDOM.
- `backend/scripts/data/ac-fidelity-so-lines.json.gz` (60,939 book SO lines,
  2026-08-11): the book states the distinction in the **line text**, not the
  code — `[ COL: HUGYP 3383-6 ]`, `Col: J9883-10-MOGANO` on one side;
  `COLOUR: RANDOM`, `col: random`, `randome colour` on the other. Of the **727**
  scrap-pillow lines in that snapshot the classifier reads **204 as naming a
  colour, 203 as saying random, 78 as TBC/KIV** and the rest as saying nothing
  decidable.

So the CUSTOM/RANDOM choice was made on OUR side, per line, by reading that
text — which is exactly where a wrong pick would come from, and it had never
been measured either way.

**Fix — this entry ships the MEASUREMENT, not a repair.**
`backend/scripts/check-scrap-pillow-sku-choice.mjs` +
`.github/workflows/scrap-pillow-sku-choice.yml` cross-tab every scrap-pillow
sales-order line by SKU family x colour recorded x order proceeded, and print
AutoCount's own words for each mismatch beside our choice. Read-only: SELECTs
only, no DDL, no writes, no transaction, no APPLY. It deliberately does **not**
propose re-coding a line — changing a live document's item code moves stock and
can move money, so that is the owner's decision and a separate gated script.

The text classifier was proved against the real corpus before being wired to
production: run over all 727 book scrap-pillow lines, with the fabric library
stubbed out, its residue was inspected string by string, and `Col -02 Beige#`,
`col - JF236-4 dark linen`, `Col：GD8371-02#Beige` (a full-width colon) and
`rondom` are in its patterns because they are in the data, not because they were
imagined.

**PRODUCTION RUN: not yet dispatched at the time this entry was written.** A
`workflow_dispatch` workflow cannot be triggered until its file is on `main`
(`HTTP 404: workflow ... not found on the default branch`), so the numbers from
production land in the immediately following PR that updates this entry. Nothing
here asserts a production count.

**Ref.** `audit/scrap-pillow-sku`, 2026-09-10.
