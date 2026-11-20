/**
 * ERPTransporterSync.gs — the SINGLE two-way bridge between the ERP's Delivery
 * Planning board and the two transporter Google Sheets (ESB + BS).
 *
 * The ERP is the hub now (owner 2026-11-20). This one script, bound to the ESB
 * spreadsheet, drives BOTH sheets, so the old ESB<->BS satellites (Satellite.gs
 * / BS_Satellite.gs) and the master-sheet leg are retired — delete them, leave
 * only this. The BS spreadsheet needs NO script of its own; this script opens it
 * by id and reads / writes it directly.
 *
 * Each sync does two directions, write-back FIRST so the loop closes in one run:
 *
 *   1. WRITE-BACK (sheets -> ERP)
 *      POST {ERP_BASE_URL}/api/delivery-sheet/em-transporter-updates
 *        body { updates: [ { DocNo, emDeliveryStatus?, consignmentNo?, ... } ] }
 *      The transporters' own columns — ESB: EM Order Delivery Status ESB Remarks
 *      (holds "TO BRIGHTSUN"), Consignment No, Vessel & Voyage, ETD Port Klang,
 *      ETA EM Port, Actual Arrived EM Warehouse, ESB Remarks; BS: BS KK Delivery
 *      Date, BS Remarks — land on each order's latest live Delivery Order in the
 *      ERP. A blank cell never clears an ERP value (server COALESCEs).
 *
 *   2. FORWARD (ERP -> sheets)
 *      GET {ERP_BASE_URL}/api/delivery-sheet/em-transporter
 *        -> { records: [ DeliverySheetRecord + { Kind, Appendable } ] }
 *      Each record is an East (Sabah / Sarawak) Sales Order or an own-team
 *      Service-Case leg, in the AutoCount-named shape. The ERP marks
 *      `Appendable`: an SO only when READY (owner's "只收 ready 的" gate), a leg
 *      always. Rows the sheet already has are updated whether appendable or not.
 *      ESB ("EM Delivery") gets every East record. BS ("SABAH EM Delivery") gets
 *      a record only when its ERP `EmDeliveryStatus` contains "TO BRIGHTSUN"
 *      (owner 2026-10-23) — read from the ERP record now, since write-back ran
 *      first, not from an ESB-sheet re-read.
 *
 * WHAT FORWARD WRITES. Only the columns the ERP authoritatively owns, by header
 * name (TS_RECORD_COLUMNS): the board's delivery message status (col A "EM Order
 * Shipment Status"), the planner's Remarks ("Houzs Remark 2"), CTN, SHIPOUT DATE
 * (= the latest non-cancelled DO date), and the AutoCount basics (Ref, Debtor,
 * Phone, Sales Location, Total, Balance, Remark 4, Sales Exemption Expiry,
 * Address 1-4, Transfer To). A blank ERP value never clears a cell; a value the
 * target column's dropdown rejects is skipped. The transporter-owned columns
 * (Consignment, Vessel, ETD/ETA, Actual Arrived, BS Delivery Date, ESB/BS
 * Remarks) are NEVER forward-written — they are write-back SOURCES only, so the
 * two directions never fight over a cell.
 *
 * SETUP (Script properties — this file is in a PUBLIC repo, never hard-code ids
 * or the key):
 *   ERP_BASE_URL            e.g. https://<worker-host>
 *   SHEET_SYNC_KEY          the shared intake secret (paste it in the editor;
 *                           it is never committed and never printed)
 *   TRANSPORTER_BS_SS_ID    the BS ("Houzs x BS_EM Order (KK)") spreadsheet id
 *   TRANSPORTER_ESB_SS_ID   OPTIONAL — only when this script is NOT bound to the
 *                           ESB spreadsheet (a bound script uses the active one)
 *
 * GO-LIVE:
 *   - run tsAudit()  once, read the Execution log, confirm every expected header
 *     matched a real column on each sheet (fix TS_* header names if one misses).
 *   - run manualSyncTransporters() once to dry the first real sync.
 *   - run setupTransporterSyncTrigger() for the hourly schedule.
 *   - on the OLD master project, delete the `scheduledPushToTransporters`
 *     trigger; delete Satellite.gs / BS_Satellite.gs so only this script writes.
 */

var TS_CONFIG = {
  ESB_SHEET: "EM Delivery",
  BS_SHEET: "SABAH EM Delivery",
  EM_PATH: "/api/delivery-sheet/em-transporter",
  WRITEBACK_PATH: "/api/delivery-sheet/em-transporter-updates",
  DOC_HEADER: "doc. no.",
  STATUS_HEADER: "em order shipment status",
  WRITEBACK_MAX: 300, // must match backend EM_WRITEBACK_MAX
};

/** ERP-owned FORWARD columns, by the target sheet's header name (normalised).
 *  Only these are written; every other column on ESB / BS is the sheet's own or
 *  a write-back source. col A status / Houzs Remark 2 / CTN are ERP-driven now
 *  (owner 2026-11-20): the board is their source of truth. */
function TS_RECORD_COLUMNS(rec) {
  return {
    "em order shipment status": rec.DeliveryMessageStatus || "", // col A <- board delivery message status
    "houzs remark 2": rec.DpRemark || "",                        // <- board Remarks
    "ctn": rec.Ctn == null ? "" : rec.Ctn,                        // <- board CTN (now editable there)
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

/** WRITE-BACK fields (sheet -> ERP). `key` is the request-body field the backend
 *  expects (EM_WRITEBACK_COLS); `sheet` says which sheet owns it; `heads` are the
 *  accepted header names (normalised) — the first that exists on that sheet's row
 *  1 is used. `date` values are sent as yyyy/MM/dd (the backend normalises); the
 *  rest as text. Add a header variant here if tsAudit() reports one unmatched. */
var TS_WRITEBACK_FIELDS = [
  { key: "emDeliveryStatus",       sheet: "ESB", cast: "text", heads: ["em order delivery status esb remarks", "em order delivery status", "esb delivery status"] },
  { key: "consignmentNo",          sheet: "ESB", cast: "text", heads: ["consignment no", "consignment no.", "consignment number", "consignment"] },
  { key: "vesselVoyage",           sheet: "ESB", cast: "text", heads: ["vessel & voyage", "vessel and voyage", "vessel/voyage", "vessel voyage", "vessel & voyage no", "vessel"] },
  { key: "etdPortKlang",           sheet: "ESB", cast: "date", heads: ["etd port klang", "etd port kelang", "etd pk", "etd"] },
  { key: "etaArrivingPort",        sheet: "ESB", cast: "text", heads: ["eta em port", "eta port", "eta arriving port", "eta em", "eta"] },
  { key: "arrivesEmWarehouseDate", sheet: "ESB", cast: "date", heads: ["actual arrived em warehouse", "actual arrive em warehouse", "arrives em warehouse", "arrived em warehouse", "actual arrived em warehouse date"] },
  { key: "esbRemarks",             sheet: "ESB", cast: "text", heads: ["esb remarks", "esb remark"] },
  { key: "bsDeliveryDate",         sheet: "BS",  cast: "date", heads: ["bs kk - delivery date", "bs kk delivery date", "bs kk- delivery date", "bs kk -delivery date", "bs delivery date"] },
  { key: "bsRemarks",              sheet: "BS",  cast: "text", heads: ["bs remarks", "bs remark"] },
];

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

/** target header (normalised) -> 0-based column index (first wins). A header is
 *  ALSO indexed with a trailing "(...)" annotation stripped, so a column titled
 *  "ETD Port Klang (YYYY/MM/DD)" is matched by "etd port klang" too. */
function tsTargetColumns_(headers) {
  var tCol = {};
  headers.forEach(function (h, i) {
    var k = tsNormHeader_(h);
    if (!k) return;
    if (tCol[k] === undefined) tCol[k] = i;
    var base = k.replace(/\s*\([^)]*\)\s*$/, "").trim(); // drop a trailing (…) note
    if (base && tCol[base] === undefined) tCol[base] = i;
  });
  return tCol;
}

/** The first of `heads` present in `tCol`, or undefined. */
function tsFindCol_(tCol, heads) {
  for (var i = 0; i < heads.length; i++) {
    if (tCol[heads[i]] !== undefined) return tCol[heads[i]];
  }
  return undefined;
}

function tsEsbSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty("TRANSPORTER_ESB_SS_ID");
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error("No active spreadsheet and TRANSPORTER_ESB_SS_ID is not set");
  return active;
}

function tsBsSpreadsheet_() {
  return SpreadsheetApp.openById(tsProp_("TRANSPORTER_BS_SS_ID"));
}

function tsChunk_(arr, n) {
  var out = [];
  for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* ------------------------------ WRITE-BACK ------------------------------ */

/** Read one sheet's write-back columns into [{ DocNo, <key>: value, ... }],
 *  skipping rows with no DocNo and rows whose every mapped cell is blank. */
function tsCollectWriteback_(spreadsheet, tabName, which) {
  var sh = spreadsheet.getSheetByName(tabName);
  if (!sh) throw new Error("tab '" + tabName + "' not found");
  var last = sh.getLastRow();
  if (last < 2) return { updates: [], missing: [], docCol: undefined };
  var lc = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lc).getValues()[0];
  var tCol = tsTargetColumns_(headers);
  var docCol = tCol[TS_CONFIG.DOC_HEADER];

  var fields = TS_WRITEBACK_FIELDS.filter(function (f) { return f.sheet === which; });
  var missing = [];
  var cols = fields.map(function (f) {
    var ci = tsFindCol_(tCol, f.heads);
    if (ci === undefined) missing.push(f.heads[0]);
    return { key: f.key, cast: f.cast, col: ci };
  }).filter(function (c) { return c.col !== undefined; });

  if (docCol === undefined || !cols.length) return { updates: [], missing: missing, docCol: docCol };

  var rows = sh.getRange(2, 1, last - 1, lc).getValues();
  var updates = [];
  rows.forEach(function (r) {
    var doc = tsCell_(r[docCol]);
    if (!doc) return;
    var u = { DocNo: doc };
    var any = false;
    cols.forEach(function (c) {
      var v = r[c.col];
      var s = tsCell_(v); // Date -> yyyy/MM/dd, else trimmed string
      if (s === "") return;
      u[c.key] = s;
      any = true;
    });
    if (any) updates.push(u);
  });
  return { updates: updates, missing: missing, docCol: docCol };
}

function tsPostWriteback_(updates) {
  if (!updates.length) return { updated: 0, count: 0, notUpdated: [] };
  var base = tsProp_("ERP_BASE_URL").replace(/\/+$/, "");
  var key = tsProp_("SHEET_SYNC_KEY");
  var updated = 0, count = 0, notUpdated = [];
  tsChunk_(updates, TS_CONFIG.WRITEBACK_MAX).forEach(function (batch) {
    var resp = UrlFetchApp.fetch(base + TS_CONFIG.WRITEBACK_PATH, {
      method: "post",
      contentType: "application/json",
      headers: { "X-Intake-Key": key },
      payload: JSON.stringify({ updates: batch }),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    if (code !== 200) throw new Error("ERP write-back " + code + ": " + resp.getContentText().slice(0, 200));
    var body = JSON.parse(resp.getContentText());
    updated += body.updated || 0;
    count += body.count || 0;
    (body.not_updated || []).forEach(function (d) { notUpdated.push(d); });
  });
  return { updated: updated, count: count, notUpdated: notUpdated };
}

/* ------------------------------- FORWARD -------------------------------- */

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
  var docT = tCol[TS_CONFIG.DOC_HEADER];
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

  var updated = 0, blocked = 0;
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

/* --------------------------------- RUN ---------------------------------- */

function tsSyncTransporters_(triggerType) {
  var ssEsb = tsEsbSpreadsheet_();
  var ssBs = tsBsSpreadsheet_();

  // 1) WRITE-BACK first, so the ERP's EmDeliveryStatus reflects any new
  //    "TO BRIGHTSUN" before the forward pass computes the BS gate.
  var wbEsb = tsCollectWriteback_(ssEsb, TS_CONFIG.ESB_SHEET, "ESB");
  var wbBs = tsCollectWriteback_(ssBs, TS_CONFIG.BS_SHEET, "BS");
  var wbMissing = wbEsb.missing.concat(wbBs.missing);
  var posted = tsPostWriteback_(wbEsb.updates.concat(wbBs.updates));

  // 2) FORWARD: ERP -> ESB (every East record) and BS (TO BRIGHTSUN only).
  var records = tsFetchEmRecords_();
  var esb = tsPushToSheet_(ssEsb, TS_CONFIG.ESB_SHEET, records, function () { return true; });
  var bs = tsPushToSheet_(ssBs, TS_CONFIG.BS_SHEET, records, function (rec) {
    return /to\s*brightsun/i.test(tsCell_(rec.EmDeliveryStatus));
  });

  var msg =
    "Write-back: " + posted.updated + "/" + posted.count + " order(s) updated in ERP" +
    (posted.notUpdated.length ? " (" + posted.notUpdated.length + " no live DO)" : "") +
    (wbMissing.length ? ". MISSING write-back headers: " + wbMissing.join(", ") : "") + ".\n" +
    records.length + " East record(s). " +
    "ESB: " + esb.updated + " updated, " + esb.appended + " added" + (esb.blocked ? ", " + esb.blocked + " skipped by dropdown" : "") + ". " +
    "BS: " + bs.updated + " updated, " + bs.appended + " added" + (bs.blocked ? ", " + bs.blocked + " skipped by dropdown" : "") + ".";
  Logger.log(msg);
  if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("ERP <-> ESB / BS sync\n\n" + msg);
  return msg;
}

function manualSyncTransporters() { tsSyncTransporters_("MANUAL"); }
function scheduledSyncTransporters() { tsSyncTransporters_("SCHEDULED"); }

/** Read-only header check — run once at go-live, read the Execution log. Lists
 *  each sheet's row-1 headers and whether every expected forward / write-back
 *  header matched a real column. Writes nothing. */
function tsAudit() {
  var out = [];
  function auditSheet(ss, tab, which) {
    var sh = ss.getSheetByName(tab);
    if (!sh) { out.push("[" + which + "] tab '" + tab + "' NOT FOUND"); return; }
    var lc = sh.getLastColumn();
    var headers = sh.getRange(1, 1, 1, lc).getValues()[0];
    var tCol = tsTargetColumns_(headers);
    out.push("[" + which + "] '" + tab + "' row1 (" + lc + " cols): " + headers.map(function (h) { return "«" + h + "»"; }).join(" "));
    out.push("[" + which + "] Doc. No. column: " + (tCol[TS_CONFIG.DOC_HEADER] === undefined ? "MISSING" : "ok"));
    // forward columns present on this sheet
    var fwd = Object.keys(TS_RECORD_COLUMNS({}));
    var fwdMiss = fwd.filter(function (k) { return tCol[k] === undefined; });
    out.push("[" + which + "] forward headers missing: " + (fwdMiss.length ? fwdMiss.join(", ") : "none"));
    // write-back columns for this sheet
    TS_WRITEBACK_FIELDS.filter(function (f) { return f.sheet === which; }).forEach(function (f) {
      var ci = tsFindCol_(tCol, f.heads);
      out.push("[" + which + "] write-back " + f.key + " -> " + (ci === undefined ? "MISSING (tried: " + f.heads.join(" | ") + ")" : "«" + headers[ci] + "»"));
    });
  }
  auditSheet(tsEsbSpreadsheet_(), TS_CONFIG.ESB_SHEET, "ESB");
  auditSheet(tsBsSpreadsheet_(), TS_CONFIG.BS_SHEET, "BS");
  var text = out.join("\n");
  Logger.log(text);
  return text;
}

/** Run once (as the trigger-owning Workspace account): hourly. */
function setupTransporterSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "scheduledSyncTransporters") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("scheduledSyncTransporters").timeBased().everyHours(1).create();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("ERP <-> ESB / BS")
    .addItem("Sync now (both directions)", "manualSyncTransporters")
    .addItem("Check headers (audit)", "tsAudit")
    .addToUi();
}
