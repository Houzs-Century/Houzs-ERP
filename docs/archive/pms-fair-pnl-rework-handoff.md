> **ARCHIVED 2026-08-13.** Rework closed — the file records RECONCILE COMPLETE on **2026-07-27**. The one item still open is tracked in `tasks/FAIR-PNL-RENTAL-OPEN.md`. Kept for history; do not follow it as a current instruction.

# FAIR PNL seed — rework handoff (2026-07-26)

Historical roadshow P&L backfill into the PMS from the owner's Excel (`~/Downloads/FAIR PNL Y'2024/2025/2026 (1).xlsx`). The first seed shipped, then several bugs surfaced (owner-caught). This doc is the single source of truth to finish it cleanly. Scripts live in `backend/scripts/fair-pnl/`; every DB touch runs via an owner-triggered GitHub Actions workflow (dry-run default, `secrets.DATABASE_URL`). **A new workflow must be merged to `main` before it can be dispatched.**

## RECONCILE COMPLETE — 2026-07-27 (scope 2024-01-01 .. 2026-06-30)

The 5-step owner spec + COGS-gap fill are done and committed to prod. All runs were dry-run-reviewed before commit; nothing on/after 2026-07-01 was touched. New scripts + read-only/owner-triggered workflows: `reconcile-cleanup`, `reconcile-dedup`, `reconcile-empty-delete`, `reconcile-fillcats`, `reconcile-tally` (PRs #1324, #1326).

| Step | Script / workflow | Committed |
|---|---|---|
| Cleanup (relabel + blank strays) | `reconcile-cleanup` | Relabeled **4** `AKEMI C&C` -> `AKEMI`; deleted **2** blank stray projects (p14 ZANOTTI @ Stadium Bukit Jalil, p17 blank AKEMI @ Setia Spice) that matched only a blank Excel row |
| Step 5 dedup (same brand+venue+Mon-Sun week) | `reconcile-dedup` | Deleted **15** completely-empty duplicates of a data-carrying twin. **1** ambiguous group left for owner (both carry income) |
| Step 3 empty-delete (0 lines/photos/docs, no sales match) | `reconcile-empty-delete` | **0** deleted — 28 empties matched a real Excel event (filled below); 13 venue-mismatch shells kept for owner review (a matcher gap, not a phantom) |
| COGS-gap fill (missing categories on every matched project) | `reconcile-fillcats` | Inserted **372** lines across **98** projects (sales 28, cogs_matt_sofa 95, cogs_bedframe 62, cogs_accessories 63, rental 28, setup 96). No existing line touched; legacy `cogs` + one-event-one-project guards prevented double-count. System COGS **41.2% -> 47.1%** of revenue (Excel in-scope ratio ~47.9%) |
| Step 6 tally (read-only) | `reconcile-tally` | See below |

**PMS project count (in scope): 487 -> 470** (-17: 2 cleanup + 15 dedup; fillcats added 0 projects, only lines).

**Tally grand total PMS vs Excel** (2024-01..2026-06): COUNT 470 vs 451 (+19); REVENUE 46,984,682 vs 45,719,069 (+2.8%); COGS 22,117,323 vs 21,888,115 (+1.0%); RENTAL 10,161,166 vs 10,230,251 (-0.7%); SETUP 2,544,375 vs 2,526,910 (+0.7%). **2024 matches to the ringgit** on every metric; 47 of ~150 month/metric cells differ.

**Left for owner review (surfaced, never auto-changed):**
- Dedup ambiguous: **p576 + p567** (AKEMI @ SUNWAY KLUANG MALL, 2025-05-19) both carry income — decide which is the real event.
- **13 venue-mismatch empty shells** (AEON MALL roadshow, mostly 2025-07/08): same brand + near date but a venue not in the Excel under that name; empty, kept for review.
- **Data-carrying duplicate pairs** with venue-spelling variants dedup could not merge (e.g. p461 "SUNWAY CARNIVAL MALL" vs p598 "SUNWAY CARNIVAL"; recurring p426 "BOULEVARD SHOPPING MALL MIRI") — these are the main source of the 2025 PMS>Excel overcount.
- **2026-02: PMS 6 projects vs Excel 2 events** — owner projects (created_by=3) for events the Excel does not list; likely an Excel gap for that month.

Note: the COGS gap existed because the earlier `reconcile-addlines` only filled projects with NO income line; projects that had a sales line but were missing COGS/rental/setup kept dragging the aggregate down. `reconcile-fillcats` fills by MISSING category on every matched project, which is what closed it.

## Owner rules (hard)
- Accuracy must match Project Maintenance. Venue/brand/organizer/event_type must MATCH the maintained pickers — **no free text**. State from the 16-state maintained list.
- Cross-month event = ONE project. Never delete Apr-2026+ owner data.
- **NEVER rush money-data changes in a long/tired context** — that caused the ×100 bug. Always: read-only dry-run → owner review → commit.
- Fill the owner's existing projects; **don't delete owner data**. Delete seed duplicates + PMS projects that match no Excel event. Owner insists events "一定 match 得上" → treat a high no-match count as a MATCHER bug, not missing data.

## Done + LIVE in prod (verified)
| Fix | PR | Result |
|---|---|---|
| 2025/26 seed | #1310 | 203 projects inserted, 25 venues created, 274 skipped |
| Venue 统称 | #1310 | 5 merges, 12 convention-centre full names, 6 state fixes (venue FIELD only) |
| **amount ×100** | #1311/#1314 | `project_finance_lines.amount` is WHOLE-RM integer (app `createLedgerLine` stores raw; `fair-report.ts:375` "NOT centi"; cost-rate `boost_min_sales=130000` only sane as RM; frontend create sends raw & compares half-cent). Seed used `rm*100` → RM 2,221M + int4-overflow 500. Fixed: `fix-seed-amounts.mjs` ÷100 the 1076 seeded lines (match `description LIKE '%(FAIR PNL seed)%'` — seed left finance-line `created_by` NULL), marked `[rm]`. seed now stores `toRm()`. |
| 7 seed-vs-owner dups | #1311 | `dedupe-fair-pnl.mjs` removed 7 (KLCC + Kuching MetroCity) |
| occurred_at / date filter | #1314 | Finance Lines date filter uses `COALESCE(occurred_at, created_at)`; seed left occurred_at NULL → used seed run date. `fix-seed-occurred.mjs` set occurred_at = project start_date on 1040 lines; seed now sets it. |

## Root design flaw (the rework)
The seed CREATED ~193 (now ~249 counted) new projects instead of FILLING the owner's ~379 existing projects. On a dedup match it just SKIPPED without adding finance lines → those owner projects stay EMPTY (212 empty), and the inserted ones DUPLICATE. So filtered views are fragmented (Dec-2025 shows RM 69K vs real ~RM 2-3M).

## Reconcile audit (read-only, `reconcile-audit.mjs`, run 2026-07-26)
Scope 2025 + 2026-Jan-Apr = **393 Excel events**:
- **142** match an owner project that ALREADY has data → leave.
- **13** match an EMPTY owner project → fill.
- **238** NO owner match → matcher too weak (brand+venue+date±10). canonVenue is CONFIRMED correct (SSCC→Setia Spice, MIDVALLEY→Mid Valley, IOI City→IOI Mall Putrajaya). Only **1** malformed date (`2025-26-17`, AEON Alma — build_seed_data.py cross-month bug).
- Owner projects: 379 (212 empty). Seed projects (created_by=0) to remove: 249.

## The rework — do in a FRESH focused session

> DONE 2026-07-27 — see **RECONCILE COMPLETE** at the top. The steps below are the original plan, kept for provenance. Remaining open items are the owner-review list in that section; 2024 (`build_2024.py`) is still sparse (3 events) and the follow-on features below are unstarted.
1. **Strengthen the matcher first** (why 238 miss): enhance the audit to print, per no-match event, the nearest owner project (same brand, any date / any venue) → classify date-mismatch vs venue-mismatch vs genuinely-absent. Then match owner EMPTY projects by brand+venue ignoring exact date; use organizer as tiebreaker.
2. Fix the 1 malformed date in build_seed_data.py; add within-batch dedup (two Excel spellings → one project, e.g. IOI Damansara).
3. Update `canonVenue` in seed-fair-pnl.mjs for the 统称 renames (it's STALE — returns "KLCC CONVENTION CENTRE" not "KUALA LUMPUR CONVENTION CENTRE"); `reconcile-audit.mjs` already has the RENAME map to copy.
4. DELETE all seed projects (created_by=0). Re-import in FILL mode: add finance lines to the matched owner project; create new only when no match; delete PMS projects matching no Excel event.
5. Titles = standard venue full name + FULL state name; stage=completed for past events; update `projects.name` where venue was renamed (统称 only updated `projects.venue`).
6. Scope 2024 + 2025 + 2026-before-May (owner: never empty). 2024 needs `build_2024.py` finished (single COGS col, `X/Y`=mattress/bedframe, single=mattress/sofa, no accessories, MYLATEX ok, Mar–Dec, SKIP showroom Dunlopillo-Suite/Kelana-Jaya, SKIP transport).
7. Complete costing per project: Revenue + COGS(matt_sofa/bedframe/accessories) + Rental + Setup + auto Transport/Commission/Merchandise.

## Follow-on features (owner-approved)
- **Effective-dated cost rates** (rates historically CONSTANT → backfill `effective_from=2024-01-01`): `project_cost_rates` gains `effective_from`, many rows/brand; `recomputeAutoCostLines` picks rate where `effective_from <= project.start_date` (latest); saving a rate INSERTs a new dated row + recomputes only the affected window. The cost-rate SAVE currently HANGS ("Saving...") because the seed enlarged per-brand cohorts and it recomputes ALL synchronously (Worker timeout, routes/projects.ts:665-672) — new save must recompute only the affected window; the one-time auto-cost backfill runs via a WORKFLOW, not the UI save. Frontend Cost Rates UI adds effective date + history.
- **Analytics rework** (NOT done): cards/tables show Revenue, COGS, Rental, COST, GP, NP (all by amount), not just Income/Profit/Margin.
- **Move Project Finances into the Finance module**, finance-staff only.
- Intermittent "Failed to load" on /finance/lines (loads sometimes) — likely Worker timeout on the 200-row aggregate, NOT int4 overflow (that's fixed).

Memory: `~/.claude/projects/<hash>/memory/fair-pnl-seed.md`.
