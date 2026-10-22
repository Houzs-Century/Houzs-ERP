// Sync2990.gs
// 2990 ready-to-ship orders -> Delivery Details (Nico 2026-08-26)
//
// Houzs orders reach this tab through the AutoCount pull. 2990 orders are born
// in the ERP SCM module and never touch AutoCount, so dispatch has been typing
// them by hand. This pulls every 2990 order whose stock has come good and
// appends the ones the tab does not already carry, keyed on Doc. No. in col B.
//
// The key is NOT in this file. It lives in Project Settings > Script Properties
// under SHEET_SYNC_KEY_2990, so it never appears in the source, a screenshot or
// an export. It is a 2990-only key: by the rule set 2026-08-18 an intake secret
// may only open its own company data, and the two Houzs keys may not open this.

var SO_2990_URL = "https://erp.houzscentury.com/api/assr-form-intake/so-export";
var SO_2990_SHEET = "Delivery Details";

function so2990Key_() {
  var k = PropertiesService.getScriptProperties().getProperty("SHEET_SYNC_KEY_2990");
  if (!k) throw new Error("Script property SHEET_SYNC_KEY_2990 is not set - add it under Project Settings.");
  return k;
}

/** ISO date text -> a real Date so the cell formats like its neighbours. */
function so2990Date_(iso) {
  if (!iso) return "";
  var p = String(iso).slice(0, 10).split("-");
  if (p.length !== 3) return "";
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

/**
 * One order as columns B..AE. Index 0 is column B. The blanks are columns this
 * feed does not own: Delivery Date (Q) belongs to scheduling, and the driver
 * block belongs to dispatch.
 */
function so2990Row_(o) {
  var r = [];
  for (var i = 0; i < 30; i++) r.push("");
  r[0]  = o.doc_no || "";                              // B  Doc. No.
  r[1]  = o.transfer_to || "";                         // C  Transfer To
  r[2]  = so2990Date_(o.so_date);                      // D  Date
  r[3]  = o.ref || "";                                 // E  Ref. No
  r[4]  = o.branding || "";                            // F  Branding
  r[5]  = o.debtor_name || "";                         // G  Debtor Name
  r[6]  = o.phone || "";                               // H  Phone
  r[7]  = o.sales_location || "";                      // I  Sales Location
  r[8]  = o.agent || "";                               // J  Agent
  r[9]  = (o.local_total == null ? "" : o.local_total);   // K  Local Total
  r[10] = (o.balance == null ? "" : o.balance);           // L  Balance
  r[11] = o.stock_remark || "";                        // M  Remarks 2
  r[12] = so2990Date_(o.processing_date);              // N  Processing Date
  r[13] = so2990Date_(o.customer_delivery_date);       // O  carries the customer date
  r[20] = o.building_type || "";                       // V  Landed / Condo / Apartment
  r[25] = o.po_doc_no || "";                           // AA PO Doc No.
  r[26] = o.address1 || "";                            // AB Address 1
  r[27] = o.address2 || "";                            // AC Address 2
  r[28] = o.address3 || "";                            // AD Address 3
  r[29] = o.address4 || "";                            // AE Address 4
  return r;
}

function so2990Fetch_() {
  var res = UrlFetchApp.fetch(SO_2990_URL, {
    headers: { "X-Intake-Key": so2990Key_() },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) throw new Error("ERP answered " + code + ": " + body.slice(0, 200));
  return JSON.parse(body).orders || [];
}

/** Core. dryRun true = report only, the sheet is never touched. */
function so2990Sync_(dryRun) {
  var orders = so2990Fetch_();
  var sh = SpreadsheetApp.getActive().getSheetByName(SO_2990_SHEET);
  if (!sh) throw new Error(SO_2990_SHEET + " not found");

  var last = getRealLastRow(sh);
  var seen = {};
  sh.getRange(1, 2, last, 1).getValues().forEach(function (row) {
    var v = String(row[0] == null ? "" : row[0]).trim();
    if (v) seen[v] = true;
  });

  var missing = orders.filter(function (o) { return !seen[String(o.doc_no).trim()]; });
  var already = orders.length - missing.length;

  console.log("[2990Sync] ERP ready " + orders.length + ", already on the tab " + already +
              ", to append " + missing.length + ", first free row R" + (last + 1));
  missing.forEach(function (o, i) {
    console.log("[2990Sync]   R" + (last + 1 + i) + "  " + o.doc_no + "  " + (o.debtor_name || "") +
                "  " + (o.branding || "") + "  " + (o.stock_remark || "") +
                "  cust date " + (o.customer_delivery_date || "-"));
  });

  if (dryRun) {
    SpreadsheetApp.getActive().toast(
      "ERP ready " + orders.length + " / already here " + already + " / would append " +
      missing.length + " from R" + (last + 1) + ". Nothing written - open the execution log.",
      "2990 preview", 20);
    return { ready: orders.length, already: already, appended: 0, pending: missing.length };
  }

  if (!missing.length) {
    SpreadsheetApp.getActive().toast("Nothing new - all " + orders.length +
      " ready orders are already on the tab.", "2990 sync", 8);
    return { ready: orders.length, already: already, appended: 0, pending: 0 };
  }

  var values = missing.map(so2990Row_);
  var target = sh.getRange(last + 1, 2, values.length, 30);
  try {
    target.setValues(values);
    SpreadsheetApp.flush();
  } catch (e) {
    // A column may still carry a reject-mode data validation from an older
    // vocabulary. Apps Script commits lazily, so the refusal surfaces on the
    // next read, not at setValues - flush() forces it here where it can be
    // caught. These rows are brand new, so dropping the rule on them costs
    // nothing (same handling as the ASSR delivery linkage).
    console.log("[2990Sync] write refused (" + e + ") - clearing validation on the new rows and retrying");
    target.clearDataValidations();
    target.setValues(values);
    SpreadsheetApp.flush();
  }

  console.log("[2990Sync] appended " + values.length + " row(s) from R" + (last + 1));
  SpreadsheetApp.getActive().toast("Appended " + values.length + " order(s) from R" + (last + 1) + ".",
    "2990 sync", 10);
  return { ready: orders.length, already: already, appended: values.length, pending: 0 };
}


/** Sheet column letter for a B..AE index (0 is column B). */
function so2990Col_(i) {
  var n = i + 2;
  var s = "";
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Backfill for the 2990 rows dispatch typed by hand before this feed existed:
 * they carry the Doc. No. and little else, because the AutoCount-fed columns
 * were never filled for them.
 *
 * Fills BLANK cells only. A cell that already holds anything - even something
 * that disagrees with the ERP - is left exactly as it is, so nobody loses a
 * correction they made by hand. Delivery Date is skipped outright.
 */
function so2990Backfill_(dryRun) {
  var orders = so2990Fetch_();
  var sh = SpreadsheetApp.getActive().getSheetByName(SO_2990_SHEET);
  if (!sh) throw new Error(SO_2990_SHEET + " not found");

  var last = getRealLastRow(sh);
  var grid = sh.getRange(1, 2, last, 30).getValues();   // B..AE
  var rowByDoc = {};
  for (var i = 0; i < grid.length; i++) {
    var d = String(grid[i][0] == null ? "" : grid[i][0]).trim();
    if (d && !rowByDoc[d]) rowByDoc[d] = i + 1;
  }

  var cells = 0, rows = 0;
  orders.forEach(function (o) {
    var r = rowByDoc[String(o.doc_no).trim()];
    if (!r) return;
    var want = so2990Row_(o);
    var cur = grid[r - 1];
    var touched = [];
    for (var c = 0; c < 30; c++) {
      if (c === 15) continue;                       // Q Delivery Date - scheduling owns it
      var v = want[c];
      if (v === "" || v === null) continue;         // the ERP has nothing to offer
      var existing = cur[c];
      var isBlank = !(existing instanceof Date) && String(existing == null ? "" : existing).trim() === "";
      if (!isBlank) continue;                       // never overwrite a human
      if (!dryRun) sh.getRange(r, c + 2).setValue(v);
      touched.push(so2990Col_(c));
      cells++;
    }
    if (touched.length) {
      rows++;
      console.log("[2990Backfill] R" + r + "  " + o.doc_no + "  " + (dryRun ? "would fill " : "filled ") +
                  touched.length + ": " + touched.join(","));
    }
  });

  if (!dryRun) SpreadsheetApp.flush();
  console.log("[2990Backfill] " + (dryRun ? "would fill " : "filled ") + cells + " blank cell(s) across " + rows + " row(s)");
  SpreadsheetApp.getActive().toast(
    (dryRun ? "Would fill " : "Filled ") + cells + " blank cell(s) across " + rows +
    " existing 2990 row(s)." + (dryRun ? " Nothing written." : ""),
    dryRun ? "2990 backfill preview" : "2990 backfill", 15);
  return { cells: cells, rows: rows };
}


/* Columns the ERP OWNS on a 2990 row, unlike the blanks-only backfill above.
   A stale figure in one of these is worse than an empty cell: Balance moves
   every time a payment lands, and Remarks 2 every time stock does. Both were
   written wrong on the first pull - the export was reading a stored balance
   column that nothing maintains - so they need overwriting, not filling.
   Local Total rides along because an amendment moves it. */
var SO_2990_OWNED = [
  { i: 9,  col: "K", label: "Local Total" },
  { i: 10, col: "L", label: "Balance" },
  { i: 11, col: "M", label: "Remarks 2" }
];

function so2990Resync_(dryRun) {
  var orders = so2990Fetch_();
  var sh = SpreadsheetApp.getActive().getSheetByName(SO_2990_SHEET);
  if (!sh) throw new Error(SO_2990_SHEET + " not found");
  var last = getRealLastRow(sh);
  var grid = sh.getRange(1, 2, last, 30).getValues();
  var rowByDoc = {};
  for (var i = 0; i < grid.length; i++) {
    var d = String(grid[i][0] == null ? "" : grid[i][0]).trim();
    if (d && !rowByDoc[d]) rowByDoc[d] = i + 1;
  }
  var changed = 0, rows = 0;
  orders.forEach(function (o) {
    var r = rowByDoc[String(o.doc_no).trim()];
    if (!r) return;
    var want = so2990Row_(o);
    var cur = grid[r - 1];
    var notes = [];
    SO_2990_OWNED.forEach(function (f) {
      var target = want[f.i];
      var existing = cur[f.i];
      var same = String(existing == null ? "" : existing).trim() === String(target == null ? "" : target).trim() ||
                 (typeof existing === "number" && typeof target === "number" && Math.abs(existing - target) < 0.005);
      if (same) return;
      if (!dryRun) sh.getRange(r, f.i + 2).setValue(target);
      notes.push(f.col + " " + f.label + ": " + (existing === "" || existing == null ? "(blank)" : existing) + " -> " + target);
      changed++;
    });
    if (notes.length) {
      rows++;
      console.log("[2990Resync] R" + r + "  " + o.doc_no + "  " + (dryRun ? "would change " : "changed ") + notes.join("  |  "));
    }
  });
  if (!dryRun) SpreadsheetApp.flush();
  console.log("[2990Resync] " + (dryRun ? "would change " : "changed ") + changed + " cell(s) across " + rows + " row(s)");
  SpreadsheetApp.getActive().toast(
    (dryRun ? "Would overwrite " : "Overwrote ") + changed + " cell(s) across " + rows + " row(s)." +
    (dryRun ? " Nothing written." : ""), dryRun ? "2990 resync preview" : "2990 resync", 20);
  return { cells: changed, rows: rows };
}


/**
 * The whole 2990 feed behind ONE menu item, in the order that makes sense:
 *   1. append the ready orders the tab does not carry
 *   2. fill the blanks on the rows it already had
 *   3. correct the three columns the ERP owns (Total / Balance / Remarks 2)
 *
 * Each step reports its own line to the log; the toast is the summary. The
 * three internals stay separate so a future caller can still run one alone.
 */
function so2990SyncAll_(dryRun) {
  var a = so2990Sync_(dryRun);
  var b = so2990Backfill_(dryRun);
  var c = so2990Resync_(dryRun);
  var msg = (dryRun ? "Would append " : "Appended ") + (dryRun ? a.pending : a.appended) + " order(s), " +
            (dryRun ? "fill " : "filled ") + b.cells + " blank(s), " +
            (dryRun ? "correct " : "corrected ") + c.cells + " figure(s). " +
            "ERP has " + a.ready + " ready order(s)." + (dryRun ? " Nothing written." : "");
  console.log("[2990] " + msg);
  SpreadsheetApp.getActive().toast(msg, dryRun ? "2990 preview" : "2990 sync", 25);
  return msg;
}

/** Menu: report what a sync would do. Writes nothing. */
function preview2990Sync() { so2990SyncAll_(true); }

/** Menu: append new ready orders, fill blanks, correct Total/Balance/Remarks 2. */
function sync2990FromErp() { so2990SyncAll_(false); }

/**
 * Install the nightly timer that runs the sync unattended. Safe to re-run:
 * it removes any existing timer for this handler first, so it can never end
 * up with two.
 *
 * Run this ONCE from the editor. It exists because the Add Trigger dialog
 * cannot be driven reliably - its function picker is an old Closure control
 * that snaps back to the current selection - so the trigger is created in
 * code instead of by clicking.
 */
function setup2990SyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "sync2990FromErp") ScriptApp.deleteTrigger(t);
  });
  /* Midnight daily, same shift as the AutoCount jobs (Nico 2026-08-26). Apps
     Script fires time triggers inside a one-hour window, so this lands between
     00:00 and 01:00 on the project timezone. During the day the two menu items
     are the way in - the feed is not urgent enough to hammer the ERP all day. */
  ScriptApp.newTrigger("sync2990FromErp").timeBased().atHour(0).everyDays(1).create();
  console.log("[2990] nightly (00:00) trigger installed for sync2990FromErp");
}

/** The 2990 pull now runs inside scheduledErpSync every 5 minutes (owner
 *  2026-10-02). Run once to drop the old nightly timer so the two never overlap. */
function remove2990NightlyTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "sync2990FromErp") { ScriptApp.deleteTrigger(t); n++; }
  });
  console.log("[2990] removed " + n + " nightly trigger(s); scheduledErpSync pulls 2990 every 5 minutes");
}

/** Read-only: what timers exist for the 2990 sync right now. */
function check2990SyncTrigger() {
  var found = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === "sync2990FromErp";
  });
  console.log("[2990] triggers for sync2990FromErp: " + found.length);
  return found.length;
}
