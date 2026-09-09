## Nine sales orders cannot be edited because a split build leaves rows with no AutoCount line key [high]
<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-09: 「完了之后，我的 sales order 就可以开放给全部人
edit 了，因为有一些还在关着，不可以被 edit」. Ten of company 1's migrated sales
orders refuse editing with "the ERP cannot tell which lines AutoCount already
has", and `backfill-ac-sofa-line-keys.mjs` — the tool written to clear exactly
this — had reported `UNEDITABLE AFTER: 8 migrated sales order(s) still hold a
line with no AutoCount line key (was 8)` after stamping **zero** rows
(run `34316280108`, 05:47 UTC).

**Root cause (traced).** `autocount-line-keys.ts:155` requires every ERP row
behind one AutoCount line to carry the SAME key, and `composeEdit` treats a build
whose rows disagree — or hold none — as having no line identity at all. So one
keyless row does not cost that row: it costs the WHOLE document its editability.

The rows are keyless for two different reasons, and only one of them is a sofa:

- **A split build.** `lib/ac-forced-line-pairing.mjs` stamps only where the
  DOCUMENT forces the answer. On HC-SO-012025 and HC-SO-013384 the book holds TWO
  sofa lines and the ERP's compartment rows are split across them, so nothing in
  the document says which unkeyed row belongs to which. Its own log named both:
  `split, untouched by this run HC-SO-013384 ...: 6 row(s) carrying (none),
  914562, 914561`. **That refusal is correct and is not relaxed here** — a
  pairing rule that guesses is `docs/bugs/0708-...`, and a key pair is not an
  identity match (`docs/bugs/0671-...`).
- **Nothing to do with sofas at all.** Four delivery-fee lines (RM 50 / 150 /
  400 / 200), one whole migrated order (HC-SO-000015) and one ERP-created order
  the write-back put in the book (HC-SO-2609-011, six lines matching the book
  one-for-one by item code) simply never had their keys recorded. The sofa tool
  does not look at them: its scope is "only units the fold calls a SOFA".

**Fix.** `backend/scripts/stamp-ac-line-keys-2026-09-09.mjs` +
`.github/workflows/stamp-ac-line-keys-2026-09-09.yml` stamp 23 rows across nine
documents from a pinned manifest, each row carrying the evidence class that
forces it:

- `RULED` — the owner has already adjudicated the build, and the sales-order
  verdict prints his ruling (run `34336644061`). It forces the grouping
  *uniquely*: pairing HC-SO-013384's two `1NA` rows together would build
  `1A(LHF)+1NA+1NA`, which is not what he ruled.
- `DESC2` — the owner, 2026-09-09: 「如果没有图片的就看description 2」.
  HC-SO-013145 carries no drawing in the book (`FurtherDescription` is a
  115-byte empty RTF shell, checked against live `AED_HOUZS`) and its own Desc2
  states the builds — rows 1 and 2 read `1R+2R`, row 3 reads `2S`. The money
  agrees independently: book line 891939 holds RM 7,200 and so does ERP row 1,
  which is the `1R+2R` one.
- `ONE` — exactly one unclaimed book line on that document, matching on both
  quantity and price.

**Deliberately excluded.** HC-SO-012312: its book line `BEDFRAME` qty 2 "BEDFRAME
KIV" faces two ERP `HILTON (A)-(Q)` rows and the second carries RM 250 the book
does not. That is money, and the owner said twice that somebody else has it.

**A key is identity, not value.** One column is written. The verification
re-reads on a fresh connection and asserts the whole table's rows, quantities,
unit prices, totals and cancelled count are unchanged, that no document still
holds a keyless line, and that each stamped book line's compartment multiset is
exactly the expected one — a row count cannot separate a correct grouping from a
wrong one of the same size, which is the whole difficulty here.

**Nothing reaches AutoCount from this.** `enqueueAcEdit` runs on the API save
path and no trigger on `scm.mfg_sales_order_items` writes to
`scm.autocount_outbox` (checked against `pg_trigger` on production 2026-09-09),
so a direct row update queues nothing. The documents become editable; what the
book receives afterwards is a person's save.
