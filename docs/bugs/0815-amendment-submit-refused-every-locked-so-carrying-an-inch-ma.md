## Amendment submit refused every locked SO carrying an inch-mark item code [high]

<!-- area: Sales orders + pricing -->
<!-- status: fixed -->

**白话.** 老板 2026-09-11：一张已下单供应商的销货单（HC-SO-004928）改了行项後按
「Submit amendment request」没反应。真正的报错在页面最顶（滚下去看不到）："Save
failed. Could not check this order's item mix, so nothing was saved."——是後端拒收，
不是按钮点不了。

根因跟 0780 是同一个：产品编号里有「5 寸」写成 `5"` 的床褥
（`DUNLOPILLO GENERASI 5" MATT (SS)`）。後端提交 amendment 时要一次去问一批产品，
`.in('code', …)` 遇到那个引号会把整串问题从中间截断、并且**不报错、静默回空**，於是
「混单检查」以为读失败而拒绝。0780 修好了 MRP / 供应商绑定那几处，但**销货单
amendment 走的两个读函数没一起迁**。全线上有 3 个含 `"` 的编号、26 张单、41 行会中招
——这些单只要改任一行就提交不了，只有「只改表头」能过。

**Symptom.** Owner 2026-09-11, HC-SO-004928 (CONFIRMED, processing-locked,
11 lines). Editing a line then "Submit amendment request" appeared to do nothing;
the inline banner (rendered at the top of the page, off-screen while scrolled to
the lines) read **"Save failed. Could not check this order's item mix, so nothing
was saved. Please try again."** Phone was present and the past processing date was
grandfathered, so it was not a frontend guard. The SO carries the line code
`DUNLOPILLO GENERASI 5" MATT (SS)` — an inch mark (`"`) in the code.

**Root cause (traced).** The same `@supabase/postgrest-js` 2.108.2 `.in()` defect
as docs/bugs/0780 — it quotes reserved chars `[,()]` but never ESCAPES, so a value
carrying `"` closes the in-list early and every value after it is dropped, the
request still answering 200. Two by-code reads on the amendment-submit path were
never migrated to `pgrestInList` when 0780 fixed the MRP/supplier reads:

- `loadProductsByCodes` (`backend/src/scm/lib/mfg-pricing-recompute.ts`) used
  `.in('code', uniq)` and `const { data } = await q` — swallowing the PostgREST
  error into a silent empty map. `amendmentMixRefusal`
  (`backend/src/scm/lib/main-mix.ts`, called from `POST /:docNo/amendments` in
  `mfg-sales-orders.ts` — resolve the line with `gen:route-locator`) loads
  `rows.map(r => r.item_code).concat(requested)` — i.e. ALL existing line codes
  plus the requested ones — so the inch-mark line poisoned the batch, the
  requested clean code read as absent, and the gate returned its "could not tell"
  409 (`mixCheckUnavailable`, main-mix.ts:111).
- `validateItemCodes` (`backend/src/scm/lib/validate-item-codes.ts`) had the same
  `.in('code', unique)` + swallowed error. It runs FIRST on the submit path, but
  only over the REQUESTED codes; editing a clean line keeps those clean, so it
  passed — leaving the poison to fire inside the mix check. Editing the inch-mark
  line itself instead surfaces this one as "Item code is not in the product
  catalog: DUNLOPILLO GENERASI 5\" MATT (SS)" — same root cause, other face.

Verified against the live DB (project anogrigyjbduyzclzjgn, 2026-09-11): all 11 of
HC-SO-004928's line codes exist in `mfg_products` under company 1 — so a code "not
coming back" was a read failure, not a missing product. The malformed filter was
reproduced with the installed client, no network:

    code=in.("STAR-(SS)","STAR-(K)","CROWN (SS+S)","DUNLOPILLO GENERASI 5" MATT (SS)")
                                                                          ^ closes the value early

Blast radius: 3 distinct `mfg_products.code` values carry a `"`, across 26
non-cancelled SOs / 41 lines.

**Fix.** Both reads now escape via `pgrestInList` (the serialiser 0780 introduced)
whenever a code in the batch actually carries a `"` or `\`, and keep the plain
`.in()` — byte-identical for a clean list — for every other read. It is scoped
this way on purpose: these two functions run on every SO/DO/SI/PO line write, and
switching them to `.filter()` unconditionally would force a `.filter` verb onto
dozens of hand-rolled test fakes that only implement `.in`; escaping only the
lists that need it fixes the 26 affected SOs without that suite-wide churn. Both
also stopped swallowing the driver error (log it, so a future break is loud, not a
silent empty — the swallow was why 0780 stayed invisible). Regression tests proved
RED on the unfixed tree: `backend/src/scm/lib/main-mix.test.ts` ("resolves an
existing line whose code carries an inch mark") and `validate-item-codes.test.ts`
("a code carrying an inch mark is found, not reported unknown"); their fakes model
the wire faithfully (postgrest-js's quote-without-escape → `parsePgrestInList`), so
reverting to a plain `.in('code', …)` fails them.

Other unmigrated by-code `.in()` reads are left as-is (see Deferred); the same
escape-when-needed shape applies to them the day one carries a poison character.

**RULED OUT**, so the next pass does not re-chase them:

- NOT a missing/legacy product. The DB shows all 11 codes present under the SO's
  company — the code that "did not come back" is in the catalogue.
- NOT the frontend submit guards. Phone was set; the unchanged past processing
  date is grandfathered by `soDateGuardError`; the `EMAIL *` asterisk is cosmetic
  (`validate()` runs `validateDates()` only, never email).
- NOT `liveLines`. It reads `mfg_sales_order_items` by `doc_no` (no `.in`), so it
  is unaffected — the failure was the `mfg_products` by-code read alone.

**Deferred.** Other unmigrated by-code `.in()` reads remain
(`allowed-options-check.ts:428`, `delivery-planning.ts`, `delivery-zones.ts`,
`inventory.ts`, `mfg-purchase-orders.ts`, `consignment-orders.ts`, and more) — a
broader sweep to `pgrestInList`, tracked separately rather than widened here.

**Ref.** fix/scm-in-code-quote-escaping, 2026-09-11.
