## DataGrid export wrote money as RM text or blank cells, and hand-written exports had no 2dp money format [medium]

<!-- area: Frontend + mobile -->

**Symptom.** Owner, 2026-09-15: 「我看到amount是那种150000，全部amount需要跟Autocount 的一样」. Every exported amount must read like AutoCount: a ringgit number with two decimals. The census of the `DataGrid` Export (the toolbar Export on consignment notes/orders/returns, payment vouchers, receipts, purchase consignment, the SO/DO/SI/DR detail listings, the convert-from pickers, delivery planning and special add-ons) found 76 money columns that did not:

- **Blank cells — 22 columns.** The cell renders JSX and has no `exportValue`, so the sheet got an empty cell. Examples: consignment line Total and Margin, SO detail Total and Margin RM.
- **Text, not numbers — 23 columns.** The cell returns a string and has no `exportValue`, so the sheet got `RM 1,234.00` / `MYR 1,234.00`. A sheet cannot sum that.
- **No number format — 29 columns.** They already exported ringgit through `exportValue` (`sen / 100`) but carried no format, so the sheet showed `15000` or `123.4` instead of `15,000.00`.
- **Convert-from pickers — 4 files.** The Line Value column in DO-from-SO, GRN-from-PO, PO-from-SO and SI-from-DO exported blank.

Two hand-written exports had the same defect. The HR commission `.xlsx` wrote ringgit numbers with no format. The SKU price sheet wrote `1535` for RM 1,535.00.

**Root cause (traced).** `vendor/scm/components/DataGrid.tsx` `exportRows` writes `exportValue`, then `filterValue`, then the accessor only when it returns a string or number (`coerceSearchString` returns `''` for JSX), and it never set a cell number format. Nothing required a money column to declare an export value. The price sheet's `senToRm` deliberately dropped `.00` (Wei Siang 2026-06-09), a choice the owner's 2026-09-15 rule replaces.

**Fix.**
- `DataGridColumn` gains `exportFormat?: 'money' | 'rate'`, and `exportRows` stamps numeric cells `#,##0.00` / `#,##0.00##`.
- Each of the 76 columns now has `exportValue` in ringgit plus `exportFormat`. Unit price and unit cost use `rate`.
- The commission export goes through `writeLineExportXlsx` with money formats.
- The price sheet writes `priceSheetRinggit` (`toFixed(2)`).
- The fabric converter CSV keeps `price_sen` in sen. It is a round-trip import contract whose header already names the unit, and it is recorded as such, not changed.

Pinned by three tests:

- `frontend/src/lib/money-export-guard.test.ts`: an AST scan of DataGrid columns. A column whose accessor calls a money formatter must carry `exportValue` and `exportFormat`, with one reasoned exception (PaymentVouchers status). **RED on the unfixed tree:** 76 columns listed. GREEN after.
- `frontend/src/vendor/scm/components/DataGridMoneyExport.test.tsx`: real SheetJS. A JSX money cell exports `{t:'n', v:15000, z:'#,##0.00'}` and a rate exports `z:'#,##0.00##'`. **RED on the unfixed DataGrid:** `expected { t: 'n', v: 15000 } to match object { ..., z: '#,##0.00' }`.
- `line-export-file.test.ts` and `productsPriceSheet.test.ts` pin the commission format and the 2dp price sheet. These two are new pins; RED was not run for them.

**Ref.** fix/money-exports, 2026-09-15.
