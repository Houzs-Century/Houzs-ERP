// Main.gs

/**
 * Creates the custom menu in the spreadsheet UI.
 * Triggered automatically when the spreadsheet is opened.
 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('ERP Sync')
    .addItem('Pull Latest FROM Houzs ERP', 'manualErpPull')
    .addItem('Push Changes TO Houzs ERP', 'manualErpPush')
    .addItem('Restore Orders by Doc No', 'manualErpRestoreByDocNos')
    .addItem('Sync EM Sheet with Transporter Sheet', 'syncEmWithTransporter')
    .addSeparator()
    .addItem('Refresh Overdue Sheet', 'manualErpOverdue')
    .addItem('Refresh Balance Sheet', 'manualErpBalance')
    .addSeparator()
    .addItem('Refresh PO Outstanding Listing', 'manualErpPoPull')
    .addItem('Sync Selected PO Dates TO Houzs ERP', 'erpSyncSelectedPoDates')
    .addItem('Push All PO Dates TO Houzs ERP', 'manualErpPoPush')
    .addSeparator()
    .addItem('Preview 2990 Sync (no write)', 'preview2990Sync')
    .addItem('Sync 2990 FROM ERP', 'sync2990FromErp')
    .addToUi();
}

/**
 * Simple onEdit trigger for lightweight, non-auth operations.
 * Handles PENDING status marking and delivery date validation across
 * the three regional sheets (West, East, SG).
 *
 * Operations requiring {@code SpreadsheetApp.openById()} are delegated
 * to the installable trigger {@link onEditInstallable}.
 *
 * @param {GoogleAppsScript.Events.SheetsOnEdit} e - The edit event object.
 */
function onEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  const row = e.range.getRow();
  const col = e.range.getColumn();

  const REMARK4_COL = 16;
  const DELIVERY_DATE_COL = 17;
  const EXPIRY_DATE_COL = 15;

  /** @type {{ statusCol: number, startRow: number } | null} */
  let rules = null;

  if (sheetName === CONFIG.WEST_SHEET) {
    rules = { statusCol: 46, startRow: 4 };
  } else if (sheetName === CONFIG.EAST_SHEET) {
    rules = { statusCol: 43, startRow: 4 };
  } else if (sheetName === CONFIG.SG_SHEET) {
    rules = { statusCol: 46, startRow: 4 };
  }

  if (!rules || row < rules.startRow) return;

  if (col === 1) {
    const newValue = e.range.getValue();
    sheet.getRange(row, REMARK4_COL).setValue(newValue);
    sheet.getRange(row, rules.statusCol).setValue("PENDING").setBackground("#fff2cc");
    console.log(`[onEdit] ${sheetName} R${row}: Col A → Col P synced. Status → PENDING.`);
    return;
  }

  if (col === DELIVERY_DATE_COL) {
    const cellValue = e.range.getDisplayValue();
    const dateRegex = /^\d{4}\/\d{2}\/\d{2}$/;

    if (dateRegex.test(cellValue)) {
      sheet.getRange(row, EXPIRY_DATE_COL).setValue(cellValue);
      sheet.getRange(row, rules.statusCol).setValue("PENDING").setBackground("#fff2cc");
      console.log(`[onEdit] ${sheetName} R${row}: Col Q date "${cellValue}" → Col O synced. Status → PENDING.`);
    } else if (cellValue !== "") {
      e.range.clearContent();
      SpreadsheetApp.getUi().alert("Invalid Format! Please use YYYY/MM/DD (e.g., 2023/12/31)");
      console.warn(`[onEdit] ${sheetName} R${row}: Col Q rejected invalid value "${cellValue}".`);
    }
    return;
  }

  if (col !== rules.statusCol) {
    const statusRange = sheet.getRange(row, rules.statusCol);
    if (statusRange.getValue() !== "PENDING") {
      statusRange.setValue("PENDING").setBackground("#fff2cc");
      console.log(`[onEdit] ${sheetName} R${row} C${col}: General edit. Status → PENDING.`);
    }
  }
}

/**
 * Installable onEdit trigger for operations requiring full authorization.
 * Handles EM → Transporter real-time push and ASSR Alternative sheet lookups.
 *
 * Must be registered once via {@link setupOnEditTransporter}.
 *
 * @param {GoogleAppsScript.Events.SheetsOnEdit} e - The edit event object.
 */
function onEditTransporter(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  const row = e.range.getRow();

  if (sheetName === CONFIG.EAST_SHEET && row >= 4) {
    console.log(`[onEditTransporter] EM edit at R${row}. Pushing to Transporter.`);
    pushSingleRowToTransporter(row);
  }

  if (sheetName === CONFIG.OTHER_ASSR_SHEET) {
    console.log(`[onEditTransporter] Alternative ASSR edit at R${row}. Running API lookup.`);
    atEditAlternativeSheet(e);
  }
}

/**
 * Registers the installable onEdit trigger for {@link onEditInstallable}.
 * Safe to re-run — removes any existing trigger for the same handler first.
 *
 * Run this function ONCE from the Apps Script editor after deployment.
 */
function setupOnEditTransporter() {
  const ss = getTargetSs();

  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'onEditTransporter') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('onEditTransporter')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  console.log("[setupOnEditTransporter] Trigger registered successfully.");
}

/** Manually triggers a pull from AutoCount. */
function manualPull()    { runPullProcess("MANUAL"); }

/** Manually triggers a push to AutoCount. */
function manualPush()    { pushUpdatesToAutoCount("MANUAL"); }

/** Manually triggers the overdue history pull. */
function manualOverdue() { runOverduePull("MANUAL"); }

/** Manually triggers the balance collection report. */
function manualBalance() { runBalanceCollectionPull("MANUAL"); }

/** Manually triggers the outstanding PO report. */
function manualPO()      { runOutstandingPOPull("MANUAL"); }

/** Scheduled pull — called by time-based trigger. */
function scheduledPull()    { runPullProcess("SCHEDULED"); }

/** Scheduled push — called by time-based trigger. */
function scheduledPush()    { pushUpdatesToAutoCount("SCHEDULED"); }

/** Scheduled overdue pull — called by time-based trigger. */
function scheduledOverdue() { runOverduePull("SCHEDULED"); }

/**
 * Prompts the user to reset the sync checkpoint.
 * The next pull after reset will perform a full refresh from the earliest date.
 */
function resetSyncTime() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert("Warning", "Reset checkpoint? Next pull will be a full refresh.", ui.ButtonSet.YES_NO);
  if (res === ui.Button.YES) {
    PropertiesService.getScriptProperties().deleteProperty(CONFIG.CHECKPOINT_PROP);
    ui.alert("Checkpoint cleared.");
    console.log("[resetSyncTime] Sync checkpoint cleared by user.");
  }
}