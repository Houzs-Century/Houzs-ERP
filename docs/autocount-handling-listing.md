# Handling Listing — read one Further Description out of the AutoCount book

> **DONE 2026-08-15 — the three steps below have been RUN, and this sheet is now
> the FALLBACK rather than the channel. Do not hand it to anyone.**
>
> The measured values are in `docs/autocount-further-description-photos.md`
> §4.2. The answer is **`form=wmetafile8`** — the branch of section 6's table
> where the JPEG-to-metafile conversion has to move into `AcSyncService.cs` on
> the Windows host. Tool: LINQPad on the AutoCount host, connection `.\A2006` /
> `AED_HOUZS`, three read-only `SELECT`s; no document was opened in the
> AutoCount UI, per section 5.
>
> **Step 3 was settled without saving a file.** That step exists to route around
> `sqlcmd` cutting a long column at 256 characters where nobody sees it happen,
> and it asks a human to check a file size. LINQPad does not truncate, so the
> check became an identity instead: `LEN(x) * 2 = DATALENGTH(x)` held on all
> three rows, which an `nvarchar` column satisfies only when the whole value is
> in hand. Stronger evidence than a file size, and no attachment to mishandle.
>
> **The deploy this banner used to be waiting on has happened.**
> `deploy-on-host.ps1 -Server ".\A2006"` was run on the office host on
> 2026-08-15 and reported `compiled - 51712 bytes`, `/health` naming
> `AED_HOUZS`, and `/ensure-masters` answering 200 — so the running exe now
> carries the read route below, and the rollback sits beside it as
> `C:\Temp\AcSyncService.prev.exe`.
>
> Section 8 below said the durable fix was a read-only route on `AcSyncService`
> and that it should be the first thing added the next time that file was
> opened. It has been added, and is now LIVE:
>
> ```bash
> AC_SYNC_URL=... AC_SYNC_KEY=... \
>   node backend/scripts/read-further-description.mjs --dtlkey 34553 --extract ./ac-34553.rtf
> ```
>
> That one command does all three steps below — it DISCOVERS the column name
> rather than assuming it (step 1), reads the value (step 2), and writes the
> file (step 3). It reports truncation instead of hiding it, which is the trap
> section 5 warns about.
>
> **Nothing is now waiting on a human.** For any other `DtlKey` — including the
> one open question this read did NOT settle, how AutoCount lays out more than
> one picture on a line (`…-photos.md` §7.8) — call the route.
>
> Kept, not deleted, for the case it still covers: a machine that cannot reach
> the service, or a service that will not start. Sections 2 and 5 also remain
> the rules for anyone reading the book by hand at all.

**For:** somebody who has an AutoCount machine. Nobody on the development side
has one, so this task cannot be done here and cannot be automated yet.
**Costs:** about ten minutes.
**Writes nothing.** Every step below is a `SELECT` and a file save. There is no
`UPDATE`, no `INSERT`, and no change to any document.

**What it settles:** the photographs on our sales-order lines came out of
AutoCount's *Further Description* field during the cutover. To put them back we
have to know **which picture format AutoCount stores them in**. One real value,
read out of one line, answers it. Nobody kept a copy of the original, so the
only place that answer exists is the live book.

The full analysis is `docs/autocount-further-description-photos.md`. Nobody
doing this task needs to read it.

---

## 1. Who to ask, and what to say

Anyone who can open **SQL Server Management Studio** on the AutoCount server, or
who has the AutoCount dealer's access, can do this. It does not need an
accountant and it does not need anybody who knows the ERP.

The AutoCount UI alone is **not** enough — the field has to be read out of the
database, because what we need to see is the raw stored text, not the picture
the screen draws from it.

Copy-paste for WhatsApp:

> 我们需要从 AutoCount 的资料库读一笔资料出来，不改任何东西，只是读。
> 大概十分钟。要用 SQL Server Management Studio 开 `AED_HOUZS` 这个 database，
> 跑一个 SELECT，然后把结果存成一个档案传给我。步骤我这边有，一步一步写好了。
> 需要的是可以开 SSMS 的人（或者叫 AutoCount 的 dealer 帮忙）。

Send them section 3. Ask for the two things in section 4.

---

## 2. What they need before starting

| | |
|---|---|
| access | SQL Server Management Studio on the AutoCount server, or `sqlcmd` |
| database | `AED_HOUZS` |
| permission | read on the `SODTL` table. Nothing else. |
| to send back | one file, plus the text output of two queries |

They do **not** need node, the ERP, GitHub, or this repository.

---

## 3. The listing — three steps, in order

### Step 1 — confirm the column exists and what it is called

The SDK calls the field `FurtherDescription`. The database column has never been
looked at, so do not assume the two names match.

```sql
SELECT name, system_type_id, max_length
FROM sys.columns
WHERE object_id = OBJECT_ID('SODTL') AND name LIKE '%Further%';
```

**Copy the whole result.** If it returns no rows, stop and send that back — that
is the answer, and it means the field is stored somewhere else.

### Step 2 — check the three lines that are known to hold a photograph

These three `DtlKey` values are the first rows of our photo manifest, so all
three definitely held a picture at the time of the cutover.

| DocNo | DtlKey | ItemCode |
|---|---|---|
| `SO-000368` | 34553 | `RDS-5526 SOFA` |
| `SO-000383` | 34737 | `HOK-2009(A) (K)` |
| `SO-002559` | 165891 | `RDS-5527 SOFA` |

```sql
SELECT d.DtlKey, d.ItemCode, DATALENGTH(d.FurtherDescription) AS bytes
FROM SODTL d WHERE d.DtlKey IN (34553, 34737, 165891);
```

**Copy the whole result, including the `bytes` numbers.** Those numbers are how
step 3 is checked for truncation, so they are not optional.

If a row is missing, or `bytes` is NULL, say which one — that is useful and not a
failure.

### Step 3 — save one whole value to a file

The value for `DtlKey = 34553`. Two ways; the SSMS one is safer.

**In SSMS (preferred):**

```sql
SELECT d.FurtherDescription FROM SODTL d WHERE d.DtlKey = 34553;
```

Right-click the result cell, **Save Results As**, name it `ac-34553.rtf`.

**Or from the command line:**

```
sqlcmd -S <server> -d AED_HOUZS -E -y 0 -h -1 -W ^
  -Q "SET NOCOUNT ON; SELECT FurtherDescription FROM SODTL WHERE DtlKey = 34553" ^
  -o ac-34553.rtf
```

**Then check the file size before sending it.** `sqlcmd` cuts a long text column
off at 256 characters unless `-y 0` is given, and a cut-off file looks exactly
like a small photograph — it will not announce itself.

- The file should be roughly **half** the `bytes` figure from step 2 if the
  column type is `ntext` or `nvarchar`, or roughly the **same** if it is
  `varchar`.
- **If the file is exactly 256 bytes it was truncated.** Use the SSMS route
  instead.

---

## 4. What to send back

1. `ac-34553.rtf` — the file.
2. The text output of step 1 and step 2, pasted in a message.

That is the whole task. Everything after this happens on our side.

---

## 5. What NOT to do

- **Do not edit, save or re-save any sales order** while doing this. Opening a
  document in the AutoCount UI to "have a look" can rewrite the very field we
  are trying to read in its original form.
- **Do not run this against a backup or a copy.** It has to be the live
  `AED_HOUZS` book, because the question is what AutoCount is holding now.
- **Do not retype or reformat the file.** It must arrive byte for byte. Send it
  as a file attachment, not pasted into a message body.
- **Do not open it in Word.** Word will offer to convert it and can rewrite the
  picture into a different format, which destroys the one thing we are measuring.

---

## 6. What happens on our side afterwards

For the record, so the person doing the read knows why the file matters.

```
node backend/scripts/further-description-rtf.mjs inspect ac-34553.rtf --extract ./ac
```

That prints a `form=` line. One word, and it decides the whole return path:

| if it prints | what follows |
|---|---|
| `form=jpegblip` | the return path is already written and only needs wiring in |
| `form=wmetafile8` | AutoCount writes metafiles; the JPEG-to-metafile conversion has to move into `AcSyncService.cs` on the Windows host |
| `form=pngblip`, `dibitmap0`, `emfblip` | same as above, different target format |
| `0 picture group(s)` or `form=UNRECOGNISED` | the premise is wrong and the photographs travel some other way — that is a finding, and building stops until it is understood |

The reading tool is `backend/scripts/further-description-rtf.mjs` over
`backend/scripts/lib/rtf-picture.mjs`. It opens no database and holds no
credential; its only input is the file.

---

## 7. The second task, which is NOT part of this listing

`docs/autocount-further-description-photos.md` section 5.2 describes a **write**
probe — creating a scratch sales order and setting a Further Description on it
through the SDK, to find out whether AutoCount will render a picture it did not
write itself.

**Do not ask anyone to do that yet.** It writes, it needs a scratch document, and
it is pointless before the read above has been done. It is a separate
conversation with a separate instruction sheet.

---

## 8. Why this is a manual task at all

Every other production question in this system is answered by a script plus a
read-only workflow — that is the standing rule in `CLAUDE.md`, and it exists so
nobody is ever asked to run a query by hand.

The rule assumes the data is in our Postgres, which every workflow can reach with
`secrets.DATABASE_URL`. **The AutoCount book has no such channel.** The only
automated path into it is `AcSyncService.cs` on the office host, and that service
exposes no read route at all.

So the durable fix was a read-only route on that service. **It is now written**
— `POST /further-description` with `{ Table, DtlKey }`: two SELECTs on one
connection, no SDK session, no transaction, and the table name comes from an
allow-list rather than from the caller. Its caller is
`backend/scripts/read-further-description.mjs`.

It DISCOVERS the column instead of naming it, for the reason step 1 exists:
nobody has looked at what the column is called, and hard-coding a guess would
turn "the column has another name" — a real answer — into a SQL error that
reads like a broken service. No matching column comes back as a 200 with
`column: null`.

Until the office host runs a build that contains it, this listing is still the
channel.

---

## 9. See also

- `docs/autocount-further-description-photos.md` — the full analysis, what is
  proven and what is not
- `docs/autocount-service-deploy.md` — the host build and deploy procedure
- `backend/scripts/import-so-line-photos.mjs` — the inbound half of the cutover,
  and the source of the manifest the three `DtlKey` values in step 2 come from
