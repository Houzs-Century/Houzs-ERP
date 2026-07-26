# FAIR PNL seed — rework handoff (2026-07-26)

Historical roadshow P&L backfill into the PMS from the owner's Excel (`~/Downloads/FAIR PNL Y'2024/2025/2026 (1).xlsx`). The first seed shipped, then several bugs surfaced (owner-caught). This doc is the single source of truth to finish it cleanly. Scripts live in `backend/scripts/fair-pnl/`; every DB touch runs via an owner-triggered GitHub Actions workflow (dry-run default, `secrets.DATABASE_URL`). **A new workflow must be merged to `main` before it can be dispatched.**

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
