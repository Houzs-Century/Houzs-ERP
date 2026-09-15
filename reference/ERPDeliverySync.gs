// ERPDeliverySync.gs
//
// The HC Delivery sheet's sync with the ERP — replaces the AutoCount pull and
// push in GetAutoCountData.gs for the three regional tabs (Delivery Details,
// EM Order, SG Order). Owner ruling 2026-09-15: stop the AutoCount sync, feed
// the sheet from the ERP; col A (delivery message status) writes back to the
// ERP's remark4; col O (the dispatch date) writes back to customer_delivery_date;
// Transfer To carries the ERP's HC-DO numbers. Overdue / Balance Collection /
// Outstanding PO stay on their AutoCount pulls for now (phase 2).
//
// Reuses Helper.gs as it stands: getTargetSs, getSheetConfig,
// writeDataToTargetSheet, recordExecutionLog, Log. Column A is never written
// by the pull (the writer starts at col B, as it always did).
//
// SETUP (once, by the account that owns the triggers):
//   1. File > Project settings > Script properties:
//        ERP_BASE_URL   = https://<the ERP worker host>          (no trailing slash)
//        SHEET_SYNC_KEY = <the HC sheet's key, same value as the GitHub secret>
//   2. Run erpSeedFromSheet()   — pushes EVERY row's col A / col O into the ERP,
//      so the first ERP pull does not overwrite the sheet with older values.
//   3. Run setupErpTriggers()   — removes the AutoCount scheduledPull /
//      scheduledPush triggers and installs scheduledErpSync every 15 minutes.
//
// ENDPOINTS (backend/src/routes/deliverySheetSync.ts, X-Intake-Key = SHEET_SYNC_KEY):
//   GET  {ERP_BASE_URL}/api/delivery-sheet/so-since?since=<checkpoint>&limit=300
//   POST {ERP_BASE_URL}/api/delivery-sheet/updates   {updates:[{DocNo, Remark4, ExpiryDate}]}

const ERP_CHECKPOINT_PROP = "ERP_SYNC_CHECKPOINT";
const ERP_PAGE_LIMIT = 300;
// Apps Script kills a run at 6 minutes; ~300 rows write in about a minute.
// The checkpoint advances per page, so a run that stops early resumes.
const ERP_MAX_PAGES_PER_RUN = 4;
const ERP_PUSH_BATCH = 300;

function erpConfig_() {
  const props = PropertiesService.getScriptProperties();
  const base = (props.getProperty("ERP_BASE_URL") || "").replace(/\/+$/, "");
  const key = props.getProperty("SHEET_SYNC_KEY") || "";
  if (!base || !key) throw new Error("Script properties ERP_BASE_URL and SHEET_SYNC_KEY must be set.");
  return { base: base, key: key };
}

function erpFetch_(cfg, path, options, rid) {
  const url = cfg.base + path;
  const res = UrlFetchApp.fetch(url, Object.assign({
    headers: { "X-Intake-Key": cfg.key, "X-Request-ID": rid },
    muteHttpExceptions: true
  }, options || {}));
  Log.api(rid, path, (options && options.method) || "GET", res.getResponseCode());
  return res;
}

/** The old routing rule, kept for a record the ERP could not place. */
function erpRegionOf_(o) {
  if (o.Region === "WEST" || o.Region === "EAST" || o.Region === "SG") return o.Region;
  const addr = (o.InvAddr3 || "").toUpperCase();
  const loc = (o.SalesLocation || "").toUpperCase();
  if (addr.indexOf("SINGAPORE") >= 0) return "SG";
  if (loc === "KL" || loc === "PG" || loc === "HQ") return "WEST";
  if (loc === "SBH" || loc === "SRW") return "EAST";
  return null;
}

function erpSheetFor_(region) {
  if (region === "WEST") return CONFIG.WEST_SHEET;
  if (region === "EAST") return CONFIG.EAST_SHEET;
  if (region === "SG") return CONFIG.SG_SHEET;
  return null;
}

function erpDateText_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, getTargetSs().getSpreadsheetTimeZone(), "yyyy-MM-dd");
  return String(v == null ? "" : v).trim();
}

/**
 * The ERP only overwrites a cell when it KNOWS the value. For every field the
 * writer touches, a null from the ERP keeps what the sheet already holds — so
 * a migrated order with no ERP delivery order keeps its AutoCount DO number,
 * and a row whose ERP remark4 is empty keeps its Remark 4. Numbers (Total,
 * Balance) are always the ERP's.
 */
function erpPreserveBlanks_(sheet, cfg, records) {
  const lastRow = sheet.getLastRow();
  if (lastRow < cfg.startRow) return;
  const width = cfg.block2StartCol + 6;
  const values = sheet.getRange(cfg.startRow, 1, lastRow - cfg.startRow + 1, width).getValues();
  const byDoc = {};
  values.forEach(function (row) { if (row[1]) byDoc[String(row[1]).trim()] = row; });

  const block1 = ["TransferTo", "DocDate", "Ref", "SOUDF_BRANDING", "DebtorName", "Phone1", "SalesLocation",
    "SalesAgent", null, null, "Remark2", "SOUDF_PDate", "SalesExemptionExpiryDate", "Remark4"];
  const block2 = cfg.includeRemark3
    ? ["Remark3", "SOUDF_Note", "SOUDF_ToPONo", "InvAddr1", "InvAddr2", "InvAddr3", "InvAddr4"]
    : ["SOUDF_Note", "SOUDF_ToPONo", "InvAddr1", "InvAddr2", "InvAddr3", "InvAddr4"];

  records.forEach(function (o) {
    const row = byDoc[String(o.DocNo)];
    if (!row) return;
    block1.forEach(function (field, i) {
      if (!field) return;
      const existing = row[2 + i];
      if ((o[field] == null || o[field] === "") && existing !== "" && existing != null) {
        o[field] = erpDateText_(existing);
      }
    });
    block2.forEach(function (field, i) {
      const existing = row[cfg.block2StartCol - 1 + i];
      if ((o[field] == null || o[field] === "") && existing !== "" && existing != null) {
        o[field] = String(existing);
      }
    });
  });
}

/**
 * Pull orders changed since the checkpoint, page by page, and write them to
 * the regional tabs. The checkpoint advances after each fully-written page.
 */
function runErpPullProcess(triggerType) {
  const rid = Utilities.getUuid();
  const startTime = new Date();
  const props = PropertiesService.getScriptProperties();
  const ss = getTargetSs();
  const userEmail = Session.getActiveUser().getEmail();
  let status = "PENDING";
  let message = "";
  let pulled = 0;
  let failed = 0;

  try {
    const cfg = erpConfig_();
    for (let page = 0; page < ERP_MAX_PAGES_PER_RUN; page++) {
      const since = props.getProperty(ERP_CHECKPOINT_PROP) || "";
      Log.info(rid, "ERP pull page " + (page + 1) + " since [" + since + "]");
      const res = erpFetch_(cfg, "/api/delivery-sheet/so-since?since=" + encodeURIComponent(since) + "&limit=" + ERP_PAGE_LIMIT, null, rid);
      if (res.getResponseCode() !== 200) throw new Error("ERP returned " + res.getResponseCode() + ": " + res.getContentText().slice(0, 200));
      const data = JSON.parse(res.getContentText());
      const records = data.records || [];
      if (records.length === 0) break;

      const buckets = { WEST: [], EAST: [], SG: [] };
      let dropped = 0;
      records.forEach(function (o) {
        o.Attention = "SEAMPIFY";
        const region = erpRegionOf_(o);
        if (region) buckets[region].push(o); else dropped++;
      });
      if (dropped) Log.warn(rid, dropped + " record(s) had no region and were not written.");

      let pageFail = 0;
      ["WEST", "EAST", "SG"].forEach(function (region) {
        if (!buckets[region].length) return;
        const sheetName = erpSheetFor_(region);
        const sheet = ss.getSheetByName(sheetName);
        if (sheet) erpPreserveBlanks_(sheet, getSheetConfig(sheetName), buckets[region]);
        const r = writeDataToTargetSheet(ss, sheetName, buckets[region], rid);
        pulled += r.success;
        pageFail += r.fail;
      });
      failed += pageFail;

      if (pageFail === 0 && data.next_since) {
        props.setProperty(ERP_CHECKPOINT_PROP, data.next_since);
        Log.info(rid, "Checkpoint advanced to " + data.next_since);
      } else if (pageFail > 0) {
        Log.warn(rid, pageFail + " record(s) failed on this page. Checkpoint NOT advanced; stopping.");
        break;
      }
      if (!data.has_more) break;
    }
    if (pulled === 0 && failed === 0) { status = "SKIPPED"; message = "No modifications since the checkpoint."; }
    else { status = failed > 0 ? "PARTIAL" : "SYNCED"; message = "Pulled " + pulled + " record(s) from the ERP. Failed " + failed + "."; }
  } catch (e) {
    status = "FAILED";
    message = e.message;
    Log.error(rid, "ERP pull failed", e);
  } finally {
    Log.info(rid, "ERP pull finished: " + status + " - " + message);
    recordExecutionLog(ss, rid, triggerType === "MANUAL" ? "ERP_PULL_MANUAL" : "ERP_PULL", startTime, new Date(), status, message, userEmail);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("ERP pull " + status + "\n" + message);
  }
}

/** The rows to push from one regional tab: every PENDING row, or every row with a Doc. No. when `all` is true. */
function erpCollectUpdates_(sheet, sConfig, all) {
  const data = sheet.getDataRange().getValues();
  const out = [];
  for (let i = sConfig.start - 1; i < data.length; i++) {
    const row = data[i];
    const docNo = String(row[1] || "").trim();
    if (!docNo) continue;
    if (!all && row[sConfig.statusCol - 1] !== "PENDING") continue;
    out.push({ rowIndex: i + 1, DocNo: docNo, Remark4: String(row[0] == null ? "" : row[0]), ExpiryDate: erpDateText_(row[14]) });
  }
  return out;
}

function erpPushRows_(cfg, sheet, sConfig, updates, rid, markStatus) {
  let ok = 0;
  let err = 0;
  for (let i = 0; i < updates.length; i += ERP_PUSH_BATCH) {
    const batch = updates.slice(i, i + ERP_PUSH_BATCH);
    let results = null;
    try {
      const res = erpFetch_(cfg, "/api/delivery-sheet/updates", {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({ updates: batch.map(function (u) { return { DocNo: u.DocNo, Remark4: u.Remark4, ExpiryDate: u.ExpiryDate }; }) })
      }, rid);
      if (res.getResponseCode() === 200) results = JSON.parse(res.getContentText()).results || [];
      else Log.error(rid, "Push batch failed: HTTP " + res.getResponseCode() + " " + res.getContentText().slice(0, 200));
    } catch (e) {
      Log.error(rid, "Push batch connection error", e);
    }
    batch.forEach(function (u, j) {
      const r = results ? results[j] : null;
      const good = r && r.ok === true;
      if (good) ok++; else err++;
      if (!markStatus) return;
      if (good) sheet.getRange(u.rowIndex, sConfig.statusCol).setValue("SYNCED").setBackground("#d9ead3");
      else if (r && r.skipped === "no_order") sheet.getRange(u.rowIndex, sConfig.statusCol).setValue("ERR: NO ORDER").setBackground("#f4cccc");
      else sheet.getRange(u.rowIndex, sConfig.statusCol).setValue(results ? "ERR: " + ((r && (r.skipped || r.error)) || "?") : "ERR: CONN").setBackground("#f4cccc");
    });
  }
  return { ok: ok, err: err };
}

function erpRegionalSheets_() {
  return [
    { name: CONFIG.WEST_SHEET, statusCol: 46, start: 4 },
    { name: CONFIG.EAST_SHEET, statusCol: 43, start: 4 },
    { name: CONFIG.SG_SHEET,   statusCol: 46, start: 4 }
  ];
}

/** Push PENDING rows (col A → remark4, col O → delivery date) to the ERP. */
function pushUpdatesToErp(triggerType) {
  const rid = Utilities.getUuid();
  const start = new Date();
  const ss = getTargetSs();
  const user = Session.getActiveUser().getEmail();
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) {
    Log.warn(rid, "Could not acquire lock. Another push may be in progress.");
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("Another push is currently running. Please try again in a moment.");
    return;
  }
  let pushCount = 0;
  let errorCount = 0;
  try {
    const cfg = erpConfig_();
    erpRegionalSheets_().forEach(function (sConfig) {
      const sheet = ss.getSheetByName(sConfig.name);
      if (!sheet) { Log.warn(rid, "Sheet [" + sConfig.name + "] not found. Skipping."); return; }
      const updates = erpCollectUpdates_(sheet, sConfig, false);
      if (!updates.length) return;
      const r = erpPushRows_(cfg, sheet, sConfig, updates, rid, true);
      pushCount += r.ok;
      errorCount += r.err;
    });
    let status = "SYNCED";
    let message = "Pushed " + pushCount + " row(s) to the ERP.";
    if (errorCount > 0 && pushCount > 0) { status = "PARTIAL"; message = "Pushed " + pushCount + " row(s). " + errorCount + " failed."; }
    else if (errorCount > 0) { status = "FAILED"; message = "All " + errorCount + " push attempts failed."; }
    else if (pushCount === 0) { status = "SKIPPED"; message = "No PENDING rows."; }
    Log.info(rid, "ERP push finished: " + status + " - " + message);
    recordExecutionLog(ss, rid, "ERP_PUSH", start, new Date(), status, message, user);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("ERP push: " + status + "\n\n" + message);
  } catch (e) {
    Log.error(rid, "ERP push failed", e);
    recordExecutionLog(ss, rid, "ERP_PUSH", start, new Date(), "FAILED", e.message, user);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("ERP push FAILED\n" + e.message);
  } finally {
    lock.releaseLock();
  }
}

/**
 * ONE-TIME cutover step. Pushes EVERY row's col A and col O into the ERP —
 * the sheet is the source of truth for those two columns today, and the ERP's
 * copies (remark4 from the go-live import, customer_delivery_date) are older.
 * Run this BEFORE setupErpTriggers, or the first ERP pull writes the ERP's
 * older values over the sheet's. Safe to re-run. Does not touch Sync Status.
 */
function erpSeedFromSheet() {
  const rid = Utilities.getUuid();
  const start = new Date();
  const ss = getTargetSs();
  const cfg = erpConfig_();
  let ok = 0;
  let err = 0;
  erpRegionalSheets_().forEach(function (sConfig) {
    const sheet = ss.getSheetByName(sConfig.name);
    if (!sheet) return;
    const updates = erpCollectUpdates_(sheet, sConfig, true)
      .filter(function (u) { return u.Remark4 !== "" || u.ExpiryDate !== ""; });
    Log.info(rid, "[" + sConfig.name + "] seeding " + updates.length + " row(s)");
    const r = erpPushRows_(cfg, sheet, sConfig, updates, rid, false);
    ok += r.ok;
    err += r.err;
  });
  const message = "Seeded " + ok + " row(s) into the ERP; " + err + " not matched or failed (rows without an ERP order are expected: service/pickup/fair rows).";
  recordExecutionLog(ss, rid, "ERP_SEED", start, new Date(), err && !ok ? "FAILED" : "SYNCED", message, Session.getActiveUser().getEmail());
  Log.info(rid, message);
  try { SpreadsheetApp.getUi().alert(message); } catch (e) {}
}

/** Push first so a pending edit is never overwritten by the pull that follows. */
function scheduledErpSync() {
  pushUpdatesToErp("SCHEDULED");
  runErpPullProcess("SCHEDULED");
}
function manualErpPull() { runErpPullProcess("MANUAL"); }
function manualErpPush() { pushUpdatesToErp("MANUAL"); }

/** Clears the ERP checkpoint so the next pull re-reads every order. */
function resetErpCheckpoint() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert("Reset the ERP checkpoint? The next pull re-reads every order.", ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  PropertiesService.getScriptProperties().deleteProperty(ERP_CHECKPOINT_PROP);
  ui.alert("ERP checkpoint cleared.");
}

/**
 * Stops the AutoCount pull/push for the regional tabs and installs the ERP
 * sync. Overdue, Balance Collection and PO triggers are left as they are.
 */
function setupErpTriggers() {
  const stop = ["scheduledPull", "scheduledPush", "scheduledErpSync"];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (stop.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("scheduledErpSync").timeBased().everyMinutes(15).create();
  Log.info("setup", "AutoCount pull/push triggers removed; scheduledErpSync installed every 15 minutes.");
  try { SpreadsheetApp.getUi().alert("ERP sync installed (every 15 min). AutoCount pull/push triggers removed."); } catch (e) {}
}
