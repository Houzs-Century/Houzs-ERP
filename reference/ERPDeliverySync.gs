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
//   1. Nothing to configure while ERPMain.gs keeps ASSR_SYNC_KEY and the ERP is
//      at https://erp.houzscentury.com (the defaults below). Otherwise set Script
//      properties ERP_BASE_URL (no trailing slash) and SHEET_SYNC_KEY.
//   2. Run erpSeedFromSheet()   — pushes EVERY row's col A / col O into the ERP,
//      so the first ERP pull does not overwrite the sheet with older values.
//   3. Run setupErpTriggers()   — removes the AutoCount scheduledPull /
//      scheduledPush triggers and installs scheduledErpSync every 15 minutes.
//
// ENDPOINTS (backend/src/routes/deliverySheetSync.ts, X-Intake-Key = SHEET_SYNC_KEY):
//   GET  {ERP_BASE_URL}/api/delivery-sheet/so-since?since=<checkpoint>&limit=300
//   POST {ERP_BASE_URL}/api/delivery-sheet/updates   {updates:[{DocNo, Remark4, ExpiryDate}]}
//   GET  {ERP_BASE_URL}/api/delivery-sheet/assr-legs?since=<checkpoint>&limit=300
//        Service-Case legs the ERP marked OWN-TEAM (inspection / pickup /
//        delivery-back). Appended to the SAME regional tabs, DocNo =
//        "<S/O>-<SERVICE|PICKUP|INSPECTION>" (keyed like a Farra leg so the
//        sheet's date write-back finds it). Own-team gated by the ERP; the leg
//        rows are never pushed back (erpCollectUpdates_ skips '#' and the
//        "-<KIND>" leg key).

const ERP_CHECKPOINT_PROP = "ERP_SYNC_CHECKPOINT";
// Service-Case legs ride their own cursor so a stuck ASSR page never holds up
// the Sales-Order pull and vice-versa.
const ERP_ASSR_CHECKPOINT_PROP = "ERP_ASSR_CHECKPOINT";
const ERP_PAGE_LIMIT = 300;
// Apps Script kills a run at 6 minutes; ~300 rows write in about a minute.
// The checkpoint advances per page, so a run that stops early resumes.
const ERP_MAX_PAGES_PER_RUN = 4;
const ERP_PUSH_BATCH = 300;

// The live project already holds the ERP origin and the HC sheet key for the
// ASSR sync (ERPMain.gs: ASSR_SYNC_URL / ASSR_SYNC_KEY), so those are the
// defaults; a Script Property of the same purpose overrides either.
const ERP_DEFAULT_BASE_URL = "https://erp.houzscentury.com";

function erpConfig_() {
  const props = PropertiesService.getScriptProperties();
  const base = (props.getProperty("ERP_BASE_URL") || ERP_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const key = props.getProperty("SHEET_SYNC_KEY") || (typeof ASSR_SYNC_KEY !== "undefined" ? ASSR_SYNC_KEY : "");
  if (!base || !key) throw new Error("Set Script property SHEET_SYNC_KEY (or keep ASSR_SYNC_KEY in ERPMain.gs).");
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

// Rows the pull may APPEND: only orders dated on/after ERP_APPEND_FROM (Script
// property, default = the cutover day). AutoCount's getSince only ever added an
// order to the sheet when that order was modified, so years-old open orders
// never reached it; sending every ERP order on the first pull appended ~2,400
// of them (2026-09-16 15:11). Existing rows are always updated.
function erpAppendFrom_() {
  return PropertiesService.getScriptProperties().getProperty("ERP_APPEND_FROM") || "2026-09-15";
}
function erpIsNewOrder_(o) {
  return !!o.DocDate && String(o.DocDate).slice(0, 10) >= erpAppendFrom_();
}
// Owner 2026-09-17: an order may ENTER the sheet only when Remarks 2 says READY
// or READY (PARTIAL). The ERP decides (record.Ready); the text test is only for
// a backend that does not send the flag yet. Rows already on the sheet are
// always updated, whatever their Remarks 2.
function erpIsReady_(o) {
  if (o.Ready === true || o.Ready === false) return o.Ready;
  return /^READY\b/i.test(String(o.Remark2 || "").trim());
}

/**
 * The sweep behind the READY gate. An order that was not ready when it last
 * changed is not appended by the pull, and stock arriving later flips its
 * LINES, not the order, so the since-feed never re-sends it. ready-open lists
 * every undelivered READY order dated on/after ERP_APPEND_FROM; the ones not on
 * their tab yet are appended here. Existing rows are left to the pull.
 */
function erpAppendReadyOpen_(ss, cfg, rid) {
  const out = { appended: 0, failed: 0 };
  const res = erpFetch_(cfg, "/api/delivery-sheet/ready-open?from=" + encodeURIComponent(erpAppendFrom_()), null, rid);
  if (res.getResponseCode() !== 200) {
    Log.warn(rid, "ready-open returned " + res.getResponseCode() + "; READY sweep skipped this run.");
    return out;
  }
  const records = JSON.parse(res.getContentText()).records || [];
  const buckets = { WEST: [], EAST: [], SG: [] };
  records.forEach(function (o) {
    o.Attention = "SEAMPIFY";
    const region = erpRegionOf_(o);
    if (region) buckets[region].push(o);
  });
  ["WEST", "EAST", "SG"].forEach(function (region) {
    if (!buckets[region].length) return;
    const sheetName = erpSheetFor_(region);
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    const existing = erpExistingDocNos_(sheet, getSheetConfig(sheetName));
    const fresh = buckets[region].filter(function (o) { return !existing[String(o.DocNo).trim()]; });
    if (!fresh.length) return;
    const r = writeDataToTargetSheet(ss, sheetName, fresh, rid);
    out.appended += r.success;
    out.failed += r.fail;
  });
  if (out.appended || out.failed) Log.info(rid, "READY sweep: appended " + out.appended + ", failed " + out.failed + ".");
  return out;
}
function erpExistingDocNos_(sheet, cfg) {
  const map = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < cfg.startRow) return map;
  sheet.getRange(cfg.startRow, 2, lastRow - cfg.startRow + 1, 1).getValues().forEach(function (r) {
    if (r[0]) map[String(r[0]).trim()] = true;
  });
  return map;
}

// Manual restore (owner 2026-09-21): put specific orders back on their tab, even
// ones that are NOT ready (the ready-open sweep only re-adds READY orders dated
// on/after ERP_APPEND_FROM, so an older or not-yet-ready order cannot return on
// its own). Fetches full sheet records for the given DocNos and appends the ones
// not already on the tab, reusing the same region routing + writer as the pull.
function erpRestoreByDocNos_(docNos) {
  var rid = Utilities.getUuid();
  var cfg = erpConfig_();
  var ss = getTargetSs();
  var out = { appended: 0, failed: 0, skipped: 0, notFound: 0 };
  var res = erpFetch_(cfg, "/api/delivery-sheet/feed-by-docnos", { method: "post", contentType: "application/json", payload: JSON.stringify({ doc_nos: docNos }) }, rid);
  if (res.getResponseCode() !== 200) throw new Error("feed-by-docnos " + res.getResponseCode() + ": " + res.getContentText().slice(0, 200));
  var records = JSON.parse(res.getContentText()).records || [];
  out.notFound = docNos.length - records.length;
  var buckets = { WEST: [], EAST: [], SG: [] };
  records.forEach(function (o) {
    o.Attention = "SEAMPIFY";
    var region = erpRegionOf_(o);
    if (region) buckets[region].push(o);
  });
  ["WEST", "EAST", "SG"].forEach(function (region) {
    if (!buckets[region].length) return;
    var sheetName = erpSheetFor_(region);
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    var existing = erpExistingDocNos_(sheet, getSheetConfig(sheetName));
    var fresh = buckets[region].filter(function (o) { return !existing[String(o.DocNo).trim()]; });
    out.skipped += buckets[region].length - fresh.length;
    if (!fresh.length) return;
    var r = writeDataToTargetSheet(ss, sheetName, fresh, rid);
    out.appended += r.success;
    out.failed += r.fail;
  });
  var msg = "restore: appended " + out.appended + ", skipped(already on tab) " + out.skipped + ", not-in-ERP " + out.notFound + ", failed " + out.failed;
  Logger.log(msg);
  return msg;
}
// One-off: the orders removed by the 2026-09-20 reconcile that the owner wants
// back (4 now READY + HC12896 / HC12874 he tracks despite a pending mattress).
function erpRestoreDeletedOrders() {
  return erpRestoreByDocNos_(["SO-007223", "SO-007718", "SO-012654", "SO-012596", "SO-013020", "SO-012319"]);
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
  let skipped = 0;
  let notReady = 0;

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
        let recs = buckets[region];
        if (sheet) {
          const cfg = getSheetConfig(sheetName);
          const existing = erpExistingDocNos_(sheet, cfg);
          recs = recs.filter(function (o) {
            if (existing[String(o.DocNo).trim()]) return true;
            if (!erpIsNewOrder_(o)) { skipped++; return false; }
            if (!erpIsReady_(o)) { notReady++; return false; }
            return true;
          });
          erpPreserveBlanks_(sheet, cfg, recs);
        }
        if (!recs.length) return;
        const r = writeDataToTargetSheet(ss, sheetName, recs, rid);
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
    const sweep = erpAppendReadyOpen_(ss, cfg, rid);
    pulled += sweep.appended;
    failed += sweep.failed;
    if (pulled === 0 && failed === 0) { status = "SKIPPED"; message = "No modifications since the checkpoint." + (notReady ? " " + notReady + " new order(s) not READY yet." : ""); }
    else { status = failed > 0 ? "PARTIAL" : "SYNCED"; message = "Pulled " + pulled + " record(s) from the ERP (" + sweep.appended + " newly READY). Failed " + failed + ". Skipped " + skipped + " old order(s) not on the sheet, " + notReady + " new order(s) not READY yet."; }
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
    // ASSR leg rows carry "<ASSR-NO>#<KIND>" (legacy) or, since the ERP pull,
    // "<S/O>-<SERVICE|PICKUP|INSPECTION>" (keyed like a Farra leg) and have no SO
    // to update — never push them back (they only come back as skipped 'no_order').
    if (docNo.indexOf("#") >= 0 || /-(?:PICKUP|SERVICE|INSPECTION)$/.test(docNo)) continue;
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
/**
 * Pull the Service-Case (ASSR) legs the ERP marked OWN-TEAM and write them to
 * the regional tabs beside the Sales-Order rows. Each open case emits up to
 * three legs (inspection / pickup / delivery-back), keyed
 * DocNo = "<ASSR-NO>#<KIND>", so they never collide with an SO number and a
 * re-pull updates the same row. There is NO readiness / append-from gate: the
 * own-team mark IS the entry condition, applied by the ERP feed, so every
 * returned record is written. Own cursor, own execution-log line.
 */
function runErpAssrPull(triggerType) {
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
      const since = props.getProperty(ERP_ASSR_CHECKPOINT_PROP) || "";
      Log.info(rid, "ERP ASSR pull page " + (page + 1) + " since [" + since + "]");
      const res = erpFetch_(cfg, "/api/delivery-sheet/assr-legs?since=" + encodeURIComponent(since) + "&limit=" + ERP_PAGE_LIMIT, null, rid);
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
      if (dropped) Log.warn(rid, dropped + " ASSR leg(s) had no region and were not written.");

      let pageFail = 0;
      ["WEST", "EAST", "SG"].forEach(function (region) {
        if (!buckets[region].length) return;
        const sheetName = erpSheetFor_(region);
        const sheet = ss.getSheetByName(sheetName);
        if (!sheet) return;
        // writeDataToTargetSheet finds each DocNo (col B) or appends it, so an
        // existing leg row is updated in place and a new one is appended.
        const r = writeDataToTargetSheet(ss, sheetName, buckets[region], rid);
        pulled += r.success;
        pageFail += r.fail;
      });
      failed += pageFail;

      // next_since / has_more count CASES, not legs (see the /assr-legs route),
      // so the checkpoint advances one case-page at a time exactly like the SO pull.
      if (pageFail === 0 && data.next_since) {
        props.setProperty(ERP_ASSR_CHECKPOINT_PROP, data.next_since);
        Log.info(rid, "ASSR checkpoint advanced to " + data.next_since);
      } else if (pageFail > 0) {
        Log.warn(rid, pageFail + " ASSR leg(s) failed on this page. Checkpoint NOT advanced; stopping.");
        break;
      }
      if (!data.has_more) break;
    }
    if (pulled === 0 && failed === 0) { status = "SKIPPED"; message = "No ASSR legs changed since the checkpoint."; }
    else { status = failed > 0 ? "PARTIAL" : "SYNCED"; message = "Pulled " + pulled + " ASSR leg(s) from the ERP. Failed " + failed + "."; }
  } catch (e) {
    status = "FAILED";
    message = e.message;
    Log.error(rid, "ERP ASSR pull failed", e);
  } finally {
    Log.info(rid, "ERP ASSR pull finished: " + status + " - " + message);
    recordExecutionLog(ss, rid, triggerType === "MANUAL" ? "ERP_ASSR_PULL_MANUAL" : "ERP_ASSR_PULL", startTime, new Date(), status, message, userEmail);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert("ERP ASSR pull " + status + "\n" + message);
  }
}

function scheduledErpSync() {
  pushUpdatesToErp("SCHEDULED");
  runErpPullProcess("SCHEDULED");
  runErpAssrPull("SCHEDULED");
}
function manualErpPull() { runErpPullProcess("MANUAL"); }
function manualErpPush() { pushUpdatesToErp("MANUAL"); }
function manualErpAssrPull() { runErpAssrPull("MANUAL"); }

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

// ── One-off cleanup of the rows the FIRST pull appended (2026-09-16 15:04) ──
// erpSeedFromSheet at 14:54 counted the rows with a Doc. No. on each tab; every
// row the 15:04 pull appended sits BELOW those, so the appended block on a tab
// is 'the rows with a Doc. No. after the first N'. erpListAppendedRows() only
// logs the ranges; erpDeleteAppendedRows() deletes them after checking that
// every row in the block looks pull-written (col A empty, Sync Status SYNCED).
const ERP_ROWS_BEFORE_FIRST_PULL = { 'Delivery Details': 4238, 'EM Order': 243, 'SG Order': 134 };
function erpAppendedRowRanges_() {
  const ss = getTargetSs();
  const out = [];
  erpRegionalSheets_().forEach(function (sConfig) {
    const sheet = ss.getSheetByName(sConfig.name);
    const keep = ERP_ROWS_BEFORE_FIRST_PULL[sConfig.name];
    if (!sheet || keep == null) return;
    const data = sheet.getDataRange().getValues();
    let seen = 0, firstRow = null;
    for (let i = sConfig.start - 1; i < data.length; i++) {
      if (!String(data[i][1] || '').trim()) continue;
      seen++;
      if (seen === keep + 1) { firstRow = i + 1; break; }
    }
    if (!firstRow) { out.push({ name: sConfig.name, firstRow: null, lastRow: sheet.getLastRow(), count: 0, ok: true, why: 'nothing appended' }); return; }
    const lastRow = sheet.getLastRow();
    let bad = [];
    for (let r = firstRow; r <= lastRow; r++) {
      const row = data[r - 1];
      const a = String(row[0] || '').trim(), doc = String(row[1] || '').trim(), st = String(row[sConfig.statusCol - 1] || '').trim();
      if (a !== '' || doc === '' || st !== 'SYNCED') bad.push('R' + r + ' A=' + a + ' B=' + doc + ' status=' + st);
    }
    out.push({ name: sConfig.name, firstRow: firstRow, lastRow: lastRow, count: lastRow - firstRow + 1, firstDoc: String(data[firstRow - 1][1]), lastDoc: String(data[lastRow - 1][1]), ok: bad.length === 0, why: bad.slice(0, 5).join(' | ') });
  });
  return out;
}
function erpListAppendedRows() {
  erpAppendedRowRanges_().forEach(function (r) { Log.info('cleanup', JSON.stringify(r)); });
}
function erpDeleteAppendedRows() {
  const ss = getTargetSs();
  erpAppendedRowRanges_().forEach(function (r) {
    if (!r.firstRow) { Log.info('cleanup', '[' + r.name + '] nothing to delete'); return; }
    if (!r.ok) { Log.warn('cleanup', '[' + r.name + '] NOT deleted, block is not uniformly pull-written: ' + r.why); return; }
    ss.getSheetByName(r.name).deleteRows(r.firstRow, r.count);
    Log.info('cleanup', '[' + r.name + '] deleted rows ' + r.firstRow + '-' + r.lastRow + ' (' + r.count + ' rows, ' + r.firstDoc + ' .. ' + r.lastDoc + ')');
  });
}

// ── Reconcile: keep only READY / READY (PARTIAL) on the delivery tabs (owner 2026-09-20) ──
// Applied once 2026-09-20 (delete 22, refresh 46). Chunked /prune-check (BATCH=400) so it
// handles the >2000-row Delivery Details tab; deletes ONLY undelivered main-not-ready rows
// (Deletable = ERP owns it AND not ready AND not delivered/invoiced/closed); delivered,
// historical and non-ERP (found:false) rows are left untouched; refreshes a READY row's
// Remarks 2 only when the live value differs. Run erpReconcileDryRun() before erpReconcileApply().
function erpReconcile_(dryRun) {
  var rid = Utilities.getUuid();
  var cfg = erpConfig_();
  var ss = getTargetSs();
  var START = 4, DOCNO_COL = 2, REMARK2_COL = 13, BATCH = 400;
  var isStockSo = function (d) {
    d = String(d || "").trim().toUpperCase();
    var s = d.indexOf("HC-SO-") === 0 ? d.slice(6) : (d.indexOf("SO-") === 0 ? d.slice(3) : null);
    return s !== null && s.length > 0 && /^[0-9-]+$/.test(s);
  };
  var out = [];
  [CONFIG.WEST_SHEET, CONFIG.EAST_SHEET, CONFIG.SG_SHEET].forEach(function (tabName) {
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) { out.push(tabName + ": (tab not found)"); return; }
    var lastRow = sheet.getLastRow();
    if (lastRow < START) { out.push(tabName + ": (empty)"); return; }
    var n = lastRow - START + 1;
    var data = sheet.getRange(START, DOCNO_COL, n, 12).getValues(); // cols B..M
    var rows = [];
    for (var i = 0; i < n; i++) {
      var d = String(data[i][0] || "").trim();
      if (isStockSo(d)) rows.push({ row: START + i, doc: d, cur: String(data[i][11] == null ? "" : data[i][11]) });
    }
    if (!rows.length) { out.push(tabName + ": no stock rows"); return; }
    var byDoc = {};
    for (var b = 0; b < rows.length; b += BATCH) {
      var chunk = rows.slice(b, b + BATCH).map(function (r) { return r.doc; });
      var res = erpFetch_(cfg, "/api/delivery-sheet/prune-check", { method: "post", contentType: "application/json", payload: JSON.stringify({ doc_nos: chunk }) }, rid);
      if (res.getResponseCode() !== 200) throw new Error(tabName + " prune-check " + res.getResponseCode() + ": " + res.getContentText().slice(0, 200));
      (JSON.parse(res.getContentText()).results || []).forEach(function (r) { byDoc[r.DocNo] = r; });
    }
    var toDelete = [], toRefresh = [];
    rows.forEach(function (r) {
      var st = byDoc[r.doc];
      if (!st || !st.found) return;                 // ERP does not own it -> leave
      if (st.Deletable) { toDelete.push({ row: r.row, doc: r.doc }); }
      else if (st.Ready) { var want = st.Remark2 == null ? "" : String(st.Remark2); if (want !== r.cur) toRefresh.push({ row: r.row, remark2: want }); }
    });
    if (!dryRun) {
      toRefresh.forEach(function (x) { sheet.getRange(x.row, REMARK2_COL).setValue(x.remark2); });
      toDelete.slice().sort(function (a, b) { return b.row - a.row; }).forEach(function (x) { sheet.deleteRow(x.row); });
    }
    out.push(tabName + ": delete " + toDelete.length + ", refresh " + toRefresh.length + (dryRun ? " (DRY-RUN, unchanged)" : " (APPLIED)"));
    if (toDelete.length) out.push("   delete -> " + toDelete.map(function (x) { return x.doc; }).slice(0, 60).join(", "));
  });
  var text = out.join(String.fromCharCode(10));
  Logger.log(text);
  return text;
}
function erpReconcileDryRun() { return erpReconcile_(true); }
function erpReconcileApply() { return erpReconcile_(false); }
