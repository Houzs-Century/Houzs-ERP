> **ARCHIVED 2026-08-13.** The seed ran and the follow-up reconcile completed **2026-07-27**. The one item still open is tracked in `tasks/FAIR-PNL-RENTAL-OPEN.md`. Kept for history; do not follow it as a current instruction.

# PMS historical seed — FAIR PNL 2025 + 2026 (build-ready plan)

_Owner request 2026-07-26: backfill historical roadshow projects from the two FAIR PNL Excel files into the PMS so the Finance Snapshot + analytics show real history without re-typing from Excel. Branch `feat/pms-fair-pnl-seed`. **Release HELD** — the prod write runs only on the owner's explicit go-ahead, via a DRY-RUN first._

## Source (verified by reading both files)

- `FAIR PNL Y'2025.xlsx` — sheets `Jan 2025 Sales` … `Dec 2025 Sales` (+ `Monthly & Quater PNL`, `G&A PNL`).
- `FAIR PNL Y'2026 (1).xlsx` — `Jan 2026 Sales` … `Aug 2026 Sales` (+ same two).
- Each month sheet has a **per-event table**. Header row = `DATE | BRAND | LOCATION | SALES | COST | … | GROSS MARGIN | RENTAL | TRANSPORT | SET UP | COMMISION | Est Merchant Fee | Transportation(4%) | NP`. The row **below** the header carries the COST sub-split: **`MATTRESS/SOFA | BEDFRAME | ACCESSORIES`** in the 3 columns right after `SALES`. Data rows start 2 rows under the header.
- Leading-column offset differs per sheet, so the extractor locates the header by name (`DATE`+`SALES`+`SET UP`) and maps columns by header text (`backend/scripts/fair-pnl/extract_fair_pnl.py`).

### Extractor result (this branch)
`python backend/scripts/fair-pnl/extract_fair_pnl.py` → 1107 raw event rows (1036 with a sales figure). Brands: AKEMI 654, ZANOTTI 320, ERGOTEX 58, DUNLOPILLO 46, CARRESS 3, AKEMI C&C ~4, + noise (`BRAND` header rows, `DUNOPILLO` typo). Sample verified: sales + COGS(matt/sofa, bedframe, accessories) + rental + setup all captured.

## Column → PMS mapping

`project_finance_lines` rows (per `services/projectCostRates.ts`): `kind` ∈ income|cost, `category`, `amount` (integer **sen** in prod — Excel values are RM, ×100), `company_id`.

| Excel | kind | category |
|---|---|---|
| SALES | income | `sales` |
| MATTRESS/SOFA | cost | `cogs_matt_sofa` |
| BEDFRAME | cost | `cogs_bedframe` |
| ACCESSORIES | cost | `cogs_accessories` |
| RENTAL | cost | `rental` |
| SET UP | cost | `setup` (booth setup — KEEP; owner reversed the earlier "remove") |
| COMMISION / Transport / Merchant | — | **do NOT seed** — auto-computed by `recomputeAutoCostLines` from the brand rate card |

`projects` header: `brand`, `venue`, `organizer`, `start_date`, `end_date`, `stage`='completed', `company_id`=Houzs Century, plus `code`/`name`. **TODO before writing the inserter:** confirm exact columns + the create path in `routes/projects.ts` / `schema.pg.ts` (grep `INSERT INTO projects`), and whether venue/organizer are FKs (`project_venues`/`project_organizers`) needing lookup-or-create.

## The two correctness problems (why this is a DRY-RUN, not a blind insert)

1. **Cross-month split → one project.** The old PNL split an event that spans two months across both month-sheets (owner: "我之前的 PNL 是把它拆分的，但在 PMS 里是一个 project"). Date strings look like `DD-DD/MM` (e.g. `03-05/01` = Jan 3–5, same month) and `17-02/11` (Oct 17 → Nov 02, cross-month). Merge rule: group rows by (brand, venue) with adjacent/overlapping date ranges into ONE project spanning the full range; SUM the money. **Parse care:** `start_day > end_day` ⇒ month rollover; the same event may also appear in the previous month's sheet.
2. **Dedup vs the ~432 already-seeded projects.** Cannot see prod from the dev box. The seed MUST, at run time, load existing projects for the company and skip any (brand, venue, start_date) already present. Normalise brand (`DUNOPILLO`→`DUNLOPILLO`), drop `BRAND` header-noise rows.

## Build steps (each a small, reviewable commit)

1. `extract_fair_pnl.py` (DONE) — Excel → normalized event JSON. Add: brand normalisation, header-noise drop, date-range parse (start/end ISO), venue/organizer split from `LOCATION` (`"HOMELOVE @ SSCC SPICE PG"` → organizer `HOMELOVE`, venue `SSCC SPICE PG` — confirm the convention with the owner).
2. Cross-month merge pass (pure, unit-tested).
3. `backend/scripts/fair-pnl/seed-fair-pnl.mjs` — reads the JSON, connects with `DATABASE_URL`, **`--dry-run` default**: prints per event INSERT vs SKIP(dedup) + totals; `--commit` writes. Idempotent (re-run safe). Insert project + finance lines, then call `recomputeAutoCostLines` so the auto rows compute.
4. `.github/workflows/seed-fair-pnl.yml` — `workflow_dispatch`, own concurrency group (never the deploy's), `--dry-run` input default true. Owner uploads the two Excel files as inputs OR the JSON is committed. Read-only until the owner flips `--commit`.
5. Verify against screenshots: Finance Snapshot shows the 10 lines; the project list + analytics fill with real 2025/26 numbers.

## STATUS 2026-07-26 — data DONE + reconciled; inserter is the last build

**Data pipeline complete + owner-verified** (`backend/scripts/fair-pnl/build_seed_data.py`):
- 556 raw rows (table-1 only — the 2nd/3rd claim tables were the double-count) → **472 projects** (2025: 293, 2026: 179).
- **2025 SALES RM 31.66M · 2026 SALES RM 15.86M** — 2026 matches the owner's own Finance Lines (~15.45M). ✅
- COGS split correct (matt/sofa > bedframe > accessories). Event type: **Exhibition 296 / Roadshow 176**.
- All owner rules baked in: event_type (Roadshow=SOLO incl VINCENT/SYELIN/MR OOI/MALL MGMT/KAIHAO/SUNWAY KLUANG; named=Exhibition); **setup+rental apportioned by sales ONLY for Roadshow (SOLO shared booth); Exhibition keeps each brand's own and reference-fills an empty from the same venue+organizer average**; **drop projects with zero revenue+COGS+rental+setup** (5 dropped); AMAN CENTRAL overlap = keep both (different months, both AKEMI); no-@ venue split by SOLO prefix.
- Output: `seed_data_final.json` (472 records; regenerate from Excel via build_seed_data.py — Excel is NOT committed).

### Inserter spec (build next — HELD, prod-write, owner-triggered dry-run)
`createProject(env, input)` (services/projects.ts:215) is the template — reuse or replicate its INSERT:
- `INSERT INTO projects (code, name, stage, event_type_id, brand, start_date, end_date, venue, state, organizer, pic_id, created_by, company_id)`.
  - `code` = `deriveProjectCode({year, month, organizer, state, venue, brand})` (projects.ts:28) — needs state; derive state from venue or leave the deriver's fallback.
  - `event_type_id` = look up `project_event_types` by slug for **Exhibition** / **Roadshow** (resolve-or-create).
  - `stage` = **'completed'** for historical (createProject hardcodes 'draft' — override in the seed's raw INSERT).
  - `company_id` = Houzs Century.
- Finance lines per project: `INSERT INTO project_finance_lines (project_id, kind, category, amount, company_id)` — income/`sales`; cost/`cogs_matt_sofa`,`cogs_bedframe`,`cogs_accessories`,`rental`,`setup`. **amount in SEN (Excel RM ×100)**. Then call `recomputeAutoCostLines` so transport/commission/merchandise auto-compute.
- **MUST map to the maintained picker lists — NEVER free text** (owner 2026-07-26, hard rule): resolve every project's `brand` → `project_brands`, `venue` → `project_venues`, `organizer` → `project_organizers`, `event_type` → `project_event_types`, by exact + normalized name match (e.g. `PEX PAVILION BUKIT JALIL KL` ↔ maintained `PAVILION BUKIT JALIL`). The dry-run LOADS those tables from prod and prints an **UNMATCHED** section (venue/brand/organizer/type with no maintained entry); the owner adds them to the list or gives a mapping. Seeding a value that is not in the maintained list is forbidden — it would break analytics grouping + the picker. No project is written until every value matches.
- **Dedup**: skip any existing project matching (brand, venue, start_date) for the company.
- **Dry-run default** (`--dry-run`): print per-project INSERT vs SKIP + grand totals; `--commit` writes. Runs from `.github/workflows/seed-fair-pnl.yml` (`workflow_dispatch`, own concurrency group, `secrets.DATABASE_URL`), owner-triggered. Never auto-run.

## Open questions for the owner
- **venue vs organizer** parse from `LOCATION` (`ORG @ VENUE`?) — confirm which side is which.
- Projects with **no sales** (71 rows): seed as RM0 completed, or skip?
- Commit the extracted financial JSON to the repo, or upload the Excel to the Action each run? (Default: upload to the Action — keeps bulk financials out of git.)
