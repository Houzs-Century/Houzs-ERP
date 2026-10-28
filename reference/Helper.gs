// Helper.gs

/**
 * Opens the target spreadsheet by its configured ID.
 *
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getTargetSs() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

/**
 * Structured logger keyed by request ID for traceability.
 * @namespace
 */
const Log = {
  /**
   * @param {string} rid - Request ID.
   * @param {string} msg - Message to log.
   */
  info: (rid, msg) => console.log(`[${rid}] [INFO] ${msg}`),

  /**
   * @param {string} rid - Request ID.
   * @param {string} msg - Warning message.
   */
  warn: (rid, msg) => console.warn(`[${rid}] [WARN] ${msg}`),

  /**
   * @param {string} rid  - Request ID.
   * @param {string} msg  - Error context.
   * @param {Error}  [err] - Optional Error object.
   */
  error: (rid, msg, err) => console.error(`[${rid}] [ERROR] ${msg} | ${err ? err.stack : ''}`),

  /**
   * @param {string} rid    - Request ID.
   * @param {string} url    - Request URL or path.
   * @param {string} method - HTTP method.
   * @param {number} code   - HTTP response code.
   */
  api: (rid, url, method, code) => console.log(`[${rid}] [API] ${method} ${url} | HTTP ${code}`)
};

/**
 * Inserts a row into the execution log sheet.
 * Creates the log sheet with headers if it does not yet exist.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss - Target spreadsheet.
 * @param {string} id        - Request / correlation ID.
 * @param {string} trigger   - Trigger type (e.g. "MANUAL", "PUSH", "OVERDUE_LOG").
 * @param {Date}   start     - Execution start time.
 * @param {Date}   end       - Execution end time.
 * @param {string} status    - Result status (SYNCED | PARTIAL | FAILED | SKIPPED).
 * @param {string} msg       - Human-readable result message.
 * @param {string} userEmail - Email of the invoking user or "SYSTEM".
 */
function recordExecutionLog(ss, id, trigger, start, end, status, msg, userEmail) {
  let logSheet = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!logSheet) {
    logSheet = ss.insertSheet(CONFIG.LOG_SHEET);
    logSheet.appendRow(["ID", "Type", "User", "Start", "End", "Result", "Message"]);
    logSheet.getRange("A1:G1").setFontWeight("bold").setBackground("#444444").setFontColor("white");
  }

  logSheet.insertRowBefore(2);
  logSheet.getRange(2, 1, 1, 7).setValues([[
    id, trigger, userEmail || "SYSTEM",
    Utilities.formatDate(start, "GMT+8", "yyyy-MM-dd HH:mm:ss"),
    Utilities.formatDate(end, "GMT+8", "yyyy-MM-dd HH:mm:ss"),
    status, msg
  ]]);

  const colors = { "SYNCED": "#d9ead3", "FAILED": "#f4cccc", "SKIPPED": "#fff2cc", "PARTIAL": "#fff2cc" };
  if (colors[status]) logSheet.getRange(2, 6).setBackground(colors[status]);
}

/**
 * Writes an array of Sales Order objects to the appropriate regional sheet.
 *
 * Column layout differs per sheet:
 *   WEST  — Block 2 starts at Y (25) [Remark3, Note, PO, Addr1-4], Attention=AS(45), Status=AT(46)
 *   EAST  — Block 2 starts at Y (25) [Remark3, Note, PO, Addr1-4], Attention=AP(42), Status=AQ(43)
 *   SG    — Block 2 starts at Z (26) [Note, PO, Addr1-4] (no Remark 3), Attention=AS(45), Status=AT(46)
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss        - Target spreadsheet.
 * @param {string}  sheetName - Name of the target sheet.
 * @param {Object[]} dataArray - Array of Sales Order API objects.
 * @param {string}  rid       - Request ID for logging.
 * @returns {{ success: number, fail: number }} Write result counts.
 */
function writeDataToTargetSheet(ss, sheetName, dataArray, rid) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    Log.warn(rid, `writeDataToTargetSheet: Sheet [${sheetName}] not found.`);
    return { success: 0, fail: 0 };
  }

  const cfg = getSheetConfig(sheetName);
  Log.info(rid, `[${sheetName}] Writing ${dataArray.length} record(s). ` +
    `startRow=${cfg.startRow}, block2Col=${cfg.block2StartCol}, ` +
    `attentionCol=${cfg.attentionCol}, statusCol=${cfg.statusCol}`);

  const lastRow = sheet.getLastRow();
  const docNoMap = {};
  if (lastRow >= cfg.startRow) {
    const docNos = sheet.getRange(cfg.startRow, 2, (lastRow - cfg.startRow) + 1, 1).getValues();
    docNos.forEach((row, idx) => {
      if (row[0]) docNoMap[row[0].toString()] = idx + cfg.startRow;
    });
  }
  Log.info(rid, `[${sheetName}] Indexed ${Object.keys(docNoMap).length} existing DocNo(s).`);

  const counts = { success: 0, fail: 0 };

  dataArray.forEach(o => {
    let rowIndex = docNoMap[o.DocNo];
    if (!rowIndex) {
      rowIndex = sheet.getLastRow() + 1;
      try {
        sheet.getRange(rowIndex, 2).setValue(o.DocNo);
        Log.info(rid, `[${sheetName}] New DocNo ${o.DocNo} → R${rowIndex}.`);
      } catch (e) {
        Log.error(rid, `[${sheetName}] Failed to create row for ${o.DocNo}`, e);
        counts.fail++;
        return;
      }
    }

    // Block 1: Core info (Cols B–P)
    const b1Data = [
      o.DocNo, o.TransferTo || "", o.DocDate ? o.DocDate.split('T')[0] : "",
      o.Ref || "", o.SOUDF_BRANDING || "", o.DebtorName || "",
      (o.Phone1 || "").toString().replace(/[+&\- ]/g, ''),
      o.SalesLocation || "", o.SalesAgent || "", o.Total || 0,
      o.SOUDF_BALANCE || 0, o.Remark2 || "",
      o.SOUDF_PDate ? o.SOUDF_PDate.split('T')[0] : "",
      o.SalesExemptionExpiryDate ? o.SalesExemptionExpiryDate.split('T')[0] : "",
      o.Remark4 || ""
    ];

    try {
      sheet.getRange(rowIndex, 2, 1, b1Data.length).setValues([b1Data]);
    } catch (e) {
      Log.warn(rid, `[${sheetName}] Block 1 bulk write failed for ${o.DocNo}. Falling back to cell-by-cell.`);
      for (let j = 0; j < b1Data.length; j++) {
        try { sheet.getRange(rowIndex, j + 2).setValue(b1Data[j]); } catch (ce) {}
      }
    }

    // Block 2: Address & notes (layout varies by sheet)
    let b2Data;
    if (cfg.includeRemark3) {
      b2Data = [
        o.Remark3 || "", o.SOUDF_Note || "", o.SOUDF_ToPONo || "",
        o.InvAddr1 || "", o.InvAddr2 || "", o.InvAddr3 || "", o.InvAddr4 || ""
      ];
    } else {
      b2Data = [
        o.SOUDF_Note || "", o.SOUDF_ToPONo || "",
        o.InvAddr1 || "", o.InvAddr2 || "", o.InvAddr3 || "", o.InvAddr4 || ""
      ];
    }

    try {
      sheet.getRange(rowIndex, cfg.block2StartCol, 1, b2Data.length).setValues([b2Data]);
    } catch (e) {
      Log.warn(rid, `[${sheetName}] Block 2 (Addr) for ${o.DocNo} hit protection.`);
    }

    // Block 3: Attention & sync status
    try {
      sheet.getRange(rowIndex, cfg.attentionCol).setValue(o.Attention || "");
      sheet.getRange(rowIndex, cfg.statusCol).setValue("SYNCED").setBackground("#d9ead3");
    } catch (e) {
      Log.warn(rid, `[${sheetName}] Block 3 (Status) for ${o.DocNo} hit protection.`);
    }

    counts.success++;
  });

  Log.info(rid, `[${sheetName}] Write complete: ${counts.success} success, ${counts.fail} fail.`);
  return counts;
}

/**
 * Returns the column configuration for a given regional sheet.
 *
 * @param {string} sheetName - The sheet name to configure.
 * @returns {{ startRow: number, block2StartCol: number, includeRemark3: boolean, attentionCol: number, statusCol: number }}
 */
function getSheetConfig(sheetName) {
  if (sheetName === CONFIG.EAST_SHEET) {
    return { startRow: 4, block2StartCol: 25, includeRemark3: true, attentionCol: 42, statusCol: 43 };
  }
  if (sheetName === CONFIG.SG_SHEET) {
    return { startRow: 4, block2StartCol: 26, includeRemark3: false, attentionCol: 45, statusCol: 46 };
  }
  // Default: WEST
  return { startRow: 4, block2StartCol: 25, includeRemark3: true, attentionCol: 45, statusCol: 46 };
}

/**
 * Activates the execution log sheet in the UI.
 */
function openLogSheet() {
  const ss = getTargetSs();
  const s = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (s) s.activate();
}