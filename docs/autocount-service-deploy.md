# AcSyncService — build and deploy on the AutoCount host

`backend/scripts/autocount-service/AcSyncService.cs` is the only piece of this
repository that does **not** build in CI. It references the licensed AutoCount
2.2 assemblies, which exist only on the AutoCount host, so CI cannot compile it
and no automated test covers it. It is reviewed as source here and built by hand
there.

This page is the whole procedure. It is written to be followed in one sitting by
someone who did not write the change.

---

## 1. What changed on 2026-08-11, and why it matters

Three changes, all about **line identity** — the ERP's ability to name a single
line inside an AutoCount document.

### 1.1 `/edit` refuses a line it cannot identify (the safety guard)

Before: a line arriving without a `DtlKey` fell through to `doc.AddDetail()`.

That fallback reads as "this must be a new line". It is not. Measured against
production on 2026-08-11:

| | lines on AutoCount-linked documents | carrying a `DtlKey` |
|---|---|---|
| Sales-order lines | 13,907 | **0** |
| Purchase-order lines | 864 | **0** |

Every line of every document was keyless, so the first edit of any document
would have appended a **second copy of every line the operator did not touch**
into the live `AED_HOUZS` book. On a purchase order those duplicates are
permanent: `PurchaseOrder` exposes no `DeleteDetail` and no line-level
`Cancelled` in this SDK. Only `SalesOrder` has `DeleteDetail` at all.

Now: a keyless line is refused unless the caller explicitly sets
`"IsNewLine": true` on it. The check runs as a **pre-flight pass over every
line before any detail is touched**, so a refusal leaves the document exactly as
AutoCount already had it — not half-applied.

Refusal returns HTTP 500 with a message naming the line, its position, and its
`ItemCode`. Nothing is saved.

### 1.2 Create and convert routes return the created `DtlKey`s

Before: `/create-so`, `/create-po` and the four convert routes answered
`{ ok, docNo }`. The created line keys were never returned, which is *why* every
ERP-created document had NULL line identity forever.

Now they answer:

```json
{ "ok": true,
  "docNo": "SO-2608-003",
  "lines": [ { "Seq": 0, "DtlKey": 481920, "ItemCode": "AKM-QD", "Desc2": "..." },
             { "Seq": 1, "DtlKey": 481921, "ItemCode": "TRION-KD", "Desc2": "..." } ] }
```

`lines` is ordered by `DtlKey`, which is creation order. `ItemCode` and `Desc2`
travel with each key so the ERP can **assert** its index-zip is correct and
refuse to store anything when the two disagree. A wrong `DtlKey` is worse than
no `DtlKey`: no key is refused loudly by 1.1, a wrong key silently edits a
different line.

The read-back is best-effort and can never fail a create that already
succeeded — if the read-back throws, the response still carries `docNo` with an
empty `lines`, and the document simply degrades to the refusal path on a later
edit.

### 1.3 A line can be retired in place

The owner's rule is that nothing is ever deleted, only cancelled. The SDK gives
no way to honour that at line level: the string `Cancelled` appears **zero
times** in `sdk-api-reference.txt`, and five of the six document classes have no
line-removal method at all.

So retirement is expressed in the fields that do exist. Send `"Retire": true`
on a line and `/edit` sets:

| field | value | why |
|---|---|---|
| `Qty` | `0` | **Load-bearing.** AutoCount's own outstanding predicate is `Qty - ISNULL(TransferedQty,0) > 0`. Only zeroing the quantity makes AutoCount's outstanding set agree with an ERP line that has been retired. |
| `Transferable` | `false` | Stops the line being pulled into a later DO or GRN. |
| `Desc2` | `[ERP-CANCELLED] <previous Desc2>` | What a human reads on the printed document and in SQL. |

`Qty = 0` is deliberately **not** wrapped in the `Set()` helper. `Set()` swallows
exceptions; a silently-skipped `Qty = 0` would leave the line outstanding in
AutoCount while the ERP believes it is cancelled, which is the exact divergence
the change exists to prevent. It fails the whole edit instead.

`PrintOut` is deliberately left alone. A retired line stays visible on the
printed document, marked. Hiding it would be deletion wearing a different hat.

---

## 2. Build

On the AutoCount host, in a directory containing `AcSyncService.cs`.

### 2.1 Substitute the DB connection line — EVERY occurrence

`__DBLINE__` is a placeholder that must be replaced with the real
`AutoCount.Data.DBSetting db = ...` line before compiling, so the DB password
never lives in source control.

> **It now appears in THREE methods** — `Session()`, `DtlKeys()` and the new
> `CreatedLines()`. It used to appear in two. **A substitution that replaces only
> the first occurrence will not compile.** Use a global replace.

```bat
powershell -Command ^
  "(Get-Content AcSyncService.cs -Raw) -replace '__DBLINE__', (Get-Content dbline.txt -Raw).Trim() ^
   | Set-Content AcSyncService.build.cs -Encoding UTF8"
```

Verify before compiling — this must print `0`:

```bat
findstr /C:"__DBLINE__" AcSyncService.build.cs | find /C "__DBLINE__"
```

### 2.2 Compile

Unchanged from the existing procedure except the input filename:

```bat
csc.exe /platform:x64 ^
  /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.dll" ^
  /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Invoicing.dll" ^
  /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Sales.dll" ^
  /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Purchase.dll" ^
  /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Accounting.dll" ^
  /r:System.Web.Extensions.dll /r:System.Data.dll ^
  /out:AcSyncService.exe AcSyncService.build.cs
```

No new assembly references are needed. `CreatedLines()` uses
`System.Data.SqlClient`, already referenced via `System.Data.dll`, and the same
`db.ConnectionString` that `DtlKeys()` has always used.

### 2.3 Delete the substituted source

```bat
del AcSyncService.build.cs
```

It contains the DB password.

---

## 3. Deploy

1. Stop the running `AcSyncService.exe`.
2. Keep the previous `.exe` as `AcSyncService.prev.exe` — this is the rollback.
3. Copy the new `.exe` into place and start it.
4. Confirm it is listening:

```bat
curl -X POST http://localhost:8900/health -H "X-API-KEY: %ACKEY%"
```

Expect `{"ok":true,"book":"AED_HOUZS","service":"AcSyncService"}`.

---

## 4. Verify against the TEST book before the live one

Do not accept this change on evidence from `/health` alone. The three changes
are all about behaviour under edit, and only an edit proves them.

Run these against a **test book**, not `AED_HOUZS`.

### 4.1 A create now returns line keys

```
POST /create-so   { DocNo, DebtorCode, Details:[ {ItemCode, Qty, UnitPrice}, ... ] }
```

**Pass:** the response contains a `lines` array with one entry per detail, each
with a non-zero `DtlKey`, and `ItemCode` matching what was sent, in order.
**Fail:** `lines` is absent or empty — check `C:\Temp\ac-sync-service.log` for a
`CreatedLines(...) failed:` line.

### 4.2 The guard refuses a keyless line

```
POST /edit   { DocType:"SO", DocNo:"<the SO above>",
               Lines:[ { ItemCode:"...", Qty: 5 } ] }        <- no DtlKey
```

**Pass:** HTTP 500, body `{"ok":false,"error":"REFUSED: line 1 of 1 ... carries
no DtlKey and does not declare IsNewLine ..."}`, **and re-opening the document
in AutoCount shows the original line count, unchanged.** That second half is the
real test — confirm the document was not modified.
**Fail:** HTTP 200, or the document gains a line.

### 4.3 An edit by key updates rather than appends

```
POST /edit   { DocType:"SO", DocNo:"<same>",
               Lines:[ { DtlKey:<from 4.1>, Qty: 9 } ] }
```

**Pass:** the line count is unchanged and the quantity is now 9.

### 4.4 An explicitly new line is still allowed

```
POST /edit   { DocType:"SO", DocNo:"<same>",
               Lines:[ { ItemCode:"...", Qty:1, IsNewLine:true } ] }
```

**Pass:** exactly one line is added.

### 4.5 Retirement zeroes the quantity

```
POST /edit   { DocType:"SO", DocNo:"<same>",
               Lines:[ { DtlKey:<key>, Retire:true } ] }
```

**Pass:** the line still exists, `Qty` is 0, and `Desc2` begins
`[ERP-CANCELLED]`. Then confirm the line no longer appears as outstanding —
`SELECT Qty - ISNULL(TransferedQty,0) FROM SODTL WHERE DtlKey = <key>` must
return 0 or less.

### 4.6 Only then, the live book

Repeat 4.1 and 4.2 against `AED_HOUZS` using a throwaway document number, and
**cancel** the document afterwards (`/cancel`) — never delete it. 4.2 in
particular is safe on the live book by construction: a passing guard writes
nothing.

---

## 5. Rollback

Stop the service, restore `AcSyncService.prev.exe`, start it.

Rolling back re-opens the duplicate-append defect, so it should be paired with
turning the ERP write-back toggle off:

```sql
UPDATE scm.app_config SET value = 'off' WHERE key = 'scm.autocount_writeback';
```

The ERP side carries its own copy of the keyless-line refusal, so an
un-upgraded service is not silently exposed — but the toggle is the fast stop.

---

## 6. What the ERP must do with `lines`

For reference; this half lives in the ERP and is described in
`docs/modules/autocount-writeback.md`.

On a successful create/convert the drain stores each returned `DtlKey` into
`scm.mfg_sales_order_items.linked_ac_dtlkey` /
`scm.purchase_order_items.linked_ac_dtlkey`, zipping by index and **verifying
`ItemCode` matches** before writing. A mismatch stores nothing and records the
outbox row as failed, because a wrong key is worse than no key.
