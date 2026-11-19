/**
 * ERPTransporterSync.gs — the ESB / BS transporter sheets fed DIRECTLY from the
 * ERP (owner 2026-11-19), replacing the old path through the HC Delivery master
 * sheet's EM Order tab (ERPDeliverySync.gs `erpPushToTransporters_`).
 *
 * WHY. The master sheet's EM -> ESB / BS push is being retired. This script
 * reads the ERP's own East-Malaysia transporter feed and writes ESB and BS
 * itself, so neither sheet depends on the master any more:
 *
 *   GET {ERP_BASE_URL}/api/delivery-sheet/em-transporter   (header X-Intake-Key)
 *   -> { records: [ DeliverySheetRecord + { Kind, Appendable } ] }
 *
 * Each record is an East (Sabah / Sarawak) Sales Order or an own-team Service
 * Case leg, in the SAME AutoCount-named shape the master sheet used. The ERP
 * marks `Appendable`: a Sales Order is appendable only when READY (the owner's
 * gate, "只收 ready 的", 2026-11-19); a service leg is always appendable (its
 * own-team gate is applied server side). Rows the sheet already has are updated
 * whether appendable or not.
 *
 * ESB ("EM Delivery") gets every East record. BS ("SABAH EM Delivery") gets a
 * record ONLY once the ESB sheet marks it "TO BRIGHTSUN" in its delivery-status
 * remarks (owner 2026-10-23) — read from the ESB sheet, processed first.
 *
 * WHAT IS WRITTEN. Only the columns the ERP authoritatively owns, by header
 * name (TS_RECORD_COLUMNS). A blank ERP value never clears a cell, and a value
 * the target column's dropdown rejects is skipped. The transporter-owned
 * columns (Consignment, Vessel, ETD / ETA, Done Delivery, BS KK Delivery Date,
 * ESB / BS Remarks) and the sheet's own columns (EM Order Shipment Status, CTN,
 * Houzs Remark 2, Attention, Sync Status) are NEVER written — they were team /
 * transporter owned on the master too. SHIPOUT DATE = DO date IS written now
 * (owner 2026-11-19): the ERP's latest non-cancelled DO date. On a NEW appended
 * row the shipment-status cell is seeded from Remark 4, as the master did for col A.
 *
 * Nothing is read back into the ERP: the ERP has never stored the transporters'
 * freight columns, so this is a one-way push, exactly as the master leg was.
 *
 * SETUP (Script properties — this file is in a public repo, never hard-code ids
 * or the key):
 *   ERP_BASE_URL            e.g. https://<worker-host>
 *   SHEET_SYNC_KEY          the same shared secret the master sheet uses
 *   TRANSPORTER_BS_SS_ID    the BS ("Houzs x BS_EM Order (KK)") spreadsheet id
 *   TRANSPORTER_ESB_SS_ID   OPTIONAL — only when this script is NOT bound to the
 *                           ESB spreadsheet (a bound script uses the active one)
 * Then run setupTransporterSyncTrigger() once (daily ~07:30) and, on the master
 * project, DELETE the old `scheduledPushToTransporters` trigger so only one
 * writer touches ESB / BS.
 */

var TS_CONFIG = {
  ESB_SHEET: "EM Delivery",
  BS_SHEET: "SABAH EM Delivery",
  EM_PATH: "/api/delivery-sheet/em-transporter",
  ESB_REMARK_HEADER: "em order delivery status esb remarks",
  STATUS_HEADER: "em order shipment status",
};

/** The ERP-owned columns, by the target sheet's header name. Only these are
 *  written; every other column on ESB / BS is the sheet's or transporter's. */
function TS_RECORD_COLUMNS(rec) {
  return {
    "transfer to": rec.TransferTo || "",
    "ref.": rec.Ref || "",
    "debtor name": rec.DebtorName || "",
    "phone": String(rec.Phone1 || "").replace(/[+\s&-]/g, ""),
    "sales location": rec.SalesLocation || "",
    "local total": rec.Total == null ? "" : rec.Total,
    "balance": rec.SOUDF_BALANCE == null ? "" : rec.SOUDF_BALANCE,
    "remark 4": rec.Remark4 || "",
    "sales exemption expiry date": tsDate_(rec.SalesExemptionExpiryDate),
    "shipout date = do date": tsDate_(rec.ShipoutDate),
    "address 1": rec.InvAddr1 || "",
    "address 2": rec.InvAddr2 || "",
    "address 3": rec.InvAddr3 || "",
    "address 4": rec.InvAddr4 || "",
  };
}

function tsProp_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error("Script property " + name + " is not set");
  return v;
}

function tsNormHeader_(h) {
  return String(h == null ? "" : h).toLowerCase().replace(/\s+/g, " ").trim();
}

function tsCell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, "Asia/Kuala_Lumpur", "yyyy/MM/dd");
  return String(v == null ? "" : v).trim();
}

/** The sheet's date columns display yyyy/MM/dd; the ERP sends yyyy-mm-dd text. */
function tsDate_(v) {
  var s = String(v == null ? "" : v).trim();
  if (!s) return "";
  return s.slice(0, 10).replace(/-/g, "/");
}

/** target header (normalised) -> 0-based column index. */
function tsTargetColumns_(headers) {
  var tCol = {};
  headers.forEach(function (h, i) {
    var k = tsNormHeader_(h);
    if (k && tCol[k] === undefined) tCol[k] = i;
  });
  return tCol;
}

function tsEsbSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty("TRANSPORTER_ESB_SS_ID");
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error("No active spreadsheet and TRANSPORTER_ESB_SS_ID is not set");
  return active;
}

function tsFetchEmRecords_() {
  var base = tsProp_("ERP_BASE_URL").replace(/\/+$/, "");
  var key = tsProp_("SHEET_SYNC_KEY");
  var resp = UrlFetchApp.fetch(base + TS_CONFIG.EM_PATH, {
    method: "get",
    headers: { "X-Intake-Key": key },
    muteHttpExceptions: true,
  });
  var code = resp.getResponseCode();
  if (code !== 200) throw new Error("ERP em-transporter " + code + ": " + resp.getContentText().slice(0, 200));
  var body = JSON.parse(resp.getContentText());
  return body.records || [];
}

/** DocNo -> the ESB sheet's "EM Order Delivery Status ESB Remarks" text, for the
 *  BS "TO BRIGHTSUN" gate (read from ESB, which is written first). */
function tsReadEsbRemarks_(ssEsb) {
  var sh = ssEsb.getSheetByName(TS_CONFIG.ESB_SHEET);
  var last = sh.getLastRow();
  if (last < 2) return {};
  var lc = sh.getLastColumn();
  var tCol = tsTargetColumns_(sh.getRange(1, 1, 1, lc).getValues()[0]);
  var dc = tCol["doc. no."];
  var rc = tCol[TS_CONFIG.ESB_REMARK_HEADER];
  if (dc === undefined || rc === undefined) return {};
  var rows = sh.getRange(2, 1, last - 1, lc).getValues();
  var out = {};
  rows.forEach(function (r) {
    var d = tsCell_(r[dc]);
    if (d && out[d] === undefined) out[d] = tsCell_(r[rc]);
  });
  return out;
}

/** Update the rows the target already has and append the appendable, missing
 *  ones. `wants(rec)` decides whether a missing record may be appended at all
 *  (BS: only TO BRIGHTSUN). A blank ERP value never clears; a dropdown-rejected
 *  value is skipped. */
function tsPushToSheet_(spreadsheet, tabName, records, wants) {
  var sh = spreadsheet.getSheetByName(tabName);
  if (!sh) throw new Error("tab '" + tabName + "' not found");
  var lc = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lc).getValues()[0];
  var tCol = tsTargetColumns_(headers);
  var docT = tCol["doc. no."];
  if (docT === undefined) throw new Error("tab '" + tabName + "' has no Doc. No. column");

  var last = sh.getLastRow();
  var rows = last >= 2 ? sh.getRange(2, 1, last - 1, lc).getValues() : [];
  var allowed = {};
  if (last >= 2) {
    sh.getRange(2, 1, 1, lc).getDataValidations()[0].forEach(function (dv, i) {
      if (dv && dv.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
        var ok = {};
        (dv.getCriteriaValues()[0] || []).forEach(function (x) { ok[String(x == null ? "" : x).trim()] = 1; });
        allowed[i] = ok;
      }
    });
  }
  var tRow = {};
  rows.forEach(function (r, i) { var d = tsCell_(r[docT]); if (d && tRow[d] === undefined) tRow[d] = i; });

  var updated = 0, appended = 0, blocked = 0;
  var appends = [];
  records.forEach(function (rec) {
    var doc = tsCell_(rec.DocNo);
    if (!doc) return;
    var map = TS_RECORD_COLUMNS(rec);
    var ti = tRow[doc];
    if (ti === undefined) {
      if (!rec.Appendable || !wants(rec)) return;
      var row = headers.map(function () { return ""; });
      row[docT] = doc;
      Object.keys(map).forEach(function (k) {
        var t = tCol[k];
        if (t === undefined) return;
        var v = map[k];
        if (v === "" || v == null) return;
        var al = allowed[t];
        if (al && !al[String(v)]) { blocked++; return; }
        row[t] = v;
      });
      var statusCol = tCol[TS_CONFIG.STATUS_HEADER];
      if (statusCol !== undefined && tsCell_(rec.Remark4)) row[statusCol] = rec.Remark4;
      appends.push(row);
      tRow[doc] = -1;
      return;
    }
    if (ti < 0) return;
    Object.keys(map).forEach(function (k) {
      var t = tCol[k];
      if (t === undefined) return;
      var v = map[k];
      if (v === "" || v == null) return;                   // blank never clears
      if (tsCell_(rows[ti][t]) === tsCell_(v)) return;      // unchanged
      var al = allowed[t];
      if (al && !al[String(v)]) { blocked++; return; }
      try { sh.getRange(ti + 2, t + 1).setValue(v); updated++; } catch (e) { /* skip one bad cell */ }
    });
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, lc).setValues(appends);
  return { updated: updated, appended: appends.length, blocked: blocked };
}

function tsSyncTransporters_(triggerType) {
  var records = tsFetchEmRecords_();
  var ssEsb = tsEsbSpreadsheet_();
  var esb = tsPushToSheet_(ssEsb, TS_CONFIG.ESB_SHEET, records, function () { return true; });

  var esbRemarks = tsReadEsbRemarks_(ssEsb);
  var ssBs = SpreadsheetApp.openById(tsProp_("TRANSPORTER_BS_SS_ID"));
  var bs = tsPushToSheet_(ssBs, TS_CONFIG.BS_SHEET, records, function (rec) {
    return /to\s*brightsun/i.test(esbRemarks[tsCell_(rec.DocNo)] || "");
  });

  var msg = records.length + " East record(s). " +
    "ESB: " + esb.updated + " updated, " + esb.appended + " added" + (esb.blocked ? ", " + esb.blocked + " skipped by dropdown" : "") + ". " +
    "BS: " + bs.updated + " updated, " + bs.appended + " added" + (bs.blocked ? ", " + bs.blocked + " skipped by dropdown" : "") + ".";
  if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("Sync ESB / BS from ERP\n" + msg);
  return msg;
}

function manualSyncTransporters() { tsSyncTransporters_("MANUAL"); }
function scheduledSyncTransporters() { tsSyncTransporters_("SCHEDULED"); }

/** Run once (as the trigger-owning Workspace account): daily ~07:30. */
function setupTransporterSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "scheduledSyncTransporters") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("scheduledSyncTransporters").timeBased().everyDays(1).atHour(7).nearMinute(30).create();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("ERP -> ESB / BS").addItem("Sync ESB / BS from ERP now", "manualSyncTransporters").addToUi();
}
