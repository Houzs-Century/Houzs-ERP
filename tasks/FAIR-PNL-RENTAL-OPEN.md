# FAIR PNL — rental / setup is NOT reconciled (open, needs accountant)

Status as of 2026-07-29. Sales and COGS across the 568 aligned PMS projects were
checked row-by-row against the owner's original FAIR PNL workbooks and are
trustworthy. **Rental and setup are not.** Do not treat the PMS rental figures as
reconciled until this is closed.

## What was measured

Every aligned project's rental compared with the rental on the raw row it came from:

| result | projects |
| --- | --- |
| matches the raw row | 361 |
| differs | 94 |
| **PMS has rental, the raw row has none** | **100** (RM 1,860,077) |
| no raw row matched | 13 |

## Two causes, both traced

1. **A shared venue rental counted several times.** The book repeats one rental
   figure on each brand's line of the same fair; the v8 inventory summed those
   lines and then apportioned the inflated total by sales. Aman Central 2024-10:
   raw shows 46,000 on each of three brand rows; PMS carries 81,451 + 5,470 +
   51,079 = 138,000, i.e. 46,000 x 3.
2. **Rental with no source at all.** p179 (AKEMI, Aman Central, 19/12-11/01): the
   Dec-2025 and Jan-2026 sheets carry no rental for that fair in either month, yet
   v8 has 150,805 (split 146,044). Sales and COGS for the same event reconcile
   exactly, so this is specific to the rental column.

## Owner's decision (2026-07-29)

- Each brand row carries **its own** rental — no apportioning across brands.
- A blank in the book means **zero**; never derive a figure.

## Why it was NOT applied

A rebuild straight from the raw sheets was computed (223 projects, rental
-RM 2.03M, 100 dropping to zero) and deliberately **not written**. While checking
it the raw extraction proved fragile: the 2024 sheets split one event across two
sub-tables, and the row carrying COSTING/RENTAL often has no value in the SALES
column, so a `sales > 0` filter drops that row and loses its rental with it.
Zeroing RM 2M on an extraction with a known hole is not acceptable.

## How to close it

1. Accountant reviews `RENTAL_discrepancies.csv` (207 rows: PMS vs raw rental, with
   the source sheet, date and LOCATION text) alongside
   `RECON_project_by_project.csv` (all 568 projects, every money column).
   Both were handed to the owner on 2026-07-29.
2. They return a confirmed `pid -> rental (and setup)` list.
3. Apply it with `polish-all.yml` task=align-figures — the script rewrites only the
   pids present in `align_v8_targets.json`. Dry-run, owner reviews, then commit.
4. Re-run task=autocost only if sales changed (commission is a % of sales).

Apply the confirmed list verbatim. Do not infer a rental for a row the accountant
did not confirm.
