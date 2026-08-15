# Handling Listing — read one Further Description out of the AutoCount book

> **UPDATE 2026-08-15 — this sheet is now the FALLBACK, not the channel.**
>
> Section 8 below said the durable fix was a read-only route on `AcSyncService`
> and that it should be the first thing added the next time that file was
> opened. It has been added:
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
> **The one human step that remains is a DEPLOY, not a query:** the route is in
> the source and compiles (verified locally against the licensed assemblies —
> `build-local.ps1`, exit 0, 51712 bytes), but the office host is still running
> the previous build. Run `deploy-on-host.ps1` there once and this sheet is
> spent.
>
> Keep it afterwards for the case it still covers: a machine that cannot reach
> the service, or a service that will not start.

---

## 0. EVERYTHING that needs this machine, in one place

Added 2026-08-15 because the answer to *"what else needs the AutoCount host?"*
was scattered across four documents. **This is the whole list.** Nothing else in
the project is waiting on that machine.

> Updated 2026-08-15 with job 7 — `/so-to-po` landed after this section was first
> written, which is the exact way a hand-written list goes stale. If you add an
> operation to `AcSyncService.cs`, add its row here in the same PR.

**Read the order, not just the rows: job 1 unblocks every other job.** Until the
exe is rebuilt, FIVE merged changes are sitting in the repository and not
running, including the read route the banner above depends on and the SO-to-PO
transfer.

| # | Job | Writes? | What it needs | What it unblocks |
|---|---|---|---|---|
| **1** | **Rebuild and swap the exe** — `deploy-on-host.ps1` | replaces a binary; touches no document | one PowerShell line, on that machine | **everything below** |
| 2 | Confirm the swap — `GET /health`, read `builtAt` | no | one call, with the key | proof that job 1 actually happened |
| 3 | Prove it can reach the book — `POST /ensure-masters` with **empty arrays** | no (empty arrays open nothing) | one call | that the new build has a live DB connection, which `/health` cannot tell you |
| 4 | Read one `FurtherDescription` | no | job 1, then `read-further-description.mjs` (the banner above) | which picture format the photos are in — the last unknown blocking photo sync |
| 5 | `qa-convert.ps1` | **YES — writes to the LIVE book and consumes real DO / GR running numbers** | job 1, plus the owner saying go | `create-po`, `so-to-do`, `po-to-gr` — three operations never proven end to end |
| 6 | The `FurtherDescription` write probe | **YES — scratch document only** | job 4 first | whether AutoCount will render RTF it did not write |
| 7 | Convert one sales order to a purchase order and look at the PO's **Transfer From** | **YES — a real PO** | job 1 | that `/so-to-po` works, and that a CONSOLIDATED purchase correctly falls back to a plain create with the source SO numbers in `Ref` |

### 0.05 ROOT CAUSE — why these six cannot be done from the development side

Written 2026-08-15 after measuring, not assuming. Everything else the ERP owes
AutoCount has been built; what is left is here because of ONE property, and it
is worth stating plainly so nobody spends another session trying to route
around it.

**There is no channel from here into that machine.** The four that were supposed
to exist were each checked:

| channel | expected | measured, 2026-08-15 |
|---|---|---|
| ZeroTier -> `10.147.17.100,55500`, direct SQL to `AED_HOUZS` | how the cutover read the book | **ZeroTier is not installed on the development machine, and the address is not reachable** |
| a SQL client | `sqlcmd` / `tsql` / `isql` | **none installed** |
| a driver, to write one | `mssql` / `tedious` in `backend/` | **neither is a dependency** |
| `AcSyncService` over the tunnel | the automated path | reachable, but it is a WRITE service with no read route until `#2243`, and its key is a Cloudflare Worker secret that cannot be read from here |

So the account book is not readable, not writable and not inspectable from the
development side by any route. That is not a gap to be closed with more code:
the licensed SDK assemblies exist on exactly one machine, and everything below
either runs there or does not run.

**Each item, and what would actually settle it:**

| # | The question that cannot be answered here | What settles it | Why it is stuck |
|---|---|---|---|
| 1 | Which build is the host running? | rebuild once, then `GET /health` | Until `#2241` merges, `/health` answers `{ok, book, service}` — no version, no timestamp. The repository records nothing about what is deployed either, so the only material that looks like an answer is prose, and prose about a deployment goes stale in days. **The same class already cost a fortnight on staging**, where `/health` answered `sha:null` and a two-week-old build passed the nightly check (`docs/SECURITY-DX-ROADMAP.md`). |
| 2 | Can the new build reach the account book? | `POST /ensure-masters` with empty arrays | `/health` answers from CONSTANTS and opens no database, so a build that cannot connect passes it. The probe that proves a connection is not in the runbook. |
| 3 | Which picture format does AutoCount store photos in? | job 1, then `read-further-description.mjs` | The photographs came OUT of `FurtherDescription` at cutover, and **the raw RTF was not kept and neither was the extractor** — `git ls-files \| grep -c '\.rtf$'` is 0. The only copy of the answer is the 554 sales-order lines in the live book still holding it. Sending the wrong picture form renders a red X or a blank, and a blank photograph is worse than none. |
| 4 | Do `create-po`, `so-to-do`, `po-to-gr` work end to end? | `qa-convert.ps1` | Never run since the blocker was fixed. `FK_PO_PurchaseAgent` stopped `create-po` on 2026-08-12; the cause is fixed in source (`AC_PURCHASE_AGENT`) and nothing has been sent since. A conversion cannot be tested against anything but a real book: `AED_TESTING` exhausted its 500-transaction limit. |
| 5 | Will AutoCount RENDER RTF it did not write? | the write probe, job 6 | Two different renderers are involved — the entry screen and the report's `XRRichText` — so a picture that appears in one may not appear in the other. Only the host can show that. |
| 6 | Does a document actually move stock? | job 5, then read a stock card | `qa-convert.ps1`'s own header says the GR posts a real stock IN. Nobody has looked at a stock card afterwards, so it is documented and unobserved. |

**What is NOT on this list, deliberately.** Everything that can be built without
the host has been: the payment balance and its references, the blank line
delivery date, the eight unsent fields, clearing a field, the item-code chain,
master creation. Those wait on a DEPLOY, not on an answer — see 0.1.

### 0.1 What job 1 actually brings live

Four merged changes are in the repository and not on the host. The running exe
predates all of them:

| change | what stops working without it |
|---|---|
| `#2043` | purchase-side converts pass `transferMaster=true`; without it `po-to-gr` and `gr-to-pi` die on save |
| `#2200` | eight fields the ERP holds and the write-back was not sending |
| `#2218` | a line with no delivery date arrives BLANK instead of carrying the document date |
| `#2243` | `POST /further-description` — the read route the banner above needs |
| `#2251` | `POST /so-to-po` — the SO-to-PO **Transfer From** link. Without it a purchase order raised from a sales order still reaches AutoCount, but as a standalone document with no provenance |

Verify rather than trust this table: compare `builtAt` from job 2 against

```
git log -1 --format=%ad --date=short -- backend/scripts/autocount-service/AcSyncService.cs
```

### 0.2 Sequencing — do NOT rebuild twice

A fifth change is open and not yet merged: it adds `builtAt` and `mvid` to
`/health`, which is what makes job 2 possible at all. Before that lands,
`/health` answers `{ok, book, service}` and there is no way to tell which build
is running — the exact blind spot this list exists to close.

**Land it first, then rebuild once.** Rebuilding before it merges means doing
job 1 twice.

### 0.3 Two things nobody needs to supply

- **A purchase agent for the PO.** The ERP has no such field and is not getting
  one. AutoCount's `FK_PO_PurchaseAgent` insists on a value, so the write-back
  sends the constant `OTHERS` (`AC_PURCHASE_AGENT`). Do not go looking for this
  data; it does not exist and it is already handled.
- **A customer account per debtor.** Every Houzs order is written against one
  fixed account with the name overwritten, so there is nothing per-customer to
  open.

### 0.4 Preconditions job 1 refuses without

Both live on the host, and `deploy-on-host.ps1` stops rather than guessing:

- `C:\Temp\ac-svc-key.txt` must exist — this is the same value as the
  `AC_SYNC_KEY` Worker secret.
- `C:\Temp\ac-svc-port.txt` must read `8900`. The tunnel ingress points at that
  port; any other value and the service is unreachable even when it starts.

And two values in `setup.json` that cannot be trusted: it names the book
`AED_DEMO` (must be `AED_HOUZS`) and the server `192.168.1.198\A2006` (the host
resolves `.\A2006`). Pass `-Server ".\A2006"` explicitly.

---

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
