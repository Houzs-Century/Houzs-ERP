# Module: Global Search (Cmd+K palette)

One endpoint, ten sources, two palettes, and one rule that matters more than the
rest: **a source that could not be READ must never be presented as a source with
nothing in it.**

Written 2026-08-02 alongside the fix for the bug that rule is named after
(BUG-HISTORY, the "unreadable vs empty" entry).

---

## 1. Frontend

### Screens

| Surface | File | Notes |
|---|---|---|
| Desktop | `frontend/src/components/GlobalSearch.tsx` | Cmd+K overlay, grouped by type with icons + keyboard nav |
| Mobile | `frontend/src/mobile/MobileSearch.tsx` | Same sources, flat list with type chips |

### The shared layer

`frontend/src/lib/globalSearch.ts` is the ONE place request state lives:

- `useGlobalSearchResults(query)` → `{ term, hits, loading, error, degradedNotice }`.
  Both palettes consume exactly this. Neither fetches on its own.
- `GLOBAL_SEARCH_MIN_LENGTH = 1` — the owner's contract is that the FIRST
  character starts a real server search. Never ask for a second one.
- `GLOBAL_SEARCH_DEBOUNCE_MS = 250` — coalesces network traffic only; the UI
  enters the searching state immediately.
- Results are bound to the normalized term that produced them. The derived
  `current` state hides an older term's hits in the render right after a
  keystroke, before the effect cleanup aborts. Without it, Enter could commit a
  hit belonging to a term the user already replaced.
- `degradedSearchNotice(degraded)` builds the "could not search X" sentence.
  It lives here, not in either palette, so the two cannot describe the same
  outage differently.

### The three states, and why they are three

| State | Shown when | Copy |
|---|---|---|
| error | the request itself failed (non-2xx / network) | "Search failed…" |
| degraded | request succeeded, some SOURCES failed | "Could not search {names} just now — results below are incomplete." |
| empty | request and every source succeeded, zero hits | "No matches for {term}." |

When degraded and empty coincide, the empty copy becomes *"No matches found for
{term} in what could be searched."* — the two lines must never contradict each
other. Collapsing any of these into another is the bug this module keeps
re-learning.

## 2. API surface

```
GET /api/search?q=<term>  →  { q, hits: Hit[], degraded: HitType[] }
```

- Auth: the global `/api/*` middleware. No extra permission gate.
- `degraded` is `[]` on a healthy search. It is OPTIONAL on the wire
  (`degraded?` in the FE type) so a Worker older than the SPA reports nothing
  degraded instead of rendering `undefined`.
- `PER_SOURCE_LIMIT = 6` per source. This is a palette, not a report.
- `Hit` carries METADATA only — no record contents, no money.

### The same function, headless

`runGlobalSearch(c, env, raw)` is exported and called by the ERP Assistant's
`search_erp` tool (`backend/src/services/assistant-tools.ts`). That is deliberate:
the assistant gets IDENTICAL company scoping instead of re-deriving the predicate,
which is how a cross-company leak would enter. It also carries the degraded note,
because an assistant that answers "no such invoice" from an unread table is the
most damaging consumer of this bug.

## 3. Backend (`backend/src/routes/search.ts`)

Two halves with different data access — check which you are in:

- **Public schema** (`projects`, `assr_cases`, `users`) — `env.DB.prepare` through
  the d1-compat shim. Fired with `Promise.all`, so a failure THROWS and the whole
  search 500s. That is correct: the client renders its error state.
- **SCM schema** (the other seven) — supabase-js/PostgREST, `Promise.allSettled`,
  and a failure degrades instead of throwing. One PostgREST hiccup must not take
  the whole palette down. Every settled result goes through
  `sourceRows(res, type, degraded)` — the single place a failure is recorded.
  **Add a source, and you get the failure branch for free; that is the point of
  the helper.**

### Scoping

Company isolation IS these predicates — the DB client is service-role, so RLS is
bypassed. Each fragment is `""` ONLY when the company context is unresolved;
a resolved-but-restricted caller gets a match-nothing predicate. Never fail open.

- projects → `activeCompanySql` (follows the ACTIVE company)
- ASSR → `assrCompanySql`, mirroring `routes/assr.ts`: rank-and-file Sales are
  PINNED to HOUZS, office/backend/directors widen to their allowed set
- users → global (an unscoped shared directory, matching `/api/users`)
- all SCM sources → `scopeToCompany`

Row-level permission scoping (PIC / brand / salesperson) is intentionally loose:
hits are metadata, and following one lands on a module that enforces its own perms.

### `searchPattern()`

Strips `%`, `_` and `*` (LIKE wildcards; PostgREST also treats `*` as `%`), and
routes PostgREST terms through `escapeForOr` so `,(){}` cannot corrupt the filter.
A ONE-character term becomes `term%` (prefix) rather than `%term%`, because a
single-character contains-scan cannot use a trigram index at ERP scale.

## 4. Database — the index rule

Every column in a `.or(...ilike...)` or `LIKE ?1` needs a `gin_trgm_ops` GIN
index, or it is a sequential scan on every keystroke.

| Migration | Added |
|---|---|
| `0001_search_trgm.sql` | public schema: projects, assr_cases, users, + legacy AutoCount tables |
| `0074_search_trgm_indexes.sql` | scm.mfg_sales_orders, scm.mfg_products (shipped WITH search v1) |
| `0104_perf_indexes_products_fabric.sql` | products description/barcode, fabric |
| `0108_perf_trgm_so_debtor.sql` | SO debtor_name, phone |
| `0239_search_trgm_scm_documents.sql` | scm.purchase_orders, grns, delivery_orders, sales_invoices, purchase_invoices |
| `0240_search_trgm_list_filters.sql` | the module LIST search boxes: scm.suppliers, the SO/DO/SI extras, the consignment trio |

**0239 exists because PR #1269 added five sources without it** and the gap sat
unnoticed for a week — small tables hide it completely. If you add a source to
`appendScmHits`, the migration belongs in the SAME PR. Deliberately NOT indexed:
`roles.name` (a few dozen rows) and the FK embeds `supplier(name)` /
`purchase_order(po_number)`, which PostgREST cannot filter inside `.or` anyway.

**Do not audit this by hand — the rule is checkable:**

```
npm --prefix backend run audit:trgm
```

`backend/scripts/check-trgm-coverage.mjs` diffs every `.or(...ilike...)` column
in `backend/src/scm` against every `gin_trgm_ops` index in `migrations-pg/`,
resolving views to their base table. A column that should genuinely stay
unindexed goes in the script's `ACCEPTED` map **with a reason**. It is not a CI
gate on purpose: it reads source text rather than a query plan, and a false
positive must cost a conversation, never a deploy.

## 5. Rules that will bite you

1. **Never let a failed source render as an empty one.** The whole module exists
   under this rule now. If you add a source, route it through `sourceRows`.
2. **Add the trgm index in the same PR as the source.** See §4.
3. **Both palettes change together.** They share `useGlobalSearchResults`; a fix
   applied to one surface only is the recurring bug class in this repo.
4. **A new hit type needs the deep link to exist on BOTH surfaces.** Desktop
   navigates the router; mobile resolves through `mobileRoute.ts`, which will not
   404 on an unknown path — it lands somewhere wrong.
5. **`.or()` cannot filter an embedded FK resource.** Supplier name reaches the
   subtitle through the SELECT, not the filter. Adding it to `.or` errors — and
   before 0239's sibling fix, that error was silent.

## 6. See also

- `BUG-HISTORY.md` — the "unreadable vs empty" and "five sources, no index" entries
- `docs/CODEBASE-MAP.md` §6 — Sales Report ("Fair Report") and the other
  easy-to-miss subsystems, several of which are search sources
- `backend/src/scm/lib/postgrest-search.ts` — `escapeForOr`
