# What to trust, and for what

This repo has a lot of markdown. Most of it was written to be true on the day it
was written, and some of it has not been true for months. This file is the map:
for each subject, **which single file is authoritative**, so you do not have to
guess between two documents that disagree.

Read it as a routing table, not as a reading list. You want one row.

**The rule that put each file where it is** (from
[`KNOWLEDGE-SYSTEM.md`](KNOWLEDGE-SYSTEM.md)): *a fact belongs in the layer that
will be forced to update it when it changes.* A doc nothing forces you to revisit
is a doc that will lie to you, which is why plans and runbooks whose work has
shipped now live in [`archive/`](archive/) instead of beside the live ones.

**One thing this map cannot promise.** "Authoritative" means *this is the file to
read and the file to correct* — not that every line in it is currently true. When
a file disagrees with the code, the code wins and you fix the file. Section 9
lists the disagreements already found.

---

## 0. What a commit owes these documents

Before anything below: the root [`README.md`](../README.md) carries **"What a
commit owes the documentation"** — one table of what each kind of change must
update, and for every row, who enforces it and whether it can block a merge.
Read it once. The recurring failure here is never a wrong document; it is a
change that shipped while the document describing it stayed still.

The short version, because two of these surprise people: only
`backend-typecheck` and `frontend` can block a merge, so a red
`working-agreement` stops nobody — and **nothing at all** gates a COE, the
regenerated `route-locator` / `codebase-map-facts`, or the Obsidian wiki.

## 1. Start here

| File | Authoritative for |
|---|---|
| [`../CLAUDE.md`](../CLAUDE.md) | The rules and traps every session must obey before touching anything: the two migration trees, the company-scope predicate, the optional-param bug class, the shebang/vitest trap, `main` branch protection, "never ask the owner to run a query". Deliberately thin — rules only, no inventory. |
| [`CODEBASE-MAP.md`](CODEBASE-MAP.md) | What each area of the tree is FOR, and the judgement you cannot grep for: which trees are vendored, which are dead, the d1-compat shim, the `/api/scm/*` identity swap, which files are too big to open whole. **Read this instead of exploring.** |
| [`KNOWLEDGE-SYSTEM.md`](KNOWLEDGE-SYSTEM.md) | Where a new fact belongs, and why these layers exist. Settles "should this go in `CLAUDE.md` or a module guide or the generator?". |
| [`../BUG-HISTORY.md`](../BUG-HISTORY.md) | Every bug: symptom → traced root cause → fix → ref. Also the **BUG CLASS** entries at the top, which are the recurring shapes. Mandatory to append to, in the same PR as the fix. |
| [`../README.md`](../README.md) | The repo's front door — stack, quick start, deploy commands. **Partly stale**; it carries a banner naming exactly which of its claims the code contradicts. Prefer `CODEBASE-MAP.md` for anything structural. |

## 2. Generated — never hand-edit, never copy the numbers out

`generated/` is computed from the tree by `backend/scripts/gen-codebase-map.mjs`.
**Regenerate with the generator itself — `node backend/scripts/gen-codebase-map.mjs`.**
`npm --prefix backend run audit:map` is `--check`: it reports drift and exits 1,
it does NOT rewrite the file. (This line said "Regenerate with … audit:map"
until 2026-08-14.) The check is deliberately not a CI gate — a stale navigation
doc must never block a deploy.

| File | Authoritative for |
|---|---|
| [`generated/route-locator.md`](generated/route-locator.md) | Every route's **file and line**. Use this to jump into a multi-thousand-line router instead of reading it whole. Regenerate: `npm --prefix backend run gen:route-locator`. |
| [`generated/route-capability-matrix.csv`](generated/route-capability-matrix.csv) + [`generated/route-capability-summary.md`](generated/route-capability-summary.md) | Each route's full mount path and permission gates. [`route-capability-matrix.md`](route-capability-matrix.md) is the hand-written note explaining how the inventory is built and versioned. |
| [`generated/codebase-map-facts.md`](generated/codebase-map-facts.md) | All counts and inventories: route modules, both migration trees and their highest numbers, largest source files, desktop route table, mobile screen list, desktop/mobile pairing. **Any number typed anywhere else is the wrong copy.** |

## 3. Per-module guides — `modules/`

Owner rule: **read the guide for the module you are touching before you touch it,
and update it in the same PR if you change that module's surface** (a new
endpoint, permission, status, lock, or a field that starts or stops being
required). If a module has no guide, writing one is the first task.

Each file is authoritative for that module's surface — its endpoints, statuses,
permissions, locks, and the traps found while working in it:
[`sales-order.md`](modules/sales-order.md) ·
[`sales-invoice.md`](modules/sales-invoice.md) ·
[`quote.md`](modules/quote.md) ·
[`delivery-order.md`](modules/delivery-order.md) ·
[`delivery-return.md`](modules/delivery-return.md) ·
[`purchase-order.md`](modules/purchase-order.md) ·
[`purchase-order-amendment.md`](modules/purchase-order-amendment.md) ·
[`purchase-return.md`](modules/purchase-return.md) ·
[`purchase-consignment-order.md`](modules/purchase-consignment-order.md) ·
[`grn.md`](modules/grn.md) ·
[`payment-voucher.md`](modules/payment-voucher.md) ·
[`mrp.md`](modules/mrp.md) ·
[`stock-take.md`](modules/stock-take.md) ·
[`warehouses.md`](modules/warehouses.md) ·
[`combo-pricing.md`](modules/combo-pricing.md) ·
[`scan-to-so.md`](modules/scan-to-so.md) ·
[`service-case.md`](modules/service-case.md) ·
[`projects-pms.md`](modules/projects-pms.md) ·
[`delivery-tms.md`](modules/delivery-tms.md) ·
[`delivery-rate-card.md`](modules/delivery-rate-card.md) ·
[`fleet-maintenance.md`](modules/fleet-maintenance.md) ·
[`mail-center.md`](modules/mail-center.md) ·
[`announcements.md`](modules/announcements.md) ·
[`team-members.md`](modules/team-members.md) ·
[`global-search.md`](modules/global-search.md) ·
[`document-traceability.md`](modules/document-traceability.md) ·
[`autocount-writeback.md`](modules/autocount-writeback.md)

Two of these are the authority for a *mechanism* rather than a screen, and are
easy to miss: **`autocount-writeback.md`** owns how to call the write-back
service, the master-data foreign-key chain and the payload shapes; and
**`document-traceability.md`** owns the read-time purchase→sales linkage display
(no writes, no snapshot — do not add one).

## 4. AutoCount — more than one channel, running in opposite directions

**Start at [`autocount-integration-map.md`](autocount-integration-map.md).** It is
authoritative for *which* channel you are dealing with and which document you
need next. Getting this wrong is the single most expensive mistake in this area,
because the read relay and the write-back run opposite ways.

| File | Authoritative for |
|---|---|
| [`autocount-integration-map.md`](autocount-integration-map.md) | The map of every channel between the two systems: direction, purpose, and what each is allowed to do. |
| [`modules/autocount-writeback.md`](modules/autocount-writeback.md) | The ERP → AutoCount write-back: how to call it, the FK chain, payload shapes. |
| [`autocount-field-alignment-audit.md`](autocount-field-alignment-audit.md) | Per FIELD: which ERP column the composer reads, whether that is where the ERP keeps the value, whether anything opens the master, and what AutoCount does when it is missing. The BROKEN / AT RISK list, with the numbers. Read it before adding a field to a payload. |
| [`archive/autocount-sync-coverage-2026-08-11.md`](archive/autocount-sync-coverage-2026-08-11.md) | Coverage and gaps of the write-back. Carries its own SUPERSEDED-conclusions box — read that box before quoting anything from it. |
| [`autocount-migration-record.md`](autocount-migration-record.md) | The one-time AutoCount → ERP migration: how it was done, what broke, and the numbered runbook to resume it. |
| [`autocount-cutover-ledger.md`](autocount-cutover-ledger.md) | Which rows came from AutoCount vs were made in the ERP, with an evidence chain to a workflow run id. The answer to "where did this row come from" a year from now. |
| [`cutover-tally-method.md`](cutover-tally-method.md) | How to COUNT and reconcile the outstanding SO/PO migration, re-runnably. |
| [`stock-reconciliation.md`](stock-reconciliation.md) | Reconciling ERP stock against the live AutoCount book, the owner's go-live blocker. |
| [`autocount-line-retirement-plan.md`](autocount-line-retirement-plan.md) | What must change before a line can be cancelled instead of deleted. AutoCount half shipped; ERP-side soft cancel not. |
| [`autocount-service-deploy.md`](autocount-service-deploy.md) | Building and deploying `AcSyncService.cs` on a host with AutoCount installed. |
| [`golive-readiness.md`](golive-readiness.md) | The assessment of what is left before staff move onto the ERP. Cites the four docs above rather than restating them. |
| [`write-freeze-staged-lift.md`](write-freeze-staged-lift.md) | The `scm.app_config['scm.write_freeze']` switch and how to lift it module by module, with the one-statement rollback. |
| [`generated/autocount-coverage.md`](generated/autocount-coverage.md) | **What actually works, AutoCount-side** — GENERATED from source every run. The four hand-written copies of this table contradicted each other; do not write a fifth. |

## 5. Multi-company, 2990, and tenant isolation

| File | Authoritative for |
|---|---|
| [`MULTICOMPANY-MODULE-MAP.md`](MULTICOMPANY-MODULE-MAP.md) | Which modules are SEPARATE / SHARED / unified-with-targeting, and **the predicate-is-the-only-isolation rule**. The service role bypasses RLS; read this before writing any query. |
| [`MULTICOMPANY-SCALING.md`](MULTICOMPANY-SCALING.md) | What it takes to add company 3+, and the natural-key masters that need `UNIQUE(company_id, key)` first. |
| [`add-company-design.md`](add-company-design.md) | The self-service "add a company + its account book" design. |
| [`2990-cutover/HANDOFF.md`](2990-cutover/HANDOFF.md) | The 2990 → Houzs cutover **outcome** and what is still open. The flip happened 2026-07-21; the plans and runbooks that got there are in [`archive/2990-cutover/`](archive/2990-cutover/). |
| [`2990-live-sync/00_DESIGN.md`](2990-live-sync/00_DESIGN.md) | The one-way 2990 → Houzs mirror, **still live** — its receivers are mounted at `/api/sync/*-mirror`. The SQL it describes sits beside it in the same directory. |
| [`2990-mirror-full-design.md`](2990-mirror-full-design.md) | The full-mirror design (authority, write-back, loop prevention). Its "no production code exists" banner is stale — see §9. |
| [`2990-parity-allocation-costing.md`](2990-parity-allocation-costing.md) | Point-in-time parity audit of allocation / batch / costing / inventory against 2990. |
| [`testing/scope-tests-backlog.md`](testing/scope-tests-backlog.md) | The cross-company scope regression tests still to be written, and the assert-both-directions pattern they must follow. |

## 6. Data, money, and inventory correctness

| File | Authoritative for |
|---|---|
| [`inventory-costing-integrity-audit.md`](inventory-costing-integrity-audit.md) | The risk register of every way inventory qty or costing can go wrong, with code evidence. Explicitly excludes double-posting. |
| [`inventory-idempotency-audit.md`](inventory-idempotency-audit.md) | Double-post and write-without-consume risk on every inventory-affecting post path. The other half of the pair above. |
| [`hard-delete-inventory.md`](hard-delete-inventory.md) | Every `DELETE` on the SCM route surface, classified, enforcing the owner rule **不可以删只可以 cancel**. |
| [`sofa-document-chain-map.md`](sofa-document-chain-map.md) | What one sofa build looks like at each stop SO → PO → GRN → DO, and which stops self-update vs need a push. |
| [`sofa-import-handoff.md`](sofa-import-handoff.md) | All sofa-import knowledge. Read before re-deriving any of it. |
| [`owner-fabric-catalogue.md`](owner-fabric-catalogue.md) | The owner-supplied fabric code list — the only authority on which fabric codes should exist. |
| [`duplicate-fabric-series-merge.md`](duplicate-fabric-series-merge.md) | The duplicate-fabric-series decision (merge; higher reference count wins) and its tool. |
| [`migrated-do-duplicate-lines.md`](migrated-do-duplicate-lines.md) | The 18 duplicate migrated DO lines and the Option-B decision applied to them. |
| [`MIGRATION-RETIREMENTS.md`](MIGRATION-RETIREMENTS.md) | The immutable exception list of migration filenames applied then removed. Do not delete those tracker rows. |
| [`../backend/scripts/scm-schema/README.md`](../backend/scripts/scm-schema/README.md) | Where the `scm` schema's CREATE side lives — the numbered tree only ALTERs. Records exactly how incomplete it is. |

## 7. Platform, delivery, and operations

| File | Authoritative for |
|---|---|
| [`STAGING-RELEASES.md`](STAGING-RELEASES.md) | The staging → prod promotion path, and the prod/staging topology. |
| [`emergency-deploy.md`](emergency-deploy.md) | The **only** sanctioned way to deploy prod outside GitHub Actions. Never run bare `wrangler deploy`. |
| [`DB-REPOINT-RUNBOOK.md`](DB-REPOINT-RUNBOOK.md) | Re-pointing prod at a different Supabase project, and the loader script that builds a schema. Still cited by `backend/scripts/load-d1-dump-to-pg.mjs`. |
| [`IDEMPOTENCY-PHASE2-RUNBOOK.md`](IDEMPOTENCY-PHASE2-RUNBOOK.md) | The fail-closed soak gate for idempotency phase 2. Cited from `backend/src/types.ts` and `mfg-sales-orders.ts`. |
| [`error-tracking-options.md`](error-tracking-options.md) | Why Sentry-on-free-plan via our own code, and what leaves the building. Cited from `services/errorTracking.ts`, `types.ts`, `wrangler.toml`. |
| [`server-snapshot-playbook.md`](server-snapshot-playbook.md) | The deliberately-deferred snapshot/cache machinery, and the recipe for when a trigger fires. |
| [`SCALE-PERFORMANCE-HARNESS.md`](SCALE-PERFORMANCE-HARNESS.md) | The scale fixture and its schema contract. |
| [`perf-optimization-plan.md`](perf-optimization-plan.md) | The live per-file, per-line performance work checklist. |
| [`scm-scaling-audit.md`](scm-scaling-audit.md) | Why the SCM pages feel slow, measured live, and the correctness-first fix ranking. |
| [`hookka-technique-parity.md`](hookka-technique-parity.md) | Which Hookka techniques we adopted, skipped, or still owe — with a verdict each. |
| [`FRAGMENTATION-MAP.md`](FRAGMENTATION-MAP.md) | Every "3-4 of the same thing" duplicate, what was fixed, and **which duplicates are intentional and must not be merged**. |
| [`AI-DEV-VELOCITY.md`](AI-DEV-VELOCITY.md) | Why sessions here are slow and token-heavy, and the progressive-retrieval fix. |
| [`HARDENING-COMPLETION-LEDGER.md`](HARDENING-COMPLETION-LEDGER.md) | Live status of the A–Z hardening scope. An item is DONE only with recorded acceptance evidence. |
| [`google-sheet-status-sync.md`](google-sheet-status-sync.md) | The ERP → HC Delivery sheet ASSR sync, and which columns each side owns. |
| [`../mail-sync/README.md`](../mail-sync/README.md) | The Gmail IMAP → ERP poller (no MX change). |

## 8. Security

| File | Authoritative for |
|---|---|
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | How the system could still be destroyed or taken, ordered by the owner's real priority (availability, not confidentiality), naming who owns each remaining action. |
| [`SECURITY-AUDIT-2026-07-23.md`](SECURITY-AUDIT-2026-07-23.md) | The point-in-time code-level audit findings. AI-assisted scan, not a pen test. |
| [`SECURITY-DX-ROADMAP.md`](SECURITY-DX-ROADMAP.md) | What shipped, what was deliberately not done and why, and who owns what next. |
| [`ACCOUNT-SECURITY-SETUP.md`](ACCOUNT-SECURITY-SETUP.md) | The owner-only account/platform actions no PR can perform (MFA first). |
| [`PERMISSION-MATRIX.md`](PERMISSION-MATRIX.md) | The position × page access grid — the seed script transcribes this file verbatim. Living doc. |
| [`USER-MANAGEMENT.md`](USER-MANAGEMENT.md) | The role/position model: roles decide actions, positions decide pages. |

## 9. Where two documents disagree

Kept as a list rather than silently merged, so you can see which side the code
was on. **The code-supported file wins; the other keeps a pointer.**

| Subject | The two files | Resolved |
|---|---|---|
| Data store, migration trees, tests, module list | [`../README.md`](../README.md) vs [`CODEBASE-MAP.md`](CODEBASE-MAP.md) + [`../CLAUDE.md`](../CLAUDE.md) | **Map + `CLAUDE.md` win.** The README now carries a banner listing each contradicted claim; it was not rewritten, so nothing is hidden. |
| Is 2990 a full replace, a mirror, or both? | [`archive/2990-cutover/DATA-FLOW.md`](archive/2990-cutover/DATA-FLOW.md) vs [`2990-cutover/HANDOFF.md`](2990-cutover/HANDOFF.md) | **Both, and that is not a contradiction.** Houzs owns the 2990 write path (`HOUZS_OWNS_2990="true"`) *and* the one-way mirror receivers stay mounted. DATA-FLOW is archived with that noted. |
| Is `main` branch-protected? | [`archive/2990-cutover/SESSION-HANDOFF-2026-07-24-session3.md`](archive/2990-cutover/SESSION-HANDOFF-2026-07-24-session3.md) ("no branch protection — you are the merge gate") vs [`../CLAUDE.md`](../CLAUDE.md) | **`CLAUDE.md` wins.** The `main-protection` ruleset has existed since 2026-07-31. The session handoff is archived with its rule 1 explicitly marked false. |
| Does the Draft/Confirmed lifecycle exist beyond SO? | [`archive/draft-confirm-plan.md`](archive/draft-confirm-plan.md) ("PLAN ONLY, nothing implemented") vs the routes | **The code wins** — DRAFT lifecycle ships on DO, SI, PO, GRN, PI. Archived. |

**Known-stale, not yet resolved** (reported, deliberately left alone rather than
half-fixed):

- [`2990-mirror-full-design.md`](2990-mirror-full-design.md) opens with *"design
  only … no production code exists"*, but `so-mirror.ts`, `customer-mirror.ts`,
  `staff-mirror.ts`, `warehouse-mirror.ts`, `amendment-mirror.ts` and
  `scm/lib/bridge-2990.ts` all exist and are mounted. The banner is wrong; the
  body is still being edited, so correcting it needs someone who knows which
  sections shipped.
- [`../reference/Database-Reference.md`](../reference/Database-Reference.md)
  describes the pre-Postgres table set and calls the migration in-progress. Treat
  `backend/src/db/schema.pg.ts` and `generated/codebase-map-facts.md` as the real
  answer.
- [`FOUNDATION-PLAN.md`](FOUNDATION-PLAN.md), [`UPGRADE-PLAN.md`](UPGRADE-PLAN.md)
  and [`UPGRADE-NEXT.md`](UPGRADE-NEXT.md) are roadmaps from 2026-06-13 whose
  status columns were never re-run. `FOUNDATION-PLAN.md` still names the
  abandoned Supabase project. They keep open items, so they were not archived.

## 10. Incidents — `*-coe.md`, left exactly where they are

A **COE** (Correction of Error) is the record of a serious incident: an outage,
data at risk, a fault that recurred. They are append-only history and are cited
by line from `BUG-HISTORY.md`, from other COEs, and from code comments — so
**none were moved**, and none should be. `docs/system-foundation-coe.md` is the
canonical shape to copy when writing a new one.

Find them with `ls docs/*-coe.md` rather than trusting a list here — a typed list
is exactly the thing that goes stale. One lives outside `docs/`:
[`../backend/docs/scm-view-trap-coe.md`](../backend/docs/scm-view-trap-coe.md).

The COE's most valuable section is **what the audit RULED OUT** — it is what
stops the next person re-chasing a disproved theory.

## 11. Live batons — read before assuming a subject is settled

These are not documentation; they are work-in-flight, and they expire.

| File | Carries |
|---|---|
| [`generated/autocount-coverage.md`](generated/autocount-coverage.md) | What actually works, AutoCount-side. Generated — three of its four columns are read out of source. |
| [`../tasks/FAIR-PNL-RENTAL-OPEN.md`](../tasks/FAIR-PNL-RENTAL-OPEN.md) | PMS rental/setup figures are **not** reconciled. Do not trust them until closed. |
| [`HANDOFF-2026-08-05.md`](HANDOFF-2026-08-05.md) | Session baton with items still open. Its own header says to delete it once they close. |
| [`agents/agent-platform-buildout.md`](agents/agent-platform-buildout.md) | Agent-platform build state and the specs meant to survive compaction. |
| [`../backend/scripts/data/supplier-price-list-DRY-RUN-2026-08.md`](../backend/scripts/data/supplier-price-list-DRY-RUN-2026-08.md) | An un-executed import checklist — nothing written yet. Check before running anything near supplier pricing. |

## 12. Specs and designs not yet built

Read these as *intent*, not as description of the system. Each states its own
status at the top; believe that line over this table.

[`delivery-planning-jobtypes-spec.md`](delivery-planning-jobtypes-spec.md) (seven
fleet job types) ·
[`delivery-tms-stage2-backend-spec.md`](delivery-tms-stage2-backend-spec.md) ·
[`tms-fleet-3pl-redesign.md`](tms-fleet-3pl-redesign.md) (WS1 shipped, WS2–4
queued) ·
[`pricing-effective-dating-design.md`](pricing-effective-dating-design.md) ·
[`ocr-payment-spec.md`](ocr-payment-spec.md) ·
[`ocr-self-evolution.md`](ocr-self-evolution.md) ·
[`ocr-prompt-audit.md`](ocr-prompt-audit.md) ·
[`agents/operating-spec.md`](agents/operating-spec.md) (owner-provided policy
source for agent decision authority) ·
[`agent-console-api.md`](agent-console-api.md) ·
[`ios-app-store.md`](ios-app-store.md) + [`app-store-metadata.md`](app-store-metadata.md)
+ [`../native/README.md`](../native/README.md) ·
[`mockups/README.md`](mockups/README.md) + [`mockups/pdf/README.md`](mockups/pdf/README.md)
(owner-approved mockups; approval unblocks the work, it is not the work).

## 13. Testing and design system

| File | Authoritative for |
|---|---|
| [`../e2e/README.md`](../e2e/README.md) | The ASSR Playwright lifecycle suite (staff + customer contexts in one run). |
| [`../frontend/e2e/README.md`](../frontend/e2e/README.md) | The staging smoke proofs that run after every staging deploy — "shipped" is not "working". |
| [`SERVICE_MODULE_TEST_GUIDE.md`](SERVICE_MODULE_TEST_GUIDE.md) | The manual ASSR walkthrough, written for a non-technical tester. |
| [`../frontend/.design-sync/conventions.md`](../frontend/.design-sync/conventions.md) | Design-system usage for the design agent (Theme C, Tailwind, no provider wrapper). |

## 14. `archive/` — history, not instruction

[`archive/`](archive/) holds documents whose work **shipped and closed**: plans
that were built, runbooks whose event was executed, session batons whose items
were merged, and reviews of branches that landed. Every file carries a header
saying what superseded it and when.

They were moved, never deleted — a plan is often the only surviving explanation
of *why* something is shaped the way it is. Read them for that. Do not follow
them as current instruction.

`reference/` is a different thing and stays put: it is the legacy Google Apps
Script export and brand assets, never imported by the app.

## 15. Where does a new fact go?

[`KNOWLEDGE-SYSTEM.md`](KNOWLEDGE-SYSTEM.md) is the full answer. The short form:

| You learned… | Write it… |
|---|---|
| A bug's root cause | `BUG-HISTORY.md`, same PR as the fix. Mandatory. |
| A serious incident | A new `docs/<subject>-coe.md`, shaped like `system-foundation-coe.md`. |
| A module's surface changed | That module's `docs/modules/<module>.md`, same PR. Mandatory. |
| Why an approach was rejected | The module guide, or `CODEBASE-MAP.md` §4 Traps. |
| A rule every session must obey | `CLAUDE.md` — only if short and stable. |
| A number, count or inventory | Nowhere. Teach `gen-codebase-map.mjs` to emit it. |
| A plan you just finished executing | Move it to `archive/` with a header, and add its successor to this map. |
