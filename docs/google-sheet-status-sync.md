# HC Delivery sheet — ASSR sync (ERP → Google Sheet)

The ERP owns service-case stages; the `ASSR Case (Farra)` tab of the
**HC Delivery Updated** spreadsheet keeps an operational log next to them.
Every **10 minutes** a sheet-bound Apps Script pulls the ERP's live cases
and writes back two columns:

| Sheet column | Owner | Written when |
|---|---|---|
| **A — ASSR STATUS** | ERP | the row resolves to a case and the stage differs |
| **C — ASSR NO** | ERP (since 2026-08-04) | the row resolves **by SO** and the number differs |

Everything else on the row stays hand-maintained.

**Status: LIVE since 2026-07-14**; matching hardened and col C write-back
added 2026-08-04.

## ⚠️ `syncAssrStatus` is defined TWICE

The Apps Script project **“Delivery & Amend Updated”** (bound to the
spreadsheet) declares `syncAssrStatus` in **both** `ASSRStatusSync.gs` and
`ERPMain.gs`. Apps Script shares one global scope and loads files in list
order, so **`ERPMain.gs` wins — that is the copy that actually runs.**

Consequences, all confirmed 2026-08-04:

- Editing `ASSRStatusSync.gs`'s copy changes nothing. An earlier session
  added an "append ERP cases the sheet is missing to the bottom" feature
  (`_appendNewAssrRow`) there; it has **never executed**. It also fills
  customer/phone/location from fields `status-export` does not return, so
  those columns would land blank — don't revive it without fixing that.
- The shared helpers (`_assrSoKey`, `_assrRefAgrees`, `_assrIndex`,
  `_assrResolve`, `_assrDateKey`) and the read-only `assrDriftReport()` live
  in `ASSRStatusSync.gs` and are called by the live copy in `ERPMain.gs`.

Keep the two in step, or delete one. A header comment in `ERPMain.gs` says
the same thing.

## Pieces

| Side | What | Where |
|---|---|---|
| ERP | `GET /api/assr-form-intake/status-export` — every non-archived case as `{assr_no, so_no, ref_no, complained_date, status, completed_date}`, guarded by `X-Intake-Key` accepting `FORM_INTAKE_KEY` or `SHEET_SYNC_KEY` | `backend/src/routes/assrFormIntake.ts` |
| Google | `syncAssrStatus()` + a 10-minute time trigger | `ERPMain.gs` (**live**) |
| Google | matching helpers + `assrDriftReport()` | `ASSRStatusSync.gs` |
| Google | `ASSRDeliverySync.gs` (pre-existing) — its `ASSR_DELIVERY_TRIGGERS` map drives the ASSR → Delivery Details linkage | unchanged |

**CORRECTION: it DOES return customer PII.** `backend/src/routes/assrFormIntake.ts:427` selects `customer_name, phone, location, sales_agent, po_no, complaint_issue` and `:474-484` maps `addr1`-`addr4` and `item_codes` into the response — 15 fields, not the 6 this doc lists. The change is annotated in the route at `:420-424` (2026-08-07): with the Google Form closed, the sheet's Apps Script auto-APPENDS rows for ERP cases, so the export was widened deliberately to carry the columns a new row needs. There is a stale in-code comment repeating the old claim four lines above the fields that refute it.

## Matching (sheet row → ERP case)

Data rows start at **row 16**. For each row, in order:

1. **ASSR NO (col C)** exact match — **accepted only if the row's SO or Ref
   also agrees** with that case.
2. Else **SO NO (col B)**: one case on that SO → use it.
3. Several cases on that SO → narrow by **Ref No (col E)**.
4. Still several (same SO *and* same Ref) → narrow by **complained date
   (col D)** against the ERP's `complained_date`.
5. Nothing conclusive → **the row is left untouched**, with the reason
   logged (`assr_conflict`, `ambiguous`).

SO numbers compare on digits only, so `SO-001766` / `S0-1766` / `SO 001766`
are one key; non-numeric SO cells (display sets) fall back to their text.
Ref agreement is deliberately loose — equal, one containing the other, or a
shared 4+ digit run — because refs are hand-typed and often carry two orders
(`HC9368 + ZNT4039`).

### Why rule 1 needs corroboration

Col C used to be hand-keyed, and during **2026-07 it drifted out of step
with the ERP's own numbering: 37 of the 62 July rows carried a number
belonging to a different customer's case.** The old "ASSR NO wins" rule then
copied the wrong customer's stage into col A — silently, every 10 minutes.
Jan–Jun were clean (336 rows).

The cause was two independent sequences: Farra numbered by hand while the
ERP minted its own, and each side had records the other lacked. The ERP's
sequence is also **shared between Houzs and 2990** (ASSR/2607-043/045/046
are 2990 cases), so the Houzs numbers have natural gaps.

The 33 drifted rows were corrected in place on 2026-08-04 (one-off
`assrApplyColCFix()`, kept in `ASSRStatusSync.gs` as the record — it is
guarded on each cell's current value, so re-running it is a no-op). Since
then a rule 2–4 match writes col C back, so it cannot drift again.

## ASSR → Delivery Details linkage

`ASSRDeliverySync.gs` watches manual edits to column A (installable onEdit)
and, on certain statuses, adds/updates a row in the regional delivery sheet
(`Delivery Details` / `EM Order` / `SG Order`) tagged
`{DocNo}-{PICKUP|SERVICE|INSPECTION}` in col B.

Programmatic writes **never fire onEdit**, so `syncAssrStatus()` calls
`syncASSRToDelivery()` directly, with a synthetic `{range}` event, for every
row that just **entered** a trigger status. Col C is flushed before col A so
the linkage reads back the corrected number.

```javascript
const ASSR_DELIVERY_TRIGGERS = {
  "Pending Item Pickup":      "PICKUP",      // legacy manual vocabulary
  "Pending Delivery/Service": "SERVICE",
  "Pending Inspection":       "INSPECTION",  // legacy manual vocabulary
  // 2026-07 ERP 7-stage vocabulary — same delivery actions:
  "Pending Supplier Pickup":  "PICKUP",
  "Under Verification":       "INSPECTION"
};
```

Known pre-existing noise: some delivery-sheet writes fail their column's
data validation (`Pending Review`, and a few Delivery Details statuses, are
not in the dropdown lists). It is caught and logged per row.

## `assrDriftReport()` — read-only

Run it from the editor (open `ASSRStatusSync.gs` first — the function picker
only lists the open file's functions) and read the execution log. It writes
nothing and prints, with **real sheet row numbers**:

- col C numbers the ERP disagrees with, and what each would become
- rows left untouched, split by reason
- ERP cases with no sheet row at all

## Operating rules

- A matched row's cols A and C are ERP-owned. Manual edits are overwritten
  within 10 minutes — change the stage in the ERP instead.
- Rows that never became ERP cases keep their hand-keyed values forever.
- The stats block, rows 1–13, is never touched.
- To reinstall or change the cadence, run `setupAssrStatusTrigger`.

## Editing the script (hard-won)

- `monaco.editor.getModels()` on the editor page reads and writes file
  contents directly — far more reliable than clipboard paste, which can be
  hijacked mid-Ctrl+V. Model index = file-list order + 1.
- The function picker only lists the **currently open file's** functions and
  resists both keyboard and synthetic clicks. To run something else,
  temporarily call it from the top of `syncAssrStatus` in `ERPMain.gs`, run,
  then remove the line.
- Triggers run as the account that created them (nicochoong93). Another
  account can open and save the project but gets an authorization prompt on
  **Run** — don't authorize on someone's behalf; switch accounts, or let the
  10-minute trigger pick the change up.
- The script holds `SHEET_SYNC_KEY` in plaintext (Apps Script has no secret
  store). It is the same value as the GitHub Actions secret; never paste it
  into a doc, a commit, or a screenshot.
