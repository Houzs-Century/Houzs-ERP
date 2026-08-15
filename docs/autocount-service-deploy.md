# AcSyncService — build and deploy on the AutoCount host

`backend/scripts/autocount-service/AcSyncService.cs` does not build in CI: it
references the licensed AutoCount 2.2 assemblies, which no GitHub runner has.

**But "only the office host can compile it" was FALSE, and believing it cost us
a defect.** The assemblies ship with the ordinary AutoCount 2.2 desktop install
and `csc.exe` ships with the .NET Framework, so any workstation with AutoCount
installed compiles this file - the owner's desktop included. Verified
2026-08-11: a clean build, byte-size identical to the `AcSyncService.prev.exe`
already on the host.

**Run `backend/scripts/autocount-service/build-local.ps1` before you push a C#
change.** It substitutes a dummy connection line, compiles, prints the size and
throws the binary away - it answers the one question CI cannot, which is DOES IT
COMPILE. The migration record's defect 4 (an over-transfer handler that could
never compile, sitting on `main`) is exactly what that check would have caught,
and the reason recorded for missing it - "a file that compiles on exactly one
machine in the building gets no CI" - was a premise nobody tested.

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

**Prefer `deploy-on-host.ps1`. The manual procedure below is what it automates,
kept because you need it when the script itself is what you are debugging.**

```
powershell -ExecutionPolicy Bypass -File deploy-on-host.ps1 -DryRun   # does it compile
powershell -ExecutionPolicy Bypass -File deploy-on-host.ps1           # compile, swap, verify
```

It does every step in 2.1 to 3 in order, and adds the two things a written
ritual cannot: it **refuses to swap an exe that did not compile**, and it
**rolls back by itself** if the new exe does not answer `/health` with the
expected book. It deletes `AcSyncService.build.cs` in a `finally`, so the
password does not survive a failed run either. To ask only "does the source
compile", with no credentials involved at all, use `build-local.ps1` — that runs
on any workstation with AutoCount 2.2 installed.

The rest of this section is the manual equivalent.

On the AutoCount host, in a directory containing `AcSyncService.cs`.

### 2.1 Substitute the DB connection line — EVERY occurrence

`__DBLINE__` is a placeholder that must be replaced with the real
`AutoCount.Data.DBSetting db = ...` line before compiling, so the DB password
never lives in source control.

> **It appears in THREE methods** — `Session()`, `DtlKeys()` and `CreatedLines()`
> — plus once more in the file header comment, so a global replace reports
> **four**. It used to appear in two. **A substitution that replaces only the
> first occurrence will not compile.** Use a global replace.

> **The connection line goes inside ORDINARY C# string literals, not verbatim
> ones, so every backslash in it is an escape sequence.** A named SQL instance is
> spelled `HOST\INSTANCE`, and pasting that raw fails to compile with **CS1009,
> three times** — one per substitution site. Write `HOST\\INSTANCE` in
> `dbline.txt`. `deploy-on-host.ps1` escapes this for you when it assembles the
> line from `setup.json`; it cannot when you hand it a `dbline.txt`, because at
> that point the file is already C# source and correcting it would be guessing.

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
  /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.Stock.dll" ^
  /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.ARAP.dll" ^
  /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.GeneralMaint.dll" ^
  /r:"C:\Program Files\AutoCount\Accounting 2.2\AutoCount.StockMaint.dll" ^
  /r:System.Web.Extensions.dll /r:System.Data.dll ^
  /out:AcSyncService.exe AcSyncService.build.cs
```

**THREE new assembly references** since `/ensure-masters` landed - `Stock`,
`ARAP` and `GeneralMaint` carry `ItemDataAccess`, `DebtorDataAccess` and
`SalesAgentCommand`. A build without them fails with CS0234 on the master-data
namespaces. `CreatedLines()` still needs nothing beyond `System.Data.dll`.

### 2.3 Delete the substituted source

```bat
del AcSyncService.build.cs
```

It contains the DB password.

---

## 3. Deploy

> **What is RUNNING on the host right now — 2026-08-15.** `deploy-on-host.ps1
> -Server ".\A2006"`, exit 0. The source it built is `main`'s
> `AcSyncService.cs` at SHA256 `b51e60a9…c933da` (57,382 bytes), fetched onto
> the host from the public raw URL — the two copies already on the machine were
> stale (`C:\Temp` 08-11, `C:\Temp\acbuild` 08-12) and would have rebuilt code
> four merged PRs behind. It compiled to **51,712 bytes** and reported:
>
> ```
> OK   health: {"ok":true,"book":"AED_HOUZS","service":"AcSyncService"}
> OK   database reachable: /ensure-masters answered 200 - the connection line works
> OK   listening on port 8900, as expected
> ```
>
> So `/ensure-masters` and `/further-description` — both of which the previous
> exe answered `404 unknown route` — are live. Rollback is
> `C:\Temp\AcSyncService.prev.exe`, and §5 is the procedure.
>
> Two things worth knowing before the next deploy:
>
> - **`setup.json` names `AED_DEMO`, not `AED_HOUZS`.** The script says so and
>   proceeds with the `-Book` value; that NOTE line is expected, not a warning
>   to chase. The book comes from `-Book` (default `AED_HOUZS`), the server from
>   `-Server`, and only the credentials come from the file.
> - **`-Server ".\A2006"` is not optional here.** Without it the value is taken
>   from `setup.json` and the build fails every real request with "Error
>   Locating Server/Instance Specified" while `/health` still passes — the exact
>   trap §4 was written against. `.\A2006` is what the host's own LINQPad
>   connection uses.
>
> **Getting a command onto that host is harder than it looks.** It is driven
> through UltraViewer, which does NOT pass Ctrl key combinations — so `Ctrl+V`
> pastes nothing, in the console and in LINQPad alike. In LINQPad use the
> **Edit menu's** Select All / Paste; in `conhost` use right-click, and note
> that a left-click first puts the console into QuickEdit selection, which
> FREEZES it and makes the next right-click copy instead of paste. Running the
> deploy from LINQPad's C# mode via `Process.Start` with the output redirected
> is more reliable than the console, and it captures the whole transcript.

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

### 4.6a The three cells 4.1-4.5 never touch

4.1 to 4.5 exercise create-SO and edit. `qa-convert.ps1` is `/create-po`,
`/so-to-do` and `/po-to-gr`, in order, over the public tunnel from any machine:

```
powershell -ExecutionPolicy Bypass -File qa-convert.ps1 -KeyFile <path> -IReallyMeanIt
```

**Which of those three have actually run is NOT recorded here.** This sentence
used to say all three had never run end to end, and by the time anyone read it
`/so-to-do` had consumed a real DO number. Run status lives in exactly one
place now — `docs/generated/autocount-coverage.md` — and nothing else may state
it.

It proves the convert actually LINKED the documents without needing a database:
step 6 cancels the parent SO **while its DO still exists and requires that to
fail**, because AutoCount refuses to cancel a transferred document. Then it
tears down child-before-parent. Read its header before running — the converts
consume real DO and GR running numbers, and the GR posts a real stock IN.

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
