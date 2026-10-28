// ══════════════════════════════════════════════════════════════
// GetBalanceCollection.gs - Balance collection data pull
// ──────────────────────────────────────────────────────────────
// PURPOSE: Pull balance collection data from AutoCount API
// TARGET SHEET: "0Balance Collection"
// TRIGGER: manualBalance() from Code.gs, or scheduled
// DEPENDENCIES: Helper.gs (getTargetSs, writeDataToTargetSheet)
// SAFE TO EDIT: Yes (data pull only, no triggers)
// ══════════════════════════════════════════════════════════════

// GetBalanceCollection.gs

/**
 * Fetches confirmed Sales Orders with a remaining balance > 0 from AutoCount
 * and writes them to the Balance sheet with colour-coded expiry highlighting.
 *
 *   - Red row:    expiry date already passed.
 *   - Yellow row: expiry date within the next 3 days.
 *
 * The sheet is fully replaced on each run (clear → write).
 *
 * @param {string} triggerType - "MANUAL" (shows UI alert) or "SCHEDULED".
 */
function runBalanceCollectionPull(triggerType) {
  const rid = Utilities.getUuid();
  const startTime = new Date();
  const ss = getTargetSs();
  const userEmail = Session.getActiveUser().getEmail();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const threeDaysFromNow = new Date();
  threeDaysFromNow.setDate(today.getDate() + 3);
  threeDaysFromNow.setHours(23, 59, 59, 999);

  Log.info(rid, "Balance collection pull started.");

  try {
    const res = UrlFetchApp.fetch(`${CONFIG.NGROK_URL}/SalesOrder/getBalanceCollection`, {
      "headers": { "X-API-KEY": CONFIG.API_KEY, "X-Request-ID": rid, "ngrok-skip-browser-warning": "true" },
      "muteHttpExceptions": true
    });

    Log.api(rid, "/SalesOrder/getBalanceCollection", "GET", res.getResponseCode());
    if (res.getResponseCode() !== 200) throw new Error("API returned " + res.getResponseCode());

    const data = JSON.parse(res.getContentText());
    Log.info(rid, `API returned ${data.length} record(s) with balance.`);

    let sheet = ss.getSheetByName(CONFIG.BALANCE_SHEET);
    if (!sheet) {
      Log.info(rid, `Sheet [${CONFIG.BALANCE_SHEET}] not found. Creating.`);
      sheet = ss.insertSheet(CONFIG.BALANCE_SHEET);
    }

    sheet.clear();
    sheet.clearFormats();
    sheet.getBandings().forEach(b => b.remove());

    const headers = [
      "Doc. No.", "Transfer To", "Date", "Ref. No.", "BRANDING", "Debtor Name", "Phone",
      "Location", "Agent", "Total", "BALANCE", "Remark 2", "Processing Date",
      "Sales Exemption Expiry Date", "Remark 4", "Remark 3", "Note", "PO No",
      "Address 1", "Address 2", "Address 3", "Address 4", "Venue", "Attention"
    ];
    sheet.appendRow(headers);

    if (data && data.length > 0) {
      const rows = data.map(o => [
        o.DocNo, o.TransferTo || "", o.DocDate ? o.DocDate.split('T')[0] : "",
        o.Ref || "", o.SOUDF_BRANDING || "", o.DebtorName || "", o.Phone1 || "",
        o.SalesLocation || "", o.SalesAgent || "", o.Total || 0,
        o.SOUDF_BALANCE || 0, o.Remark2 || "",
        o.SOUDF_PDate ? o.SOUDF_PDate.split('T')[0] : "",
        o.SalesExemptionExpiryDate ? o.SalesExemptionExpiryDate.split('T')[0] : "",
        o.Remark4 || "", o.Remark3 || "", o.SOUDF_Note || "", o.SOUDF_ToPONo || "",
        o.InvAddr1 || "", o.InvAddr2 || "", o.InvAddr3 || "", o.InvAddr4 || "",
        o.SOUDF_VENUE || "", o.Attention || ""
      ]);

      sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);

      const lastRow = rows.length + 1;
      const tableRange = sheet.getRange(1, 1, lastRow, headers.length);
      const headerRange = sheet.getRange(1, 1, 1, headers.length);

      headerRange.setBackground("#0b5394").setFontColor("#FFFFFF")
                 .setFontWeight("bold").setHorizontalAlignment("center");
      tableRange.setVerticalAlignment("middle");

      let expiredCount = 0;
      let warningCount = 0;

      for (let i = 0; i < data.length; i++) {
        const item = data[i];
        const rowNum = i + 2;

        if (item.SalesExemptionExpiryDate) {
          const expiryDate = new Date(item.SalesExemptionExpiryDate);
          const rowRange = sheet.getRange(rowNum, 1, 1, headers.length);
          const dateCell = sheet.getRange(rowNum, 14);

          if (expiryDate < today) {
            rowRange.setBackground("#f4cccc");
            dateCell.setFontWeight("bold").setFontColor("#990000");
            expiredCount++;
          } else if (expiryDate <= threeDaysFromNow) {
            rowRange.setBackground("#fff2cc");
            dateCell.setFontWeight("bold").setFontColor("#b45f06");
            warningCount++;
          }
        }
      }

      Log.info(rid, `Expiry highlights: ${expiredCount} expired, ${warningCount} warning (≤3 days).`);

      sheet.getRange(2, 11, rows.length, 1).setFontWeight("bold");
      sheet.setFrozenRows(1);
      sheet.autoResizeColumns(1, headers.length);
    }

    const message = `Pulled ${data.length} items.`;
    Log.info(rid, `Balance pull complete. ${message}`);
    recordExecutionLog(ss, rid, "BALANCE_LIST", startTime, new Date(), "SYNCED", message, userEmail);

  } catch (e) {
    Log.error(rid, "Balance pull failed", e);
    recordExecutionLog(ss, rid, "BALANCE_LIST", startTime, new Date(), "FAILED", e.message, userEmail);
  }
}