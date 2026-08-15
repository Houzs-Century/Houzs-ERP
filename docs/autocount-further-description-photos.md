# FurtherDescription photos — can what the cutover took out go back in?

The owner's rule for the write-back is that **whatever the cutover extracted
from AutoCount is what must go back**. Photographs were extracted. They are not
going back, and this page establishes exactly how far the return path can be
built from here, what it costs, and the ONE observation that decides the rest.

**Answer, up front and labelled.**

| | |
|---|---|
| **PROVEN** | A JPEG can be put into RTF and taken back out **byte for byte**, with no dependency, no re-encoding and no image decoding, at a wire cost of exactly 2 characters per byte. `backend/scripts/lib/rtf-picture.mjs` does it and `backend/tests/rtfPicture.test.mjs` asserts it. |
| **PROVEN** | Size is not what stops this. AcSyncService refuses a body over 2 MiB; the busiest photographed document in the cutover carries five photographs, and at the one photo size ever measured that is 70,360 hex characters — 3.4% of the ceiling. |
| **UNKNOWN** | Whether AutoCount **renders** the RTF we would produce. Nothing in this repository, and nothing on this development machine, can open the licensed application or a serious third-party RTF engine. §5 is the host procedure that settles it, and §5.1 is the read that settles it in about ten minutes without writing anything. |
| **UNKNOWN, and cheaper to answer than to reason about** | Which RTF picture form AutoCount's own editor writes. 554 sales-order lines in the live book are holding the answer right now. Nobody kept a copy. |

**Nothing here is wired into the write-back.** `autocount-writeback.ts`,
`autocount-outbox.ts` and `AcSyncService.cs` are untouched by this change on
purpose: the composer change belongs after §5 has been done, because building it
now would mean shipping on an unobserved premise.

---

## 1. What the field is, and that it really is settable

`FurtherDescription` is a **line-level rich-text column**, one per document
detail. It is not `Desc2`; the two are separate properties on the same detail
class, listed side by side in the SDK dump.

AutoCount's own documentation calls it a rich text field and ships a database
maintenance function ("Set Empty Rich Text to NULL") that treats it as one of a
CLASS of rich-text columns — see their report-design note on
[Further Description showing spaces](https://www.autocountsoft.com/products/ac_accounting/helpfile/report_design___further_descri.htm),
and their note on
[rich text not showing properly](https://www.autocountsoft.com/products/ac_accounting/helpfile/report_design___rich_text_did_.htm),
which names the report-side renderer as DevExpress's `XRRichText` control.

It is settable on **all six** document detail classes the write-back drives, not
just the sales order. From `backend/scripts/autocount-service/sdk-api-reference.txt`
(a reflection dump of the installed assemblies, not documentation):

| line | class |
|---|---|
| 444 | `AutoCount.Invoicing.Purchase.PurchaseOrder.PurchaseOrderDetail` |
| 452 | `AutoCount.Invoicing.Purchase.PurchaseInvoice.PurchaseInvoiceDetail` |
| 460 | `AutoCount.Invoicing.Purchase.GoodsReceivedNote.GoodsReceivedNoteDetail` |
| 468 | `AutoCount.Invoicing.Sales.SalesOrder.SalesOrderDetail` |
| 476 | `AutoCount.Invoicing.Sales.Invoice.InvoiceDetail` |
| 484 | `AutoCount.Invoicing.Sales.DeliveryOrder.DeliveryOrderDetail` |

Every one of them declares `FurtherDescription:String` in its `SET:` list.

**And nothing sends it.** The string `FurtherDescription` appears **zero** times
in `backend/src` and **zero** times in `AcSyncService.cs`. Its only occurrences
in this repository are the two import scripts' header comments, the six SDK-dump
lines above, and one line of `docs/sofa-import-handoff.md`.

---

## 2. What the cutover took out

`backend/scripts/import-so-line-photos.mjs` states the path in its own header:

> The images were extracted locally from the AutoCount RTF (WMF->DIB->JPEG) and
> uploaded to the SO_ITEM_PHOTOS bucket under DETERMINISTIC keys:
> `so-items/<erp doc_no>/<item id>/ac-<AC DtlKey>-<n>.jpg`

The two manifests in `backend/scripts/data/` are what survives of that pass:

| | `ac-photo-manifest.json.gz` (SO) | `ac-po-photo-manifest.json.gz` (PO) |
|---|---|---|
| rows (images) | 554 | 190 |
| distinct AutoCount lines | 554 | 183 |
| distinct AutoCount documents | 480 | 158 |
| images per line | 1 on every line | 1 on 177, 2 on 5, 3 on 1 |
| images per document | 1 on 418, 2 on 54, 3 on 5, 4 on 2, **5 on 1** | 1 on 130, 2 on 24, 3 on 4 |
| pixel width, min–max | 107–240 | 110–1280 |
| pixel height, min–max | 43–240 | 60–1038 |

Combined, 744 images, of which **nine** exceed 240x240. The busiest document is
`SO-012907` with five.

Each manifest row is `{DocNo, DtlKey, ItemCode, file, w, h}` (the PO manifest
adds `Desc2`). **`w` and `h` are the only geometry that survives**, and the
manifest does not record whether they came from `\picw`/`\pich` (source pixels)
or from `\picwgoal`/`\pichgoal` (printed twips) — see §7.

### 2.1 The raw RTF was not kept, and neither was the extractor

This is the single most consequential gap on the page.

- `git ls-files | grep -ci '\.rtf$'` → **0**. There is no RTF sample anywhere in
  the tree.
- The word `\pichgoal` appears **exactly once** in the whole repository, in
  `docs/sofa-import-handoff.md`, in a sentence pointing at two `BUG-HISTORY.md`
  entries — and **neither entry exists**. `grep -i pichgoal BUG-HISTORY.md`
  returns nothing. Whatever the extractor learned about picture geometry was
  written down as a cross-reference to a record that was never written.
- The extractor itself is not in this repository either. What it saw — which
  RTF keyword each `\pict` carried, what the header of each document looked
  like, whether any line held text as well as a picture — is unrecorded.

So the ground truth for "what a real `FurtherDescription` looks like" exists in
exactly one place: **the live `AED_HOUZS` book**, on the 554 + 183 lines that
still hold it. §5.1 is one query away from having it back.

---

## 3. What a return trip would have to produce

RTF carries a picture as a `{\pict ...}` group whose payload is hex, tagged with
a keyword naming the source format. The spec defines these, and this is the
whole decision space:

| keyword | source | can this repo produce it from a JPEG? |
|---|---|---|
| `\jpegblip` | JPEG | **yes** — the bytes go in verbatim |
| `\pngblip` | PNG | no — needs a JPEG decode and a PNG encode |
| `\emfblip` | enhanced metafile | no — needs pixels |
| `\wmetafileN` | Windows metafile | no — needs pixels |
| `\dibitmapN` | Windows device-independent bitmap | no — needs pixels |

A DIB is raw pixels and a WMF wraps a DIB, so every form except `\jpegblip`
requires decoding the JPEG, and this repository has no image library:
`backend/package.json` carries `@supabase/supabase-js`, `drizzle-orm`, `hono`,
`postgres`, `qrcode-generator`, `zod` and nothing that decodes an image.

**Ruled out: BI_JPEG.** A `BITMAPINFOHEADER` may declare
`biCompression = BI_JPEG`, which would let a DIB carry the JPEG without a
decode. GDI only honours that where the device driver supports it, which
display drivers generally do not — so it would render blank rather than fail
loudly, and a silently blank photograph is worse than none. Not attempted.

**Where the conversion is cheap: the Windows host.** On the AutoCount machine,
JPEG to WMF/DIB is a `System.Drawing` call. If §5 says AutoCount will not take a
`\jpegblip`, the conversion belongs in `AcSyncService.cs` — which means the
eventual wiring change is a HOST change, not a Worker change, and that is the
main thing this page is telling whoever picks it up next.

### 3.1 What was tried locally, and why it settles nothing

macOS `textutil` was fed a `\jpegblip` document and then a `\pngblip` document.
It **dropped the picture from both** — its RTF pipeline routes images to `.rtfd`
attachments and does not read an inline `\pict` at all. That makes it useless as
an oracle in either direction: it is not evidence that our RTF is malformed, and
it would not have been evidence that it is well-formed. No serious third-party
RTF engine (LibreOffice, Word) is installed on the development machine, and
installing one would still not be AutoCount.

**There is no local oracle. §5 is the only one.**

---

## 4. The experiment, and what it proves

`backend/scripts/lib/rtf-picture.mjs` is a pure, dependency-free pair of halves:
a **writer** that builds the RTF, and a **reader** that says what is inside one.
`backend/scripts/further-description-rtf.mjs` is the CLI over it. It opens no
database, holds no credential, and its only input is a file on disk.

```
$ node backend/scripts/further-description-rtf.mjs build \
    --dpi 96 --text "RDS-5526 SOFA" --out out.rtf probe.jpg
  probe.jpg: 24x16px, 689 bytes -> 1378 hex chars
  RTF: 1559 bytes (0.1% of AcSyncService's 2097152-byte body ceiling, for this ONE line)

$ head -c 200 out.rtf
{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fnil Arial;}}
\viewkind4\uc1\pard\f0\fs20
RDS-5526 SOFA\par
{\pict\jpegblip\picw24\pich16\picwgoal360\pichgoal240
ffd8ffe000104a46494600010100004800480000ffc000110800100018...

$ node backend/scripts/further-description-rtf.mjs inspect out.rtf --extract ./x
out.rtf: 1559 chars, 1 picture group(s)
  [0] form=jpegblip
      picw=24 pich=16 picwgoal=360 pichgoal=240
      689 bytes from 1378 hex chars
      leading bytes: ff d8 ff e0 00 10 4a 46
      -> ./x/pict-0.jpg

$ cmp probe.jpg ./x/pict-0.jpg && echo IDENTICAL
IDENTICAL
```

The test file asserts the same round trip against a real 24x16 baseline JPEG
carried inline — real on purpose, because a hand-assembled marker sequence would
let a parser reading the wrong offset pass. It also pins the parts that fail
QUIETLY, which are the ones worth a test:

- the frame dimensions come from the JPEG's own SOF header, and a truncated
  file that leaves only a Huffman table (`FF C4`, which sits inside the
  `C0..CF` range and is **not** a frame header) throws instead of returning
  four bytes of a DHT segment as a size;
- `dpi` is a **required** parameter, because it decides the printed size
  (`\picwgoal = px * 1440 / dpi`), and CLAUDE.md's rule is that a parameter
  which decides something is never optional;
- the writer **refuses** `pngblip` / `wmetafile` / `dibitmap` / `emfblip`
  rather than emitting JPEG bytes under a metafile keyword;
- the reader recognises all five forms, finds pictures nested inside
  `{\*\shppict{\pict …}}` and `{\nonshppict{\pict …}}`, reports an
  unrecognised keyword as `null` rather than as a default, and surfaces an odd
  hex-digit count instead of silently rounding a nibble away.

**The reader is the more important half.** It is what turns §5.1 from an opinion
into a measurement.

---

## 5. What a human must do on the AutoCount host

Written to be followed in one sitting by someone who did not write this change,
in the shape of `docs/autocount-service-deploy.md`. **§5.1 alone is worth doing
even if nothing else on this page is ever built**, and it writes nothing.

CLAUDE.md's rule is *never ask the owner to run a query, build the check
instead*. That rule is about the ERP's Postgres, which every workflow here can
reach with `secrets.DATABASE_URL`. **The AutoCount book has no such channel**:
the only automated path into it is `AcSyncService.cs`, that file is owned by
another change in flight, and it exposes no read route. So §5.1 is manual TODAY
and should not stay that way — the durable version is a read-only
`/further-description?dtlkey=N` route on the service, and that is the first
thing to add once the file is free.

### 5.1 Read one real value out of the book (READ-ONLY, ~10 minutes)

This is the step that answers the open question. Do it on the AutoCount host,
against `AED_HOUZS`, in SQL Server Management Studio or `sqlcmd`.

**a. Confirm the column name.** The SDK property is `FurtherDescription`; the
column has not been observed. Do not assume they match:

```sql
SELECT name, system_type_id, max_length
FROM sys.columns
WHERE object_id = OBJECT_ID('SODTL') AND name LIKE '%Further%';
```

**b. Pick a line that is known to hold a photograph.** Any `DtlKey` from
`backend/scripts/data/ac-photo-manifest.json.gz` will do; these three are the
first rows of it:

| DocNo | DtlKey | ItemCode | manifest w x h |
|---|---|---|---|
| `SO-000368` | 34553 | `RDS-5526 SOFA` | 240 x 159 |
| `SO-000383` | 34737 | `HOK-2009(A) (K)` | 240 x 50 |
| `SO-002559` | 165891 | `RDS-5527 SOFA` | 148 x 240 |

```sql
SELECT d.DtlKey, d.ItemCode, DATALENGTH(d.FurtherDescription) AS bytes
FROM SODTL d WHERE d.DtlKey IN (34553, 34737, 165891);
```

**c. Save one whole value to a file.** In SSMS: run
`SELECT d.FurtherDescription FROM SODTL d WHERE d.DtlKey = 34553;`, right-click
the cell, *Save Results As* → `ac-34553.rtf`. Or from the command line:

```
sqlcmd -S <server> -d AED_HOUZS -E -y 0 -h -1 -W ^
  -Q "SET NOCOUNT ON; SELECT FurtherDescription FROM SODTL WHERE DtlKey = 34553" ^
  -o ac-34553.rtf
```

**Check the size before you trust the file.** `sqlcmd` truncates a
variable-length column to 256 characters unless `-y 0` is given, and a truncated
RTF looks exactly like a small photograph. The file must be about half the
`bytes` figure from (b) if the column is `ntext`/`nvarchar` (two bytes per
character), or about the same if it is `varchar`. **If it is 256 bytes, it was
truncated — use the SSMS route.**

**d. Read it.** On any machine with node:

```
node backend/scripts/further-description-rtf.mjs inspect ac-34553.rtf --extract ./ac
```

**Write the `form=` line it prints into this document.** That single word is the
answer to "which RTF picture form does AutoCount write", and everything after it
follows mechanically:

| if it prints | then |
|---|---|
| `form=jpegblip` | The return path is already built. Wire `rtfPicture()` into the composer and go to §5.2 for confirmation only. |
| `form=wmetafile8` (expected, given `WMF->DIB->JPEG`) | AutoCount writes metafiles. §5.2 decides whether it also *reads* a `\jpegblip`; if it does not, the JPEG→WMF conversion goes into `AcSyncService.cs` with `System.Drawing`, and the Worker sends raw bytes rather than RTF. |
| `form=pngblip` / `dibitmap0` / `emfblip` | Same as above with a different target encoder. |
| `form=UNRECOGNISED` or `0 picture group(s)` | **Stop and re-open the premise.** The photographs are carried some other way, and that is the finding — record it here rather than building anything. |

**e. Compare the extracted picture with ours.** `./ac/pict-0.*` is what AutoCount
stored. The ERP's copy of the same photograph is R2 key
`so-items/<erp doc_no>/<item id>/ac-34553-1.jpg`. If the AutoCount side is a
metafile, they will not be byte-identical and are not expected to be; what
matters is whether the picture is the same picture and the same size.

### 5.2 The write probe (WRITES — scratch document only)

Only after 5.1. **Never on a customer document**, and never on a line that
already holds a `FurtherDescription`: the whole risk of this feature is
overwriting a value AutoCount owns.

1. In the AutoCount UI, create a **new sales order** for a test debtor with one
   line. Note its `DocNo` and read back its `DtlKey` with the query in 5.1(b).
2. Build the candidate RTF from a real extracted photograph:
   `node backend/scripts/further-description-rtf.mjs build --dpi 96 --out probe.rtf <a real ac-*.jpg>`
   — use the dpi implied by 5.1's `picw` vs `picwgoal` ratio if it is not 96.
3. Set it on that one line through the SDK, on the host, in a scratch C# script
   (not through `AcSyncService.cs` — that file is owned by another change):
   load the order, `EditDetail(dtlKey)`, assign `FurtherDescription`, `Save()`.
4. **Record four observations, all four:**

   | | what to look at | what a pass looks like |
   |---|---|---|
   | i | the entry screen's Further Description editor for that line | the photograph is visible, right way up, roughly the size the manifest says |
   | ii | *Preview* of the printed sales order | the photograph appears in the printed document |
   | iii | re-run 5.1(c)+(d) against the same `DtlKey` | AutoCount either stored our bytes unchanged, or **rewrote them into its own form** — either is an answer, and the second one is the more useful one |
   | iv | the AutoCount log / any dialog on Save | no silent truncation of the string |

5. Cancel the scratch document (the owner's rule: nothing is deleted, only
   cancelled).

A picture that appears in (i) but not (ii) is a real outcome, not a partial
one: the entry editor and `XRRichText` are different renderers, and the printed
document is the one the customer sees.

### 5.3 What would make this a failure worth stopping on

Any of: the string is truncated on save; the picture appears as a red X or a
filename; AutoCount silently discards the `\pict` group and keeps only the text;
the entry screen renders it but Preview does not. In each case the answer is
"AutoCount will not take our RTF **in this form**", which is a good answer —
write it in §3's table and move the conversion to the host.

---

## 6. Size, risk, and what an edit must not do

### 6.1 How many lines

Measured against **production**, today, by dispatching the two read-only RESOLVE
workflows that already exist for this (`apply: "0"` is their default, so the run
opens the database and writes nothing):

```
$ gh workflow run import-so-line-photos.yml -f target=prod -f apply=0
$ gh workflow run import-po-line-photos.yml -f target=prod -f apply=0

run 31859813791, 2026-08-15T02:41:03Z
  manifest rows: 554; sofa held: 18; unmapped: 0; order-not-imported: 4; line-missing: 0
  photo keys planned: 532 (already attached: 520)

run 31859815380, 2026-08-15T02:41:08Z
  manifest rows: 190; sofa held (PO not imported): 30; unmapped: 0; PO-not-imported: 0; line-missing: 0
  photo keys planned: 160 (already attached: 51)
```

| population | count | how it is known |
|---|---|---|
| AutoCount SO lines that held a photograph at cutover | **554** | `ac-photo-manifest.json.gz`, one row per line |
| AutoCount PO lines that held a photograph at cutover | **183** (190 images) | `ac-po-photo-manifest.json.gz` |
| **AutoCount-origin photo keys ON ERP lines right now** | **520 SO + 51 PO = 571** | the `already attached` counts above |
| keys the mapping resolves but which are not attached | 12 SO, 109 PO | `planned` minus `already attached` |
| SO photographs with no ERP line to hang on | 18 held (sofa) + 4 on documents never imported | run 31859813791 |
| PO photographs with no ERP line to hang on | 30 (the purchase order itself was not imported) | run 31859815380 |

**571 is the number that matters** — it is what the ERP is holding today that
AutoCount gave it, and therefore what the owner's rule says must be able to go
back. Not 13,916; under 4% of the AutoCount-linked sales-order lines, and every
one of them on a MIGRATED document.

The 109 unattached PO keys are a separate, pre-existing gap: the PO import's
last APPLY run attached 51 and the resolver now maps 160. It is recorded here
because it changes the sizing if it is ever closed, not because this change
touches it.

**Do not size this from the migration record.**
`docs/autocount-migration-record.md` line 1096 says *"983 SO + 242 PO keys in
R2"*. That number predates the owner's 2026-08-10 instruction that a sofa
photograph hangs on the first compartment only (*"每个 SKU 的照片都一样,留第一个
就可以了"*) and the prune that carried it out — `Prune duplicate sofa photos`,
run 31384579900, 2026-08-10T11:44Z:

```
SALES ORDER:    APPLIED — 405 rows updated, 457 keys removed
PURCHASE ORDER: APPLIED — 103 rows updated, 127 keys removed
```

The sales-order side reconciles exactly: 983 − 457 = **526**, which is what the
RESOLVE run three hours later that same day reported as `already attached`. It
is 520 today.

**The purchase-order side does not reconcile and this page is not going to
pretend it does.** 242 − 127 = 115, and the RESOLVE run after the prune reported
51 attached, as does today's. Either the 242 counts something other than
attached keys, or a step between is unrecorded. Whichever it is, **51** is the
measured present-day figure and 242 should not be used for sizing until someone
establishes what it counted.

### 6.2 Line identity is already there, and in two places

An `/edit` addresses a line by AutoCount's `DtlKey` and **refuses a line that
has none** (`docs/autocount-service-deploy.md` §1.1). That was once fatal to
this idea — on 2026-08-11 zero of 13,907 sales-order lines carried one. It is
not fatal now. `backend/scripts/backfill-ac-line-keys.mjs`, run against
production in DRY-RUN on 2026-08-12 (run 31607804485), reported:

```
SO lines: erp lines 13916; to set 1; already set 12904; no AC match 986; count mismatch 27 (skipped 25 lines in ambiguous groups)
PO lines: erp lines 873; to set 0; already set 273; no AC match 600; count mismatch 0 (skipped 0 lines in ambiguous groups)
```

`linked_ac_dtlkey` (mig 0273) is populated on 12,904 SO lines and 273 PO lines.

And for the photographed lines specifically there is a **second, independent
copy of the same key**: the R2 object key is
`so-items/<doc_no>/<item id>/ac-<DtlKey>-<n>.jpg`, so the AutoCount `DtlKey` is
recoverable from `photo_urls` with a regex on exactly the lines this feature
cares about. Two sources that must agree is a gift — zip them and refuse on
disagreement, the same discipline `composeEdit` already applies to the
create-time `DtlKey` index-zip.

### 6.3 What an edit must do, and what it must never do

The rule here is settled and already structurally supported. `AcSyncService.cs`
sets a detail field only when the payload CARRIES the key:

```csharp
if (it.ContainsKey("Description")) Set(() => d.Description = Str(it, "Description"));
if (it.ContainsKey("Desc2"))       Set(() => d.Desc2 = Str(it, "Desc2"));
```

So `FurtherDescription` follows the same shape and inherits the same guarantee:
**a key the ERP does not own is OMITTED, never sent as null.** Three cases, and
the composer has to decide each one deliberately:

| case | what to send |
|---|---|
| the ERP line's photos are exactly the `ac-*` keys the cutover put there, unchanged | **omit the key.** Re-sending an unchanged value can only lose. This is the overwhelming majority of the 571. |
| the operator ADDED photographs in the ERP that AutoCount never had | this is the case worth building for, and it is the one that needs 5.1's answer: sending a `FurtherDescription` here **replaces** the whole field, so the AutoCount-origin picture must be re-emitted alongside the new ones or it is destroyed. The field is one string; there is no append. |
| the operator REMOVED an `ac-*` photo in the ERP | **do not act on this yet.** An ERP-side removal is not evidence the account book should lose its copy, and no owner rule covers it. Omit, and raise it. |

**The duplication risk is real and is a property of the field, not of the code.**
`FurtherDescription` is a single string that is replaced wholesale. Any composer
that builds it from the ERP's photo list without first reading what AutoCount
holds will either duplicate (if it appends) or destroy (if it replaces). That is
why 5.1 has to be answered before anything is wired: **the write needs a read.**

### 6.4 Payload size

`AcSyncService.cs:149` — `const int MaxBody = 2 * 1024 * 1024;`, enforced at
`:172` and `:175`, answering HTTP 413. Hex doubles the picture, and the payload
carries every line of the document, so the ceiling belongs to the DOCUMENT.

The only photograph whose transfer size has ever been measured is **7,036
bytes** (`BUG-HISTORY.md`, "Photos still rendered err after the bucket-name
fix" — the proxy route answered `200 image/jpeg 7036 bytes`). At that size the
worst document in the corpus, `SO-012907` with five photographs, costs 70,360
hex characters, 3.4% of the ceiling.

**That is arithmetic on ONE measurement, and it is the weakest number on this
page.** 735 of the 744 images are at most 240x240, which is consistent with it;
nine are larger, up to 1280x1038, and nobody has weighed those. `rtfPayloadBytes()`
exists so a composer can check before it sends rather than after AutoCount
answers 413.

---

## 7. Ruled out, and still open

**Ruled out**

- *"`FurtherDescription` is just `Desc2`."* No — both are separate `SET:`
  properties on all six detail classes, and `Desc2` is already sent while
  `FurtherDescription` never is.
- *"The photographs might not really be in that field."* The import scripts name
  it, twice, and 744 images came out of it.
- *"The SDK's `String` typing is the limit."* .NET strings are not the
  constraint; the 2 MiB HTTP body is, and it is not binding at these sizes.
- *"A local RTF engine can tell us whether the output is acceptable."* macOS
  `textutil` drops every inline `\pict`, `\pngblip` included (§3.1). It is not
  an oracle.
- *"Line identity blocks this."* It did on 2026-08-11; the backfill has since
  populated 12,904 SO keys (§6.2).
- *"BI_JPEG lets a DIB carry a JPEG without a decode."* Technically true,
  practically blank on a display driver (§3).

**Still UNKNOWN**

1. **Which picture form AutoCount writes.** §5.1. Everything else waits on it.
2. **Whether AutoCount reads a form it did not write.** §5.2(i) and (ii),
   separately — the entry editor and `XRRichText` are different renderers.
3. **The source dpi.** The manifests record `w`/`h` in pixels but not which RTF
   field they came from, and `\picwgoal` is what decides printed size. 5.1's
   output gives both numbers for one real line and settles the ratio.
4. **The column's SQL name and type.** `SODTL.FurtherDescription` is the
   expected name and has not been observed; 5.1(a) checks it.
5. **Whether any of the 571 lines' `FurtherDescription` also holds TEXT.** If it
   does, replacing the field with pictures alone destroys it. The reader reports
   picture groups; the surrounding text needs looking at in the same dump.
6. **What the nine large images weigh.** §6.4.
7. **Whether the same treatment is wanted on DO / IV / GR / PI lines.** The
   field exists on all six (§1); only SO and PO were extracted.

---

## 8. See also

- `docs/autocount-service-deploy.md` — the host build/deploy procedure this
  page's §5 is written in the shape of, and §1.1 for why a line needs a `DtlKey`
- `docs/autocount-migration-record.md` — the cutover, including the line-photos
  row of its inventory table
- `docs/sofa-import-handoff.md` §8.1 — the photo extraction as it was recorded
  at the time
- `backend/scripts/import-so-line-photos.mjs` / `import-po-line-photos.mjs` —
  the inbound half, and the deterministic key format §6.2 relies on
