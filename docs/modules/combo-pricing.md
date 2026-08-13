# Module: Combo Pricing (SCM)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Products -> **COMBO PRICING**. Prices a whole COMBINATION of sofa modules
instead of adding the modules up, and overrides per-Model compartment pricing
when a line's module set matches.

> Money is in **sen** (integer cents). Everything goes through `/api/scm/sofa-combos`.
> Ported from HOOKKA, Commander 2026-05-28 ("去查看 hookka 的 combo module 把整个 copy 过来").

**Every production figure below was read off the live database on 2026-08-12
with a read-only session, not inferred from a migration file.** That distinction
is the standing lesson of `docs/system-foundation-coe.md`, and section 6 is a
case of it biting.

---

## 1. What a combo is

A combo says: *for base model X, this exact set of modules, at this tier, for
this customer scope, the price is N* — instead of pricing `1A(LHF) + 2A +
1A(RHF)` as three separate compartment prices.

The match is on the module SET, canonicalised so ordering cannot change
identity: `comboSlotsKey(modules)` (`scm/shared`) is the lookup key, and
`canonicalizeComboModulesForStorage` normalises what gets written.

Scope tuple: `base_model` + `modules` + `tier` + `customer_id` + `supplier_id`.

| tier | `PRICE_1` \| `PRICE_2` \| `PRICE_3` \| null |
| `customer_id` | null = every customer; a uuid = that customer only |
| `supplier_id` | **null = master / sales side** (the selling reference); a uuid = that supplier's COST |

**Combos load and match at `PRICE_1`.** `computeSofaSellingSen`
(`scm/shared/sofa-build.ts`) pins it, because module seat prices load at
`PRICE_1` and every combo is authored at `PRICE_1` — querying `PRICE_2` there
would make the server price a-la-carte while the POS applied the combo, and the
drift gate would then reject a correct order.

## 2. Append-only, effective-dated

Editing does **not** update a row. It INSERTS a new one with a fresher
`effective_from`; the latest row in scope wins at lookup. `DELETE` is a
**soft** delete (`deleted_at = now()`).

So `PUT /:id` is a convenience alias for `POST` — it creates a new effective row
and keeps the logical combo's identity through the scope tuple, not through the
row id.

## 3. Endpoints

`backend/src/scm/routes/sofa-combos.ts` (694 lines). Registered:

| method | path | notes |
|---|---|---|
| GET | `/sofa-combos` | list, filterable; supplier scope via `?supplierId=` (omitted / `null` = sales side) |
| GET | `/sofa-combos/history` | append-only history rows |
| GET | `/sofa-combos/anchors` | see section 6 |
| PUT | `/sofa-combos/anchors/:baseModel` | see section 6 |
| POST | `/sofa-combos` | create / insert new effective row |
| PUT | `/sofa-combos/:id` | alias for POST |
| DELETE | `/sofa-combos/:id` | soft delete |

Writes gate on `requireWriteRole`. Frontend hooks:
`frontend/src/vendor/scm/lib/sofa-combos-queries.ts`.

**Two things the file's own header gets wrong — do not trust it over this table:**

- It advertises `POST /sofa-combos/copy-to-customer`. That endpoint was
  **removed on 2026-05-28** (see the comment at `:771`); the header at `:17` was
  never updated.
- It cites `0090_sofa_combo_pricing.sql` for the schema. In THIS repo `0090` is
  `0090_scm_purchase_consignment_tables.sql` — the citation is **2990's**
  migration numbering, carried across with the vendored code. Only `0083`
  (company_id) and `0114` (per-company config split) mention `sofa_combo*` here.

## 4. Live size (production, company 1, 2026-08-12)

```
sofa_combo_pricing            270 rows
  of which supplier-scoped    173
```

So the supplier-cost half is the majority of the data, which is what makes
section 6 worth reading rather than skipping.

## 5. Where combos are consumed

`computeSofaSellingSen(cells, depth, modulePrices, combos)` — the authoritative
selling total for a configured sofa, and the same function the POS configurator
uses, so the server drift gate and the POS agree by construction rather than by
convention.

Note the neighbouring trap documented in `sofa-build.ts`: the compartment list a
Model offers is derived from its module **SKUs**
(`sofaCompartmentsFromModulePrices` <- `sofaModulePricesFromSkus`), NOT from the
maintenance `sofaCompartments` pool. The pool is the shortcut used when OPENING
codes; it is not read when pricing an existing build.

## 6. The anchor mirror (R8) — code without a table

**Absorbed from the standalone `docs/sofa-combo-anchor.md`, which this file
replaces.** A per-investigation doc at the top of `docs/` was the wrong home for
it; this module had no guide at all, which is the gap the repo rule says to
close.

An **anchor** pins one `base_model` to ONE supplier. While anchored, every combo
CREATE and price EDIT is mirrored **bidirectionally** between the master row
(`supplier_id NULL`) and that supplier's row, so the Product-Maintenance cost
reference and the anchored supplier's cost stay in lock-step and the same number
is never typed twice. Mirroring is append-only (it INSERTs a copy on the other
side) and best-effort — the primary write already succeeded, so a mirror failure
reports `mirrored:false` rather than failing the caller
(`mirrorAnchoredCombo`, `:141`).

**The table does not exist in this database.** Verified on production
2026-08-12: `to_regclass('scm.sofa_combo_anchor')` returns NULL. R8 came across
from 2990 with its route AND its frontend query (`useSofaComboAnchors`,
`staleTime: 30_000`) but without its table.

| surface | state |
|---|---|
| `GET /anchors` | returned **500 on every Combo Pricing page load** until 2026-08-12 |
| `PUT /anchors/:baseModel` | would fail the same way — you cannot set an anchor with no table |
| combo CREATE / price EDIT | **works** — `loadComboAnchor` drops its error, so a missing table reads as "not anchored" and the write proceeds unmirrored |

Nothing staff do was blocked, which is why it went unreported for months.

**What migration 0114 knew, and the half it got wrong.** 0114 records the same
`to_regclass` check and concludes *"no migration needed; the route scoping is a
harmless no-op"*. The table fact was right; the conclusion answered only the
question being asked — whether the multi-company SCOPING change was safe, which
it was. Nobody asked whether the ENDPOINT works without the table.
**Lesson: "no migration needed" answers a schema question, not a code question.**

**Shipped 2026-08-12 (stop the bleeding):** `GET /anchors` returns
`{ anchors: [] }` when — and only when — the error is `42P01` (relation does not
exist). Every other error still surfaces as 500, so a genuine permission or
connection fault cannot hide behind that branch.

**Completed 2026-08-12 (owner decision): the table now exists.** Migration
`0283_scm_sofa_combo_anchor.sql` creates
`scm.sofa_combo_anchor (company_id, base_model, supplier_id, created_by,
created_at, updated_at)`. Everything else had been in place since the vendoring —
the route, the hooks, and the UI control at `SofaComboTab.tsx:245-253`. Only the
table was missing.

**Creating it changed nothing on its own.** An empty table means no model is
anchored, `mirrorAnchoredCombo` is never reached, and every combo write behaves
exactly as before. Behaviour changes only when someone sets an anchor in the UI.

**The unique key is load-bearing.** `sofa-combos.ts:452` upserts with
`onConflict: 'company_id,base_model'`, and Postgres matches `ON CONFLICT` against
a real unique index — so the constraint must stay exactly that pair. Anything
else makes every `PUT /anchors/:baseModel` fail with `42P10`. That is not
hypothetical: the identical failure shipped in `special_addons`, where 0087
replaced a single-column unique with a per-company one while `/save` kept
upserting `onConflict: 'code'`, and every Save returned 500 for weeks. **If the
key changes, change the route in the same PR.**

**What to know before anchoring a model:** mirroring INSERTs, so an anchored
model accumulates effective-dated rows on BOTH sides. That is deliberate — the
picker takes the latest in scope — but it means turning anchoring on for a model
with a long price history is not a no-op. There is no FK to `scm.suppliers`
(nothing in this schema references it, and an anchor is a preference, not a
dependency); a stale `supplier_id` simply reads as unset in the UI.

## 7. See also

- `BUG-HISTORY.md` — the anchor 500 entry, and the lesson above
- `docs/modules/sales-order.md` — where combo pricing lands on a document
- `frontend/src/pages/scm-v2/_VENDORING_PROGRESS.md` — what was vendored and with what caveats
