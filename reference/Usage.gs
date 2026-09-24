// Usage.gs
//
// The sheet side of the script audit the owner asked for on 2026-09-24:
// "每个 gs 的来源用处 / 调用次数 / 监控调用次数、数据量", so a script unused for a
// month can be isolated and one unused for three months can be deleted on
// evidence. The ERP counts its own endpoints (scm.sheet_sync_usage); this
// covers what never reaches the ERP at all — the Google Form intake, the
// dashboard rebuilds, the EM transporter sync, the delivery-message sender.
//
// TWO SIGNALS, BECAUSE EITHER ALONE LIES.
//
//   · The LOG ("Track Record (Logs)") only holds what a script chose to write.
//     HC_Dashboard's refreshDashboard stopped writing rows on 2026-07-30 and
//     has run daily at 0% error ever since — on the log alone it reads as dead
//     for two months.
//   · The TRIGGERS say what still fires, but a trigger that fires is not a
//     script that works: four of this project's handlers were deleted and
//     their triggers still fire daily into "function not found".
//
// So the board prints both, side by side, and only calls something idle when
// BOTH agree. Read-only apart from the one tab it writes.
//
// SETUP: paste this file into the project, then run buildScriptUsageBoard()
// once from the editor. Add a menu item in Main.gs's onOpen if you want it on
// the menu; nothing else in the project needs to change.
//
// WHAT IT CANNOT SEE, and why the board says so in its own header:
//   · ScriptApp.getProjectTriggers() returns only the triggers owned by the
//     ACCOUNT RUNNING IT. The triggers a removed colleague left behind are
//     invisible here and undeletable by anyone left — the editor's Triggers
//     page is the only place they show up.
//   · A function nobody logs and no trigger fires (a menu item run by hand)
//     appears only if it writes to the log.

/** The tab this writes. Everything else here reads. */
var USAGE_BOARD_SHEET = "Script Usage";

/** The owner's two thresholds, in days (must match check-sheet-sync-usage.mjs). */
var USAGE_ISOLATE_AFTER = 30;
var USAGE_DELETE_DECISION_AFTER = 90;

/**
 * Rebuild the "Script Usage" tab: one row per logged execution type, one row
 * per trigger this account owns.
 */
function buildScriptUsageBoard() {
  var ss = getTargetSs();
  var now = new Date();
  var rows = [];

  rows.push(["LOGGED EXECUTIONS (from " + CONFIG.LOG_SHEET + ")", "", "", "", "", "", ""]);
  rows.push(["Type", "Runs 7d", "Runs 30d", "Runs all", "Failed 30d", "Last run", "Verdict"]);
  var logged = usageFromLog_(ss, now);
  for (var i = 0; i < logged.length; i++) {
    var t = logged[i];
    rows.push([
      t.type,
      t.runs7,
      t.runs30,
      t.runsAll,
      t.failed30,
      t.last ? Utilities.formatDate(t.last, "GMT+8", "yyyy-MM-dd HH:mm") : "never",
      usageVerdict_(t.idleDays),
    ]);
  }

  rows.push(["", "", "", "", "", "", ""]);
  rows.push(["TRIGGERS OWNED BY " + (Session.getEffectiveUser().getEmail() || "this account"), "", "", "", "", "", ""]);
  rows.push(["Handler", "Event", "Source", "Handler exists?", "", "", "Verdict"]);
  var triggers = ScriptApp.getProjectTriggers();
  for (var j = 0; j < triggers.length; j++) {
    var tr = triggers[j];
    var fn = tr.getHandlerFunction();
    var exists = usageHandlerExists_(fn);
    rows.push([
      fn,
      String(tr.getEventType()),
      String(tr.getTriggerSource()),
      exists ? "yes" : "NO - fires into 'function not found'",
      "",
      "",
      exists ? "" : "DELETE THIS TRIGGER",
    ]);
  }

  rows.push(["", "", "", "", "", "", ""]);
  rows.push([
    "Built " + Utilities.formatDate(now, "GMT+8", "yyyy-MM-dd HH:mm") +
      ". Triggers owned by a removed colleague are NOT listed here - the editor's Triggers page is the only place they appear. " +
      "A type missing from the top block is not necessarily unused: it may simply never have written to the log.",
    "", "", "", "", "", "",
  ]);

  var sheet = ss.getSheetByName(USAGE_BOARD_SHEET) || ss.insertSheet(USAGE_BOARD_SHEET);
  sheet.clear();
  sheet.getRange(1, 1, rows.length, 7).setValues(rows);
  sheet.getRange(1, 1, 1, 7).setFontWeight("bold").setBackground("#444444").setFontColor("white");
  sheet.getRange(2, 1, 1, 7).setFontWeight("bold");
  sheet.setFrozenRows(2);
  sheet.autoResizeColumns(1, 7);
  return rows.length;
}

/**
 * Per execution type: run counts in the 7- and 30-day windows, all-time, the
 * failures in the last 30 days, and when it last ran.
 *
 * Reads the log tab whole once. The log is newest-first (recordExecutionLog
 * inserts at row 2), but nothing here depends on that order.
 */
function usageFromLog_(ss, now) {
  var sheet = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  var byType = {};
  var day = 24 * 60 * 60 * 1000;

  for (var r = 1; r < values.length; r++) {
    var type = String(values[r][1] || "").trim();
    if (!type || type.charAt(0) === "{") continue; // a 2026-03 bug logged the event object as the type
    var start = usageParseDate_(values[r][3]);
    var result = String(values[r][5] || "").trim();
    var t = byType[type] || (byType[type] = { type: type, runs7: 0, runs30: 0, runsAll: 0, failed30: 0, last: null });
    t.runsAll++;
    if (start) {
      var ageDays = (now.getTime() - start.getTime()) / day;
      if (ageDays <= 7) t.runs7++;
      if (ageDays <= 30) {
        t.runs30++;
        if (result === "FAILED" || result === "PARTIAL") t.failed30++;
      }
      if (!t.last || start > t.last) t.last = start;
    }
  }

  var out = [];
  for (var k in byType) {
    var e = byType[k];
    e.idleDays = e.last ? Math.floor((now.getTime() - e.last.getTime()) / day) : null;
    out.push(e);
  }
  out.sort(function (a, b) { return b.runs30 - a.runs30 || b.runsAll - a.runsAll; });
  return out;
}

/** The log writes the start column as "yyyy-MM-dd HH:mm:ss" text, but older
 *  rows hold a real Date. Accept both; anything else is not a date. */
function usageParseDate_(v) {
  if (v instanceof Date) return v;
  var s = String(v || "").trim();
  if (!s) return null;
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Whether a trigger's handler still exists in the project. */
function usageHandlerExists_(name) {
  try {
    return typeof globalThis[name] === "function";
  } catch (e) {
    return false;
  }
}

function usageVerdict_(idleDays) {
  if (idleDays === null || idleDays === undefined) return "never ran";
  if (idleDays >= USAGE_DELETE_DECISION_AFTER) return "DELETE DECISION DUE (" + idleDays + "d idle)";
  if (idleDays >= USAGE_ISOLATE_AFTER) return "ISOLATE + BACK UP (" + idleDays + "d idle)";
  return "active";
}
