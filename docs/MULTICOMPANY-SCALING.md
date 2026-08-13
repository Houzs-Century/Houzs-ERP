# Multi-company scaling — what it takes to add company 3, 4, 5

Owner asked (2026-07-23): *"如果开第三个公司、第四个公司、第五个公司的话，这些又要怎么去分呢？"*
This is the evidence-based answer, built from the scope audit
(`backend/scripts/audit-multicompany-scope.mjs`, run vs prod in PR #1131) which
classified all 157 `scm.*` tables.

> **Before anything below: the isolation rule.** The service-role client bypasses
> RLS, so the `company_id` predicate on each individual statement is the ONLY
> tenant boundary — on WRITES as much as on reads, and a scoped read does not
> protect the write that follows it. See the "THE PREDICATE IS THE ONLY
> ISOLATION" section at the top of `MULTICOMPANY-MODULE-MAP.md`. Adding company 3
> multiplies the cost of every statement that is still missing one.

## The short version

Adding a company is mostly **configuration, not migration** — *except* for one
class of table (natural-key masters) that still carries a **global** unique key.
Those need a one-time `UNIQUE(company_id, key)` change, and it is cheapest to do
that batch **once, before company 3**, so the 3rd/4th/5th company then "just
works".

The audit found **54** tables with a global unique key. Sorted by what actually
happens at company N:

## 1. Already safe — document-number tables (no change needed)

Every transaction doc (SO / PO / GRN / DO / PI / PR / SI / PV / journal entries /
stock takes / transfers / trips / consignment docs …) has a global unique on its
number — but the **value is company-namespaced by prefix**, so two companies can
never collide:

- `scm.series` is **per-company** (`company_id NOT NULL`, mig 0083), so each
  company draws its own numbers.
- 2990 numbers are prefixed `2990-` (`prefixDoc` in the importer); Houzs draws
  its own; journal entries use `jePrefixForCompany()` (`accounting.ts`).

**Action for company 3:** give it a distinct series prefix (e.g. `CO3-`). That is
a data/config step, **no schema change**. As long as prefixes are distinct, the
global unique is harmless.

## 2. Already safe — surrogate / UUID-keyed child tables (no change needed)

Junction and per-parent tables (`product_fabrics`, `product_size_variants`,
`product_compartments`, `product_bundles`, `fabric_colours`,
`model_*_overrides`, `product_model_photos`, `pos_carts`, `hr_payout_rows`,
`warehouse_racks`, `delivery_legs`, `po_revisions`, `so_revisions` …) are keyed
by a **globally-unique parent UUID** (`product_id`, `model_id`, `so_doc_no`,
`staff_id`, …). Different companies produce different UUIDs, so no collision.
The `create_product_with_pricing` SP already stamps `company_id` on every child
row (mig 0104).

## 3. REAL landmines — natural-key masters (fix once, before company 3)

These key on a **human-chosen code that a new company will legitimately reuse**.
They work *today* only because Houzs and 2990 happen not to overlap — a third
company breaks them. Each needs the unique (and any FK to it) to become
per-company:

| Table | Current global key | Why it collides at company 3 | Fix |
|---|---|---|---|
| `accounts` | `UNIQUE(account_code)` | every company wants its own `200-0000` etc. | `UNIQUE(company_id, account_code)`; make the `payment_vouchers(_lines)` FK composite (mig 0081) |
| `product_models` | `UNIQUE(model_code, category)` | model codes are **not** prefixed by the importer | `UNIQUE(company_id, model_code, category)` |
| `product_dept_configs` | `PK(product_code)` | product codes recur across companies | `PK(company_id, product_code)` |
| `pwp_codes` | `PK(code)` | promo codes recur | `PK(company_id, code)` |

`accounts` is the one that matters **now**: 2990's chart is being imported under
`company_id=2` (see below). No collision today (`check-2990-gl-collision.mjs`
proved all 31 codes free), so the 2-company world is fine — but the composite
constraint is the thing to land before a 3rd chart of accounts exists.

**Status — shipped in migration `0188_percompany_natural_key_masters.sql`.** All
four are now keyed per company: `product_models` gets a per-company UNIQUE index,
`product_dept_configs` and `pwp_codes` get a composite `PRIMARY KEY(company_id,
key)`, and `accounts` gets `UNIQUE(company_id, account_code)` with its three
inbound FKs (`journal_entry_lines`, `payment_vouchers.credit_account_code`,
`payment_voucher_lines.debit_account_code`) re-added as composite and `NOT VALID`
(enforced on new writes, no existing-row scan — see the migration header). A
follow-up may `VALIDATE CONSTRAINT` those three once confirmed clean against prod,
and scope the by-code reads of these masters (e.g. `product_dept_configs` /
`pwp_codes` lookups) to the active company before company 3 goes live.

## 4. Decision needed — `app_config`

`app_config` keys on `key` alone (global). Whether a new company should share the
same config row or get its own is an **owner decision**, not a mechanical fix.
Default today = shared. If any config must differ per company, it becomes
`PK(company_id, key)`.

## 5. Intentionally shared (leave global — by design)

`currencies` (MYR is MYR), `staff` roster, `my_localities`, `sync_config`,
`mrp_category_lead_times`, `so_settings`. These are one copy for everyone on
purpose — see `MULTICOMPANY-MODULE-MAP.md` (SHARED class). Note the fleet
(`drivers` / `helpers` / `lorries`) is a shared fleet by the owner's 2026-07-14
ruling, so its codes/plates being global is intended.

## The company-3 onboarding checklist

1. **Row + access.** Insert `public.companies` (code + name + hostname); grant
   users via `public.user_companies` (the switcher and `companyContext.ts`
   restrict by grant).
2. **Series prefixes.** Configure this company's doc-number prefixes in
   `scm.series` so its SO/PO/GRN/etc. never collide with the others.
3. **Per-company constraint batch (do once, before this step matters).** Ship the
   Section-3 migrations so the natural-key masters are keyed per company.
4. **Empty masters, set up fresh** (all SEPARATE — the map's rule): branding
   dropdown, warehouses, suppliers, venues, catalog / SKU master, SO maintenance
   (specials / fabrics / sizes / combo pricing). A new company starts empty.
5. **Delivery Planning / Service Cases** need nothing — they are UNIFIED and pick
   the new company up automatically once its orders exist.

## Chart of accounts is per-company in the CODE (map was stale)

`MULTICOMPANY-MODULE-MAP.md` listed chart-of-accounts under **SHARED**. That is
**stale**: `accounts.company_id` is `NOT NULL` (mig 0083) and the `/accounts`,
`/journal-entries`, `/gl` routes all `scopeToCompany(q, c)` — the chart is
**SEPARATE per company** in code. The map has been corrected. This is why 2990's
GL is imported under `company_id=2` rather than merged into one shared chart.
