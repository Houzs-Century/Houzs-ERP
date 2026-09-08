# Every transaction, and what reaches AutoCount

**The owner asked for this on 2026-09-08**: 「我需要同步到autocount 包裹全部
transaction flow的文件」 — one file covering the whole transaction flow, not one
file per part.

**Read this first, then go where it points.** It is the flow: every document a
person raises in the ERP, in the order they raise it, what happens to it in
AutoCount, what does NOT go, and what stops it. The deep detail lives elsewhere
and each section says where.

| for | go to |
| --- | --- |
| the channels, the tunnel, the SQL instance | `docs/autocount-integration-map.md` |
| payload shapes, master-data chain, line identity | `docs/modules/autocount-writeback.md` |
| every refusal message and what to do about it | `docs/autocount-sync-reasons.md` |
| which operations have run against the live book | `docs/generated/autocount-coverage.md` [generated] |
| rebuilding the exe on the office machine | `docs/autocount-service-deploy.md` |

---

## 1. The shape, in one paragraph

**The ERP is where documents are made. AutoCount is where they are kept for the
accounts.** Every document is raised, edited and cancelled in the ERP; a copy is
pushed into the account book so the statutory side stays in one place. AutoCount
is not a second place to type things — the owner's standing rule is
*暂时只可以在 ERP 改*.

Nothing is deleted, ever. **不可以删，只可以 cancel.**

---

## 2. The chain

```
        Quotation ─────► Sales Order ─────► Delivery Order ─────► Sales Invoice
                              │                    ▲
                              │                    │  (the goods)
                              ▼                    │
                        Purchase Order ──► Goods Received ──► Purchase Invoice
```

**Six of these cross into AutoCount. The quotation does not.**

| the ERP document | in AutoCount | how it gets there |
| --- | --- | --- |
| Quotation | — | stays in the ERP |
| Sales Order | `SO` | **created** |
| Purchase Order | `PO` | **created** |
| Delivery Order | `DO` | **transferred** from the sales order |
| Goods Received Note | `GR` | **transferred** from the purchase order |
| Sales Invoice | `IV` | **transferred** from the delivery order |
| Purchase Invoice | `PI` | **transferred** from the goods received note |

**Created and transferred are different things, and the difference is the source
of most trouble.** AutoCount's SDK will make a sales order or a purchase order
out of nothing. The other four it will only make BY TRANSFERRING an existing
document's lines. So a delivery order raised in the ERP with no sales order
behind it **has no path into AutoCount at all** — that is AutoCount's design, not
a gap in ours, and the ERP records it rather than pretending.

---

## 3. Numbering — every document has two names

- The ERP numbers its own documents and AutoCount accepts that number, so
  `HC-SO-000021` **is** AutoCount's `SO-000021`. The paperwork matches on both
  sides.
- Each LINE also carries AutoCount's own line id. **That is what makes an edit
  possible**: a line with no id cannot be changed in the book, only refused.
  Without that rule an edit appended a second copy of every line into the
  account book, and on a purchase order those copies can never be removed.

---

## 4. What happens when you press Save

Nothing is sent while you wait. The ERP writes a row into a queue
(`scm.autocount_outbox`) and answers you immediately.

1. **A five-minute sweep** picks the row up and calls the office machine.
2. **Six attempts.** After that the row is `failed` and someone has to look —
   roughly thirty minutes of a dead tunnel before anything gives up.
3. **The AutoCount Sync page is where you look.** One row per document, what was
   sent, whether it arrived, and when it did not, why.

Four states, and each has a different remedy:

| state | what it means |
| --- | --- |
| **sent** | it is in the account book |
| **pending** | queued, or retrying |
| **skipped** | the ERP DECLINED to send, on purpose. The reason says which backlog it belongs to |
| **failed** | it was sent and AutoCount refused it. This is the one that means the ERP and the book disagree |

---

## 5. Sales order → delivery order — the one that broke

This is the step the goods actually move on, and it has three shapes. **All three
now go through AutoCount's own documented call** (changed 2026-09-08 —
`docs/bugs/0716`):

| you are shipping | what is sent |
| --- | --- |
| the whole order | every line, at whatever is still outstanding |
| some of the lines | only those lines, at their outstanding quantity |
| part of one line (2 of 5) | that line, at 2 |

**The third one matters more than it looks.** If the ERP ships 2 of 5 and the
book is told only "this line", AutoCount moves all 5 — stock wrong by 3, silently,
in a licensed account book. That is why a partial quantity is always spelled out
and why the service refuses rather than falling back when it cannot express one.

**Delivery fees ride the chain.** A fee is a SERVICE line on the sales order and
it travels SO → DO → invoice like any other line. It is never stock: it allocates
nothing, gates nothing, and produces no inventory movement.

---

## 6. Editing and cancelling

**An edit** re-sends the changed document. It works only where every line carries
AutoCount's line id; where one does not, the edit is **refused** rather than
appended, because appending is unrecoverable on the purchase side.

**A cancel** cancels in AutoCount too. It never deletes. A cancelled document
stays in both systems, marked.

**A document that has moved downstream is locked.** Once a sales order has a
delivery order against it, the parts that have shipped are not editable — the
account book has already recorded the movement.

---

## 7. When something does not arrive

In order, cheapest first:

1. **The AutoCount Sync page** — find the document, read the reason on its row.
   Every reason and its remedy: `docs/autocount-sync-reasons.md`.
2. **"What the office machine said"** on that same page — the service's own log.
   This is where AutoCount's own words are, including which line it will not
   take. It exists because the answer used to be reachable only by remote
   desktop, and ten documents failed sixty times while it sat there unread
   (`docs/bugs/0717`).
3. **Send again** on the row, once the cause is actually fixed. Re-sending
   without fixing anything spends attempts and produces the same message faster.
4. **The health check** — Actions → *AutoCount write-back queue — health*. It
   also runs itself every morning and only shouts when something is stuck.

**Two failures that look identical and are not:**

- *The tunnel is down.* Nothing is reaching AutoCount; documents queue up and
  drain on their own once it is back.
- *AutoCount refused this document.* Everything else is going through. This one
  needs a person.

---

## 8. What will never go, and why

- **A document with no parent** — a delivery order raised with no sales order, an
  invoice with no delivery order. AutoCount cannot hold one. It has to be raised
  in AutoCount by hand, or not at all.
- **A quotation.** It is not an accounting document.
- **A DELETE.** Cancel is the only removal on either side.
- **A line the ERP can express and the book cannot.** These are recorded per
  document rather than silently dropped — the writeback guide's §7 lists them.

---

## 9. The parts that are not automatic

**Master data goes first.** A customer, supplier or item that AutoCount does not
know will refuse the document that names it. The service creates what it can
before sending; the chain of what depends on what is in the writeback guide's
master-data section, and it is the first place to look at a refusal that mentions
a code.

**The office machine is a single point.** The service runs on one PC. If that PC
is off, nothing reaches the account book — the ERP keeps working and the queue
keeps growing, which is the intended behaviour, but the backlog is real.

**A change to the service is not live until that PC is rebuilt.** The code cannot
be compiled anywhere else; the licensed AutoCount assemblies only exist there. So
a fix can be merged, correct, and completely inert. Every entry that ships one
says so, and `docs/autocount-service-deploy.md` is the swap.

---

## 10. Where each rule actually lives

| the rule | the file |
| --- | --- |
| what the ERP sends, per document type | `backend/src/scm/lib/autocount-convert-lines.ts` |
| which lines a conversion names, and when it refuses | `readConvertSourceKeys`, same file |
| the queue, the sweep, the attempt budget | `backend/src/scm/lib/autocount-outbox.ts` |
| the transfer itself, on the office machine | `backend/scripts/autocount-service/AcSyncService.cs` |
| the page | `frontend/src/pages/AutoCountSync.tsx` |

**Ref.** Written 2026-09-08, the day the SO → DO transfer was traced to an
undocumented SDK call. If a number or a rule here disagrees with the generated
coverage table, the generated one is right.
