# Bugs: classes and recurring pitfalls

The per-bug ledger (`docs/bugs/NNNN-*.md`, 1,477 entries) and `docs/bug-classes.md` were removed on 2026-09-15. List them with `git ls-tree --name-only archive/docs-2026-09-15 docs/bugs/`; read one with `git show archive/docs-2026-09-15:docs/bugs/<file>` (or `…:docs/bug-classes.md`).
New policy: a fixed bug gets a regression test, plus Symptom / Cause / Fix in 3 lines in its PR body. There is no per-bug file any more.
Only a NEW recurring class is added here, as one line: the mistake → what to do instead → the check that fails on it.

## Bug classes

A trap written down in prose recurred anyway; a class is closed only by a check. Paths are from the repo root.

- **Pre-serialized jsonb bind.** `JSON.stringify(x)` bound to a json/jsonb parameter is encoded again by postgres.js and stored as a jsonb string, while the UPDATE still reports rows → bind the object (`tx.json(x)`) or cast `$n::text::jsonb` → `backend/scripts/check-jsonb-binds.mjs`.
- **A failed read taken as an absence.** `const { data }` with no `error`, `data ?? []`, `count ?? 0`, `.catch(() => {})` turn "failed" or "not allowed" into "nothing here", and the code acts on it (money collected twice, uncapped receipts, list tabs showing 0) → bind `error`; refuse when the read authorises a write; show "could not read", never 0 → `backend/scripts/check-swallowed-reads.mjs`, `backend/tests/destructiveGuardsRefuseUnreadableProbe.test.ts`, `backend/tests/statusCountsFailLoud.test.mjs`.
- **An optional parameter that decides.** `companyId?`, `itemCode?`, `idempotencyKey?`, `asDraft?`: omitting it compiles and takes the dangerous default (every company, ship now) → declare `x: T | null` so every caller must answer → `backend/scripts/check-optional-decision-params.mjs`.
- **No company predicate.** The SCM client is service-role and RLS has no policies, so the predicate is the tenant boundary; a read or write by id, document number or code alone crosses companies → `scopedDb` / `scopeToCompany`, fail closed, `CENTRALISED('<why>')` when cross-company is intended → `backend/scripts/check-company-scope.mjs`, `backend/scripts/check-master-read-scope.mjs`.
- **One rule, several copies.** Status lists, date formats, predicates, backend/frontend and desktop/phone twins drift apart and production reads the stale copy → one home in `scm/shared` with a byte-identical frontend mirror, imported everywhere → `backend/scripts/check-duplicated-decisions.mjs`, `backend/scripts/check-shared-mirrors.mjs`, `scripts/eslint/houzs-lint-rules.mjs`.
- **A guard at the call sites, not the chokepoint.** One sibling document or one writer of a table never gets the cap, lock or cancel guard, and nothing disagrees to notice → put the rule in the single write path; register every document in the manifest → `backend/scripts/check-workflow-consistency.mjs`.
- **A link written on the key alone.** A `DtlKey`, document number, row position or client uuid links rows whose item, variant or company differ; a valid supplier code names another company → assert identity before linking, refuse on mismatch or ambiguity, never pair by position → `backend/tests/keyWithoutIdentityGuards.test.mjs`, `backend/tests/soLinkItemIdentity.test.ts`.
- **Silent truncation.** `.limit(N)` above a JS filter, PostgREST's `db-max-rows` response cap (assumed 1,000, never measured), ordering by uuid and unbounded `.in()` URLs drop rows with no error → filter in SQL, `paginateAll` with a total order, `chunkIn` for id lists → `backend/tests/chunkInOverlaps.test.ts`.
- **An empty result reported as a fact.** "Every line has been received", "there is no transfer API", a readiness gate passing over zero lines → say what was searched, run a positive control, require a non-empty population → `backend/scripts/check-empty-state-claims.mjs`.
- **An unenumerated completeness claim.** "Every call site" or "all four arms" in a PR that covered part of the population → put the enumerating command and its output in an `enumeration` block; CI re-runs it → `scripts/check-completeness-claim.mjs`.
- **A check that cannot fail or never runs.** Exit 0 on every path, wired to no workflow, a regex that matches nothing, a probe that prints SKIPPED and passes, `| tee` eating the exit code → plant a violation in a test, assert a non-empty population, wire it into CI → `backend/scripts/check-generators-run.mjs`, `frontend/scripts/check-typecheck-gate.test.mjs`.
- **Reading the empty one of two columns.** The screen reads both columns that hold a fact; the sync or report reads the empty one → find what writes a column before reading it; reuse the screen's fallback chain → `backend/src/services/autocount-writeback.contract.test.ts`, `backend/scripts/check-autocount-field-alignment.mjs`.
- **A derived value one writer forgets.** PO received status, `po_qty_picked`, header totals, a payment's journal, SO delivered status, the AutoCount edit after a raw-SQL repair → every writer (amendment, import, repair) calls the same recompute → no general check.
- **A best-effort side effect.** Stock reversal, allocation enqueue or journal posting inside a swallowing `try/catch` while the request answers 200 → same transaction, or fail the request → `backend/tests-pg/grnCancelAtomicity.pg.test.ts`.
- **A refusal nobody sees.** A mutation with no error path, a save that reports a count or "saved", a button the server refuses → show the server's own reason; gate controls with the route's predicate → `frontend/scripts/check-silent-writes.mjs`, `frontend/src/auth/projectActionGates.test.ts`.
- **A repeated submit.** A create with no Idempotency-Key, a key kept after a refusal, a slow POST pressed nine times → key every create, release the key on refusals before the first write, answer before slow side work → `backend/tests/grnPreWriteRefusalsReleaseKey.test.ts`.
- **Read-then-lock, or compare-and-set from a cache.** State read before the lock is taken, or an expected status taken from the query cache, loses updates or refuses the first click → lock, re-read, compare, write; expected values come from what the operator saw → `backend/tests-pg/soConcurrency.pg.test.ts`.
- **Type coercion at the database edge.** `COALESCE(enum, '')`, `''` into a DATE or enum column, text written into an enum, an integer id into a uuid column → cast before comparing (`status::text`), send `null` for blank, match the column type → no general check.
- **Time zone and date parsing.** Workers run in UTC but business dates are Malaysian; `new Date('YYYY-MM-DD')` is UTC midnight; `String(pgDate).slice(0,10)` is "Wed Jun 24"; native date inputs follow the OS locale → `backend/src/scm/lib/my-time.ts`, `fmtDate`, `DateField` → `frontend/src/vendor/shared/format.date.canonical.test.ts`, `backend/scripts/check-date-formatting.mjs`.
- **Many spellings of one value.** Straight and curly inch marks, `Col`/`Clr`, retired column names, one state called CONFIRMED/SUBMITTED/POSTED split stock buckets and defeat matchers → fold at the write boundary; register retired names → `backend/scripts/check-vocabulary.mjs`, `backend/tests/mfgPricingSmartQuotes.test.ts`.
- **A stale or mismatched comparison.** A repair planned from a weeks-old export; a checker comparing different cuts, currencies, scopes or populations; a count taken from a LIMIT → print snapshot dates and the denominator, re-cut before comparing, "cannot be compared" is its own verdict → no general check.
- **Prod-writing scripts outside the gates.** `backend/scripts` sits outside `tsc`, lint and most tests, so SQL ships unexecuted, names missing columns and still reports success → execute queries in `backend/tests-pg`, preflight columns, plan by default, verify by read-back, make reruns no-ops → `backend/tests/opsScriptsParse.test.ts` (parse floor only).
- **Deleting what should be cancelled.** Hard deletes of documents and lines (and purges of cancelled documents) destroyed history against the owner's cancel-only rule → cancel or retire; hard-delete only drafts and test data, behind a guard → no general check.

## By area

The pitfalls that recurred most, one line each.

### Sales orders and pricing

- The Processing Date has one column and one name; gates, lists, locks and the phone read the same one; setting it moves the order into In Production and clearing it moves it out → `backend/tests/soProcessingDateOneStorage.test.ts`.
- RM 0 is a price, not "unset": the pricing recompute must keep an authored zero on the line edit and on the amendment path alike.
- Imported (AutoCount-priced) orders are never re-priced from the catalogue or given surcharges on any edit path; decide "imported" with `backend/src/scm/lib/so-is-migrated.ts`, not by `linked_ac_docno` presence → `backend/src/scm/lib/erpLineTrustMigrated.test.ts`.
- A new amendment field needs the whole read path (route select, change diff, approver view, PDF, phone sheet), not only the write; approval must re-derive the bound PO (item code, supplier code, photo), and service lines never route to Purchasing.
- Derived lines (delivery fee) are rebuilt on every save: carry the operator's discount through the rebuild, and lock before reading the state being compared.
- Locks are per line: a partly delivered order keeps undelivered lines editable (`backend/src/scm/shared/so-line-freeze.ts`); the imported-order read-only lock must cover every router that writes the order (handover, header buttons, payments).
- The allocation cron bumps the order version, so a version conflict must offer "see changes / save on top" instead of refusing forever.
- Readiness lives in `backend/src/scm/lib/so-readiness.ts`; a gate over zero lines is vacuously true; a save must not run allocation or MRP line by line over serial round trips → `backend/tests/soAllocationReadShape.test.ts`.

### Purchasing: PO, GRN, PI

- Caps and recounts skipped lines with a null parent link, so one goods receipt could be billed twice; count unlinked lines that sit on the named parent → `backend/src/scm/lib/return-unlinked-lines.test.ts`.
- The supplier code must move with the item code on convert, amendment and correction; a PO line's code is the supplier's model, not ours → `backend/tests/sofaPieceToken.test.mjs`.
- Resolve `item_group` from the SKU on the server; a client-supplied or lost category drops the line out of MRP and out of the sofa stock bucket → `frontend/src/pages/scm-v2/poFromSoKeepsCategory.test.ts`.
- A PO line with no `so_item_id` is invisible to hard-bound demand; a consolidated line's SO links live in `po_item_allocations`, not the single-valued column.
- PO received status and the SO line's `po_qty_picked` are caches: every quantity writer (amendment apply, import, repair) must run the same recount.
- Carry AutoCount's line discount and the document currency; compare MYR with MYR; a zero-priced PO line opens a zero-cost stock lot.
- Pickers (From SO, Receive PO, Bill GRN) filter in SQL and page completely; list exports cover every filtered row, in ringgit to 2 decimals, not one screen page in sen.

### Delivery orders and returns

- DO status sets have one home, `backend/src/scm/shared/do-shipped-states.ts`: LOADED (shown as Confirmed) moves stock, and stock OUT, SO sync and invoicing key on the same set → `backend/tests/doShippedStatesMirror.test.ts`, `backend/tests/doStatusShipSyncPreship.test.ts`.
- `from-sos` without `asDraft: true` ships and deducts immediately; clients create drafts, and the status PATCH stays the single stock-writing chokepoint.
- Every DO line links to its SO line (derived on the server, 400 when ambiguous); over-delivery guards must count unlinked lines too → `backend/tests/deriveDoSoItemId.test.ts`.
- Cancel, line reduction and return reverse the recorded movements at the recorded cost, inside the request; never best-effort, never at an invented cost → `backend/tests-pg/returnDoUnitsAtCost.pg.test.ts`.
- The ship-from stock bucket comes from the SKU's category and hard binding, never from the client → `backend/tests/doLineCategoryFromSku.test.ts`.
- A DO whose line rows went missing reads as undelivered and releases the order back into MRP; header and lines are written together.
- `/:id/linked`, crew, rack, warehouse and consignment inputs are all checked against the active company.

### Stock, costing and MRP

- MRP planned over one truncated page of about 14,000 demand rows; every multi-row read pages with a total order, and opening a page must not run the whole engine live.
- A hard-bound line (sofa, bedframe, special-order mattress) is covered only by its own dedicated PO, never by pooled supply → `backend/src/scm/routes/mrp.test.ts`.
- The stock key is `computeVariantKey(item_group, variants)`: a missing category, a curly inch mark or a retired colour code splits one product into buckets nothing ships from.
- Coverage must use the same links and status sets as readiness, or MRP asks to buy goods already received or delivered.
- Display, showroom and service warehouses are not sellable (`backend/src/scm/lib/non-selling-warehouse.ts`); accessories keyed on code alone pool one customer's colour into another order.
- Zero-cost lots came from zero-priced POs, partly shipped lots and cutover lots; cutover cost comes from the book's cost layers, and shipped cost never from a rounded unit price.
- Stock-moving writes must invalidate the inventory queries the Stock Card reads.

### Accounting and GL

- Account codes repeat across companies: every GL view, join and voucher load carries `company_id` → `backend/tests-pg/glViewsScopeToCompany.pg.test.ts`.
- Every money writer posts or re-posts its journal (payment edit, deposit at SO create, supplier invoice payment); a legacy route that bypasses the voucher is closed, not left beside it.
- One predicate decides what counts in the books (reversed originals and their contras), read by statements, ledger and trial balance → `backend/tests-pg/glViewKeepsReversed.pg.test.ts`.
- Money paths were dead for days before anyone noticed (text written into an enum, a missing column, an unmounted auth bridge, a throwing number-prefix read); a posting failure must fail the request loudly.
- Voucher numbers and periods follow the document's Malaysian date, not the day it was keyed or the UTC clock.
- Bank and merchant matching is many-to-many (split payouts, one movement paying two vouchers); keep Finance's corrected amount over the uploaded one.
- Postings target accounts active in that company's chart.

### AutoCount write-back and sync

- Store the `DtlKey` every create, convert and rebuild returns; edited lines match on the key, an added or removed line rebuilds the document (SO and PO only: a converted document is never rebuilt, it would lose its transfer link), and a keyless edit is refused, never appended → `backend/tests/acLineRemovalIsUniform.test.ts`.
- Read lines in `inAcLineOrder` (`backend/src/scm/lib/ac-line-order.ts`) wherever keys and lines are zipped by index → `backend/src/scm/lib/autocount-so-to-po-pairing.test.ts`.
- AutoCount skips or refuses values longer than its column (address, Desc2, 50-character UDFs, warehouse code); cap at compose time and list offenders → `backend/scripts/check-too-long-for-the-book.mjs`.
- "Sent" is not "landed": a refusal needs a named reason and a way through on the Sync page, and the queue needs a health check → `backend/scripts/check-autocount-outbox-health.mjs`.
- SCM auth pins `user.id` to one system uuid for every caller, so an audit row's `actor_id` says nothing about authorship; "a human edited this" is decided by `backend/src/scm/shared/audit-author.ts` → `backend/src/scm/shared/audit-author.test.ts`.
- Transfers must carry header fields, debtor/creditor, warehouse and source line keys; the SDK's FullTransfer/PartialTransfer are inherited members, so reflect with FlattenHierarchy.
- A sofa is one book line and several ERP rows: fold by build (`backend/src/services/autocount-sofa-collapse.ts`), never by position or adjacency.
- Reconcilers compare one population, one cut, one currency and one field; "cannot be compared" is never counted as "differs" or "matches".
- A stored edit refused because the ERP re-keyed the line never cleared itself: the drain must recompose once from the current lines (`backend/src/scm/lib/autocount-stale-key-recompose.ts`), not replay the old payload.
- An approved SO amendment that added a line never reached AutoCount: `applySoAmendment` must capture the inserted row id and enqueue it like any other line edit.

### Cutover and migrated data

- Migrated documents moved no stock (`migrated_no_stock`): cancel, edit, relocate and line changes write no reversal; build reversals from recorded movements, not from lines.
- Migrated-document writers named only some columns, so money, salesperson, branch, customer block, delivery date and category stayed NULL without error; census every column the screens read after a writer runs.
- Copy the book's facts instead of deriving them: `paid_sen` was total minus balance at import time, and header totals never rolled up from repriced lines.
- The book's per-document aggregates are not line facts (aggregated received qty), and its conversion links live in `DocTransfer`, not in the `FromDocDtlKey` columns.
- Importers were insert-only: book edits after the cut need a delta lane, and a receipt the book recorded later needs its own document.
- The imported-order lock, freeze switches and grants must exist on staging too, or staging cannot reproduce production.

### Sofa, fabric and variants

- Desc2 parsing lives on token boundaries: a bare `C` is a corner, `Clr` is a colour label, a measurement rule needs a left boundary, a bracketed build beats its label → `backend/tests/parseSofaGrammar.test.ts`, `backend/tests/parseSofaClrAndLeg.test.ts`.
- Colour matching had five hand copies; use `backend/scripts/lib/fabric-colour-match.mjs` and `backend/scripts/lib/colour-identity.mjs`, and select `active` so a superseded fabric row redirects to its live row.
- The fabric library renumbers (a `-7` tail became `-07`); a text selector written against the old label goes silently inert.
- Never replace the whole `variants` object: merge keys, and bind objects, not strings → `backend/tests-pg/variantMergePreservesKeys.pg.test.ts`.
- The master-follower cascade never copies per-line keys (remark, build key, specials) → `frontend/src/vendor/scm/lib/so-variant-cascade.test.ts`.
- A sofa build spans several rows: dedicate, price, deliver and correct every compartment, not the lead row, and never give each row the whole price.
- Handedness and TV position come from the owner's ruling, and the latest ruling wins (`backend/scripts/lib/sofa-rulings.mjs`).

### Mobile and desktop parity

- The phone re-implemented rules the desktop imports (Mail Center reply-all and sender, Processing Date derivation, fabric pool); import the shared module → `frontend/src/mobile/MobileMailCenter.test.tsx`, `frontend/src/mobile/MobileFabricPicker.test.tsx`.
- Phone convert wizards omitted `asDraft`, so a few taps shipped a DO or issued a customer invoice → `frontend/src/mobile/mobileConvertDraftInvoice.test.tsx`.
- Capabilities existed on one surface only (add a line, create PO/GRN/PI, refund on a cancelled order, turn off 2FA, the archived-project lock); ship both or state the gap.
- Saves reported a count instead of the server's reason, and a refusal kept its idempotency key so the corrected save was refused again → `frontend/src/mobile/MobileSoSaveFailureReason.test.ts`.
- iOS Safari: `appearance: none` and overlay inputs stopped the date picker opening, and unpadded typed dates were dropped; try date fields on a phone.
- Desktop bulk actions sent no Idempotency-Key while the phone did; one request carries the same headers on every surface.

### Permissions and company scope

- A lookup by document number, code or uuid alone crosses companies; inserts stamp `company_id`, every other statement filters on it → `backend/scripts/check-company-scope.mjs`.
- Fail closed: a user with zero grants gets no company, not all of them; a failed permission read never grants.
- `houzsUser` is set by each sub-router's own auth; a guard mounted above it (write freeze, cancel approval) reads nothing.
- Approvers act through the approve key; an area guard demanding edit level locks them out of signing.
- Client controls use the route's own predicate, and a form never says "saved" when the server stripped the field → `frontend/src/auth/projectActionGates.test.ts`.
- Role grants missing from the permission catalogue were dropped without a word → `backend/tests/permissionCatalogueDrift.test.ts`.
- Visibility keyed on free-text names (sales agent, position name) breaks on a rename; key on user ids.
- An inviter cannot grant above their own level; Actions logs are public, so no staff names, passwords or secrets in them.

### CI, deploy and migrations

- Never edit a migration that may have applied (checksum drift blocks every deploy); prove it is absent from `_pg_migrations`, or add a new file → `backend/tests/migrationChecksum.test.ts`.
- Mint migration names with `scripts/new-migration.mjs`; hand-picked numbers collided again and again → `backend/tests/migrationNumbers.test.ts`.
- Dropping a view drops its grants, and PostgREST keeps serving the old shape; restore grants in the same migration and reload the schema cache (pg-migrate does) → `backend/tests/viewDropCarriesGrantRestore.test.ts`.
- Migrations written against a renamed column or a different baseline blocked production deploys; rehearse on staging, and give `ALTER TABLE` on busy tables a lock timeout.
- A Pages deploy deletes the chunks that open tabs still load; keep previous assets → `frontend/scripts/retain-previous-assets.test.mjs`.
- Secrets are environment-scoped: a job needs `environment:`, and a job that could not read its secret fails instead of printing SKIPPED.
- A failed `needs:` job skips its dependants, and roll-ups read skipped as green → `scripts/ci-queue-reuse.test.mjs`.
- Staging needs production-shaped data, switches and grants, and a red staging run must notify someone.

### Tests, gates and generators

- A gate charges the change that introduced a violation, not every open PR that inherited it; committed generated files and line-number citations conflict on every PR.
- Every scanner plants a violation and asserts it fires, refuses a verdict over an empty population, and cannot be satisfied by a comment → `backend/tests/jsonbBindScan.test.mjs`.
- A gate is only as wide as the spellings it imagines (an expression, a variable, a sibling type); each one states what it cannot see.
- Gates must give the same verdict on Windows, CRLF checkouts and Linux CI (path roots, shebangs, line endings).
- Tests that never ran counted as passing (`node:test` files outside vitest, a concise-arrow `beforeEach` returning the mock); drive the real call site, not a source substring.
- A fixture looser than production (no enum types, no row cap) lets invalid SQL and truncation through; fakes enforce the real limits (`backend/src/scm/lib/fake-postgrest.ts`).

### Scripts, probes and repairs

- Run every SQL statement before shipping: keep it in `backend/scripts/lib`, execute it in `backend/tests-pg` against real Postgres, and dispatch the workflow from the branch before merging → `backend/tests-pg/probeUndatedDemandSql.pg.test.ts`.
- Status columns are enums: cast before `COALESCE` or `upper` (`status::text`), and never compare an enum with `''`.
- Check every column a script names against the schema first and refuse by name; tables key on uuid `id` or on `doc_no`, not one or the other everywhere.
- Plan by default, apply behind a confirm input, verify by reading back on a fresh connection (not `res.count`), and make the second run a no-op.
- Report a population with `count(*)`, never `rows.length` of a LIMITed query; verify only the lanes that ran; a section that did not run fails the job.
- Postgres dates arrive as `Date` objects; with a `max: 1` pool, a helper that uses the outer connection inside `sql.begin` hangs.
- `backend/scripts/lib/pgrest-shim.mjs` lacks embeds, savepoints and upsert, and route code swallows per-document throws: preflight the exact read or refuse.

### Frontend UI

- A mutation with no error path hides the server's refusal; show the server's sentence → `frontend/scripts/check-silent-writes.mjs`.
- A hook after an early return crashes on a cold load → `frontend/eslint.config.mjs` (`react-hooks/rules-of-hooks`).
- Menus inside clipped containers portal through `frontend/src/lib/anchoredPanel.ts`; native `confirm()` prompts are replaced by in-app dialogs.
- Dates go through `fmtDate` and `DateField`; money shows 2 decimals with thousands separators everywhere, exports included → `backend/scripts/check-date-formatting.mjs`.
- Status words come from `frontend/src/vendor/scm/lib/status-pill.ts`, not per-page maps; never print a raw enum.
- Saved grid layouts and column filters hid rows, re-rendered forever and overwrote layouts; a funnel filter is visible and clearable, and lives in in-visit memory (clean on a fresh page load, kept across route changes) — never localStorage.
- A loading or failed state never renders a value ("STOCK", "0", "No history yet").

### Projects, service cases, fleet and mail

- Service case visibility keyed on a free-text agent name, and defect review keyed on a position name, vanished on a rename or reorg; key on ids and the creator.
- Voided or cancelled records kept escalating, emailing and counting as pending; every list, count and job applies the same status filter.
- Slow side work (translation, email) runs after the response; a slow POST gets pressed again and duplicated without an idempotency key.
- Banners and bells re-read whole tables every minute from every session; cache for longer than the poll interval.
- Venue, showroom, trip and service-case reads need the company predicate; a null company id in `.eq()` matches nothing and mints duplicates.
