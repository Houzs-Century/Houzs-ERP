// ══════════════════════════════════════════════════════════════
// GetOverdueData.gs - Overdue orders data pull
// ──────────────────────────────────────────────────────────────
// PURPOSE: Pull overdue order data from AutoCount API
// TARGET SHEET: "0Overdue"
// TRIGGER: manualOverdue() from Code.gs, or scheduled
// DEPENDENCIES: Helper.gs (getTargetSs, writeDataToTargetSheet)
// SAFE TO EDIT: Yes (data pull only, no triggers)
// ══════════════════════════════════════════════════════════════

// GetOverdueData.gs

/**
 * Fetches currently overdue Sales Orders, auto-extends their expiry dates
 * in AutoCount by +3 days, and appends the original overdue records to the
 * history sheet as an audit log.
 *
 * @param {string} triggerType - "MANUAL" (shows UI alert) or "SCHEDULED".
 */
function runOverduePull(triggerType) {
  const rid = Utilities.getUuid();
  const startTime = new Date();
  const ss = getTargetSs();
  const userEmail = Session.getActiveUser().getEmail();
  const timezone = ss.getSpreadsheetTimeZone();

  Log.info(rid, "Overdue pull started.");

  try {
    const res = UrlFetchApp.fetch(`${CONFIG.NGROK_URL}/SalesOrder/getOverdue`, {
      "headers": { "X-API-KEY": CONFIG.API_KEY, "X-Request-ID": rid, "ngrok-skip-browser-warning": "true" },
      "muteHttpExceptions": true
    });

    Log.api(rid, "/SalesOrder/getOverdue", "GET", res.getResponseCode());
    if (res.getResponseCode() !== 200) throw new Error("API returned " + res.getResponseCode());

    const data = JSON.parse(res.getContentText());
    Log.info(rid, `API returned ${data.length} overdue record(s).`);

    let sheet = ss.getSheetByName(CONFIG.OVERDUE_SHEET);
    if (!sheet) {
      Log.info(rid, `Sheet [${CONFIG.OVERDUE_SHEET}] not found. Creating with headers.`);
      sheet = ss.insertSheet(CONFIG.OVERDUE_SHEET);
      const headers = [
        "Pull Date", "Doc. No.", "Transfer To", "Date", "Ref. No.", "BRANDING",
        "Debtor Name", "Phone", "Location", "Agent", "Total", "Balance",
        "Remark 2", "Processing Date", "Original Expiry Date", "Remark 4",
        "Remark 3", "Note", "PO No", "Address 1", "Address 2", "Address 3",
        "Address 4", "Venue", "Attention"
      ];
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length)
           .setBackground("#444444").setFontColor("#FFFFFF").setFontWeight("bold");
      sheet.setFrozenRows(1);
    }

    if (!data || data.length === 0) {
      Log.info(rid, "No overdue items found. Nothing to process.");
      recordExecutionLog(ss, rid, "OVERDUE_LOG", startTime, new Date(), "SKIPPED", "No overdue items found.", userEmail);
      if (triggerType === "MANUAL") {
        SpreadsheetApp.getUi().alert("Overdue History: No overdue items found.");
      }
      return;
    }

    const extensionDate = new Date();
    extensionDate.setDate(extensionDate.getDate() + 3);
    const formattedNewDate = Utilities.formatDate(extensionDate, timezone, "yyyy-MM-dd");
    const pullTimeStamp = Utilities.formatDate(new Date(), timezone, "yyyy-MM-dd HH:mm");

    Log.info(rid, `Extension target date: ${formattedNewDate}`);

    let updateCount = 0;
    let updateErrors = 0;
    const batchRows = [];

    data.forEach(o => {
      try {
        const payload = {
          "DocNo": o.DocNo,
          "Remark4": o.Remark4,
          "Attention": o.Attention,
          "ExpiryDate": formattedNewDate
        };

        const pushRes = UrlFetchApp.fetch(`${CONFIG.NGROK_URL}/SalesOrder/updateFromSheet`, {
          "method": "put",
          "contentType": "application/json",
          "headers": { "X-API-KEY": CONFIG.API_KEY, "X-Request-ID": rid, "ngrok-skip-browser-warning": "true" },
          "payload": JSON.stringify(payload),
          "muteHttpExceptions": true
        });

        if (pushRes.getResponseCode() === 200) {
          updateCount++;
        } else {
          updateErrors++;
          Log.warn(rid, `AutoCount update failed for ${o.DocNo}: HTTP ${pushRes.getResponseCode()}`);
        }
      } catch (err) {
        updateErrors++;
        Log.error(rid, `Connection error extending ${o.DocNo}`, err);
      }

      batchRows.push([
        pullTimeStamp,
        o.DocNo,
        o.TransferTo || "",
        o.DocDate ? o.DocDate.split('T')[0] : "",
        o.Ref || "",
        o.SOUDF_BRANDING || "",
        o.DebtorName || "",
        o.Phone1 || "",
        o.SalesLocation || "",
        o.SalesAgent || "",
        o.Total || 0,
        o.SOUDF_BALANCE || 0,
        o.Remark2 || "",
        o.SOUDF_PDate ? o.SOUDF_PDate.split('T')[0] : "",
        o.SalesExemptionExpiryDate ? o.SalesExemptionExpiryDate.split('T')[0] : "",
        o.Remark4 || "",
        o.Remark3 || "",
        o.SOUDF_Note || "",
        o.SOUDF_ToPONo || "",
        o.InvAddr1 || "",
        o.InvAddr2 || "",
        o.InvAddr3 || "",
        o.InvAddr4 || "",
        o.SOUDF_VENUE || "",
        o.Attention || ""
      ]);
    });

    if (batchRows.length > 0) {
      const insertAt = sheet.getLastRow() + 1;
      sheet.getRange(insertAt, 1, batchRows.length, batchRows[0].length).setValues(batchRows);
      Log.info(rid, `Appended ${batchRows.length} history row(s) starting at R${insertAt}.`);
    }

    sheet.autoResizeColumns(1, 25);

    const message = `Logged ${data.length} overdue items. Extended ${updateCount}, failed ${updateErrors}.`;
    Log.info(rid, `Overdue pull complete. ${message}`);
    recordExecutionLog(ss, rid, "OVERDUE_LOG", startTime, new Date(), "SYNCED", message, userEmail);

    if (triggerType === "MANUAL") {
      SpreadsheetApp.getUi().alert(
        `Overdue History: Pulled & Extended\n\n` +
        `- ${data.length} items added to history.\n` +
        `- ${updateCount} dates extended to ${extensionDate.toLocaleDateString()}.\n` +
        `- ${updateErrors} extension(s) failed.`
      );
    }

  } catch (e) {
    Log.error(rid, "Overdue pull failed", e);
    recordExecutionLog(ss, rid, "OVERDUE_LOG", startTime, new Date(), "FAILED", e.message, userEmail);
  }
}