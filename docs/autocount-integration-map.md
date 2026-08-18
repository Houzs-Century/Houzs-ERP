# The AutoCount integration, end to end

**Read this first if you are touching anything that talks to AutoCount.** It is
the map: every channel between the two systems, what each one is for, which
direction it runs, and what it is allowed to do. The per-subject documents go
deeper — this one exists so you know which of them you need, and so that nobody
has to rediscover the shape of the thing by probing production.

| Where to go next | For |
|---|---|
| `docs/modules/autocount-writeback.md` | how to CALL the service, the master-data foreign key chain, the payload shapes |
| `docs/autocount-migration-record.md` | how the one-time migration was done, the coverage matrix, the Friday runbook |
| `docs/autocount-service-deploy.md` | building and swapping the exe on the host |
| `docs/generated/autocount-coverage.md` | which operations exist, which the service implements, which routes trigger them, and which have run against the live book — GENERATED |
| `docs/autocount-writeback-golive-coe.md` | **the day the write-back was switched on and nothing reached the book** — seven faults in one chain, and the one shape that caused three of them |
| `docs/autocount-writeback-exposure-coe.md` | the API key that was being published |
| `docs/autocount-read-relay-exposure-coe.md` | the read relay that answers the public internet without a key |

---

## 1. What AutoCount is to us, in one paragraph

AutoCount is a **licensed desktop accounting application** installed on one
machine in the office. It has **no API**. Everything below exists because of
that sentence: to write into it we had to build our own service against its
SDK, running on that machine, because the licensed assemblies exist nowhere
else. The account book is a SQL Server database called **`AED_HOUZS`** on the
instance `.\A2006` on that same host.

**The ERP is the master.** Since the cutover, documents are created and edited
in the ERP and pushed into AutoCount. AutoCount is a receiving end, kept current
so the accounts and the statutory reporting stay in one place. It is **not** a
second place to type things, and the owner's own rule says so:
*暂时只可以在 ERP 改*.

---

## 2. The four channels — there is more than one, and they do different jobs

This is the part people get wrong. "The AutoCount connection" is not one thing.

| # | Channel | Direction | Auth | What it is for |
|---|---|---|---|---|
| 1 | `https://autocount.houzscentury.com` → cloudflared → `localhost:8900` **AcSyncService** | ERP **writes** to AutoCount | `X-API-KEY` header, fail-closed | The live write-back. Nine routes, all POST, **all writes** |
| 2 | `https://it-houzs.dev` — the LEGACY read relay | reads **out of** AutoCount | **partial and broken — see the COE** | Pre-cutover read middleware. Still up |
| 3 | ZeroTier → `10.147.17.100,55500` — direct SQL to `AED_HOUZS` | reads (and could write) | SQL login `sa2` + password | How the migration read the book, and how every fidelity comparison was done — including reading `Desc2` line by line |
| 4 | `tempdb.ac_src_bridge` — a scratch table | moves source code to and from the host | same SQL login | The only channel needing neither a screen nor a keyboard. **Its contents are stale** — see §7 |

**Channel 1 is the only one that writes documents, and it is the only one that
is current.** Channels 2 and 4 are legacy and each has a defect recorded against
it. Channel 3 is fine but needs a credential nobody should be pasting around.

### Why you must call the hostname and never the ZeroTier IP

`AcSyncService` registers the HTTP prefix `http://localhost:<port>/`, so
**http.sys serves loopback only**. A direct call to `10.147.17.100:8900`
connects at TCP level and is then refused — 400, or 403 with a forged `Host`.
That is not a fault to debug. **cloudflared runs ON that host and connects from
loopback**, which is exactly why the tunnel path works where a direct one
cannot.

The port is **8900** and must stay 8900: the tunnel ingress points at it. The
service reads its port from `C:\Temp\ac-svc-port.txt` — a file that exists and
says `8900`. `deploy-on-host.ps1` refuses to build if it ever says anything else.

---

## 3. The document relationship — what maps to what

Six document types cross the boundary. **DELETE is deliberately absent
everywhere**: the owner's rule is 不可以删，只可以 cancel.

| ERP | AutoCount | How it gets there |
|---|---|---|
| Sales order | `SO` | **created** by the ERP (`/create-so`) |
| Purchase order | `PO` | **created** by the ERP (`/create-po`) |
| Delivery order | `DO` | **converted** from the SO (`/so-to-do`) — never created standalone |
| Goods received note | `GR` | **converted** from the PO (`/po-to-gr`) |
| Sales invoice | `IV` | **converted** from the DO (`/do-to-iv`) |
| Purchase invoice | `PI` | **converted** from the GR (`/gr-to-pi`) |

**DO / GR / IV / PI cannot be created standalone, and that is AutoCount's
design, not a gap in ours.** `AddPartialTransferDetail(fromType, dtlKeys, …)` is
the SDK's only transfer primitive and the detail classes expose no settable
`From*` fields, so the parent link cannot be faked. **A delivery order raised in
the ERP with no parent sales order has no path to AutoCount** — the ERP records
a `parentless` outbox row and someone must handle it by hand.

### Numbering, and the two identities every document carries

- ERP document numbers carry an **`HC-` prefix**. `HC-SO-000021` **is**
  AutoCount's `SO-000021`.
- The raw AutoCount number lives in **`linked_ac_docno`**. That is what the
  write-back addresses, never the display number.
- Each ERP line stores **`linked_ac_dtlkey`** — AutoCount's own line id.
  **This is what makes an edit possible.** An edit whose lines carry no
  `DtlKey` is **REFUSED**, never appended: before that guard existed, editing a
  created document appended a duplicate set of lines into the live account book,
  and on a purchase order those duplicates could never be removed, only zeroed,
  because the SDK has no `DeleteDetail` for `PurchaseOrder` at all.
- Coverage today: SO **2,316 of 2,723** documents fully keyed and therefore
  editable; PO **127 of 449**. **That ratio is about MIGRATED documents only** —
  anything the ERP creates from now on gets its keys back from the create call
  and is editable by construction.

---

## 4. How a SKU crosses — and why it is not a straight copy

Three separate things happen to an item code on its way between the systems.

### 4.1 Translation

AutoCount `ItemCode` maps to the ERP product code through
`backend/scripts/data/autocount-erp-mapping-1561.csv`. Free-text AutoCount lines
were name-resolved against the ERP pick list during the migration. **A translated
code is not a changed value** — this is a dictionary, not an edit.

### 4.2 Sofa decomposition — one AutoCount line becomes many ERP lines

AutoCount carries a sofa as **one line**. The ERP carries **one line per
compartment**, because that is how the factory builds and how stock moves. The
two row shapes are therefore not comparable one-to-one, and every check that
touches sofa says so out loud rather than silently excluding it.

What survives the decomposition: the build's total quantity, the source
document, the AutoCount model the pieces came from, the group's money total, and
`Desc2`. What does not: a one-to-one line identity, and per-piece unit price —
**the price rides the lead compartment and the rest are zero**, so the document
total still matches to the cent.

### 4.3 `Desc2` is where the specification lives

AutoCount has no variant model. The fabric, the seat size, the compartment
layout, the gap, the divan, the legs — all of it is free text in the line's
**`Desc2`** field, and the migration parsed it back out into the ERP's
structured `variants`. This is why `Desc2` is the field every fidelity
comparison reads, and it is read over channel 3 (direct SQL), line by line, on
`DtlKey`.

**The single worst bug of the migration lived here.** `refresh-so-variants.mjs`
keyed its parsed-`Desc2` lookup on `${DocNo}|${itemCode}`, which is **not a line
identity**. An order with three lines of the same SKU in different colours
collapsed to one entry and the last row's parse was stamped onto all three:
183 keys collided, 298 lines affected. **Key on `DtlKey`. Always.**

### 4.4 A brand-new SKU

When the ERP sends a document naming a product AutoCount does not have, the
write-back opens it first (`/ensure-masters`) and only then sends the document —
because a document naming a missing master is refused **as a whole**. New items
land in `ItemGroup = OTHER`; mapping the ERP's own `item_group` vocabulary onto
AutoCount's ten real groups is an **open owner decision**, because it decides
where a new product appears in AutoCount's own reports.

**Masters are opened lazily, never proactively.** Creating a SKU, a venue or an
agent in the ERP does *not* put it in AutoCount that moment. The first document
carrying it does.

---

## 5. What is automatic, and what will never be

**Automatic, once `scm.autocount_writeback` is on:** a user saves in the ERP →
the route enqueues an outbox row → the **5-minute cron**
(`*/5 * * * *` → `drainAutoCountOutbox`) pushes it → AutoCount's document number
and line keys are written back onto the ERP rows. Nobody types anything twice.

Enqueue is **best-effort and never fails the user's save**. A row that cannot be
sent stays in `scm.autocount_outbox` and is retried up to 6 times; a row that
gives up is logged as `FAILED`, which is the divergence the whole mechanism
exists to prevent and must never read as routine.

**Never automatic — someone must do these by hand in AutoCount:**

| Case | Why |
|---|---|
| ~~**Several ERP sales orders merged into one delivery order**~~ | **NO LONGER TRUE — closed 2026-08-18.** It reads as a shape mismatch and was a limit of one SDK method: `AddPartialTransferDetail` refuses a key array spanning two documents, but `FullTransfer` takes an array of document numbers and the service groups named keys per source. The ERP names every source (`enqueueConvert` takes an array) and the merge syncs. Rows recorded before that date stay `skipped` — nothing was composed for them |
| **A partial transfer by QUANTITY** (a DO shipping 2 of a 5-unit line) | `AddPartialTransferDetail` takes line keys, **not quantities**. Naming the right lines does not fix the wrong number on them |
| **Un-cancelling** | The SDK has no un-cancel. A grep of the whole reflected surface for `uncancel`, `Cancelled:Boolean` and `set_Cancelled` returns nothing |
| **A document with no parent** | See §3 |

**Cancel does hold**, and this was measured rather than assumed: AutoCount
**refuses** to cancel a document that has already been transferred downstream,
with `TransferedDocNotAllowToCancelException`. Cancel the child first.

---

## 6. Reading data OUT of AutoCount

There is **no read route on the write service**. All nine of its routes are
writes; `/health` is the only thing that answers anything, and it answers from
constants. That is deliberate — it is a receiving end.

Reading happens two other ways:

1. **Direct SQL over ZeroTier** (channel 3). This is how every comparison in
   this repository was produced — `export-ac-fidelity-truth.py` and the
   `ac-*.json.gz` snapshots under `backend/scripts/data/`. Refresh them from a
   machine on that network and commit the result; each snapshot prints its own
   timestamp so a stale export is visible rather than silently compared.
2. **The legacy relay** (channel 2). Still up, and **two of its endpoints answer
   the public internet with no key at all** — see
   `docs/autocount-read-relay-exposure-coe.md`. Do not build anything new on it
   until that is closed.

---

## 7. Traps that have already cost time

Each of these was believed, acted on, and turned out false. They are here so the
next person spends the time on something new.

| Belief | Reality |
|---|---|
| "The SQL bridge holds the clean current source" | **It is stale** — 31,897 chars, no `/ensure-masters`, no fail-closed auth. Rebuilding from it ships the old service |
| "`setup.json` tells you which book to build against" | It names **`AED_DEMO`**. The build must be told `AED_HOUZS` explicitly |
| "`setup.json` tells you the server" | It says `192.168.1.198\A2006`, which the host does not resolve. It resolves `.\A2006` |
| "`/health` proves the service works" | It answers from **constants** and opens no database. A build that cannot reach the book passes it. Since 2026-08-15 it does at least say WHICH BUILD is answering — `builtAt` (the assembly's own file timestamp) and `mvid` (unique per compilation) — so "is the host behind" is now a comparison instead of a guess. It still proves nothing about the database |
| "The masters exist, `ensure-masters` said so" | A sales agent and a **purchase** agent are different tables behind different foreign keys. The report can be true and irrelevant |
| "`it-houzs.dev` is the AutoCount tunnel" | It is a different, older relay. A 404 there proves nothing about the write service |
| "The evaluation book is a safe place to test" | `AED_TESTING` exhausted its **500-transaction limit**. Verification happens on the live book, on a throwaway document, cancelled afterwards |

---

## 8. The state of the connection, and how to check it yourself

Do not trust this paragraph — every line of it is re-runnable.

```
POST https://autocount.houzscentury.com/health          -> which book, is it alive
powershell -File deploy-on-host.ps1 -DryRun             -> does the source still compile
powershell -File qa-convert.ps1 -IReallyMeanIt          -> create-po / so-to-do / po-to-gr
Actions -> AutoCount outbox health (read-only)          -> is anything queued or failing
Actions -> SCM write freeze - status (read-only)        -> who can write in the ERP right now
```

`docs/generated/autocount-coverage.md` records which operations have actually
run against the live book, with the document numbers, and it is GENERATED —
three of its four columns are read out of source every run, so they cannot go
stale the way the four hand-written copies of this table did.

**Code existing on both sides is not evidence that it works.** The generated
table keeps those two questions in separate columns for that reason: *the
service implements it* and *run against the live book* are different facts, and
only the second one means a document reached the account book.
