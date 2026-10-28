// GetAutoCountData.gs

/**
 * Pulls modified Sales Orders from AutoCount since the last sync checkpoint
 * and distributes them to the appropriate regional sheet (West, East, SG)
 * based on Sales Location and Invoice Address.
 *
 * On full success the checkpoint advances to the latest record's LastModified.
 * On partial failure the checkpoint is NOT advanced so failed records are retried.
 *
 * @param {string} triggerType - "MANUAL" (shows UI alert) or "SCHEDULED".
 */
function runPullProcess(triggerType) {
  const rid = Utilities.getUuid();
  const startTime = new Date();
  const props = PropertiesService.getScriptProperties();
  const ss = getTargetSs();
  const userEmail = Session.getActiveUser().getEmail();

  const lastSync = props.getProperty(CONFIG.CHECKPOINT_PROP) || "2000-01-01 00:00:00";
  let status = "PENDING";
  let message = "";

  Log.info(rid, `Pull started. Checkpoint: ${lastSync}`);

  try {
    const url = `${CONFIG.NGROK_URL}/SalesOrder/getSince/${encodeURIComponent(lastSync)}`;
    const response = UrlFetchApp.fetch(url, {
      "headers": { "X-API-KEY": CONFIG.API_KEY, "X-Request-ID": rid, "ngrok-skip-browser-warning": "true" },
      "muteHttpExceptions": true
    });

    Log.api(rid, url, "GET", response.getResponseCode());
    if (response.getResponseCode() !== 200) throw new Error(`API returned ${response.getResponseCode()}`);

    const data = JSON.parse(response.getContentText());
    Log.info(rid, `API returned ${data.length} record(s).`);

    if (data.length === 0) {
      status = "SKIPPED";
      message = "No modifications found since last checkpoint.";
    } else {
      const west = [];
      const east = [];
      const sg = [];

      data.forEach(o => {
        o.Attention = "SEAMPIFY";
        const addr = (o.InvAddr3 || "").toUpperCase();
        const loc = (o.SalesLocation || "").toUpperCase();

        if (addr.includes("SINGAPORE")) sg.push(o);
        else if (["KL", "PG"].includes(loc)) west.push(o);
        else if (["SBH", "SRW"].includes(loc)) east.push(o);
      });

      Log.info(rid, `Routing: West=${west.length}, East=${east.length}, SG=${sg.length}`);

      const results = [];
      if (west.length > 0) results.push(writeDataToTargetSheet(ss, CONFIG.WEST_SHEET, west, rid));
      if (east.length > 0) results.push(writeDataToTargetSheet(ss, CONFIG.EAST_SHEET, east, rid));
      if (sg.length > 0)   results.push(writeDataToTargetSheet(ss, CONFIG.SG_SHEET, sg, rid));

      const totalSuccess = results.reduce((s, r) => s + r.success, 0);
      const totalFail = results.reduce((s, r) => s + r.fail, 0);

      if (totalFail === 0) {
        const newCheckpoint = data[data.length - 1].LastModified;
        props.setProperty(CONFIG.CHECKPOINT_PROP, newCheckpoint);
        Log.info(rid, `Checkpoint advanced to ${newCheckpoint}.`);
      } else {
        Log.warn(rid, `${totalFail} record(s) failed. Checkpoint NOT advanced.`);
      }

      status = totalFail > 0 ? "PARTIAL" : "SYNCED";
      message = `Pulled ${totalSuccess} records. Skipped ${totalFail} (Validation).`;
    }
  } catch (e) {
    status = "FAILED";
    message = e.message;
    Log.error(rid, "Pull process failed", e);
  } finally {
    Log.info(rid, `Pull finished: ${status} — ${message}`);
    recordExecutionLog(ss, rid, triggerType, startTime, new Date(), status, message, userEmail);
    if (triggerType === "MANUAL") SpreadsheetApp.getUi().alert(`Pull ${status}\n${message}`);
  }
}

/**
 * Scans all three regional sheets for rows marked "PENDING" and pushes
 * their Remark 4, Attention, and Expiry Date back to AutoCount.
 *
 * Protected by {@link LockService} to prevent duplicate pushes from
 * concurrent manual + scheduled runs.
 *
 * @param {string} triggerType - "MANUAL" (shows UI alert) or "SCHEDULED".
 */
function pushUpdatesToAutoCount(triggerType) {
  const rid = Utilities.getUuid();
  const start = new Date();
  const ss = getTargetSs();
  const user = Session.getActiveUser().getEmail();
  const timezone = ss.getSpreadsheetTimeZone();

  let pushCount = 0;
  let errorCount = 0;

  Log.info(rid, "Push started. Acquiring lock...");

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    Log.warn(rid, "Could not acquire lock. Another push may be in progress.");
    if (triggerType === "MANUAL") {
      SpreadsheetApp.getUi().alert("Another push is currently running. Please try again in a moment.");
    }
    return;
  }

  try {
    const sheets = [
      { name: CONFIG.WEST_SHEET, statusCol: 46, attentionCol: 45, start: 4 },
      { name: CONFIG.EAST_SHEET, statusCol: 43, attentionCol: 42, start: 4 },
      { name: CONFIG.SG_SHEET,   statusCol: 46, attentionCol: 45, start: 4 }
    ];

    sheets.forEach(sConfig => {
      const sheet = ss.getSheetByName(sConfig.name);
      if (!sheet) {
        Log.warn(rid, `Sheet [${sConfig.name}] not found. Skipping.`);
        return;
      }

      const data = sheet.getDataRange().getValues();
      let sheetPushCount = 0;

      for (let i = sConfig.start - 1; i < data.length; i++) {
        const row = data[i];
        if (row[sConfig.statusCol - 1] !== "PENDING") continue;

        const docNo = row[1];
        Log.info(rid, `[${sConfig.name}] Pushing R${i + 1}: ${docNo}`);

        let expiryDate = row[14];
        if (expiryDate instanceof Date) {
          expiryDate = Utilities.formatDate(expiryDate, timezone, "yyyy-MM-dd");
        } else if (typeof expiryDate === "string" && expiryDate.includes("/")) {
          expiryDate = expiryDate.replace(/\//g, "-");
        }

        const payload = {
          "DocNo": docNo,
          "Remark4": row[0],
          "Attention": row[sConfig.attentionCol - 1],
          "ExpiryDate": expiryDate
        };

        try {
          const res = UrlFetchApp.fetch(`${CONFIG.NGROK_URL}/SalesOrder/updateFromSheet`, {
            "method": "put",
            "contentType": "application/json",
            "headers": { "X-API-KEY": CONFIG.API_KEY, "X-Request-ID": rid, "ngrok-skip-browser-warning": "true" },
            "payload": JSON.stringify(payload),
            "muteHttpExceptions": true
          });

          Log.api(rid, "/SalesOrder/updateFromSheet", "PUT", res.getResponseCode());

          if (res.getResponseCode() === 200) {
            sheet.getRange(i + 1, sConfig.statusCol).setValue("SYNCED").setBackground("#d9ead3");
            pushCount++;
            sheetPushCount++;
          } else {
            Log.error(rid, `Push failed for ${docNo}: ${res.getContentText()}`);
            sheet.getRange(i + 1, sConfig.statusCol).setValue("ERR: " + res.getResponseCode()).setBackground("#f4cccc");
            errorCount++;
          }
        } catch (e) {
          Log.error(rid, `Connection error for ${docNo}`, e);
          sheet.getRange(i + 1, sConfig.statusCol).setValue("ERR: CONN").setBackground("#f4cccc");
          errorCount++;
        }
      }

      Log.info(rid, `[${sConfig.name}] Sheet push complete: ${sheetPushCount} synced.`);
    });

    let status = "SYNCED";
    let message = `Successfully pushed ${pushCount} items to AutoCount.`;

    if (errorCount > 0 && pushCount > 0) {
      status = "PARTIAL";
      message = `Pushed ${pushCount} items. ${errorCount} failed.`;
    } else if (errorCount > 0 && pushCount === 0) {
      status = "FAILED";
      message = `All ${errorCount} push attempts failed.`;
    }

    Log.info(rid, `Push finished: ${status} — ${message}`);
    recordExecutionLog(ss, rid, "PUSH", start, new Date(), status, message, user);

    if (triggerType === "MANUAL") {
      SpreadsheetApp.getUi().alert(`Push Sync: ${status}\n\n${message}`);
    }

  } finally {
    lock.releaseLock();
    Log.info(rid, "Lock released.");
  }
}