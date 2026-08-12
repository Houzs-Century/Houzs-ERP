# Sofa Combo Anchor (R8) — a feature Houzs has the code for and not the table

**Every fact below was read off PRODUCTION on 2026-08-12, not inferred from a
migration file.** That distinction is the standing lesson of
`docs/system-foundation-coe.md`, and it matters here: the migration tree already
carried a note about this table, and the note was right about the table and wrong
about the consequence.

---

## 1. What a combo is, and what an anchor adds

A **combo** prices a whole COMBINATION of sofa modules instead of adding the
modules up. `1A(LHF) + 2A + 1A(RHF)` gets one number rather than three.

Combos live in `scm.sofa_combo_pricing` in two scopes:

| scope | `supplier_id` | what it means |
|---|---|---|
| master / sales side | `NULL` | the selling reference — what Product Maintenance shows |
| per supplier | the supplier's uuid | that supplier's cost for the same combination |

An **anchor** pins one `base_model` to ONE supplier. While anchored, every combo
CREATE and price EDIT is mirrored **bidirectionally** between the master row and
that supplier's row, so the sales-side reference and the anchored supplier's cost
stay in lock-step and the same number is never typed twice.

From `backend/src/scm/routes/sofa-combos.ts:104-112`, verbatim:

> A base_model can be ANCHORED to one supplier (sofa_combo_anchor, PK
> base_model). While anchored, every combo CREATE and price EDIT is mirrored
> bidirectionally between the master (sales-side, supplier_id NULL) combo and
> that supplier's scope, so the Product-Maintenance cost reference and the
> anchored supplier's cost stay in lock-step.

Mirroring is **append-only** (it INSERTs a copy on the other side) and
**best-effort** — the primary write has already succeeded, so a mirror failure
reports `mirrored:false` rather than failing the caller.

## 2. What exists in Houzs, measured

```
to_regclass('scm.sofa_combo_anchor')   = NULL      -> TABLE DOES NOT EXIST
to_regclass('scm.sofa_combo_pricing')  = present
  combo rows (company 1): 270   of which supplier-scoped: 173

sofa_quick_picks            present
sofa_personal_quick_picks   present
compartment_library         present
product_compartments        present
```

So combos themselves are **heavily used** — 270 rows, and 173 of them are
supplier-scoped, which is precisely the population the anchor mirror was built
for. The anchor table is the only piece that never came across from 2990.

## 3. What that breaks, exactly

| surface | state |
|---|---|
| `GET /api/scm/sofa-combos/anchors` | **500 on every Combo Pricing page load.** `useSofaComboAnchors` (`frontend/src/vendor/scm/lib/sofa-combos-queries.ts:171`) fires it with `staleTime: 30_000` |
| `PUT /api/scm/sofa-combos/anchors/:baseModel` | would fail the same way — you cannot set an anchor with no table |
| combo CREATE / price EDIT | **works.** `loadComboAnchor` destructures `{ data }` and ignores `error`, so a missing table returns `null` = "not anchored" and the write proceeds unmirrored |

That last row is the important one: **nothing staff do is blocked.** The only
live symptom is a red line in the console, and the silent absence of a
convenience nobody has ever had.

## 4. What migration 0114 said, and the half it got wrong

`0114_multicompany_config_split.sql` records, from a real prod check:

> `sofa_combo_anchor` does NOT exist on prod or staging (to_regclass = null) —
> no migration needed; **the route scoping is a harmless no-op** until/if the
> table is ever created.

The table fact is correct and still correct. The conclusion is scoped too
narrowly: the author was deciding whether the **multi-company scoping change**
was safe, and it was. Nobody asked whether the **endpoint** works without the
table. It does not, and it has not since the day R8 was vendored.

**The lesson worth keeping:** "no migration needed" answers a schema question.
It does not answer whether the code that reads that schema still functions.
When a table is deliberately skipped, check every route that names it.

## 5. The decision, and what each choice costs

**A — create the table.** A small migration (`base_model` PK, `supplier_id`,
`company_id`) turns R8 on: anchor a model to a supplier and combo prices mirror
between the sales reference and that supplier's cost automatically. This is
adding a feature that has never run here, so it wants a staging rehearsal and an
owner who actually intends to use anchoring.

**B — let the endpoint tell the truth (SHIPPED 2026-08-12).** An absent table
means nothing is anchored, which is exactly what an empty list says. `GET
/anchors` now returns `{ anchors: [] }` when — and only when — the error is
`42P01` (relation does not exist). Every other error still surfaces as 500, so a
genuine permission or connection fault cannot hide behind this branch. The
feature stays dark, the console stops lying, and if A is ever done this branch
simply stops being taken.

B is shipped because it is not a product decision: a route that queries a table
which is not there should say "none", not "the server broke". **A remains open
and is the owner's call.**

## 6. If you are here to do A

- The table: `scm.sofa_combo_anchor (company_id, base_model PK, supplier_id)` —
  `loadComboAnchor` filters on `company_id` when it is resolved, so create it
  per-company from the start rather than repeating 0087's retrofit.
- `mirrorAnchoredCombo` (`sofa-combos.ts:141`) is the whole mirror. It copies the
  scope tuple (base_model / modules / tier / customer) and every price map,
  swapping only `supplier_id`. A saved row on a NON-anchored supplier returns
  false and is not mirrored.
- Mirroring INSERTs, so an anchored model accumulates effective-dated rows on
  both sides. That is deliberate — the lookup picker treats each as a fresh
  row — but it means turning anchoring on for a model with a long price history
  is not a no-op. Rehearse on staging with a real model.
