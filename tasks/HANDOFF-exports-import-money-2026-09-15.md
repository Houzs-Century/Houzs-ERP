# Handoff: list exports like AutoCount, PO line import, supplier dates, money format (2026-09-15)

State at **2026-09-15 13:34Z**. Every PR state below was re-read with
`gh pr view` at that time. Re-run before quoting (R07).

The owner drove this work in chat on 2026-09-14/15. His rulings are listed
in full below, because several of them reverse an earlier design. Read them
before touching any list export.

## Start here

1. **Sales Order export is not open as a PR yet.**
   - Branch `feat/so-do-line-export`, last pushed WIP `ea001644b`.
   - Its content: windowed `/export/rows` for SO and DO, SO list wiring, the SO page export test, "no sen" tests, the check script, and module guides.
   - CI on top of it found 3 failures that belong to this branch:
     1. `frontend-typecheck` / `check:raw-fetch`: `so-do-list-columns.test.tsx:72-90` names a variable `fetch`. Rename it.
     2. `ColumnsDrawer.test.tsx` "Sales Orders column groups" anchors on `const columns: Column<SoRow>[] = [`. The list now declares `Column<SoRow, SoListLine>`. Update the anchor and keep the `>= 44` assertion.
     3. `audit:routes`: regenerate the route matrix. It still lists 9 retired `export/lines` / `export/headers` routes.
2. **Delivery Order export is PR #3972, OPEN.** It stacks on the SO branch (merged in at `94e032e8f`) and merges after the SO PR. Then merge `origin/main`, regenerate the route matrix, and merge.
3. **Nothing in this file was checked in a browser.** No legitimate login was available. Every UI statement is from tests plus read-only production checks. The owner was asked to try an export and send a screenshot.
4. **Worktrees still on disk:**
   - `houzs-work-worktrees/so-do-line-export`
   - `houzs-work-worktrees/do-list-export`
   - this handoff's `handoff-exports-0915`

   Remove each after its PR merges.

## Owner rulings (in the order given; later ones win)

The full wording is in the session memory note
`owner-rulings-2026-09-15-line-export-import.md` (not in git).

1. **Export = the whole filtered listing, never the visible page.**
   - His words: 「必须要根据我的 listing 去 export，不可以看页面」.
   - The old `DataTable` export wrote only the loaded page (default 50 rows).
2. **One row per LINE item**, like AutoCount's listings, for every transaction document.
3. **The first design was rejected, then corrected.**
   - Rejected (#3915 / #3930): a separate "Export lines" button with a fixed column list.
   - His correction: exactly ONE Export per list, and the columns are the grid's VISIBLE columns in on-screen order.
     - It follows the tab, search, sort and the column funnels.
     - Item code, supplier SKU, qty, expected date and assigned SO must be exact per line.
   - 「为什么你要有层一、层二」 refers to the two export buttons.
4. **"100% AutoCount format."**
   - Column labels and values follow AutoCount: Item Code as the book holds it, the book's description, debtor and creditor codes, the AutoCount doc no.
   - Dates are real Excel dates shown `yyyy/mm/dd`.
   - The default visible columns of GRN / PI are AutoCount's company default layouts ("S", "SS"); PO uses AutoCount's PO chasing-list columns.
5. **Money everywhere, in the whole system**, is ringgit with 2 decimals: `15,000.00` in Excel, `RM 15,000.00` on screen. His words: 「全部amount需要跟Autocount 的一样」 and 「全套系统」.
6. **Sofa: one row per ERP piece**, not AutoCount's one line per set (option A).
7. **Item Description 2** = the text composed from the variants (`buildVariantSummary`), with the stored text only as a fallback.
   - Confirmed a second time after he saw a real bedframe example. It deliberately differs from AutoCount's typed Desc2 on older documents: variant text matches the book on GR 25% / PI 16% / IV 67%, against about 77% for the stored text.
8. **Default column layouts.**
   - SO default = AutoCount layout "SALES ORDER DETAILS-SALES".
   - Sales Invoice default = 「默认跟我的data grid」: today's grid columns stay the default, and AutoCount's columns are in the chooser, hidden.
   - An admin-saved company layout (SO id 3, DO id 86 in `public.table_layouts`) still wins, so the AutoCount layout is offered as an entry in the Columns panel. Never write `table_layouts`.
9. **DO export carries NO prices.** Driver and Vehicle columns stay, even though they are empty.
10. **List SCREENS stay one row per document** (「不需要」 per-line screens). Line columns show the value, or the first value and "+N".
11. **Import = option A.**
    - Only these fields are imported: Delivery Date, Estimate Delivery Date / Supplier Delivery Date 2 / 3, Item Description 2, Remarks.
    - Rows are matched by Line ID, with a preview before apply.
    - Never qty, price or item.
    - Desktop only (「手机不需要导入」).
12. **Supplier delivery dates.**
    - Fill the ERP from AutoCount (「第 6 的这样子就要解决掉了」), then send them back to AutoCount (option A).
    - Staff only operate the ERP: 「我们只操作erp 不操作autocount」 and 「autocount 完全不能操作了啊」.
13. **Not wanted:**
    - due dates derived from credit terms;
    - line exports for quotes, amendments and finance documents (for now);
    - estimate dates on sales documents;
    - investigating the ambiguous-brand write-back codes (JAGER → HOK where the book has NB).

## What shipped (all MERGED; deploys confirmed where stated)

### List exports

| PR | what |
|---|---|
| #3902 | `docs/line-export-columns.md`: the column design per document, plus the owner's answers to its 12 questions |
| #3915 | first PO line export (fixed columns). **Superseded** by #3967 |
| #3925 / #3930 | GRN / PI / SI server line exports and "Export lines" buttons. **Superseded** by #3968 |
| #3935 | DataTable mechanism: `Column.lineValue / exportValue / exportFormat`, and the `exportLines` prop. Funnels and sort reuse the grid's own functions |
| #3948 | `components/dataTableLineCells.tsx`: `lineTextColumn`, `lineSumColumn`, `LineValuesCell` |
| #3937 | AutoCount item-master snapshot, `backend/scripts/data/ac-item-master.tsv` (1,630 items), plus `bookLineItem` in `services/autocount-book-item.ts` |
| #3940 / #3945 / #3951 | `bookLineItem` takes the write-back bindings. Sofa pieces read the SOFA set item, never an OTHER piece item |
| #3949 | Purchase Return and Delivery Return lists: ONE Export, AutoCount Detail Listing defaults |
| #3967 | PO list: ONE Export, AutoCount default columns, line columns, ringgit, funnels. The import reads the AutoCount labels. Deploy 34968427312: backend + frontend success |
| #3968 | GRN / PI / SI lists: ONE Export via the grid. The #3930 buttons and `/export/lines` + `/export/headers` are removed. Deploy 34970980267: success |
| #3975 | `readExportWindow` / `EXPORT_WINDOW`: exports served in windows of up to 500 documents |

**Server contract.** `GET /<doc>/export/rows?<list params>` returns documents in the list's own row shape, each with its `lines`.
- PO, GRN, PI, SI and returns: single request, returning `truncated`.
- SO and DO (on the open branch): windowed, taking `offset`/`limit` and returning `next`.

**Evidence (PROVEN, read-only production runs)**
- **Lines match SQL line by line**, both companies:
  - PO: run 34966925686, Outstanding tab, Houzs 300 POs / 791 lines.
  - GRN / PI / SI: run 34965352154 (GRN All 549 / 1,109; PI 196 / 523; SI 72 / 339), re-checked on main in run 34972063381.
  - SO / DO: 12 cases match with the windowed code (local read-only run by the SO/DO agent).
- **Database requests per export call, measured against the Worker cap of 1,000** (run 34974025872):
  - Houzs All tab: PO 29, GRN 78, PI 47, SI 22.
  - Single-request SO was **1,394** (Submitted) and **1,923** (All), which is why SO/DO are windowed. At most 332 requests per window.
- **Against the owner's AutoCount PO chasing list (09-04 file):**
  - 240 matched lines. Creditor, location, doc date, SO no, description and group agree 240/240.
  - Delivery Date agrees 239/240, Estimate Delivery Date 212/240, Remaining Qty 151/240. These were not traced; the file predates later receipts.
- **GRN / PI / IV against the live book, after #3951:**

  | column | GRN (791 lines) | PI (437) | IV (223) |
  |---|---|---|---|
  | Item Group | 791 | 435 | 223 |
  | UOM | 752 | 425 | 212 |
  | Description | 646 | 421 | 195 |

  - Item Code on non-sofa lines: 596/596, 357/357, 193/198.
  - IV Agent: 145/223 ignoring case. The other 78 are migrated invoices with no agent (data gap, not filled).

### PO line import (#3908)
- **Flow:** PO list → the arrow beside New Purchase Order → Import lines → preview → Confirm.
- **Estimate dates are PO-level** (the header cascades to the lines). Rows of one PO that disagree are refused.
- **Refusals:** unknown Line ID, another company, cancelled or fully received PO, a PO with a GRN, a bad date, a doc no that does not match, a duplicate Line ID.
- **Confirm re-checks the current values** and returns 409 on a conflict.
- **Proof so far:** staging round trip on HC-PO-2609-090 (change, then restore) was PROVEN.
- **Not proven:**
  - that a date import queues exactly one AutoCount edit per PO: UNTESTED on staging, unit tests only;
  - the change log on staging: UNKNOWN (staging key cannot read `entity_audit_log`, bug 0824).
- **Defect fixed on the way (ledger 0922):** the PO line save rebuilt Description 2 on every save. 35 open lines were exposed; whether any past edit erased one is UNKNOWN.
- **The dead "Import from file" menu item** (navigates to `?import=1`, which nothing reads) is still on the DO, delivery return, PI, purchase return, SI and SO lists.

### Supplier delivery dates
- **#3901 fill.**
  - Mapping, PROVEN against the live book: AutoCount `PO.UDF_EDate` ("Estimate Delivery Date") → `supplier_delivery_date_2`; `UDF_EDate2` → `_3`; `UDF_EDate3` → `_4`. These are header fields, cascaded to lines.
  - Plan run 34930145984, apply run 34930391830, re-plan run 34930684100 (0 left).
  - Filled 130 POs: 136 header slots and 413 line slots. 0 conflicts, 0 AutoCount outbox rows created.
- **#3907 write-back:** create, so-to-po and edit now send `EDate/EDate2/EDate3`. A blank slot is omitted, never sent as null.
  - Live proof is **UNTESTED**: no staff supplier-date edit had happened at merge time.
  - Read-only check once one happens: the audit row, then the outbox payload `body.Header.UDF`, then `SELECT UDF_EDate, UDF_EDate2, UDF_EDate3 FROM PO WHERE DocNo = …`.
- **Risk:** the PO edit page has no stale-form guard. A form opened before the fill and saved after it clears the filled header date. The audit log records both.

### Money format
- #3939 (screens, 26 files, desktop + mobile), #3946 (server-written messages), #3953 (grid and hand-written exports). A guard test in each was proven RED first.
- Houzs stores `unit_price_sen` as INTEGER, so unit prices have 2 decimals. This is LIKELY, read from the migrations, not checked live.

### Other fixes found along the way
- **#3952** (ledger 0928): a list with a saved column funnel re-rendered forever.
  - PROVEN in vitest.
  - LIKELY live on the PO, DO, PI and SI lists (and MRP, unchecked) since #2092 (2026-08-13), as high CPU rather than a freeze. Not observed in a browser.
- **#3935's first CI run hung.** The extracted filter/sort helpers returned a new array when nothing changed, which caused a render loop. Fixed before merge.
- **AutoCount data quality:** 37 book items are shaped like sofa pieces, and 34 of them have group OTHER. These were probably opened by `/ensure-masters`. AutoCount is untouched; the export no longer reads them.

### CI speed and rules file (2026-09-14/15)
- **#3889:** `CLAUDE.md` split into rules plus `docs/working-agreement-history.md`. 83,329 → 21,209 bytes. 121 rules are tagged and inventoried.
- **#3891:** frontend vitest sharded over 3 runners, with blob and coverage merge. A 3-shard coverage merge equalled a single run on the files compared locally. The deploy runs the light suite once and skips an unchanged frontend release.
- **#3895:** the merge queue reuses a green PR run on an identical tree.
  - PROVEN on its own queue run: 56 s, compared with about 5.5 min before.
  - Both roll-ups now require `changes` to succeed (ledger 0913).

## Not done, or open

- The SO and DO PRs (see Start here).
- **List page load cost:** the list endpoints now attach lines. The effect on list open time was not measured: UNKNOWN. If staff say a list got slower, measure this first.
- **Request-counting script:** the script count-export-requests.mjs sits (not on main) on remote branch `chore/export-request-count`, unmerged by decision.
- **Mobile:** no list export and no import, by the owner's decision.
- **Remaining Qty / Estimate Delivery Date differences** against the 09-04 AutoCount file were not traced line by line.
- **Delivery Return** has no AutoCount mapping. Purchase Return has 0 production rows.
