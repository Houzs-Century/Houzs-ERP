// ══════════════════════════════════════════════════════════════
// PO_Outstanding.gs - Outstanding Purchase Order management
// ──────────────────────────────────────────────────────────────
// PURPOSE: Pull outstanding PO data and sync PO dates with AutoCount
// TARGET SHEET: "0Outstanding PO"
// FUNCTIONS: runOutstandingPOPull(), syncSelectedRowToAutoCount(),
//            syncPODate(), dailySyncAllPODates()
// DEPENDENCIES: Helper.gs, Constant.gs
// SAFE TO EDIT: Yes, but verify API field mapping
// ══════════════════════════════════════════════════════════════

// PO_Outstanding.gs

/**
 * Fetches outstanding Purchase Orders from AutoCount and writes them to the
 * "Outstanding PO" sheet. Rows 1–10 are preserved for internal team use;
 * data begins at Row 11 (header) / Row 12 (first data row).
 *
 * Column P (Overdue Days) is manually maintained — its values are backed up
 * before the refresh and restored afterward using a DocNo+ItemCode composite key.
 *
 * @param {string} triggerType - "MANUAL" (shows UI alert) or "SCHEDULED".
 */
function runOutstandingPOPull(triggerType) {
  const rid = Utilities.getUuid();
  const startTime = new Date();
  const ss = getTargetSs();
  const userEmail = Session.getActiveUser().getEmail();
  const START_ROW = 11;

  Log.info(rid, "Outstanding PO pull started.");

  try {
    const res = UrlFetchApp.fetch(`${CONFIG.NGROK_URL}/PurchaseOrder/getOutstanding`, {
      "headers": { "X-API-KEY": CONFIG.API_KEY, "X-Request-ID": rid, "ngrok-skip-browser-warning": "true" },
      "muteHttpExceptions": true
    });

    Log.api(rid, "/PurchaseOrder/getOutstanding", "GET", res.getResponseCode());
    if (res.getResponseCode() !== 200) throw new Error("API returned " + res.getResponseCode());

    const data = JSON.parse(res.getContentText());
    Log.info(rid, `API returned ${data.length} outstanding PO line(s).`);

    let sheet = ss.getSheetByName("Outstanding PO");
    if (!sheet) {
      Log.info(rid, "Sheet [Outstanding PO] not found. Creating.");
      sheet = ss.insertSheet("Outstanding PO");
    }

    // Backup manual Column P data keyed by DocNo_ItemCode
    const manualMap = {};
    const lastRowBeforeClear = sheet.getLastRow();

    if (lastRowBeforeClear >= START_ROW) {
      const currentValues = sheet.getRange(START_ROW, 1, (lastRowBeforeClear - START_ROW) + 1, 16).getValues();
      for (let i = 1; i < currentValues.length; i++) {
        const row = currentValues[i];
        const docNo = row[0];
        const itemCode = row[4];
        if (docNo && itemCode) {
          manualMap[docNo.toString() + "_" + itemCode.toString()] = row[15];
        }
      }
      Log.info(rid, `Backed up ${Object.keys(manualMap).length} manual Overdue Days value(s).`);
    }

    // Clear data area (Row 11+)
    const maxRows = sheet.getMaxRows();
    const maxCols = sheet.getMaxColumns();

    if (maxRows >= START_ROW) {
      sheet.getRange(START_ROW, 1, (maxRows - START_ROW) + 1, maxCols).clear();
    }

    sheet.getBandings().forEach(b => {
      if (b.getRange().getRow() >= START_ROW) b.remove();
    });

    const headers = [
      "Doc No", "SO Doc No", "Creditor Code", "Creditor Name", "Item Code",
      "Item Description", "Item Description 2", "Location", "Item Group", "Doc Date",
      "Remaining Qty", "Delivery Date", "Supplier Delivery Date 1",
      "Supplier Delivery Date 2", "Supplier Delivery Date 3", "Overdue Days"
    ];

    if (data && data.length > 0) {
      const rows = data.map(o => {
        const key = (o.DocNo || "").toString() + "_" + (o.ItemCode || "").toString();
        return [
          o.DocNo,
          o.SODocNo || "",
          o.CreditorCode,
          o.CreditorName,
          o.ItemCode,
          o.ItemDescription,
          o.ItemDescription2 || "",
          o.Location,
          o.ItemGroup || "",
          o.DocDate ? o.DocDate.split('T')[0] : "",
          o.RemainingQty,
          o.DeliveryDate ? o.DeliveryDate.split('T')[0] : "",
          o.SupplierDeliveryDate1 ? o.SupplierDeliveryDate1.split('T')[0] : "",
          o.SupplierDeliveryDate2 ? o.SupplierDeliveryDate2.split('T')[0] : "",
          o.SupplierDeliveryDate3 ? o.SupplierDeliveryDate3.split('T')[0] : "",
          manualMap[key] || ""
        ];
      });

      sheet.getRange(START_ROW, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(START_ROW + 1, 1, rows.length, headers.length).setValues(rows);

      const reportRange = sheet.getRange(START_ROW, 1, rows.length + 1, headers.length);
      const headerRange = sheet.getRange(START_ROW, 1, 1, headers.length);

      headerRange.setBackground("#274e13").setFontColor("#FFFFFF")
                 .setFontWeight("bold").setHorizontalAlignment("center");
      sheet.getRange(START_ROW + 1, 1, rows.length, headers.length).setVerticalAlignment("middle");

      reportRange.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREEN);
      reportRange.setBorder(true, true, true, true, true, true, "#cccccc", SpreadsheetApp.BorderStyle.SOLID);

      sheet.setFrozenRows(START_ROW);
      sheet.autoResizeColumns(1, headers.length);

      Log.info(rid, `Sheet populated: ${rows.length} data row(s). Rows 1-10 preserved.`);
    } else {
      sheet.getRange(START_ROW, 1, 1, headers.length).setValues([headers]);
      Log.info(rid, "No data returned. Headers written only.");
    }

    const message = `Pulled ${data ? data.length : 0} items. Rows 1-10 preserved.`;
    recordExecutionLog(ss, rid, "PO_PULL", startTime, new Date(), "SYNCED", message, userEmail);

  } catch (e) {
    Log.error(rid, "PO pull failed", e);
    recordExecutionLog(ss, rid, "PO_PULL", startTime, new Date(), "FAILED", e.message, userEmail);
  }
}

/**
 * Syncs the Supplier Delivery Dates from the currently selected row in the
 * "Outstanding PO" sheet to AutoCount. Prompts for user confirmation.
 *
 * Only works for data rows (Row 12+). Rows 1–11 are reserved.
 */
function syncSelectedRowToAutoCount() {
  const ss = getTargetSs();
  const sheet = ss.getSheetByName("Outstanding PO");
  const currentRow = sheet.getActiveCell().getRow();

  if (currentRow < 12) {
    SpreadsheetApp.getUi().alert("Please select a row containing PO data (Row 12 or below).");
    return;
  }

  const rowData = sheet.getRange(currentRow, 1, 1, 15).getValues()[0];

  const poData = {
    docNo: rowData[0],
    date1: rowData[12] ? Utilities.formatDate(new Date(rowData[12]), "GMT+8", "yyyy-MM-dd") : null,
    date2: rowData[13] ? Utilities.formatDate(new Date(rowData[13]), "GMT+8", "yyyy-MM-dd") : null,
    date3: rowData[14] ? Utilities.formatDate(new Date(rowData[14]), "GMT+8", "yyyy-MM-dd") : null
  };

  console.log(`[syncSelectedRowToAutoCount] R${currentRow}: ${poData.docNo} → dates [${poData.date1}, ${poData.date2}, ${poData.date3}]`);

  try {
    const ui = SpreadsheetApp.getUi();
    const response = ui.alert('Confirm Sync', `Update dates for ${poData.docNo} in AutoCount?`, ui.ButtonSet.YES_NO);

    if (response === ui.Button.YES) {
      syncPODate(poData);
      ui.alert("Success", "AutoCount PO Dates updated.", ui.ButtonSet.OK);
    }
  } catch (e) {
    SpreadsheetApp.getUi().alert("Error: " + e.message);
  }
}

/**
 * Sends UDF date updates for a single Purchase Order to the AutoCount API.
 *
 * @param {Object}      po       - Purchase Order date payload.
 * @param {string}      po.docNo - The PO document number.
 * @param {string|null} po.date1 - Supplier Delivery Date 1 (yyyy-MM-dd or null).
 * @param {string|null} po.date2 - Supplier Delivery Date 2 (yyyy-MM-dd or null).
 * @param {string|null} po.date3 - Supplier Delivery Date 3 (yyyy-MM-dd or null).
 * @returns {boolean} True if the update succeeded.
 * @throws {Error} On API or network failure.
 */
function syncPODate(po) {
  const rid = Utilities.getUuid();
  const url = `${CONFIG.NGROK_URL}/PurchaseOrder/update-udf-dates`;

  const payload = {
    "docNo": po.docNo,
    "POUDF_EDate": po.date1,
    "POUDF_EDate2": po.date2,
    "POUDF_EDate3": po.date3
  };

  const options = {
    "method": "put",
    "contentType": "application/json",
    "headers": { "X-API-KEY": CONFIG.API_KEY, "X-Request-ID": rid, "ngrok-skip-browser-warning": "true" },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  Log.info(rid, `Syncing PO dates for ${po.docNo}...`);

  const res = UrlFetchApp.fetch(url, options);
  const responseCode = res.getResponseCode();

  Log.api(rid, "/PurchaseOrder/update-udf-dates", "PUT", responseCode);

  if (responseCode === 200) {
    Log.info(rid, `PO date sync succeeded for ${po.docNo}.`);
    return true;
  }

  const errorText = res.getContentText();
  Log.error(rid, `PO date sync failed for ${po.docNo}: ${errorText}`);
  throw new Error(`API Error (${responseCode}): ${errorText}`);
}

/**
 * Daily scheduled function that syncs ALL Supplier Delivery Dates from the
 * "Outstanding PO" sheet to AutoCount.
 *
 * Uses {@link getTargetSs} instead of {@code getActiveSpreadsheet()} to
 * ensure it works correctly as a time-based trigger (no active context).
 */
function dailySyncAllPODates() {
  const rid = Utilities.getUuid();
  const ss = getTargetSs();
  const sheet = ss.getSheetByName("Outstanding PO");

  if (!sheet) {
    Log.warn(rid, "dailySyncAllPODates: Sheet [Outstanding PO] not found. Aborting.");
    return;
  }

  const startRow = 12;
  const lastRow = sheet.getLastRow();

  if (lastRow < startRow) {
    Log.info(rid, "dailySyncAllPODates: No data rows found. Exiting.");
    return;
  }

  const data = sheet.getRange(startRow, 1, (lastRow - startRow) + 1, 15).getValues();

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  Log.info(rid, `Daily PO sync started. Processing ${data.length} row(s).`);

  data.forEach((row, index) => {
    const docNo = row[0];

    if (!docNo) {
      skippedCount++;
      return;
    }

    const poData = {
      docNo: docNo,
      date1: row[12] instanceof Date ? Utilities.formatDate(row[12], "GMT+8", "yyyy-MM-dd") : null,
      date2: row[13] instanceof Date ? Utilities.formatDate(row[13], "GMT+8", "yyyy-MM-dd") : null,
      date3: row[14] instanceof Date ? Utilities.formatDate(row[14], "GMT+8", "yyyy-MM-dd") : null
    };

    try {
      if (syncPODate(poData)) successCount++;
    } catch (e) {
      Log.error(rid, `Daily sync error for ${docNo}`, e);
      errorCount++;
    }
  });

  Log.info(rid, `Daily PO sync complete. Success=${successCount}, Errors=${errorCount}, Skipped=${skippedCount}.`);
}