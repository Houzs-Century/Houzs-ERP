// ERPOverdueBalance.gs
//
// Phase 2 of the ERP cutover (owner 2026-09-16): the Overdue History and
// Balance Collection tabs read from the ERP instead of AutoCount's
// /SalesOrder/getOverdue and /SalesOrder/getBalanceCollection. Same tab
// layouts and colours as GetOverdueData.gs / GetBalanceCollection.gs; the
// three owner rulings:
//   1. Balance Collection = delivered (DELIVERED / INVOICED / CLOSED) orders
//      that still owe money.
//   2. Overdue keeps the "push the date forward 3 days" behaviour: each run
//      writes today + 3 into the ERP's customer_delivery_date for every order
//      it lists (POST /api/delivery-sheet/updates, ExpiryDate only).
//   3. No age cap - orders overdue by more than 90 days are listed too.
//
// Reuses ERPDeliverySync.gs (erpConfig_, erpFetch_) and Helper.gs
// (getTargetSs, recordExecutionLog, Log). Setup: run setupErpPhase2Triggers()
// once from the editor.

const ERP_OVERDUE_HEADERS = [
  "Pull Date", "Doc. No.", "Transfer To", "Date", "Ref. No.", "BRANDING",
  "Debtor Name", "Phone", "Location", "Agent", "Total", "Balance",
  "Remark 2", "Processing Date", "Original Expiry Date", "Remark 4",
  "Remark 3", "Note", "PO No", "Address 1", "Address 2", "Address 3",
  "Address 4", "Venue", "Attention"
];
const ERP_BALANCE_HEADERS = [
  "Doc. No.", "Transfer To", "Date", "Ref. No.", "BRANDING", "Debtor Name", "Phone",
  "Location", "Agent", "Total", "BALANCE", "Remark 2", "Processing Date",
  "Sales Exemption Expiry Date", "Remark 4", "Remark 3", "Note", "PO No",
  "Address 1", "Address 2", "Address 3", "Address 4", "Venue", "Attention"
];

function erpDay_(v) { return v ? String(v).split("T")[0] : ""; }

/** The 24 AutoCount-named cells both tabs share (Overdue prefixes a Pull Date). */
function erpListRow_(o) {
  return [
    o.DocNo, o.TransferTo || "", erpDay_(o.DocDate),
    o.Ref || "", o.SOUDF_BRANDING || "", o.DebtorName || "", o.Phone1 || "",
    o.SalesLocation || "", o.SalesAgent || "", o.Total || 0,
    o.SOUDF_BALANCE || 0, o.Remark2 || "",
    erpDay_(o.SOUDF_PDate), erpDay_(o.SalesExemptionExpiryDate),
    o.Remark4 || "", o.Remark3 || "", o.SOUDF_Note || "", o.SOUDF_ToPONo || "",
    o.InvAddr1 || "", o.InvAddr2 || "", o.InvAddr3 || "", o.InvAddr4 || "",
    o.SOUDF_VENUE || "", o.Attention || ""
  ];
}

function erpFetchList_(cfg, path, rid) {
  const res = erpFetch_(cfg, path, null, rid);
  if (res.getResponseCode() !== 200) throw new Error("ERP returned " + res.getResponseCode() + ": " + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText()).records || [];
}

/**
 * Overdue History: append today's overdue orders, then push every one of
 * them 3 days forward in the ERP (ruling 2). The rows are appended even when
 * the push fails, as before.
 */
function runErpOverduePull(triggerType) {
  const rid = Utilities.getUuid();
  const startTime = new Date();
  const ss = getTargetSs();
  const userEmail = Session.getActiveUser().getEmail();
  const timezone = ss.getSpreadsheetTimeZone();
  Log.info(rid, "ERP overdue pull started.");
  try {
    const cfg = erpConfig_();
    const data = erpFetchList_(cfg, "/api/delivery-sheet/overdue", rid);
    Log.info(rid, "ERP returned " + data.length + " overdue order(s).");

    let sheet = ss.getSheetByName(CONFIG.OVERDUE_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.OVERDUE_SHEET);
      sheet.appendRow(ERP_OVERDUE_HEADERS);
      sheet.getRange(1, 1, 1, ERP_OVERDUE_HEADERS.length).setBackground("#444444").setFontColor("#FFFFFF").setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
    if (!data.length) {
      recordExecutionLog(ss, rid, "OVERDUE_LOG", startTime, new Date(), "SKIPPED", "No overdue orders.", userEmail);
      if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("Overdue History: no overdue orders.");
      return;
    }

    const pullTimeStamp = Utilities.formatDate(new Date(), timezone, "yyyy-MM-dd HH:mm");
    const rows = data.map(function (o) { return [pullTimeStamp].concat(erpListRow_(o)); });
    const insertAt = sheet.getLastRow() + 1;
    sheet.getRange(insertAt, 1, rows.length, rows[0].length).setValues(rows);
    Log.info(rid, "Appended " + rows.length + " history row(s) at R" + insertAt + ".");

    // Ruling 2: the delivery date moves to today + 3 in the ERP, one batch.
    const extensionDate = new Date();
    extensionDate.setDate(extensionDate.getDate() + 3);
    const newDate = Utilities.formatDate(extensionDate, timezone, "yyyy-MM-dd");
    let extended = 0, failed = 0;
    for (let i = 0; i < data.length; i += ERP_PUSH_BATCH) {
      const batch = data.slice(i, i + ERP_PUSH_BATCH).map(function (o) { return { DocNo: o.DocNo, ExpiryDate: newDate }; });
      try {
        const res = erpFetch_(cfg, "/api/delivery-sheet/updates", { method: "post", contentType: "application/json", payload: JSON.stringify({ updates: batch }) }, rid);
        if (res.getResponseCode() === 200) {
          const results = JSON.parse(res.getContentText()).results || [];
          results.forEach(function (r) { if (r.ok === true) extended++; else failed++; });
        } else { failed += batch.length; Log.error(rid, "Extension batch failed: HTTP " + res.getResponseCode()); }
      } catch (e) { failed += batch.length; Log.error(rid, "Extension batch connection error", e); }
    }

    const message = "Logged " + data.length + " overdue order(s). Extended " + extended + " to " + newDate + ", failed " + failed + ".";
    Log.info(rid, message);
    recordExecutionLog(ss, rid, "OVERDUE_LOG", startTime, new Date(), failed ? "PARTIAL" : "SYNCED", message, userEmail);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("Overdue History\n\n" + message);
  } catch (e) {
    Log.error(rid, "ERP overdue pull failed", e);
    recordExecutionLog(ss, rid, "OVERDUE_LOG", startTime, new Date(), "FAILED", e.message, userEmail);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("Overdue History FAILED\n" + e.message);
  }
}

/** Balance Collection: the tab is rewritten whole, expiry colouring as before. */
function runErpBalanceCollectionPull(triggerType) {
  const rid = Utilities.getUuid();
  const startTime = new Date();
  const ss = getTargetSs();
  const userEmail = Session.getActiveUser().getEmail();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const threeDays = new Date(); threeDays.setDate(today.getDate() + 3); threeDays.setHours(23, 59, 59, 999);
  Log.info(rid, "ERP balance collection pull started.");
  try {
    const cfg = erpConfig_();
    const data = erpFetchList_(cfg, "/api/delivery-sheet/balance-collection", rid);
    Log.info(rid, "ERP returned " + data.length + " order(s) with balance.");

    let sheet = ss.getSheetByName(CONFIG.BALANCE_SHEET);
    if (!sheet) sheet = ss.insertSheet(CONFIG.BALANCE_SHEET);
    sheet.clear();
    sheet.clearFormats();
    sheet.getBandings().forEach(function (b) { b.remove(); });
    sheet.appendRow(ERP_BALANCE_HEADERS);
    const n = ERP_BALANCE_HEADERS.length;
    sheet.getRange(1, 1, 1, n).setBackground("#0b5394").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");

    if (data.length) {
      const rows = data.map(erpListRow_);
      sheet.getRange(2, 1, rows.length, n).setValues(rows);
      sheet.getRange(1, 1, rows.length + 1, n).setVerticalAlignment("middle");
      let expired = 0, warning = 0;
      data.forEach(function (o, i) {
        if (!o.SalesExemptionExpiryDate) return;
        const d = new Date(o.SalesExemptionExpiryDate);
        const rowRange = sheet.getRange(i + 2, 1, 1, n);
        const dateCell = sheet.getRange(i + 2, 14);
        if (d < today) { rowRange.setBackground("#f4cccc"); dateCell.setFontWeight("bold").setFontColor("#990000"); expired++; }
        else if (d <= threeDays) { rowRange.setBackground("#fff2cc"); dateCell.setFontWeight("bold").setFontColor("#b45f06"); warning++; }
      });
      Log.info(rid, "Expiry highlights: " + expired + " expired, " + warning + " within 3 days.");
      sheet.getRange(2, 11, rows.length, 1).setFontWeight("bold");
    }
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, n);

    const message = "Pulled " + data.length + " order(s) with balance from the ERP.";
    recordExecutionLog(ss, rid, "BALANCE_LIST", startTime, new Date(), "SYNCED", message, userEmail);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("Balance Collection\n\n" + message);
  } catch (e) {
    Log.error(rid, "ERP balance pull failed", e);
    recordExecutionLog(ss, rid, "BALANCE_LIST", startTime, new Date(), "FAILED", e.message, userEmail);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("Balance Collection FAILED\n" + e.message);
  }
}

function manualErpOverdue() { runErpOverduePull("MANUAL"); }
function manualErpBalance() { runErpBalanceCollectionPull("MANUAL"); }
function scheduledErpOverdue() { runErpOverduePull("SCHEDULED"); }
function scheduledErpBalance() { runErpBalanceCollectionPull("SCHEDULED"); }

/**
 * Installs the two daily triggers (07:00 sheet time) and removes this
 * account's old AutoCount ones for the same tabs.
 */
function setupErpPhase2Triggers() {
  const stop = ["scheduledOverdue", "runBalanceCollectionPull", "scheduledErpOverdue", "scheduledErpBalance"];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (stop.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("scheduledErpOverdue").timeBased().everyDays(1).atHour(7).create();
  ScriptApp.newTrigger("scheduledErpBalance").timeBased().everyDays(1).atHour(7).create();
  Log.info("setup", "scheduledErpOverdue + scheduledErpBalance installed daily at 07:00; AutoCount overdue/balance triggers removed.");
  try { SpreadsheetApp.getUi().alert("Overdue + Balance Collection now sync from the ERP daily at 07:00."); } catch (e) {}
}
