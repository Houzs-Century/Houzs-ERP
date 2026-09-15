# Global Search (Cmd+K palette)

One endpoint, ten sources, two palettes (desktop Cmd+K, mobile). The rule the whole module exists to enforce: a source that could not be READ must never be presented as a source with nothing in it.

## Statuses and flow

- `GET /api/search?q=<term>` -> `{ q, hits: Hit[], degraded: HitType[] }`. `degraded` is optional on the wire so an older Worker doesn't render as `undefined`; `[]` means a fully healthy search.
- Three distinct response states, never collapsed into each other: **error** (the request itself failed), **degraded** (request succeeded, some sources failed — "Could not search {names} just now"), **empty** (every source succeeded, zero hits). When degraded and empty coincide, the copy becomes "No matches found... in what could be searched" rather than picking one message and dropping the other's information.
- Public-schema sources (projects, ASSR cases, users) run via `Promise.all` — a failure THROWS and the whole search 500s, which is correct since the client has an error state for it. SCM-schema sources (the other seven) run via `Promise.allSettled` — a single PostgREST hiccup degrades that one source rather than failing the whole palette. Every settled SCM result passes through one helper (`sourceRows`), which is the single place a failure is recorded.
- The same search function (`runGlobalSearch`) is also what the ERP Assistant's `search_erp` tool calls headlessly — deliberately, so the assistant gets identical company scoping and the same degraded-source note instead of re-deriving its own predicate (an assistant answering "no such invoice" from a table it couldn't actually read would be the most damaging consumer of this bug).

## Permissions

- Company isolation IS the per-source scoping predicate — the DB client is service-role (RLS bypassed), so a predicate must never fail open. An empty (`""`) predicate is used ONLY when the company context is unresolved; a resolved-but-restricted caller gets a match-nothing predicate instead.
- No extra permission gate beyond the global `/api/*` auth middleware — a hit carries metadata only (no record contents, no money), and following one lands on a module that enforces its own permissions.

## Rules that must not break

- A source that fails to read must degrade, never render as an empty result — route any new source through `sourceRows` so the failure branch comes for free.
- Add the `gin_trgm_ops` trigram index for a new searched column in the SAME PR as the source — an unindexed `.or(...ilike...)` column is a sequential scan on every keystroke, and a small table hides the problem completely until it's already in production.
- Both palettes must change together — they share one hook (`useGlobalSearchResults`); a fix applied to only one surface is the recurring bug class here.
- A new hit type needs its deep link wired on BOTH desktop (router navigation) and mobile (`mobileRoute.ts`, which will not 404 on an unknown path — it lands somewhere wrong).
- On mobile, "cannot open it" must never mean "do not show it" — a source with no mobile detail screen still renders read-only with an "Open on desktop" line; hiding it instead can silently suppress the empty-state message too and render a blank screen.
- An operator's search term must be escaped for PostgREST's `.or()` syntax (`,(){}` replaced with `_`, the LIKE single-character wildcard), never have those characters DELETED — deleting one from the middle of a term breaks substring matching entirely (a real SKU like `2376-1A(RHF)` stopped matching anything).

## Gotchas

- `.or()` cannot filter an embedded FK resource — a joined field (like a supplier's name) can only reach the result via the SELECT, not the filter; adding it to `.or` errors.
- A single-character search term is turned into a prefix match (`term%`), not a contains match (`%term%`) — a one-character contains-scan can't use the trigram index at this scale.
- Audit trigram coverage with `npm --prefix backend run audit:trgm` rather than by hand — it is intentionally not a CI gate (it reads source text, not a query plan), so a flagged column needs a conversation, not an automatic block.
- `PER_SOURCE_LIMIT` is 6 — this is a palette, not a report; don't expect exhaustive results from it.

## Where the code is

- `backend/src/routes/search.ts` — the endpoint, public-schema vs SCM-schema handling.
- `backend/src/scm/lib/postgrest-search.ts` — `escapeForOr`, `searchPattern`.
- `frontend/src/lib/globalSearch.ts` — `useGlobalSearchResults`, the three-state copy, debounce/min-length constants.
- `frontend/src/components/GlobalSearch.tsx` — desktop Cmd+K overlay.
- `frontend/src/mobile/MobileSearch.tsx`, `frontend/src/mobile/mobileRoute.ts` — mobile palette and deep-link resolution.
- `backend/scripts/check-trgm-coverage.mjs` — the trigram-index coverage audit.
