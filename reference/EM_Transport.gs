// ══════════════════════════════════════════════════════════════
// EM_Transport.gs - EM Order sync with Transporter sheet
// ──────────────────────────────────────────────────────────────
// PURPOSE: Sync EM orders between "0EM Order(LiTing)" and Transporter system
// FUNCTIONS: syncEmWithTransporter(), pushSingleRowToTransporter()
// DEPENDENCIES: Helper.gs, Constant.gs
// SAFE TO EDIT: Yes, but verify API field mapping
// ══════════════════════════════════════════════════════════════

// EM_Transport.gs

/**
 * Performs a full bi-directional sync between the East Malaysia master sheet
 * and the external Transporter spreadsheet.
 *
 * Master owns all columns EXCEPT the transporter-owned logistics fields:
 *   R(17), S(18), T(19), AL(37), AM(38), AN(39), AO(40), AP(41)
 *
 * Note: V(22) and W(23) are empty spacer columns in the EM sheet.
 *
 * The merge uses Master as the base and overlays transporter-owned values
 * from matched rows. The result is written back to BOTH sheets.
 */
function syncEmWithTransporter() {
  const rid = Utilities.getUuid();
  const START_ROW = 4;
  const COL_COUNT = 56;

  Log.info(rid, "EM ↔ Transporter sync started.");

  const ssMaster = getTargetSs();
  const shMaster = ssMaster.getSheetByName(CONFIG.EAST_SHEET);
  const ssTrans = SpreadsheetApp.openById(CONFIG.EM_TRANS_SS_ID);
  const shTrans = ssTrans.getSheets()[0];

  const lastRowM = shMaster.getLastRow();
  const maxRowsM = shMaster.getMaxRows();
  const dataRowsM = lastRowM - (START_ROW - 1);

  Log.info(rid, `Master: lastRow=${lastRowM}, maxRows=${maxRowsM}, dataRows=${dataRowsM}`);

  if (dataRowsM <= 0) {
    Log.warn(rid, "Master sheet has no data from Row 4 onwards. Aborting.");
    return;
  }

  const mData = shMaster.getRange(START_ROW, 1, dataRowsM, COL_COUNT).getValues();
  Log.info(rid, `Master data loaded: ${mData.length} rows × ${mData[0].length} cols.`);

  const lastRowT = shTrans.getLastRow();
  const maxRowsT = shTrans.getMaxRows();
  const dataRowsT = lastRowT - (START_ROW - 1);

  Log.info(rid, `Transporter: lastRow=${lastRowT}, maxRows=${maxRowsT}, dataRows=${dataRowsT}`);

  let tData = [];
  if (lastRowT >= START_ROW) {
    tData = shTrans.getRange(START_ROW, 1, Math.max(dataRowsT, 1), COL_COUNT).getValues();
  }

  const transOwnedIdx = [17, 18, 19, 37, 38, 39, 40, 41];

  const tMap = {};
  tData.forEach(row => {
    const docNo = row[1] ? row[1].toString().trim() : "";
    if (docNo) tMap[docNo] = row;
  });

  Log.info(rid, `Transporter index built: ${Object.keys(tMap).length} unique DocNo(s).`);

  let matchCount = 0;
  let newRowCount = 0;

  const finalOutput = mData.map((mRow, i) => {
    const docNo = mRow[1] ? mRow[1].toString().trim() : "";
    const match = tMap[docNo];
    const processedRow = [...mRow];

    if (match) {
      matchCount++;
      transOwnedIdx.forEach(idx => {
        if (match[idx] !== undefined && match[idx] !== "") {
          processedRow[idx] = match[idx];
        }
      });
    } else {
      newRowCount++;
    }
    return processedRow;
  });

  Log.info(rid, `Merge result: ${matchCount} matched, ${newRowCount} new/unmatched.`);

  if (maxRowsT < lastRowM) {
    const rowsToAdd = lastRowM - maxRowsT;
    Log.info(rid, `Transporter too short. Inserting ${rowsToAdd} row(s).`);
    shTrans.insertRowsAfter(maxRowsT, rowsToAdd);
  }

  const tWriteRange = shTrans.getRange(START_ROW, 1, finalOutput.length, COL_COUNT);
  Log.info(rid, `Writing to Transporter: ${tWriteRange.getA1Notation()}`);
  tWriteRange.setValues(finalOutput);

  shMaster.getRange(START_ROW, 1, finalOutput.length, COL_COUNT).setValues(finalOutput);

  const finalLastT = shTrans.getLastRow();
  if (finalLastT > lastRowM) {
    const excessRows = finalLastT - lastRowM;
    Log.info(rid, `Cleaning up ${excessRows} excess row(s) in Transporter.`);
    shTrans.deleteRows(lastRowM + 1, excessRows);
  }

  Log.info(rid, `Sync complete. Final row tally: ${lastRowM}.`);
}

/**
 * Pushes a single Master row to the Transporter sheet in real-time.
 * Called by the installable onEdit trigger when an EM sheet row is edited.
 *
 * Writes only master-owned column segments, preserving transporter-owned fields:
 *   Segment 1: A–Q   (cols 1–17,  indices 0–16)   17 cols
 *   Segment 2: U–AK  (cols 21–37, indices 20–36)   17 cols
 *   Segment 3: AQ–BD (cols 43–56, indices 42–55)   14 cols
 *
 * Skipped (transporter-owned): R–T (17–19), AL–AP (37–41).
 * Note: V(22) and W(23) are empty spacer columns included in Segment 2.
 *
 * @param {number} rowNum - The 1-based row number in the EM master sheet.
 */
function pushSingleRowToTransporter(rowNum) {
  if (rowNum < 4) return;

  const COL_COUNT = 56;

  try {
    const ssMaster = getTargetSs();
    const shMaster = ssMaster.getSheetByName(CONFIG.EAST_SHEET);
    const mRow = shMaster.getRange(rowNum, 1, 1, COL_COUNT).getValues()[0];
    const docNo = mRow[1];

    const shTrans = SpreadsheetApp.openById(CONFIG.EM_TRANS_SS_ID).getSheets()[0];
    const tData = shTrans.getRange(4, 2, Math.max(shTrans.getLastRow() - 3, 1), 1).getValues();

    let tRow = -1;
    if (docNo) {
      for (let i = 0; i < tData.length; i++) {
        if (tData[i][0] === docNo) { tRow = i + 4; break; }
      }
    }

    if (tRow !== -1) {
      shTrans.getRange(tRow, 1, 1, 17).setValues([mRow.slice(0, 17)]);
      shTrans.getRange(tRow, 21, 1, 17).setValues([mRow.slice(20, 37)]);
      shTrans.getRange(tRow, 43, 1, 14).setValues([mRow.slice(42, 56)]);
      console.log(`[pushSingleRowToTransporter] Updated existing Transporter R${tRow} for ${docNo}.`);
    } else {
      shTrans.appendRow(mRow.slice(0, COL_COUNT));
      console.log(`[pushSingleRowToTransporter] Appended new row for ${docNo}.`);
    }

  } catch (e) {
    console.error(`[pushSingleRowToTransporter] R${rowNum} failed: ${e.message}`);
  }
}
