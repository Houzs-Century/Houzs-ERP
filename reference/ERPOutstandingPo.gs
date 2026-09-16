// ERPOutstandingPo.gs
//
// Phase 3 of the ERP cutover (owner 2026-09-16): the "Outstanding PO" tab
// reads from the ERP instead of AutoCount's /PurchaseOrder/getOutstanding,
// and the three "Supplier Delivery Date" columns (M / N / O) are written back
// to the ERP (POST /api/delivery-sheet/po-dates) instead of AutoCount's
// /PurchaseOrder/update-udf-dates. The ERP then pushes them to the account
// book itself through the ordinary PO write-back, so the book's EDate /
// EDate2 / EDate3 still follow the sheet.
//
// Same layout as PO_Outstanding.gs: rows 1-10 are the team's, the header is
// row 11, data starts at row 12, and column P (Overdue Days) is manual and is
// backed up / restored across a refresh by DocNo + ItemCode.
//
// Rules the ERP applies to a pushed date: a BLANK cell keeps the ERP's date
// (clear it in the ERP); a date the ERP already holds is reported "unchanged"
// and queues nothing; a PO with a live GRN is locked ("po_locked") and a PO no
// longer outstanding is refused, exactly as the PO editor would.
//
// Reuses ERPDeliverySync.gs (erpConfig_, erpFetch_, erpDateText_,
// ERP_PUSH_BATCH), ERPOverdueBalance.gs (erpFetchList_, erpDay_) and
// Helper.gs (getTargetSs, recordExecutionLog, Log).
// Setup: run setupErpPhase3Triggers() once from the editor.

const ERP_PO_SHEET = "Outstanding PO";
const ERP_PO_START_ROW = 11;
const ERP_PO_HEADERS = [
  "Doc No", "SO Doc No", "Creditor Code", "Creditor Name", "Item Code",
  "Item Description", "Item Description 2", "Location", "Item Group", "Doc Date",
  "Remaining Qty", "Delivery Date", "Supplier Delivery Date 1",
  "Supplier Delivery Date 2", "Supplier Delivery Date 3", "Overdue Days"
];

/** Rewrites the tab from row 11 down; rows 1-10 and column P survive. */
function runErpOutstandingPoPull(triggerType) {
  const rid = Utilities.getUuid();
  const startTime = new Date();
  const ss = getTargetSs();
  const userEmail = Session.getActiveUser().getEmail();
  Log.info(rid, "ERP outstanding PO pull started.");
  try {
    const cfg = erpConfig_();
    const data = erpFetchList_(cfg, "/api/delivery-sheet/outstanding-po", rid);
    Log.info(rid, "ERP returned " + data.length + " outstanding PO line(s).");

    let sheet = ss.getSheetByName(ERP_PO_SHEET);
    if (!sheet) sheet = ss.insertSheet(ERP_PO_SHEET);

    // Column P is manual: keep it across the rewrite, keyed by DocNo_ItemCode.
    const manualMap = {};
    const lastRow = sheet.getLastRow();
    if (lastRow > ERP_PO_START_ROW) {
      const current = sheet.getRange(ERP_PO_START_ROW + 1, 1, lastRow - ERP_PO_START_ROW, ERP_PO_HEADERS.length).getValues();
      current.forEach(function (row) {
        if (row[0] && row[4]) manualMap[String(row[0]) + "_" + String(row[4])] = row[15];
      });
      Log.info(rid, "Backed up " + Object.keys(manualMap).length + " manual Overdue Days value(s).");
    }

    const maxRows = sheet.getMaxRows();
    if (maxRows >= ERP_PO_START_ROW) sheet.getRange(ERP_PO_START_ROW, 1, maxRows - ERP_PO_START_ROW + 1, sheet.getMaxColumns()).clear();
    sheet.getBandings().forEach(function (b) { if (b.getRange().getRow() >= ERP_PO_START_ROW) b.remove(); });

    const n = ERP_PO_HEADERS.length;
    sheet.getRange(ERP_PO_START_ROW, 1, 1, n).setValues([ERP_PO_HEADERS]);
    if (data.length) {
      const rows = data.map(function (o) {
        return [
          o.DocNo, o.SODocNo || "", o.CreditorCode || "", o.CreditorName || "", o.ItemCode || "",
          o.ItemDescription || "", o.ItemDescription2 || "", o.Location || "", o.ItemGroup || "", erpDay_(o.DocDate),
          o.RemainingQty, erpDay_(o.DeliveryDate), erpDay_(o.SupplierDeliveryDate1),
          erpDay_(o.SupplierDeliveryDate2), erpDay_(o.SupplierDeliveryDate3),
          manualMap[String(o.DocNo) + "_" + String(o.ItemCode || "")] || ""
        ];
      });
      sheet.getRange(ERP_PO_START_ROW + 1, 1, rows.length, n).setValues(rows);
      const report = sheet.getRange(ERP_PO_START_ROW, 1, rows.length + 1, n);
      sheet.getRange(ERP_PO_START_ROW, 1, 1, n).setBackground("#274e13").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");
      sheet.getRange(ERP_PO_START_ROW + 1, 1, rows.length, n).setVerticalAlignment("middle");
      report.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREEN);
      report.setBorder(true, true, true, true, true, true, "#cccccc", SpreadsheetApp.BorderStyle.SOLID);
      sheet.setFrozenRows(ERP_PO_START_ROW);
      sheet.autoResizeColumns(1, n);
    }

    const message = "Pulled " + data.length + " outstanding PO line(s) from the ERP. Rows 1-10 preserved.";
    Log.info(rid, message);
    recordExecutionLog(ss, rid, "PO_PULL", startTime, new Date(), "SYNCED", message, userEmail);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("Outstanding PO\n\n" + message);
  } catch (e) {
    Log.error(rid, "ERP outstanding PO pull failed", e);
    recordExecutionLog(ss, rid, "PO_PULL", startTime, new Date(), "FAILED", e.message, userEmail);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("Outstanding PO FAILED\n" + e.message);
  }
}

/** One sheet row (A..O) -> the ERP's payload; blank cells are omitted (kept). */
function erpPoDatesOf_(row) {
  const u = { DocNo: String(row[0] || "").trim() };
  const d1 = erpDateText_(row[12]), d2 = erpDateText_(row[13]), d3 = erpDateText_(row[14]);
  if (d1) u.SupplierDeliveryDate1 = d1;
  if (d2) u.SupplierDeliveryDate2 = d2;
  if (d3) u.SupplierDeliveryDate3 = d3;
  return u;
}

/** POSTs the updates in batches; returns per-outcome counts and the failures. */
function erpPushPoDates_(cfg, updates, rid) {
  const tally = { written: 0, unchanged: 0, skipped: 0, failed: 0, notes: [] };
  for (let i = 0; i < updates.length; i += ERP_PUSH_BATCH) {
    const batch = updates.slice(i, i + ERP_PUSH_BATCH);
    try {
      const res = erpFetch_(cfg, "/api/delivery-sheet/po-dates", { method: "post", contentType: "application/json", payload: JSON.stringify({ updates: batch }) }, rid);
      if (res.getResponseCode() !== 200) {
        tally.failed += batch.length;
        tally.notes.push("HTTP " + res.getResponseCode() + ": " + res.getContentText().slice(0, 200));
        continue;
      }
      (JSON.parse(res.getContentText()).results || []).forEach(function (r) {
        if (r.ok === true && r.unchanged === true) tally.unchanged++;
        else if (r.ok === true) tally.written++;
        else if (r.skipped) { tally.skipped++; if (r.skipped !== "nothing_to_write") tally.notes.push(r.DocNo + ": " + r.skipped + (r.message ? " - " + r.message : "")); }
        else { tally.failed++; tally.notes.push(r.DocNo + ": " + (r.error || "failed")); }
      });
    } catch (e) {
      tally.failed += batch.length;
      tally.notes.push("connection error: " + e.message);
    }
  }
  return tally;
}

function erpPoTallyText_(t) {
  return "written " + t.written + ", unchanged " + t.unchanged + ", skipped " + t.skipped + ", failed " + t.failed +
    (t.notes.length ? "\n" + t.notes.slice(0, 15).join("\n") : "");
}

/** Menu: the selected row's three dates -> the ERP, after confirmation. */
function erpSyncSelectedPoDates() {
  const ui = SpreadsheetApp.getUi();
  const sheet = getTargetSs().getSheetByName(ERP_PO_SHEET);
  const currentRow = sheet.getActiveCell().getRow();
  if (currentRow <= ERP_PO_START_ROW) { ui.alert("Please select a row containing PO data (Row 12 or below)."); return; }
  const u = erpPoDatesOf_(sheet.getRange(currentRow, 1, 1, 15).getValues()[0]);
  if (!u.DocNo) { ui.alert("That row has no Doc No."); return; }
  const answer = ui.alert("Confirm Sync", "Update supplier delivery dates for " + u.DocNo + " in the ERP?\n\n" +
    "Date 1: " + (u.SupplierDeliveryDate1 || "(keep)") + "\nDate 2: " + (u.SupplierDeliveryDate2 || "(keep)") + "\nDate 3: " + (u.SupplierDeliveryDate3 || "(keep)"), ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  const rid = Utilities.getUuid();
  try {
    const t = erpPushPoDates_(erpConfig_(), [u], rid);
    ui.alert(u.DocNo + "\n\n" + erpPoTallyText_(t));
  } catch (e) {
    ui.alert("Error: " + e.message);
  }
}

/** Every data row's dates -> the ERP, one payload per PO (a PO's lines share
 *  the header dates; a value on any of its rows counts). */
function pushPoDatesToErp(triggerType) {
  const rid = Utilities.getUuid();
  const startTime = new Date();
  const ss = getTargetSs();
  const userEmail = Session.getActiveUser().getEmail();
  const sheet = ss.getSheetByName(ERP_PO_SHEET);
  Log.info(rid, "ERP PO date push started.");
  try {
    const lastRow = sheet ? sheet.getLastRow() : 0;
    if (!sheet || lastRow <= ERP_PO_START_ROW) {
      recordExecutionLog(ss, rid, "PO_DATE_SYNC", startTime, new Date(), "SKIPPED", "No PO rows.", userEmail);
      if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("Outstanding PO: no rows to push.");
      return;
    }
    const byDoc = {};
    const order = [];
    sheet.getRange(ERP_PO_START_ROW + 1, 1, lastRow - ERP_PO_START_ROW, 15).getValues().forEach(function (row) {
      const u = erpPoDatesOf_(row);
      if (!u.DocNo) return;
      if (!byDoc[u.DocNo]) { byDoc[u.DocNo] = { DocNo: u.DocNo }; order.push(u.DocNo); }
      ["SupplierDeliveryDate1", "SupplierDeliveryDate2", "SupplierDeliveryDate3"].forEach(function (k) {
        if (u[k] && !byDoc[u.DocNo][k]) byDoc[u.DocNo][k] = u[k];
      });
    });
    const updates = order.map(function (d) { return byDoc[d]; }).filter(function (u) { return Object.keys(u).length > 1; });
    const t = erpPushPoDates_(erpConfig_(), updates, rid);
    const message = "Pushed dates for " + updates.length + " PO(s): " + erpPoTallyText_(t);
    Log.info(rid, message);
    recordExecutionLog(ss, rid, "PO_DATE_SYNC", startTime, new Date(), t.failed ? "PARTIAL" : "SYNCED", message, userEmail);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("Outstanding PO dates\n\n" + message);
  } catch (e) {
    Log.error(rid, "ERP PO date push failed", e);
    recordExecutionLog(ss, rid, "PO_DATE_SYNC", startTime, new Date(), "FAILED", e.message, userEmail);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("Outstanding PO dates FAILED\n" + e.message);
  }
}

function manualErpPoPull() { runErpOutstandingPoPull("MANUAL"); }
function manualErpPoPush() { pushPoDatesToErp("MANUAL"); }
/** Daily: the sheet's dates go to the ERP first, then the tab is refreshed. */
function scheduledErpPoSync() { pushPoDatesToErp("SCHEDULED"); runErpOutstandingPoPull("SCHEDULED"); }

/** Installs the daily 07:00 trigger and removes this account's old AutoCount PO ones. */
function setupErpPhase3Triggers() {
  const stop = ["dailySyncAllPODates", "runOutstandingPOPull", "scheduledErpPoSync"];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (stop.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("scheduledErpPoSync").timeBased().everyDays(1).atHour(7).create();
  Log.info("setup", "scheduledErpPoSync installed daily at 07:00; AutoCount PO triggers removed.");
  try { SpreadsheetApp.getUi().alert("Outstanding PO now syncs with the ERP daily at 07:00 (push dates, then refresh)."); } catch (e) {}
}
