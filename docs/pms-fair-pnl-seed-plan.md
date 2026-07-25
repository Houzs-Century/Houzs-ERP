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
3. `backend/scripts/seed-fair-pnl.mjs` — reads the JSON, connects with `DATABASE_URL`, **`--dry-run` default**: prints per event INSERT vs SKIP(dedup) + totals; `--commit` writes. Idempotent (re-run safe). Insert project + finance lines, then call `recomputeAutoCostLines` so the auto rows compute.
4. `.github/workflows/seed-fair-pnl.yml` — `workflow_dispatch`, own concurrency group (never the deploy's), `--dry-run` input default true. Owner uploads the two Excel files as inputs OR the JSON is committed. Read-only until the owner flips `--commit`.
5. Verify against screenshots: Finance Snapshot shows the 10 lines; the project list + analytics fill with real 2025/26 numbers.

## Open questions for the owner
- **venue vs organizer** parse from `LOCATION` (`ORG @ VENUE`?) — confirm which side is which.
- Projects with **no sales** (71 rows): seed as RM0 completed, or skip?
- Commit the extracted financial JSON to the repo, or upload the Excel to the Action each run? (Default: upload to the Action — keeps bulk financials out of git.)
