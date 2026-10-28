# Lessons from incidents

One entry per incident, oldest first: date and incident · what staff saw · root cause · the rule that stuck.
Each came from a full Correction-of-Error write-up (slug in brackets). Those files were removed on 2026-09-15;
read one with `git show archive/docs-2026-09-15:docs/<slug>-coe.md`. A new serious incident gets an entry here in the same four lines.

**2026-05/07, date never recorded — Cloudflare free-plan cap** [cloudflare-plan-cap]
- Saw: mass HTTP 500 "Usage limit exceeded" across production under real load.
- Cause: Cloudflare Workers Free plan limits (which limit was never written down); fixed by moving to Workers Paid.
- Rule: vendor quotas are part of availability; record a console-only fix the same day with the exact limit and error string. The SCM subrequest batching stays (latency), even though the 50-subrequest cap no longer binds.

**2026-06-13 → 07-13 — Postgres cutover dropped every column DEFAULT** [pg-migration-dropped-defaults]
- Saw: "500 Something went wrong" on pages that worked the day before (Sales Team and the org chart for everyone); later the ASSR timeline showed "-" for submission times.
- Cause: the D1→Postgres loader rebuilt tables keeping only name, type and NOT NULL, dropping DEFAULT, FK ON DELETE, CHECK and UNIQUE; nullable timestamps silently stored NULL for a month.
- Rule: verify schema against the live `information_schema`, not migration files; NOT NULL added at scale ships with a DEFAULT; Postgres-only repairs go in `migrations-pg`, never the D1 mirror tree.

**2026-06-14 → 07-21, recurring — database cold-start 503** [db-cold-start-503]
- Saw: on phones, "The database is briefly unavailable" / "Couldn't load orders" on the first tap of the day or after a deploy; earlier "Failed to fetch" and logouts from valid sessions.
- Cause: the Hyperdrive pool goes cold after every deploy and quiet period, on Supabase Micro compute; the first query can hang 12–20 s. No code defect.
- Rule: `backend/src/db/pg.ts` stays frozen; retry only what never reached the server (the cold-pool 503, mutations included); keep both client fetch paths in step; never turn a failed read into `?? []`; the real cure is a compute upgrade (owner billing).

**2026-06-17 — production wiped by the D1→Postgres loader** [prod-wipe-by-loader]
- Saw: no staff record; production tables were dropped, reloaded from a days-old dump, and restored to a point in time within hours.
- Cause: the loader drops every `public` table with CASCADE and took its only target from `.dev.vars`, which held the live production connection string.
- Rule: a destructive tool takes an explicit allow-listed target, fails closed and backs up before its first write; treat `.dev.vars` as a production credential store; write the incident up the same day.

**2026-06-22 — intermittent 500s across the app** [system-foundation]
- Saw: recurring "Failed to load / Something went wrong" on Project List, Calendar and search, worse the more staff were online.
- Cause: the DB middleware put each request's client on the shared isolate `c.env`; a request stalled on a 12 s cold connection resumed on another request's client ("Cannot perform I/O on behalf of a different request").
- Rule: never mutate shared isolate state per request (fresh env object or `c.set`); one `TRANSIENT_CONN_RE` feeds both the retry and the user message; bound every list query (supabase-js caps at 1000 rows).

**2026-06-26 — New Sales Order crash after a deploy burst** [api-fetch-hardening]
- Saw: the New Sales Order page crashed with "Cannot read properties of null (reading 'localeCompare')".
- Cause: six deploys in 90 minutes left mismatched Service-Worker cached chunks; the audit that followed also found ungated UDF writes, stock moves failing silently on post, and ~80 null-crash sites.
- Rule: batch releases into one deploy with one `sw.js` version bump; scope a deploy diff to the changed files; null-safe `?? ''` at every sort/filter; a post whose stock move fails must say so.

**2026-07-05 → 07-06 (~18 h) — Supabase shared pooler outage** [supavisor-pooler-outage]
- Saw: every request answered "The database is briefly unavailable" and it never cleared; every deploy failed with `password authentication failed for user "postgres"`; the Supabase dashboard said Healthy.
- Cause: a fault in Supabase's shared pooler (Supavisor), reported as 28P01 to direct clients and as connection errors through Hyperdrive; the credential was never wrong.
- Rule: 28P01 + unchanged secret + production 503 + dashboard Healthy means restart the Supabase project, not rotate passwords; a "transient" message lasting over a minute is an outage; never add 28P01 to `TRANSIENT_CONN_RE`.

**2026-07-17 (twice) and 07-22 — deploys that shipped nothing** [deploy-collision]
- Saw: the owner's view-as fix merged green and stayed broken in production; bugs already fixed on main kept appearing; every deploy run was green.
- Cause: the deploy concurrency group cancelled queued runs and the paths filter diffed only the last push, so the frontend job was skipped; a 40-minute run nearly published an older Worker over a newer one.
- Rule: "skipped" is not "deployed" — the frontend release is unconditional, the backend diff spans everything unreleased, and a deploy refuses to publish an ancestor of what is live; check the `/health` sha, not the badge.

**2026-07-24 — shipped accessories carried RM0 cost** [inventory-costing-oversell]
- Saw: accessories shipped on delivery orders showed RM0 COGS and 100% margin.
- Cause: ship-anyway oversell leaves the short units at zero cost for a later retro-cost, but the reconcile was wired only to GRN post; stock replenished by transfer, stock take, adjustment or return never retro-costed.
- Rule: every lot-opening stock-IN path calls `reconcileUncostedAfterIn`; wire a repair routine to every path that creates its condition; size money exposure with a read-only detector before any fix.

**2026-07-24 — "Supplier not found" after the 2990 cutover** [cross-company-detail-404]
- Saw: the owner opened a supplier and got "could no longer be found" (404), which read as data loss.
- Cause: by-id reads are scoped to the active company and the record belonged to his other company (bookmark or second window); a read-only diagnostic proved the data clean.
- Rule: a per-company by-id miss answers `in_other_company` with a switch button and never widens the read; prove a data claim with a read-only check before writing a data fix.

**2026-07-25 — movement ledger and FIFO ledger disagreed** [inventory-ledger-divergence]
- Saw: Stock Breakdown for MAKOTO RC(S)-FVI BRONZE: movements said 3 on hand, FIFO lots said 4, and two OUTs on one DO had one COGS row.
- Cause: an edit-after-ship resync wrote a delta OUT whose batch/variant key matched no open lot; the FIFO trigger discarded the shortfall, leaving an uncosted OUT.
- Rule: the two ledgers carry a standing agreement check; a batch OUT that shorts falls back to plain FIFO (migration 0195); a resync resolves the same consume key the first shipment used.

**2026-08-04 — one sales order delivered twice** [unlinked-line-duplicate]
- Saw: "why can one SO have two DOs?" — 2990-SO-2606-019 had two dispatched DOs and the pillow left the shelf twice, while a read-only check first said one DO.
- Cause: a manual DO carried lines with no `so_item_id` under a free-text SO number: stock moved, the order's remaining never dropped, and the over-delivery guard counts linked lines only; the check walked the same link.
- Rule: a nullable link is a nullable guard — an unlinked DO/GRN line for an item its named parent orders is refused; audit by header, not by link; when the owner's screen disagrees with a check, the screen is the evidence.

**2026-08-10, recurred 08-13 — stringified jsonb writes** [jsonb-double-encoding]
- Saw: cutover scripts reported "APPLIED – stamped 146 sofa lines" run after run while nothing changed; sofa line variants were being destroyed.
- Cause: `JSON.stringify` values bound to jsonb parameters in postgres.js were stored double-encoded, and `jsonb || jsonb` on a non-object concatenated into arrays; the repair script repeated it with `$2::jsonb`.
- Rule: pass objects (`sql.json`); a string that must be bound uses `$n::text::jsonb`; verify with RETURNING on a fresh connection, never a rowcount; `audit:jsonb-binds` gates CI.

**2026-08-11 — the write-back service failed open** [autocount-writeback-exposure]
- Saw: nothing; found while answering the owner's "why do we need a Service Key?".
- Cause: AcSyncService skipped auth when no key file existed, the key sat in a directory the cutover file server published, the log held customer payloads, and `/health` answered before the key check.
- Rule: a guard fails closed when its input is missing (no key → 503); never put a secret in a served directory; logs record route and document number, never payloads.

**2026-08-12 — legacy AutoCount read relay open to the internet** [autocount-read-relay-exposure]
- Saw: nothing; found by probing while checking an answer given to the owner.
- Cause: the pre-cutover relay applied auth per route and missed two — the purchase-order dump (52 MB) and the debtor list answered without a key. Closing it is an owner action (see tasks/TODO.md).
- Rule: default-deny at the edge; enumerate every route a public host serves; nothing new is built on that relay.

**2026-07-30 → 08-12 — staging stopped deploying while its nightly proof passed** [staging-bench-rot]
- Saw: nothing; staging was 775 commits behind main while the nightly Staging E2E passed every night.
- Cause: the staging Cloudflare token went invalid (9109), the deploy trigger had been narrowed to an unmaintained branch so the workflow went silent, the E2E schedule kept testing the stale build, and staging `/health` had no git sha.
- Rule: every deployed surface is stamped with its git sha and checked for staleness; a scheduled proof must fail when its deployment stops; pausing a workflow names what depended on it.

**2026-08-13 — write-back go-live: nothing reached the book** [autocount-writeback-golive]
- Saw: the owner switched the write-back on and saved HC-SO-2608-001 and -002; neither appeared in AutoCount while both looked healthy in the ERP.
- Cause: seven chained faults; the core shape was a fact held in two ERP columns (supplier SKU vs AutoCount item, header location vs line warehouse, `agent` vs `salesperson_id`) where the screen read both and the write-back read one; refused documents had no way back.
- Rule: the write-back reads the field the screen shows; refuse loudly into a readable `skipped` row; health checks print `last_error`; a copied workflow must be proven to have run.

**2026-08-13 — CI queue ate the working day** [ci-capacity]
- Saw: "CI used to be fast"; runs queued up to 14 minutes.
- Cause: strict up-to-date rule with 35 open PRs (~4.7 runs per PR), 10 runner slots per run against a 20-job cap, 277 test files paying Workers-pool setup serially; the split that fixed it silently stopped the `pretest` guard suite.
- Rule: time before optimising; invoke guard suites by name, never through lifecycle hooks; check the platform can do a thing before recommending it (the merge queue needed an organisation — the repo moved on 2026-08-18).

**2026-08-13 — rules that lived on one side only** [one-sided-rules]
- Saw: "I click deactivate and nothing happens"; variants demanded without a Processing Date; a payment method that could not be deleted; one question answered three ways.
- Cause: 35 UI mutations with no error path, a `variantsRequired = true` default inherited by 9 of 11 screens, vendored frontend copies of backend rules drifting, and a scope scanner whose regex matched nothing.
- Rule: every mutation has an error path; required props over defaults that hide a decision; mirrored rule pairs are pinned by an identity test; every checker self-tests its patterns and refuses to report from a dead one.

**2026-08-14 — a view migration stopped the backend release** [migration-gate]
- Saw: nothing; PR #2140 merged green, the frontend shipped and the backend stayed on the previous release.
- Cause: migration 0290 used CREATE OR REPLACE VIEW to rename and reorder columns, which only a real Postgres rejects; the migrate step runs before the Worker deploy, so the whole backend release stopped.
- Rule: write a view change against the live definition; CREATE OR REPLACE VIEW may only append columns (a DROP owes its grants back); a `skipped` backend deploy job is a failed deploy.

**2026-08-16 — the AcSyncService rollback had never worked** [acsync-deploy-rollback]
- Saw: after a routine rebuild on the office host the AutoCount write-back was dead for ~10 minutes (service not running, `/health` unreachable).
- Cause: the host deploy script's rollback raced the exe file handle and `ErrorActionPreference=Stop` abandoned it; the SQL address (wrong in Inistate's `setup.json`) was only tested after the service was stopped.
- Rule: test expensive preconditions before the first irreversible step; a rollback that has never run is not a rollback; the script ends with a liveness check and distinct exit codes (0 deployed, 1 refused, 2 down); never edit another system's config — pass `-Server`.

**2026-08-18 — nine hours without a production deploy** [deploy-secret-version-deadlock]
- Saw: nothing; 8 merges (75 backend files) were not live while tests were green and the deploy watchdog stayed green.
- Cause: wrangler-action uploaded secrets before deploying; Cloudflare refuses a secret edit while a newer undeployed Worker version exists (10215), so neither step could run; the watchdog exited 0 when it declined to act.
- Rule: deploy first, then upload secrets in a separate step (create a new secret before merging code that needs it); measure production by its `/health` sha; a check that chooses not to act must not read green.

**2026-08-18 — Sales Orders list showed "No sales orders yet"** [so-list-postgrest-stale]
- Saw: the main Sales Orders list was empty for a company with 2,726 orders.
- Cause: migration 0305 dropped and recreated 11 views; hosted PostgREST's 44-day-old connection pool served the new view as 0 rows (a 500 the page swallowed as empty); a full Supabase project restart cleared it.
- Rule: prefer CREATE OR REPLACE VIEW; after an unavoidable drop+create, recycle PostgREST (reload workflow with `recycle=true`, or a restart); confirm a fix on the endpoint body; never render a failed read as empty.

**2026-08-20 — document numbers re-issued** [doc-number-reissue]
- Saw: the AutoCount Sync page showed four documents refused with "Primary Key Error".
- Cause: numbers were minted as max(existing)+1; the go-live wipe deleted the top of each HC series and the outbox, so the ERP re-issued numbers the book already held (HC-SO-2608-001/-002, HC-PO-2608-001, HC-PI-2608-001).
- Rule: numbers come from `scm.doc_number_counters` and only go up (the live max is just a floor); a wipe never resets counters or deletes the export log; a gap is fine, a reuse is not.

**2026-09-12 — a migrated order's collected balance never reached the book** [migrated-so-lock-lifted]
- Saw: a balance collected on an old order and keyed in the ERP did not update the HC Delivery sheet; the customer still showed as owing.
- Cause: the migrated-order lock was off so staff recorded payments, but the write-back read `total_revenue_sen` (0 on migrated orders, which carry `local_total_sen`) and omitted `UDF_BALANCE` — 34 orders, RM 101,034.
- Rule: the write-back reads the same total the screen uses; outbox `sent` means dispatched, not landed — read the composed payload; verify a switch against the live DB, not its migration.

**2026-09-13 — clearing option pools deleted Model configuration** [option-pool-clear]
- Saw: sizes and headrest options vanished from the pickers (421 Models, both companies); the same day the 2990 POS lost every sofa colour.
- Cause: bulk scripts treated every `allowed_options` pool as a restriction, but MATTRESS/BEDFRAME `sizes` and `mattress_thickness_cm` are the configuration and the POS builds its colour chips from `fabrics`; both were restored from backups.
- Rule: enumerate every reader of a shared column, in both repos, before a bulk change; describe a destructive option by what it really deletes; a destructive script keeps its backup and restore statement beside it.
