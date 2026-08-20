## Two config routers let any SCM user rewrite shared master data [high]

**Symptom.** `POST|PATCH|DELETE /localities` (the shared 5,870-row Malaysian
postcode master, and `warehouse_id` — the city-level delivery-routing override)
and `PUT|DELETE /state-warehouse-mappings/:state` (which warehouse an ENTIRE
STATE ships from) had no permission check at all.

**Root cause.** Neither file imported `houzs-perms`, and both routers are mounted
bare — `localities` is listed in `SCM_UNGUARDED_PREFIXES` (`lib/scm-areas.ts`),
so no area guard runs over it either. The only barrier was `requireScmAccess`,
which admits any SCM user including a view-only Sales Executive. `my_localities`
has no `company_id`, so an edit hits BOTH companies.

**Fix.** `canWriteScmConfig(c)` on all five writes, matching every sibling on the
same ungated umbrella (`currencies.ts:76`, `categories.ts` ×7, `staff.ts:433`).

**Ref** - `fix/company-scope-sweep`, 2026-08-13.
