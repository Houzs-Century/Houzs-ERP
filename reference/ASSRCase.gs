// ASSRCase.gs

/**
 * Registers a form-submit trigger for the linked Google Form.
 * Safe to re-run — removes any existing trigger for the same handler first.
 * Run this function ONCE from the Apps Script editor.
 */
function setupFormTrigger() {
  const ss = getTargetSs();

  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'formSubmission') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('formSubmission')
    .forSpreadsheet(ss)
    .onFormSubmit()
    .create();

  console.log("[setupFormTrigger] Form submission trigger registered.");
}

/**
 * Handles incoming Google Form submissions.
 * Fetches supplementary data from AutoCount, generates an ASSR number,
 * creates an individual ASSR sheet from the template, and appends a
 * summary row to the master ASSR sheet.
 *
 * @param {GoogleAppsScript.Events.SheetsOnFormSubmit} e - The form submit event.
 */
function formSubmission(e) {
  const rid = Utilities.getUuid();
  const ss = getTargetSs();

  Log.info(rid, "Form submission received. Processing...");

  const formData = {};
  if (e.namedValues) {
    for (const key in e.namedValues) {
      formData[key.trim()] = e.namedValues[key][0];
    }
  }

  let detectedItem = "";
  for (const key in formData) {
    if (key.includes("Item Code") && formData[key]) {
      detectedItem = formData[key];
    }
  }
  formData["Item Code"] = detectedItem;

  const docNo = formData["Doc. No. (SO)"];
  if (!docNo) {
    Log.warn(rid, "No Doc. No. found in form submission. Aborting.");
    return;
  }

  Log.info(rid, `Processing ASSR for SO: ${docNo}`);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);

    const res = UrlFetchApp.fetch(`${CONFIG.NGROK_URL}/SalesOrder/getSingle/${encodeURIComponent(docNo)}`, {
      "headers": { "X-API-KEY": CONFIG.API_KEY, "X-Request-ID": rid, "ngrok-skip-browser-warning": "true" },
      "muteHttpExceptions": true
    });

    Log.api(rid, `/SalesOrder/getSingle/${docNo}`, "GET", res.getResponseCode());

    const apiData = JSON.parse(res.getContentText());
    const o = (res.getResponseCode() === 200 && apiData.length > 0) ? apiData[0] : null;

    if (!o) {
      Log.warn(rid, `No AutoCount data found for ${docNo}. Proceeding with form data only.`);
    }

    const newAssrNo = getNextAssrNumber();
    formData["ASSR No."] = newAssrNo;
    Log.info(rid, `Generated ASSR No: ${newAssrNo}`);

    createIndividualASSRSheet(docNo, formData, o, newAssrNo);

    const masterSheet = ss.getSheetByName(CONFIG.ASSR_SHEET);
    appendNewRowToASSR(masterSheet, docNo, formData, o);

    Log.info(rid, `ASSR ${newAssrNo} created and appended to master sheet.`);
    recordExecutionLog(ss, rid, "FORM_SUBMIT", new Date(), new Date(), "SYNCED", `ASSR Created: ${newAssrNo}`, "Form User");

  } catch (err) {
    Log.error(rid, "Critical failure in formSubmission", err);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Generates the next sequential ASSR number for the current month.
 * Scans Column C of the master ASSR sheet for the highest existing sequence
 * under the current month's prefix (e.g. "ASSR/2506-004").
 *
 * @returns {string} The next ASSR number (e.g. "ASSR/2506-005").
 */
function getNextAssrNumber() {
  const ss = getTargetSs();
  const sheet = ss.getSheetByName(CONFIG.ASSR_SHEET);
  const timezone = Session.getScriptTimeZone();
  const now = new Date();
  const currentPrefix = "ASSR/" + Utilities.formatDate(now, timezone, "yyMM");

  let maxSequence = 0;
  const lastRow = getRealLastRow(sheet);

  if (lastRow > 1) {
    const data = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
    data.forEach(row => {
      const val = row[0].toString().trim();
      if (val.startsWith(currentPrefix)) {
        const parts = val.split('-');
        if (parts.length > 1) {
          const seq = parseInt(parts[1], 10);
          if (!isNaN(seq) && seq > maxSequence) maxSequence = seq;
        }
      }
    });
  }

  const nextNo = `${currentPrefix}-${(maxSequence + 1).toString().padStart(3, '0')}`;
  console.log(`[getNextAssrNumber] Prefix=${currentPrefix}, maxSeq=${maxSequence}, next=${nextNo}`);
  return nextNo;
}

/**
 * Appends a new ASSR summary row (Columns A–AO, 41 columns) to the master sheet.
 * Uses {@link getRealLastRow} to find the true last row and avoid gaps.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet    - The master ASSR sheet.
 * @param {string}  docNo    - The Sales Order document number.
 * @param {Object}  formData - Parsed form submission data.
 * @param {Object|null} o    - AutoCount API data (null if lookup failed).
 */
function appendNewRowToASSR(sheet, docNo, formData, o) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

  const fullRow = [
    "Under Verification",                         // A: ASSR Status
    docNo,                                        // B: S/O
    formData["ASSR No."],                         // C: ASSR NO
    today,                                        // D: Complained Date
    o ? o.Ref : "",                               // E: Ref No.
    "",                                           // F: NIL
    o ? o.DebtorName : "",                        // G: Customer Name
    o ? (o.Phone1 || "").toString().replace(/[+&\- ]/g, '') : "", // H: HP
    o ? o.SalesLocation : "",                     // I: Location
    o ? o.SalesAgent : "",                        // J: Sales Agent
    o ? o.TransferTo : "",                        // K: D/O
    o ? (o.SalesExemptionExpiryDate ? o.SalesExemptionExpiryDate.split('T')[0] : "") : "", // L: DO Delivered Date
    "",                                           // M: NIL
    "",                                           // N: Action Remark
    "",                                           // O: Service Category
    "", "", "", "", "", "", "",                    // P–V: Manual Columns
    formData["Item Code"],                        // W: Service Item Code
    formData["Issue Description"],                // X: Complaint Issue
    "",                                           // Y: Action Taken
    "",                                           // Z: Call log
    o ? o.SOUDF_ToPONo : "",                      // AA: PO No
    o ? o.InvAddr1 : "",                          // AB: Address 1
    o ? o.InvAddr2 : "",                          // AC: Address 2
    o ? o.InvAddr3 : "",                          // AD: Address 3
    o ? o.InvAddr4 : "",                          // AE: Address 4
    "",                                           // AF: time range
    "",                                           // AG: Time confirmed
    "",                                           // AH: link ref
    "", "", "", "", "",                           // AI–AM: Manual
    "",                                           // AN: good return note & date
    ""                                            // AO: supplier service note
  ];

  const nextRow = getRealLastRow(sheet) + 1;
  sheet.getRange(nextRow, 1, 1, fullRow.length).setValues([fullRow]);
  console.log(`[appendNewRowToASSR] Appended ${docNo} at R${nextRow}.`);
}

/**
 * Finds the last row with actual content in Column B.
 * More reliable than {@code sheet.getLastRow()} when rows have stray formatting.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - The sheet to scan.
 * @returns {number} The 1-based row number of the last populated row in Column B.
 */
function getRealLastRow(sheet) {
  const values = sheet.getRange("B:B").getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i][0] !== "" && values[i][0] !== null) {
      return i + 1;
    }
  }
  return 1;
}

/**
 * Handles edits on the Alternative ASSR sheet (Column B).
 * When a Doc. No. is entered, fetches AutoCount data and populates
 * the row's lookup fields while preserving manually-entered columns.
 *
 * @param {GoogleAppsScript.Events.SheetsOnEdit} e - The edit event object.
 */
function atEditAlternativeSheet(e) {
  if (!e || !e.range || e.range.getColumn() !== 2 || e.range.getRow() <= 1) return;

  const sheet = e.range.getSheet();
  if (sheet.getName() !== CONFIG.OTHER_ASSR_SHEET) return;

  const docNo = e.range.getValue().toString().trim();
  if (!docNo) return;

  const rid = Utilities.getUuid();
  Log.info(rid, `Alternative ASSR lookup triggered for: ${docNo}`);

  try {
    const res = UrlFetchApp.fetch(`${CONFIG.NGROK_URL}/SalesOrder/getSingle/${encodeURIComponent(docNo)}`, {
      "headers": { "X-API-KEY": CONFIG.API_KEY, "ngrok-skip-browser-warning": "true" },
      "muteHttpExceptions": true
    });

    Log.api(rid, `/SalesOrder/getSingle/${docNo}`, "GET", res.getResponseCode());
    const data = JSON.parse(res.getContentText());

    if (data && data.length > 0) {
      const o = data[0];
      const rowIndex = e.range.getRow();
      const existing = sheet.getRange(rowIndex, 1, 1, 41).getValues()[0];
      const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

      const rowFromB = [
        docNo,
        existing[2],
        today,
        o.Ref || "",
        existing[5],
        o.DebtorName || "",
        (o.Phone1 || "").toString().replace(/[+&\- ]/g, ''),
        o.SalesLocation || "",
        o.SalesAgent || "",
        o.TransferTo || "",
        o.SalesExemptionExpiryDate ? o.SalesExemptionExpiryDate.split('T')[0] : "",
        existing[12], existing[13], existing[14],
        ...existing.slice(15, 22),
        existing[22], existing[23],
        existing[24], existing[25],
        o.SOUDF_ToPONo || "",
        o.InvAddr1 || "", o.InvAddr2 || "", o.InvAddr3 || "", o.InvAddr4 || "",
        ...existing.slice(31, 41)
      ];

      sheet.getRange(rowIndex, 2, 1, rowFromB.length).setValues([rowFromB]);
      Log.info(rid, `Alternative ASSR R${rowIndex} populated for ${docNo}.`);
    } else {
      Log.warn(rid, `No AutoCount data found for ${docNo}.`);
    }
  } catch (err) {
    Log.error(rid, `Alternative ASSR lookup failed for ${docNo}`, err);
    e.range.setBackground("#f4cccc");
  }
}

/**
 * Creates an individual ASSR sheet from the template in the external
 * template spreadsheet. Populates header fields and inserts photo links.
 *
 * @param {string}      docNo     - Sales Order document number.
 * @param {Object}      formData  - Parsed form submission data.
 * @param {Object|null} o         - AutoCount API data (null if lookup failed).
 * @param {string}      newAssrNo - The generated ASSR reference number.
 */
function createIndividualASSRSheet(docNo, formData, o, newAssrNo) {
  try {
    const templateSs = SpreadsheetApp.openById(CONFIG.TEMPLATE_SS_ID);
    const templateSheet = templateSs.getSheetByName(CONFIG.TEMPLATE_SHEET_NAME);

    const newSheet = templateSheet.copyTo(templateSs).setName(newAssrNo);

    templateSs.setActiveSheet(newSheet);
    templateSs.moveActiveSheet(3);
    newSheet.showSheet();

    const address = o
      ? [o.InvAddr1, o.InvAddr2, o.InvAddr3, o.InvAddr4].filter(v => v).join(", ")
      : "";

    newSheet.getRange("D6").setValue(o?.SalesAgent || "");
    newSheet.getRange("G6").setValue(new Date());
    newSheet.getRange("J6").setValue(newAssrNo);
    newSheet.getRange("D10").setValue(o?.DebtorName || "");
    newSheet.getRange("G10").setValue(o?.Phone1 || "");
    newSheet.getRange("J10").setValue(o?.Ref || "");
    newSheet.getRange("D11").setValue(o?.SalesExemptionExpiryDate?.split('T')[0] || "");
    newSheet.getRange("G11").setValue(o?.SOUDF_ToPONo || "");
    newSheet.getRange("D12").setValue(address);
    newSheet.getRange("D13").setValue(formData["Issue Description"] || "");
    newSheet.getRange("C15").setValue(formData["Item Code"] || "");
    newSheet.getRange("F15").setValue(1);

    const photoUrlsRaw = formData["Photo / Video"] || "";
    if (photoUrlsRaw) {
      const urls = photoUrlsRaw.split(",").map(s => s.trim());
      const cells = ["B25", "E25", "H25", "B35", "E35"];
      urls.forEach((url, i) => {
        if (i < cells.length) {
          const id = extractFileId(url);
          if (id) {
            try {
              DriveApp.getFileById(id).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
              const directUrl = `https://drive.google.com/uc?export=view&id=${id}`;
              newSheet.getRange(cells[i]).setFormula(`=HYPERLINK("${url}", IMAGE("${directUrl}", 1))`);
            } catch (err) {
              console.warn(`[createIndividualASSRSheet] Could not set sharing for file ${id}. Using link fallback.`);
              newSheet.getRange(cells[i]).setFormula(`=HYPERLINK("${url}", "VIEW")`);
            }
          }
        }
      });
    }

    SpreadsheetApp.flush();
    console.log(`[createIndividualASSRSheet] Sheet "${newAssrNo}" created successfully.`);

  } catch (e) {
    console.error(`[createIndividualASSRSheet] Template creation error: ${e.message}`);
  }
}

/**
 * Extracts a Google Drive file ID from a URL.
 *
 * @param {string} url - A Google Drive file URL.
 * @returns {string|null} The file ID, or null if not found.
 */
function extractFileId(url) {
  if (!url) return null;
  const match = url.match(/id=([\w-]+)/) || url.match(/[-\w]{25,}/);
  return match ? (match[1] || match[0]) : null;
}