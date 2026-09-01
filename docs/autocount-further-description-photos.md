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
| ~~**UNKNOWN, and cheaper to answer than to reason about**~~ **PROVEN 2026-08-15** | Which RTF picture form AutoCount's own editor writes: **`\wmetafile8`**. Read off three live lines — see §4.2. |

**Nothing here is wired into the write-back.** `autocount-writeback.ts`,
`autocount-outbox.ts` and `AcSyncService.cs` are untouched by this change on
purpose: the composer change belongs after §5 has been done, because building it
now would mean shipping on an unobserved premise.

> **§5.1 HAS NOW BEEN DONE — 2026-08-15.** The three `SELECT`s were run against
> the live `AED_HOUZS` book through LINQPad on the AutoCount host. **§4.2 below
> carries the measured values**, and they decide the return path: AutoCount
> writes metafiles, so the JPEG-to-metafile conversion belongs in
> `AcSyncService.cs` on the Windows host, exactly as §3 predicted. Four of §7's
> seven open questions are closed by that one read; three remain.

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

> **CLOSED 2026-08-31 — there is an extractor again.**
> `backend/scripts/export-ac-line-photos.py` takes every picture-bearing line
> out of the book to JPEG with a manifest, and it is IN this repository, which
> is the whole point of it. It reuses `further-description-rtf.mjs` for the RTF
> half and adds the `WMF -> DIB -> JPEG` step this repo never had. Cross-checked
> against the two `DtlKey`s that appear in both the round-1 manifest and a
> 20-line sample of its output — 34553 and 34737 — the pixel dimensions come
> back identical (240x159 and 240x50), which is the evidence that the new path
> and the lost one agree.
>
> The paragraph above is left standing because the LESSON is not closed: the
> round-1 extractor was thrown away and cost months of not being able to take a
> photograph out. The counts in this section are still round 1's, and they are
> **not** the book's — see §7 item 8 for the census.

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
  hex-digit count instead of silently rounding a nibble away;
- **a `{\*\blipuid <32 hex digits>}` sub-group does not become part of the
  photograph.** Word and the Win32 RichEdit both emit one immediately before the
  picture data, and those 32 characters are a legal hex run — a reader that
  takes "everything after the last control word" from the raw text prepends 16
  bytes of somebody's identifier and returns a file that is corrupt in a way no
  length check notices. Given `WMF->DIB->JPEG`, this is the shape most likely to
  be in the live values §5.1 dumps, so it is pinned by a test that has been
  observed RED with the guard removed.

**The reader is the more important half.** It is what turns §5.1 from an opinion
into a measurement.

### 4.2 The measurement — three live lines, 2026-08-15

**PROVEN.** Tool: LINQPad on the AutoCount host, connection `.\A2006` /
`AED_HOUZS`, three read-only `SELECT`s. Nothing was written and no document was
opened in the AutoCount UI (§5's own rule).

**Step 1 — the column.** One match, and the SDK's name is the column's name:

```
name = FurtherDescription    system_type_id = 231    max_length = -1
```

`231` is `nvarchar` and `max_length = -1` is `(MAX)`. So the photographs are
stored as **Unicode text**, not as a binary column: RTF, exactly as assumed.

**Step 2 and 3 — the three manifest lines.** `DATALENGTH` in bytes, `LEN` in
characters, picture-group counts by keyword:

| DtlKey | ItemCode | chars | bytes | `{\pict` | `\wmetafile8` | `\pngblip` | `\jpegblip` |
|---|---|---|---|---|---|---|---|
| 34553 | `RDS-5526 SOFA` | 229,439 | 458,878 | 1 | 1 | 0 | 0 |
| 34737 | `HOK-2009(A) (K)` | 72,478 | 144,956 | 1 | 1 | 0 | 0 |
| 165891 | `RDS-5527 SOFA` | 213,598 | 427,196 | 1 | 1 | 0 | 0 |

**Not truncated, and provably so:** `chars x 2 = bytes` for all three, which is
the identity an `nvarchar` column satisfies only when the whole value is in
hand. That is the check the listing's step 3 existed to force, and it is met
without saving a file.

The head of `DtlKey = 34553`, verbatim:

```rtf
{\rtf1\ansi\deff0
{\fonttbl{\f0 Arial;}}
\viewkind4\uc1\pard\fs20 Image on 8/12/2024 5:01:16 PM
\par
{\pict\wmetafile8\picw240\pich159\picwgoal3600\pichgoal2385
010009000003E2DF00000000B9DF000000000400000003010800050000000B02000000050...
```

and the tail of all three is the same shape — hex, then `}` closing the picture,
then `\fs20\par`, then `}` closing the document.

**Five things that follow, and they are the specification for the writer:**

1. **The form is `\wmetafile8`.** Per §3's table that is the branch where the
   JPEG cannot go in verbatim, so **the conversion has to happen on the Windows
   host in `AcSyncService.cs`** — `System.Drawing` — and not in the Worker. §3
   called this branch in advance; it is now the measured one.
2. **`010009000003…` is a WMF header** (`01 00`, `09 00`, `00 03` = type,
   header size in words, version), which corroborates the keyword rather than
   trusting it.
3. **The dpi is 96, and `\picw`/`\pich` are pixels.** `\picwgoal 3600` twips
   / 1440 = 2.5in against `\picw 240` gives 96; `2220/1440` against `148` and
   `750/1440` against `50` give 96 as well. `rtf-picture.mjs` takes `dpi` as a
   required parameter — **96 is the value to pass**, and it is now measured
   rather than assumed.
4. **The field is NOT pictures alone. It carries TEXT** — a caption line reading
   `Image on <M/D/YYYY h:mm:ss AM>` sits before the `\pict` group. That closes
   §7's question 5 in the direction that matters: **a writer that replaces the
   field with pictures alone destroys that caption**, so the caption is part of
   what has to be reproduced.
5. **One picture per line on all three** — and the manifest says that is the
   whole population, not a lucky sample.

   > **CORRECTED 2026-08-15**, hours after this list was first written. This
   > point used to end *"the manifest says other lines carry up to five"*, and
   > that was wrong: it took the five-photograph figure from §6.4, which counts
   > photographs on a DOCUMENT, and read it as photographs on a LINE. Counted
   > directly, every one of the 554 manifest rows is a `_1` file and the 554
   > rows carry 554 distinct `DtlKey`s — so no line in the manifest holds more
   > than one picture:
   >
   > ```
   > $ node -e '...gunzip ac-photo-manifest.json.gz...'
   > file suffix distribution: [["1",554]]
   > unique DtlKey: 554 of 554 rows
   > ```

   That closes the layout question for everything we have to write back, and
   the writer emits one caption + one `{\pict}` per photograph accordingly.

   **It does not close it for the book.** The manifest is the output of an
   extractor that was not kept (§2.1), so "the extractor only ever took the
   first picture" is not excluded by this count alone. What would exclude it is
   one aggregate over `SODTL` itself — `MAX` of the `{\pict` count — and that
   is worth running the next time anyone is on the host, because a second
   picture in the book on a line we rewrite would be destroyed, not duplicated.

---

## 5. What a human must do on the AutoCount host

Written to be followed in one sitting by someone who did not write this change,
in the shape of `docs/autocount-service-deploy.md`. **§5.1 alone is worth doing
even if nothing else on this page is ever built**, and it writes nothing.

**§5.1 has been lifted out into `docs/autocount-handling-listing.md`** — a
standalone sheet that can be handed to whoever has an AutoCount machine, with no
part of this page needed to follow it. Send that, not this. This section stays
because the surrounding argument depends on it.

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

> **RUN 2026-08-15, and it PASSED on all four observations.** The procedure
> below is kept as written because it is the method; what follows is what it
> answered. It is now a script — `backend/scripts/autocount-service/fd-probe.ps1`
> — rather than a hand procedure, and the script REFUSES to write onto a line
> that already holds a value, which was step 2's rule.
>
> Scratch order `ERP-FDPROBE-1`, `DtlKey 906102`, live `AED_HOUZS`:
>
> | | result |
> |---|---|
> | i entry screen | **renders** — right way up, `240 x 159`, caption above it |
> | ii printed Preview | **renders** — this is `XRRichText`, and it was the real risk |
> | iii read back | `chars=389549 truncated=False pict=1 wmetafile8=1` — AutoCount kept **our own bytes** unchanged rather than rewriting them |
> | iv the Save | no dialog, no truncation |
>
> §5.3 lists what would have made this a failure worth stopping on. None of it
> happened. The scratch order was **cancelled, not deleted**.
>
> Two things the run cost, both recorded in `BUG-HISTORY.md` rather than
> smoothed over: the probe's first attempt was refused by
> `FK_SO_SalesLocation` (a header field it was not sending), and its second
> created a **blank-numbered** sales order because `/create-so` accepted an
> absent `DocNo` — since fixed with `RequireDocNo()`. That document was found
> and voided too.

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

**ANSWERED 2026-08-15 by the §4.2 read** — four of the seven

1. ~~Which picture form AutoCount writes.~~ **`\wmetafile8`.** The conversion
   moves to the host.
3. ~~The source dpi.~~ **96**, derived three independent ways from `\picw` vs
   `\picwgoal` (§4.2).
4. ~~The column's SQL name and type.~~ **`SODTL.FurtherDescription`,
   `nvarchar(MAX)`.** The SDK name and the column name do match.
5. ~~Whether the field also holds TEXT.~~ **It does** — an
   `Image on <date> <time>` caption precedes the picture on all three lines
   sampled. A writer that emits pictures alone would destroy it.

**Still UNKNOWN**

2. **Whether AutoCount reads a form it did not write.** §5.2(i) and (ii),
   separately — the entry editor and `XRRichText` are different renderers.
   Now the SHARPER question, because §4.2 says the form we can produce cheaply
   (`\jpegblip`) is NOT the form AutoCount writes.
6. **What the nine large images weigh.** §6.4.
7. **Whether the same treatment is wanted on DO / IV / GR / PI lines.** The
   field exists on all six (§1); only SO and PO were extracted.
8. ~~**Whether any line in the BOOK holds more than one picture.**~~
   **ANSWERED 2026-08-31: YES. SO lines hold up to 2, PO lines up to 5.**
   The aggregate at the bottom of this item was run against the live book,
   read-only, and it is the answer this item said would be a finding:

   ```
   SO: lines_with_pict=2723 max_pictures=2 wmetafile=2723 jpegblip=0 pngblip=0 emfblip=0 dibitmap=0
   PO: lines_with_pict=2392 max_pictures=5 wmetafile=2392 jpegblip=0 pngblip=0 emfblip=0 dibitmap=0
   ```

   **So the composer MUST read before it writes.** `max_pictures = 1` would
   have closed this outright; it is 2 and 5, so a write that replaces
   `FurtherDescription` wholesale on one of those lines **destroys the second
   picture**, exactly as §6.3 warned. This is now a hard precondition on the
   write-back, not a caution.

   Two other things that read settles, both worth having here:

   - **The form is uniform.** Every one of the 5,115 picture-bearing lines is
     `\wmetafile8`. Not one `\jpegblip`, `\pngblip`, `\emfblip` or
     `\dibitmap` in the book. §4.2 measured three lines; this is the census.
   - **The population is far larger than the manifest.** 2,723 SO lines carry
     a picture against the manifest's 554, and the manifest's lowest `DtlKey`
     is 34553 — so §2.1's lost extractor did not sweep the book, and most of
     the older orders' photographs were never taken out at all. The exporter
     that closes that gap is `backend/scripts/export-ac-line-photos.py`
     (added 2026-08-31); the runbook step is `docs/ac-resync-runbook.md`
     阶段 3b.

   The original wording of this item is kept below, because the reasoning that
   made it worth asking is still the reasoning that makes the answer matter.

   Narrowed the same day it was opened, and it is no longer about layout.

   The original question assumed the manifest had lines with up to five
   pictures. It does not — 554 rows, 554 distinct `DtlKey`s, every file a `_1`
   (the count is in §4.2 point 5). So for **everything the write-back has to
   send**, one picture per line is the whole population and the layout question
   is moot.

   What survives is narrower and worth one query: the manifest is the output of
   an extractor nobody kept (§2.1), so it cannot rule out that the extractor
   took only the first picture of a line that held two. The write REPLACES the
   field wholesale (§6.3), so a second picture in the book on a line we rewrite
   would be **destroyed**, and that is the only reason this still matters.

   One aggregate settles it for the whole book, read-only:

   ```sql
   SELECT COUNT(*) AS lines_with_a_value,
          MAX((LEN(FurtherDescription) - LEN(REPLACE(FurtherDescription,'{\pict',''))) / 6) AS max_pictures
   FROM SODTL
   WHERE FurtherDescription IS NOT NULL AND LEN(FurtherDescription) > 0;
   ```

   `max_pictures = 1` closes it outright. Anything higher is a finding, and the
   composer needs a read-before-write on those lines before it may touch them.

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
