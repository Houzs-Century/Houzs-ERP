## Receipt lines carrying no category were invisible to every per-category audit [low]

**Symptom.** After `docs/bugs/0817` filled 70 sofa/bedframe receipt lines with
the spec their purchase line states, the document-chain audit still reported 21
goods-received lines carrying no variants (run 34607649126, 2026-09-11). The
first pass had taken `item_group IN ('SOFA','BEDFRAME')`, and these 21 carry **no
item_group at all** — so the sofa pass could not see them, and neither can any
other per-category check.

**Root cause (measured, not assumed).** Widening the census to every category
first answered a different question and answered it usefully: of the receipt
lines with no spec, **MATTRESS 175, ACCESSORY 61 and SERVICE 1 have a purchase
line with no spec either** — correctly, because those groups have no soft
attributes and `computeVariantKey` gives them `''`. Nothing is missing there.

What is left is **24 lines whose `item_group` is empty**, all of them
`migrated_no_stock` paperwork with zero inventory movements, and **21 of those
have a purchase line stating a bedframe spec in full** (`CODY-(Q)`, `JAGER-(Q)`,
`TRION (A) (HB STR)-(K)` and so on). The cutover importer wrote the receipt line
without either field; every later repair keyed on the category and skipped them.

**Fix.** `backfill-grn-variants-from-po.mjs` now takes every category and copies
BOTH halves from the purchase line — the spec where this line has none, the
category where this line has none — each independently, in SQL, so a line that
already has one keeps it. The guards are unchanged and are what make it safe: the
receipt must be `migrated_no_stock` and no inventory movement may name it, because
a receipt whose goods actually moved must never be re-specced underneath its own
lot (`docs/bugs/0722`).

Observed (plan, production, 2026-09-11): `receipt lines missing a spec or a
category 265` · `WRITABLE 28 over 22 receipt(s)` · `HELD 237`, every hold reading
"the purchase line has no spec either" — which is the mattress/accessory
population above, correctly left alone.

**Ref.** fix/grn-spec-and-group, 2026-09-11. Follows `docs/bugs/0817`.
