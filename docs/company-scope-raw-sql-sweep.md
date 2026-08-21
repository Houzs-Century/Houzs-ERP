# Raw-SQL company-scope sweep — 2026-08-21

Written after the brand-letterhead defect — `docs/bugs/0489-a-2990-sales-order-pdf-printed-houzs-s-zanotti-logo.md`
(PR #2599, merged) — when the
owner asked 「还有什么类似的 bugs」: the CLASS, not the instance.

**This is a TRIAGE record, not a defect list.** Its main job is the *cleared*
column: an entry here means somebody opened the code and decided, so the next
sweep does not re-chase it.

---

## 1. The class, in three overlapping shapes

1. **A comment or doc states a per-company rule; the code hardcodes one
   company's value.** The letterhead resolver hardcoded `'ZANOTTI'` while
   `shared/so-branding-label.ts` — the same rule, written by the same owner on
   the same day — resolved it per company.
2. **A read with no company predicate feeding a per-company output.** The same
   resolver read `project_brands` with no predicate.
3. **A table with no company column at all**, so the rule cannot be expressed.

Shape 3 is the one most often *claimed* and least often *true*. Both premises
the letterhead bug was reported under were shape-3 claims read off
`0000_baseline.sql`, and production refuted both — see §5.

---

## 2. Why `check-company-scope.mjs` could not see it

Verified by patching a copy of the script on 2026-08-21, not inferred. **Two
independent reasons, and fixing only the first changes nothing:**

| # | reason | evidence |
|---|---|---|
| 1 | `RAW_SQL_TABLES` is a HAND-WRITTEN list of fifteen tables. `project_brands` was never on it. | adding it to the list produced **no** new finding |
| 2 | `if (delegated \|\| hasScopedQuery \|\| wrapsABuilder) return;` acquits the WHOLE handler before any statement is read. `GET /:docNo` calls `salesDocOutOfScope` + `scopeToCompany`, so every statement in it was excused. | only lifting that return surfaced `L2759` |

**Extending that script was measured and rejected.** Its `--strict` mode
enforces *handler WRITE findings stay at ZERO*:

| variant | findings | of which WRITE |
|---|---|---|
| as it stands today | 12 | 0 |
| + table list derived from migrations | 72 | 20 |
| + the whole-handler acquittal lifted | 76 | 22 |

Landing either fix there meant loosening `--strict`, or grandfathering WRITES
into a baseline whose entire purpose is that writes stay at zero. Both are
forbidden, and rightly. **So the raw-SQL class got its own script**,
`backend/scripts/check-master-read-scope.mjs`, with its own baseline that starts
at today's state and may only shrink. `check-company-scope.mjs` is untouched.

The new check flags exactly the defect on the unfixed tree
(`mfg-sales-orders.ts :: GET /:docNo :: project_brands`, 77 keys) and does not
on the fixed one (76 keys).

---

## 3. Triage — the raw `env.DB` sites, including the CLEARED ones

Read this column-by-column. **"Cleared" means read and decided**, not skipped.

| site | feeds a per-company output? | verdict |
|---|---|---|
| `mfg-sales-orders.ts:2759` `project_brands` | YES — the SO PDF letterhead | **DEFECT, FIXED.** The instance. |
| `mfg-sales-orders.ts:2501` `project_venues` | yes | **CLEARED** — it already carries `activeCompanySql(c)` inline, three lines down. Listed as a suspect; reading it settles it. |
| `delivery-planning.ts:1359` `projects` union | board row | **CLEARED** — the code says why, in place: *"Fleet is company-shared so this is intentionally NOT company-scoped."* A documented decision, not an oversight. |
| `delivery-planning.ts:1037` `assr_cases` union | board row | **LEAD, owner's call.** `assr_cases.company_id` exists (mig 0083) and `/api/assr` scopes every read by `assrCompanySql` = the caller's GRANTED companies. This union carries no predicate at all, so the board shows a single-company user cases that `/api/assr` hides from them. |
| `delivery-planning.ts:2288 / 2297 / 2798` `assr_cases` | write + snapshot | **CLEARED as consistent, flagged as a wider question.** The whole `PATCH /:type/:id/schedule` handler is company-blind — the SO/DO arm too, not only ASSR — and the block above it carries a dated owner ruling that scheduling serves the WHOLE board. That ruling is about CREW scope, not company scope, so the company axis is genuinely open; it is not an ASSR-only asymmetry to "fix" quietly. |
| `dp-orders.ts:196` `projects` | the DP order's party snapshot | **LEAD.** `projects` carries `company_id`; `projectId` comes from the operator. Low severity (the snapshot is copied text, and the picker upstream is scoped), real nonetheless. |
| `dp-orders.ts:202` `users` | PIC name/phone | **CLEARED** — `users` is the global identity master and this row is reached THROUGH the project resolved on the line above. Scoping the parent is the act that matters. |
| `dp-orders.ts:209` `assr_cases` | party snapshot | **LEAD**, same shape as `:196`. |
| `reports.ts:724` `projects` | Fair report dimensions | **CLEARED** — the ids come from SO headers that were already company-scoped. A reference lookup keyed by an already-scoped parent's own column. |
| `reports.ts:784` `projects` | Fair P&L rate lookup | **CLEARED**, same reason. |
| `reports.ts:789` `project_cost_rates` | Fair P&L overhead | **LEAD, and the one genuine shape-3.** PROVEN in production (run 32457950996): `project_cost_rates` is in the NO-COMPANY list — no `company_id` column — and it is keyed by a brand NAME. Brand names are NOT unique across companies: "bedframe" and "service" already exist under both (run 32455140536). |
| `staff.ts:82` `users` + `positions` | POS role derivation | **CLEARED** — both are global masters, and the statement is filtered by an explicit `userIds` list that came from an already-scoped roster read. |
| `routes/projects.ts:4844` `project_brands` (drizzle) | CSV project-import brand allow-list | **LEAD.** Unscoped, but PMS is Houzs-only today and the value is upper-cased before an exact-name match, which no 2990 brand would survive. |
| `routes/users.ts:663` `project_brands` (drizzle) | `user_brands` validation | **LEAD, owner's call.** `user_brands` has NO company column (PROVEN, same run), and it drives the DIRECTOR approval-lane brand split. Making it per-company is a business decision. |

Neither drizzle site is visible to either checker: `schema.pg.ts` does not model
`project_brands.company_id`, so there is nothing to scope BY in that vocabulary.
That model file is stale for this table in three ways — no `company_id`, no
`logo_r2_key`, and a `.unique()` on `name` that production does not have.

---

## 4. What the new check found beyond the instance

`node backend/scripts/check-master-read-scope.mjs` — **76 handler/table pairs**
grandfathered in `backend/scripts/master-read-scope-baseline.json`. It was 77
until #2599 merged; the `project_brands` key is gone and the baseline was
shrunk to match, which is the ratchet doing its one job. They are LEADS, not a
bug count: the biggest clusters are `announcements`, `assr_cases` and the ASSR
lookups, and a good share will be legitimately global or scoped through a parent.
Clear one by adding the predicate, or by annotating the statement
`// company-scope: <reason>` — which leaves the decision where the next reader
will find it.

---

## 5. Two shape-3 claims that production REFUTED

Recorded because both would have bought an **irreversible** migration, and
because reading `0000_baseline.sql` is exactly how they were produced.

| claim, from the baseline file | production (run 32455140536) |
|---|---|
| `project_brands` has no company column | `company_id` since **mig 0093** — NOT NULL, FK, indexed |
| a global `UNIQUE(name)` blocks per-company scoping | only `project_brands_pkey (id)` exists; "bedframe" and "service" are already under both companies |

`0000_baseline.sql` is 93 migrations behind on this table. The schema audit
(`.github/workflows/audit-multicompany-scope.yml`) now covers `public.*` as well
as `scm.*`, which is how a claim like this gets settled in one dispatch instead
of by reading a file that has not been true for months.

---

## 6. Open, for the owner — one sentence each

- Should the Delivery Planning board show, and let a dispatcher edit, ASSR
  service cases belonging to a company that user has not been granted, when
  `/api/assr` hides those same cases from them?
- Should `project_cost_rates` (the Fair P&L rate card, keyed by brand name) be
  per-company before 2990 runs a fair, given brand names already collide across
  the two companies?
- Should `user_brands` — which drives the DIRECTOR approval lane, not project
  visibility — be per-company, or stay a single global list?
