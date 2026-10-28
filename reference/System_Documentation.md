# AutoCount Sync — System Documentation

## 1. Overview

AutoCount Sync is a Google Apps Script application that provides bi-directional synchronisation between an AutoCount accounting system and a Google Sheets-based operations dashboard. It serves as the central coordination layer for Sales Order tracking, delivery logistics, purchase order monitoring, and after-sales service case management.

The system connects to a .NET middleware API (exposed via ngrok) that interfaces with the AutoCount database. Data flows in both directions — orders are pulled from AutoCount into regional sheets, and field-level edits made by the operations team are pushed back to AutoCount.

### Core Capabilities

- **Pull**: Fetches new and modified Sales Orders from AutoCount and distributes them to regional sheets (West Malaysia, East Malaysia, Singapore) based on location.
- **Push**: Sends manually updated fields (delivery status, expiry dates, attention flags) back to AutoCount.
- **Overdue Management**: Automatically detects overdue orders, extends their expiry by 3 days, and logs the history.
- **Balance Collection**: Generates a report of orders with outstanding balances, highlighting approaching and expired deadlines.
- **Purchase Order Tracking**: Pulls outstanding PO line items and enables date synchronisation back to AutoCount.
- **ASSR Case Management**: Processes after-sales service requests from a Google Form, fetches order context from AutoCount, generates individual case sheets from a template, and maintains a master case log.
- **EM Transporter Sync**: Bi-directionally syncs the East Malaysia sheet with an external spreadsheet used by the transporter team, preserving field ownership boundaries.

### Technology Stack

| Component | Technology |
|-----------|-----------|
| Frontend / UI | Google Sheets (custom menu) |
| Scripting | Google Apps Script (V8 runtime) |
| Middleware API | .NET / C# (exposed via ngrok tunnel) |
| Database | AutoCount accounting database |
| External Sheets | Transporter spreadsheet, ASSR template spreadsheet |
| Form Input | Google Forms (linked to ASSR case creation) |

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Google Sheets UI                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │  West MY  │  │  East MY  │  │    SG    │  │   ASSR     │  │
│  │  Sheet    │  │  Sheet    │  │  Sheet   │  │   Sheet    │  │
│  └─────┬────┘  └─────┬────┘  └────┬─────┘  └──────┬─────┘  │
│        │             │            │                │         │
│  ┌─────┴─────────────┴────────────┴────────────────┴─────┐  │
│  │              Google Apps Script Engine                  │  │
│  │  Main.gs │ GetAutoCountData.gs │ Helper.gs │ etc.      │  │
│  └──────────────────────┬────────────────────────────────┘  │
└─────────────────────────┼───────────────────────────────────┘
                          │ HTTPS (UrlFetchApp)
                          ▼
                 ┌─────────────────┐
                 │  ngrok Tunnel   │
                 └────────┬────────┘
                          │
                 ┌────────▼────────┐
                 │  .NET API       │
                 │  (Middleware)    │
                 └────────┬────────┘
                          │
                 ┌────────▼────────┐
                 │  AutoCount DB   │
                 └─────────────────┘
```

### Data Flow Summary

| Direction | Trigger | Path |
|-----------|---------|------|
| **Pull** | Scheduled / Manual | AutoCount → API → Apps Script → Regional Sheet |
| **Push** | Scheduled / Manual | Regional Sheet → Apps Script → API → AutoCount |
| **Overdue** | Scheduled / Manual | AutoCount → API → Apps Script → AutoCount (extend) + Overdue Sheet (log) |
| **Balance** | Manual | AutoCount → API → Apps Script → Balance Sheet |
| **PO Pull** | Manual | AutoCount → API → Apps Script → Outstanding PO Sheet |
| **PO Push** | Manual / Daily | Outstanding PO Sheet → Apps Script → API → AutoCount |
| **ASSR** | Form submit | Form → Apps Script → API (fetch) → ASSR Sheet + Template Sheet |
| **EM Sync** | Scheduled / Manual / On edit | Master Sheet ↔ Transporter Sheet (bi-directional merge) |

---

## 3. File Structure

| File | Responsibility |
|------|---------------|
| `Main.gs` | Entry points: menu creation, simple and installable onEdit triggers, manual/scheduled wrapper functions. |
| `GetAutoCountData.gs` | Pull engine (fetches orders from AutoCount and routes to sheets) and Push engine (sends PENDING rows back). |
| `Helper.gs` | Shared utilities: spreadsheet opener, structured logger, execution log writer, `writeDataToTargetSheet`, `getSheetConfig`. |
| `GetOverdueData.gs` | Overdue detection, auto-extension (+3 days), and history logging. |
| `GetBalanceCollection.gs` | Balance report generation with expiry colour-coding. |
| `PO_Outstanding.gs` | Outstanding PO report pull, manual/daily PO date sync to AutoCount. |
| `ASSRCase.gs` | ASSR form processing, sequential ID generation, individual sheet creation, master row append, alternative sheet lookup. |
| `EM_Transport.gs` | Full batch sync and real-time single-row push between EM master and Transporter spreadsheet. |
| `Config.gs` | *(User-maintained)* All constants: spreadsheet IDs, sheet names, API URL, API key, checkpoint property key. |

---

## 4. Configuration

The system relies on a `CONFIG` object (defined in `Config.gs`) containing all environment-specific constants. This is the single source of truth for IDs, URLs, and sheet names.

### Required CONFIG Properties

| Property | Type | Purpose |
|----------|------|---------|
| `SPREADSHEET_ID` | string | ID of the main operations Google Spreadsheet. |
| `NGROK_URL` | string | Base URL of the .NET API via ngrok (e.g. `https://xxxx.ngrok.io`). |
| `API_KEY` | string | Secret key sent in `X-API-KEY` header for API authentication. |
| `CHECKPOINT_PROP` | string | Script Properties key name for storing the last pull timestamp. |
| `WEST_SHEET` | string | Sheet name for West Malaysia orders. |
| `EAST_SHEET` | string | Sheet name for East Malaysia orders. |
| `SG_SHEET` | string | Sheet name for Singapore orders. |
| `OVERDUE_SHEET` | string | Sheet name for overdue history log. |
| `BALANCE_SHEET` | string | Sheet name for balance collection report. |
| `LOG_SHEET` | string | Sheet name for execution logs. |
| `ASSR_SHEET` | string | Sheet name for the ASSR master summary. |
| `OTHER_ASSR_SHEET` | string | Sheet name for the alternative ASSR sheet. |
| `EM_TRANS_SS_ID` | string | Spreadsheet ID of the external EM Transporter sheet. |
| `TEMPLATE_SS_ID` | string | Spreadsheet ID of the ASSR template file. |
| `TEMPLATE_SHEET_NAME` | string | Sheet name of the ASSR template tab to copy. |

---

## 5. Triggers

The system uses 8 triggers: 2 automatic (simple) and 6 installable.

### Simple Triggers (Automatic)

These run without setup. They are limited to operations that do not require authorisation (no `openById`, no `UrlFetchApp`).

| Function | Event | Purpose |
|----------|-------|---------|
| `onOpen` | Spreadsheet open | Creates the "AutoCount Sync" custom menu. |
| `onEdit` | Cell edit | Marks rows as PENDING in the correct Sync Status column. Validates YYYY/MM/DD date format in Column Q. Syncs Column A → Column P. |

### Installable Triggers

These must be registered once. They have full authorisation scope.

| Function | Event | How to Register | Purpose |
|----------|-------|-----------------|---------|
| `onEditInstallable` | On edit | Run `setupInstallableOnEdit()` | EM → Transporter real-time push. ASSR Alternative sheet API lookup. |
| `formSubmission` | On form submit | Run `setupFormTrigger()` | Processes Google Form submissions for ASSR cases. |
| `scheduledPull` | Time-based | Create in Triggers UI | Pulls modified orders from AutoCount on a schedule. |
| `scheduledPush` | Time-based | Create in Triggers UI | Pushes PENDING rows to AutoCount on a schedule. |
| `scheduledOverdue` | Time-based | Create in Triggers UI | Runs overdue detection and auto-extension daily. |
| `dailySyncAllPODates` | Time-based | Create in Triggers UI | Syncs all PO supplier delivery dates daily. |
| `syncEmWithTransporter` | Time-based | Create in Triggers UI | Full EM ↔ Transporter batch sync on a schedule. |
| `runBalanceCollectionPull` | Time-based | Create in Triggers UI | Refreshes balance collection report on a schedule. |

### Recommended Schedules

| Trigger | Frequency |
|---------|-----------|
| `scheduledPull` | Every 15–30 minutes |
| `scheduledPush` | Every 15–30 minutes |
| `scheduledOverdue` | Once daily (early morning) |
| `dailySyncAllPODates` | Once daily |
| `syncEmWithTransporter` | Every 30–60 minutes |
| `runBalanceCollectionPull` | Once daily or twice daily |

---

## 6. API Endpoints

All requests include the following headers:

```
X-API-KEY: {CONFIG.API_KEY}
X-Request-ID: {generated UUID}
ngrok-skip-browser-warning: true
```

### Sales Order Endpoints

| Method | Endpoint | Used By | Description |
|--------|----------|---------|-------------|
| GET | `/SalesOrder/getSince/{timestamp}` | `runPullProcess` | Returns all Sales Orders modified since the given timestamp. |
| GET | `/SalesOrder/getSingle/{docNo}` | `formSubmission`, `atEditAlternativeSheet` | Returns a single Sales Order by document number. |
| GET | `/SalesOrder/getOverdue` | `runOverduePull` | Returns all currently overdue Sales Orders. |
| GET | `/SalesOrder/getBalanceCollection` | `runBalanceCollectionPull` | Returns confirmed Sales Orders with balance > 0. |
| PUT | `/SalesOrder/updateFromSheet` | `pushUpdatesToAutoCount`, `runOverduePull` | Updates Remark4, Attention, and ExpiryDate for a given DocNo. |

#### PUT Payload — `/SalesOrder/updateFromSheet`

```json
{
  "DocNo": "SO-00001",
  "Remark4": "DELIVERED",
  "Attention": "SEAMPIFY",
  "ExpiryDate": "2025-06-15"
}
```

### Purchase Order Endpoints

| Method | Endpoint | Used By | Description |
|--------|----------|---------|-------------|
| GET | `/PurchaseOrder/getOutstanding` | `runOutstandingPOPull` | Returns all PO line items with remaining quantity > 0. |
| PUT | `/PurchaseOrder/update-udf-dates` | `syncPODate` | Updates UDF delivery date fields for a PO. |

#### PUT Payload — `/PurchaseOrder/update-udf-dates`

```json
{
  "docNo": "PO-00001",
  "POUDF_EDate": "2025-06-10",
  "POUDF_EDate2": "2025-06-15",
  "POUDF_EDate3": null
}
```

---

## 7. Sheet Layouts

All three regional delivery sheets share the same Block 1 layout (Columns A–Q) but diverge after that. Spacer columns and regional differences are noted below.

### Column Configuration Summary

| | West MY | East MY (EM) | Singapore |
|---|---|---|---|
| **Start Row** | 4 | 4 | 4 |
| **Spacer Columns** | None | V (22), W (23) | R (18), S (19) |
| **Block 2 Start** | Y (25) | Y (25) | Z (26) |
| **Block 2 Includes Remark 3** | Yes | Yes | No |
| **Attention Column** | AS (45) | AP (42) | AS (45) |
| **Sync Status Column** | AT (46) | AQ (43) | AT (46) |
| **Last Column** | AT (46) | BD (56) | AT (46) |

### Block 1: Core Data (Columns B–P) — All Sheets

Written by `writeDataToTargetSheet` during pull. Columns are identical across all three regional sheets.

| Col | Field | API Source |
|-----|-------|-----------|
| B | Doc. No. | `DocNo` |
| C | Transfer To | `TransferTo` |
| D | Date | `DocDate` |
| E | Ref. | `Ref` |
| F | Branding | `SOUDF_BRANDING` |
| G | Debtor Name | `DebtorName` |
| H | Phone | `Phone1` (special chars stripped) |
| I | Sales Location | `SalesLocation` |
| J | Agent | `SalesAgent` |
| K | Local Total | `Total` |
| L | Balance | `SOUDF_BALANCE` |
| M | Remarks 2 | `Remark2` |
| N | Processing Date | `SOUDF_PDate` |
| O | Expiry Date | `SalesExemptionExpiryDate` |
| P | Remark 4 | `Remark4` |

### Block 2: Address & Notes — Per-Sheet Layout

Written by `writeDataToTargetSheet` starting at `block2StartCol`.

**West (starts at Y/25) and East (starts at Y/25):**

| Offset | West Col | East Col | Field | API Source |
|--------|----------|----------|-------|-----------|
| +0 | Y (25) | Y (25) | Remark 3 | `Remark3` |
| +1 | Z (26) | Z (26) | Note | `SOUDF_Note` |
| +2 | AA (27) | AA (27) | PO Doc No. | `SOUDF_ToPONo` |
| +3 | AB (28) | AB (28) | Address 1 | `InvAddr1` |
| +4 | AC (29) | AC (29) | Address 2 | `InvAddr2` |
| +5 | AD (30) | AD (30) | Address 3 | `InvAddr3` |
| +6 | AE (31) | AE (31) | Address 4 | `InvAddr4` |

**SG (starts at Z/26 — no Remark 3):**

| Offset | SG Col | Field | API Source |
|--------|--------|-------|-----------|
| +0 | Z (26) | Note | `SOUDF_Note` |
| +1 | AA (27) | PO Doc No. | `SOUDF_ToPONo` |
| +2 | AB (28) | Address 1 | `InvAddr1` |
| +3 | AC (29) | Address 2 | `InvAddr2` |
| +4 | AD (30) | Address 3 | `InvAddr3` |
| +5 | AE (31) | Address 4 | `InvAddr4` |

### Block 3: Attention & Sync Status

| | Attention Col | Status Col |
|---|---|---|
| West | AS (45) | AT (46) |
| East | AP (42) | AQ (43) |
| SG | AS (45) | AT (46) |

### Push Payload Mapping

When a row is marked PENDING and the push runs, these columns are sent to AutoCount:

| Payload Field | Source Column | Index |
|---------------|-------------|-------|
| `DocNo` | B | 1 |
| `Remark4` | A | 0 |
| `Attention` | Sheet-specific Attention column | Varies |
| `ExpiryDate` | O | 14 |

Dates in Column O stored as `YYYY/MM/DD` strings are normalised to `YYYY-MM-DD` before sending.

---

## 8. Regional Routing Logic

When orders are pulled from AutoCount, each order is routed to a regional sheet using this logic (in `runPullProcess`):

```
1. If InvAddr3 contains "SINGAPORE" → SG Sheet
2. Else if SalesLocation is "KL" or "PG" → West Sheet
3. Else if SalesLocation is "SBH" or "SRW" → East Sheet
4. Otherwise → not routed (dropped)
```

The `Attention` field is set to `"SEAMPIFY"` for all pulled orders before routing.

---

## 9. Sync Status Lifecycle

Every data row in the three regional sheets has a Sync Status column that tracks its synchronisation state:

```
  ┌──────────┐     API Pull      ┌──────────┐
  │  (new)   │ ─────────────────▶ │  SYNCED  │ (green)
  └──────────┘                    └────┬─────┘
                                       │
                                  User edits cell
                                       │
                                       ▼
                                 ┌──────────┐
                                 │ PENDING  │ (yellow)
                                 └────┬─────┘
                                      │
                              Push to AutoCount
                                      │
                          ┌───────────┴──────────┐
                          ▼                      ▼
                    ┌──────────┐          ┌──────────────┐
                    │  SYNCED  │ (green)  │ ERR: {code}  │ (red)
                    └──────────┘          └──────────────┘
```

| Status | Background | Meaning |
|--------|-----------|---------|
| `SYNCED` | Green (#d9ead3) | Row matches AutoCount. No pending changes. |
| `PENDING` | Yellow (#fff2cc) | Row has local edits not yet pushed to AutoCount. |
| `ERR: {code}` | Red (#f4cccc) | Push failed. Code indicates HTTP status or CONN for connection error. |

---

## 10. EM Transporter Sync

The East Malaysia sheet is shared with an external transporter team through a separate spreadsheet. The sync system maintains field ownership boundaries — some columns belong to the master sheet, others to the transporter.

### Field Ownership

| Owner | Columns (0-based indices) | Fields |
|-------|--------------------------|--------|
| **Master** | 0–16, 20–36, 42–55 | All order data, addresses, financials, sync status |
| **Transporter** | 17–19, 37–41 | R (ETA Port), S (Est. Delivery), T (m3), AK (Vessel), AL (ETD), AM (ETA Dest), AN (Remarks 1), AO (Remarks 2), AP (Attention) |

### Sync Modes

**Full Batch Sync** (`syncEmWithTransporter`): Reads all rows from both sheets, merges them using DocNo matching (master as base, transporter values overlaid for owned fields), then writes the merged result back to both sheets. Handles row count mismatches and cleans up excess rows.

**Real-Time Single Row Push** (`pushSingleRowToTransporter`): Triggered by the installable `onEditInstallable` trigger when any EM sheet cell in Row 4+ is edited. Pushes only master-owned segments to the transporter sheet:

| Segment | Columns | Indices | Description |
|---------|---------|---------|-------------|
| 1 | A–Q (1–17) | 0–16 | Core order data |
| 2 | U–AK (21–37) | 20–36 | Internal fields, addresses, logistics |
| 3 | AQ–BD (43–56) | 42–55 | Sync status, financials |

Transporter-owned columns (R–T, AL–AP) are never overwritten by the single-row push.

---

## 11. ASSR Case Management

ASSR (After-Sales Service Request) cases are created via a linked Google Form and tracked in both a master summary sheet and individual case sheets.

### Form-to-Sheet Flow

```
Google Form Submit
       │
       ▼
formSubmission(e)
       │
       ├─── 1. Extract form data (Doc No, Item Code, Issue Description, Photos)
       │
       ├─── 2. Fetch order context from AutoCount API (/getSingle)
       │
       ├─── 3. Generate sequential ASSR number (ASSR/YYMM-NNN)
       │
       ├─── 4. Create individual sheet from template
       │         └── Populate: agent, date, customer, address, item, photos
       │
       └─── 5. Append summary row to master ASSR sheet (41 columns, A–AO)
```

### ASSR Number Format

Format: `ASSR/YYMM-NNN`

Example: `ASSR/2506-003` (3rd case in June 2025)

The sequence number is determined by scanning Column C of the master sheet for the highest existing number under the current month's prefix, then incrementing by 1. Protected by `LockService` to prevent duplicates from concurrent form submissions.

### Alternative ASSR Sheet

A secondary ASSR sheet allows manual Doc. No. entry in Column B. When a Doc. No. is entered, the installable `onEditInstallable` trigger calls the AutoCount API to fetch order details and auto-populates lookup fields (customer name, phone, address, etc.) while preserving manually-entered columns.

---

## 12. Overdue Management

The overdue engine performs three actions in a single run:

1. **Detect**: Fetches all currently overdue orders from AutoCount via `/getOverdue`.
2. **Extend**: Pushes a new expiry date (today + 3 days) back to AutoCount for each overdue order via `/updateFromSheet`.
3. **Log**: Appends every overdue record as a historical row to the Overdue History sheet with a pull timestamp.

The Overdue History sheet is append-only and serves as an audit trail. It has 25 columns starting with "Pull Date" in Column A.

If no overdue records are found, the function logs status `SKIPPED` and shows an appropriate message (no misleading extension date).

---

## 13. Balance Collection Report

The balance report is a full-refresh sheet (cleared and rewritten on each run) showing all confirmed Sales Orders with a remaining balance > 0.

### Expiry Highlighting

| Condition | Row Background | Date Cell Style |
|-----------|---------------|-----------------|
| Expiry date has passed | Red (#f4cccc) | Bold, dark red text (#990000) |
| Expiry date within 3 days | Yellow (#fff2cc) | Bold, orange text (#b45f06) |
| Expiry date > 3 days away | No highlight | Normal |

---

## 14. Outstanding PO Report

The PO report occupies the "Outstanding PO" sheet. Rows 1–10 are reserved for internal team use and are never touched by the script. Data begins at Row 11 (header) / Row 12 (first data row).

### Manual Column Preservation

Column P (Overdue Days) is manually maintained by the team. Before each refresh, the script backs up Column P values into a map keyed by `DocNo_ItemCode`, clears the data area, writes fresh data from the API, then restores the backed-up values by matching the composite key.

### PO Date Sync

Three supplier delivery date columns (M, N, O) can be synced back to AutoCount:

| Column | API Field |
|--------|-----------|
| M (Supplier Delivery Date 1) | `POUDF_EDate` |
| N (Supplier Delivery Date 2) | `POUDF_EDate2` |
| O (Supplier Delivery Date 3) | `POUDF_EDate3` |

Sync modes: manual (select a row and use the menu) or daily batch (`dailySyncAllPODates`).

---

## 15. Logging & Observability

### Console Logging

All operations log through the structured `Log` namespace with a request ID (`rid`) for end-to-end traceability:

```
[abc-123-def] [INFO] Pull started. Checkpoint: 2025-06-01 08:00:00
[abc-123-def] [API]  GET /SalesOrder/getSince/... | HTTP 200
[abc-123-def] [INFO] API returned 15 record(s).
[abc-123-def] [INFO] Routing: West=8, East=5, SG=2
[abc-123-def] [INFO] [West MY] Writing 8 record(s).
[abc-123-def] [INFO] Pull finished: SYNCED — Pulled 15 records. Skipped 0.
```

Log levels: `INFO`, `WARN`, `ERROR`, `API`.

### Execution Log Sheet

Every major operation writes a summary row to the execution log sheet (most recent at top):

| Column | Content |
|--------|---------|
| ID | Request UUID |
| Type | Trigger type (MANUAL, SCHEDULED, PUSH, OVERDUE_LOG, BALANCE_LIST, PO_PULL, FORM_SUBMIT) |
| User | Email of invoking user or "SYSTEM" |
| Start | Execution start timestamp (GMT+8) |
| End | Execution end timestamp (GMT+8) |
| Result | SYNCED (green), FAILED (red), SKIPPED (yellow), PARTIAL (yellow) |
| Message | Human-readable result summary |

---

## 16. Concurrency & Error Handling

### Lock Service

The push engine (`pushUpdatesToAutoCount`) and ASSR form handler (`formSubmission`) use `LockService.getScriptLock()` to prevent concurrent execution. If a lock cannot be acquired within 30 seconds, the operation is skipped with a user-facing message.

### Checkpoint Safety

The pull checkpoint (`CONFIG.CHECKPOINT_PROP` in Script Properties) only advances when ALL records are successfully written. On partial failure, the checkpoint stays at its previous value so failed records are retried on the next pull.

### Error Status Tracking

The push engine tracks both success and error counts. The final logged status reflects actual results:

| Condition | Status |
|-----------|--------|
| All rows pushed successfully | `SYNCED` |
| Some rows succeeded, some failed | `PARTIAL` |
| All rows failed | `FAILED` |

### Protected Cell Fallback

When `writeDataToTargetSheet` encounters a protected cell during Block 1 write, it falls back to cell-by-cell writing to avoid losing the entire row. Block 2 and Block 3 protection errors are logged as warnings.

---

## 17. Security

### API Authentication

All API requests include a shared secret in the `X-API-KEY` header. The key is stored in the `CONFIG` object and should be treated as sensitive — avoid committing it to version control.

### Request Tracing

Every operation generates a UUID (`Utilities.getUuid()`) passed as `X-Request-ID` in API headers. This enables cross-system log correlation between Apps Script and the .NET middleware.

### Authorisation Boundaries

Simple triggers (`onEdit`, `onOpen`) cannot access external spreadsheets or make HTTP requests. All operations requiring these capabilities are routed through the installable `onEditInstallable` trigger or time-based triggers.

---

## 18. Deployment Checklist

### Initial Setup

1. Copy all `.gs` files into the Apps Script editor bound to the target spreadsheet.
2. Verify `Config.gs` contains correct values for all `CONFIG` properties.
3. Run `setupInstallableOnEdit()` from the editor to register the installable onEdit trigger.
4. Run `setupFormTrigger()` from the editor to register the form submission trigger.
5. Create 6 time-based triggers in the Triggers UI:
   - `scheduledPull` — every 15–30 minutes
   - `scheduledPush` — every 15–30 minutes
   - `scheduledOverdue` — once daily
   - `dailySyncAllPODates` — once daily
   - `syncEmWithTransporter` — every 30–60 minutes
   - `runBalanceCollectionPull` — once or twice daily
6. Verify 8 total triggers are listed (no duplicates, no legacy `onEdit` or `atEdit` triggers).
7. Run `manualPull()` to confirm API connectivity and regional routing.
8. Edit a cell in each regional sheet to confirm PENDING appears in the correct Sync Status column.

### After Column Layout Changes

If columns are added, removed, or shifted in any sheet:

1. Update `getSheetConfig()` in `Helper.gs` with new `block2StartCol`, `attentionCol`, and `statusCol`.
2. Update the corresponding `statusCol` in `onEdit` (Main.gs).
3. Update the corresponding `statusCol` and `attentionCol` in `pushUpdatesToAutoCount` (GetAutoCountData.gs).
4. If the EM sheet layout changed, update `transOwnedIdx` and segment ranges in `EM_Transport.gs`.
5. Run the verification plan to confirm all writes land in the correct columns.

---

## 19. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| PENDING never appears on edit | `onEdit` has wrong `statusCol` for that sheet | Check `statusCol` in Main.gs matches actual sheet layout |
| Push finds no PENDING rows | `statusCol` mismatch between onEdit and push | Align `statusCol` in Main.gs and GetAutoCountData.gs |
| Addresses/notes in wrong columns | `block2StartCol` or `includeRemark3` incorrect | Check `getSheetConfig()` against actual sheet layout |
| EM edits don't appear in Transporter | Installable trigger not registered | Run `setupInstallableOnEdit()` |
| Daily PO sync does nothing | Using `getActiveSpreadsheet()` in timer context | Ensure function uses `getTargetSs()` |
| Push always shows SYNCED in log | Error count not tracked | Verify `errorCount` is incremented in catch blocks |
| Overdue columns misaligned | Missing "Pull Date" header | Delete Overdue sheet and let next pull recreate it |
| ASSR duplicate numbers | Missing lock or concurrent submissions | Verify `LockService` is in `formSubmission` |
| API returns 403/401 | API key mismatch or expired ngrok tunnel | Check `CONFIG.API_KEY` and `CONFIG.NGROK_URL` |
| `ERR: CONN` on all rows | ngrok tunnel is down or API server offline | Restart ngrok tunnel and .NET middleware |

---

## 20. Revision History

| Date | Change |
|------|--------|
| 2026-04-02 | Full code review and bug fix pass (16 issues). Added JSDoc, structured logging, installable onEdit trigger, concurrency locks. |
| 2026-04-02 | EM column layout corrected: V/W empty spacers, transporter indices shifted +2, last column BD(56). |
| 2026-04-02 | SG column layout confirmed: R/S empty spacers, Attention=AS(45), Status=AT(46). |
