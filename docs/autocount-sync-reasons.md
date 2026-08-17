# AutoCount Sync — every reason a document is refused, and what to do

This is the **dictionary the AutoCount Sync page speaks from**. Every code in
here is a value the ERP actually produces; nothing on this page is invented for
the documentation.

Three separate vocabularies live on that screen, and confusing them is the
mistake this file exists to stop:

| vocabulary | where the code comes from | who decides it |
| --- | --- | --- |
| **state** — `pending` / `sent` / `failed` / `skipped` / `requeued` | `AC_STATE_MEANING`, `backend/src/scm/lib/autocount-outbox-status.ts` | the ERP |
| **reason kind** — why a row is `skipped` (or, on a `failed` row, whose words the message is) | `AC_SKIP_KINDS`, same file | the ERP for a skip, **AutoCount** for a failure |
| **re-queue outcome** — the answer to pressing **Send again** | `AC_REQUEUE_MEANING`, `backend/src/scm/lib/autocount-requeue.ts` | the re-queue ladder |

The page renders the shipped sentence for each; it must never write its own.
`backend/src/scm/lib/autocount-requeue.test.ts` fails if a code exists in the
code and not in this file.

---

## 0. Where a string is allowed to appear on the page

**Added 2026-08-16, after the owner read two of them on the live screen.** Until
then this file pinned the CODES and said nothing about the SENTENCES, and both
defects lived in a sentence: every check was green while the screen was wrong.

A row's note — `last_error`, surfaced as `reason` — has three possible homes, and
which one it lands in is decided by `acWhatWasSaid`
(`frontend/src/lib/autocountOutbox.ts`), on **who wrote the note**, never on what
it says. Pattern-matching the text on the page side would be the third opinion
§2's classifier exists to prevent.

| where | what goes there | who decides the words |
| --- | --- | --- |
| **The headline, on the row, never behind a click** | one plain-language line: `AC_REASON_COPY[reason_kind].headline`, or `AC_FAILED_COPY.headline`, or `AC_REQUEUED_LINE` | the page |
| **Behind opening the row** | the sentence, the **To fix** line, and — under the label saying WHO spoke — the machine's own sentence | the page, except the quote |
| **Behind a second, collapsed, labelled disclosure** | everything a reader cannot act on: the account book's per-line dump (whatever follows `AcSyncService`'s own ` \|\| ` separator), and the ERP's whole internal note where the page already says the same thing in plain words | nobody — it is verbatim |

**Nothing the server wrote is ever the page's own voice.** Two rules follow, and
both were bought:

1. **A reason is read by the owner.** `acParentlessCreateReason`
   (`autocount-outbox-status.ts`) used to end *"(AddPartialTransferDetail is the
   SDK's only primitive)"* and that identifier reached the screen through the
   server hours after being removed from the page's copy. The sentence now lives
   beside its own needle and `backend/tests/autocountSyncReasonsCatalogue.test.ts`
   asserts both halves: no SDK method, class or column, and the needle still
   present. The SDK explanation stays in §4 below, where engineers read it.
2. **Rewording a writer does not clean a queue.** `scm.autocount_outbox` is
   append-only and `last_error` is never rewritten — the re-queue marker is
   *prepended* (`isRequeuedNote`). Every row written before a wording change keeps
   the old words for good, which is why the fix has to be in how the page RENDERS
   a note and not only in what the writer produces.

**A superseded row is a record, not a task.** `requeued` rows are folded out of
the list under *"N superseded rows, kept as a record"* on both surfaces
(`acSplitSuperseded`) — except under the **Sent again** filter, where the reader
asked for them and they are the list. The status counts on the chips are
untouched: they are the server's, exact and whole-company.

---

## 1. What "Send again" answers — the re-queue outcome codes

`POST /api/scm/autocount-outbox/:id/requeue` always answers with
`{ accepted, code, message, … }`. `code` is stable and is the only thing the UI
may branch on. `accepted` is true for exactly one code.

| code | accepted | what happened | what the person should do |
| --- | --- | --- | --- |
| `requeued` | **yes** | A fresh attempt was queued and the old row was marked as history. The document was **re-composed** from the ERP as it stands now, so a correction made since the refusal is in it. Creates only. | Nothing. It goes on the next five-minute sweep. |
| `requeued-as-recorded` | **yes** | The same, for a **conversion** — but the instruction was queued again *exactly as first recorded*, not rebuilt. A DO / GRN / Invoice / Purchase Invoice has no create to compose: the stored payload (its `DtlKeys`, its parent, its own `DocNo`) **is** the instruction, so a re-send is a retry of that. | Nothing. One thing to know: anything changed on the document *after* it was refused is **not** in what goes out. If you edited it, check the result. |
| `already-sent` | no | **AutoCount already has this document.** Refused before anything is read or composed. | Nothing, and do not look for a way around it — see §4. |
| `row-pending` | no | This row is already queued and waiting for the next sweep. | Wait. If the age keeps climbing past about half an hour, the AutoCount host is down. |
| `already-requeued` | no | Somebody already pressed this. The document is queued or sent under a newer row. | Find the newer row; this one is the record of what happened. |
| `already-queued` | no | A different live attempt for the same document already exists. | Same — work the live row, not this one. |
| `already-in-autocount` | no | The ERP document carries a `linked_ac_docno`, so the account book has it under that number (a cutover import, or an earlier send whose row is gone). | Nothing. Creating it again would duplicate it. |
| `still-refused` | no | The ERP composed it and refused it **again**. `reason` carries the blocker **as it stands now**. | Read `reason` — it may be a *different* cause from the one just fixed. Look it up in §2. |
| `not-recoverable` | no | An `edit`, a `cancel`, or a conversion **the ERP itself refused** (a `skipped` one). None of these is fixed by sending it again. | §2 and §6 say what to do instead for each. |
| `switch-off` | no | `scm.autocount_writeback` is off, so nothing can be queued at all. | Turn it on (Actions → *AutoCount write-back (on/off)*), then press again. |
| `document-gone` | no | The ERP document behind the row cannot be read. | Nothing to send. If the document should exist, that is the thing to investigate. |
| `declined` | no | The composer accepted it on the probe and refused on the real run, without writing a reason. | Press once more. If it repeats, it is a code fault, not a data fault. |
| `row-not-found` | no | No such row in **this company's** queue. Answered identically whether the id is unknown or belongs to the other company. | Refresh the page. |
| `read-failed` | no | The queue could not be read, so no verdict was reached. | Try again in a moment. |
| `would-requeue` | no | **The button never returns this.** It is the DRY RUN's success, from the batch workflow (`requeue-autocount-skipped.yml`), and it means nothing was written. It is in the shared vocabulary so both callers speak one language; a UI that read it as accepted would tell somebody a document had been queued when nothing had. | Nothing — you are reading a workflow log, not the page. Re-run with `apply=1`. |

**The button is only OFFERED where an answer other than a flat no is possible.**
`can_requeue` on each list row (`acRowIsRequeueable`) is `true` for:

- a `create_so` / `create_po` row whose state is `failed` **or** `skipped`, and
- a **transfer** row (`so_to_do`, `po_to_gr`, `do_to_iv`, `gr_to_pi`,
  `so_to_po`) whose state is `failed` — and never a `skipped` one.

Neither ever carries the re-queue marker. It is a hint; the POST re-checks
everything.

**Why a conversion's two terminal states get opposite answers** — the rule §6
sets out in full: `skipped` means the **ERP** refused it, on grounds that are
properties of the document (no parent, several parents, a line subset it cannot
name), and no re-send touches any of those. `failed` means the ERP composed it,
the queue sent it, and the **service** refused — and a service refusal stops
being true the moment the service is replaced.

---

## 2. Why a row is `skipped` — the ERP refused, and nothing was sent

A `skipped` row **never left the building**. Re-composing it is free, which is
why the button exists at all.

`reason_kind` on each row is one of these. The needles that produce them are in
`AC_SKIP_KINDS`.

| `reason_kind` | trigger | can a re-send ever fix it? | what the person should DO |
| --- | --- | --- | --- |
| `item-code` | An ERP item resolves to no single AutoCount `ItemCode` — unmapped, or the cutover collapsed several AutoCount items onto one ERP code and there is no supplier to disambiguate. | **Yes**, once the map is right. | Fix the binding in `scm.autocount_item_bindings`, then Send again. |
| `missing-location` | A line carries no stock location and none can be inherited from the document. AutoCount rejects it on `FK_SODTL_Location`. | **Yes.** | Set the warehouse on the line, or the sales location on the document, then Send again. |
| `missing-sales-location` | The sales order names no stock location **and has no live line** to take one from. `FK_SO_SalesLocation`. | **Yes.** | Set the sales location on the order, or add a line carrying a warehouse. |
| `missing-agent` | The order names no salesperson AutoCount knows. `FK_SO_SalesAgent` — measured against the live book on 2026-08-13, the day the write-back went live. | **Yes.** | Assign a salesperson on the order, then Send again. |
| `missing-creditor` | The purchase order's supplier has no `scm.suppliers.code`. `FK_PO_Creditor`. | **Yes.** | Give the supplier a code, then Send again. |
| `desc2-too-long` | A line's Further Description is over AutoCount's 100 characters. AutoCount refuses the whole document rather than truncating, and a truncated specification is a wrong instruction to the factory. | **Yes**, once it fits. | Shorten the special order or the colour text on that line, save, then Send again. |
| `sofa-collapse` | A sofa build cannot be folded into AutoCount's one line without inventing `Desc2` text. | **Only** after the build itself changes. | Fix the build so it collapses, then save and Send again. |
| `keyless-line` | An **edit** names a line with no `linked_ac_dtlkey`. Appending it would duplicate the line in the live book, and on a PO a duplicate cannot be removed. | Not by this button — it is an `edit`, so the button answers `not-recoverable`. | Backfill `linked_ac_dtlkey` for the document's lines, then **save the document again**. |
| `dtlkey-subset` | A conversion took a **strict subset** of the parent's lines and some source line has no `DtlKey`, so the ERP cannot name the subset. Sending it without one would make AutoCount transfer *every* outstanding line — goods moving in the book that did not move here. | **No.** The ERP never composed an instruction, so there is nothing to send again — see §6. | Backfill `linked_ac_dtlkey` on the **source** document, then raise this document again. |
| `no-source-document` | A Delivery Order / GRN / Invoice / Purchase Invoice was created with **no parent**. | **NEVER.** See §4. | Nothing. It stays ERP-only, permanently. |
| `mixed-source-lines` | The document carries lines that came from **no source document** beside lines that did — the ERP allows a standalone line on an invoice, AutoCount's transfer would produce one MISSING them and understate the revenue in the book. | **No.** Nothing was composed, and re-asking would not change the document's shape. | Raise the delivered lines from the Delivery Order and the standalone lines as their own invoice. |
| `no-autocount-shape` | A conversion merged **several** source documents into one (a DO from two SOs, a GRN batched from three POs). The ERP records it rather than inventing documents. | Not today, and **not by Send again** — the ERP composed nothing, so there is nothing to re-send (§6). See §5: the AutoCount service side learned to do this on 2026-08-16, the ERP side has not followed. | Raise the matching document in AutoCount by hand, or split the ERP document. |
| `edit-before-counterpart` | A downstream document was edited while the conversion that creates it was still queued. That conversion will transfer the **source** document's lines, not this edit. | Not by this button. | Save the document again once the conversion has drained. |
| `cancelled-before-send` | The document was cancelled in the ERP while its create was still queued, so the create was withdrawn. | No, and nothing is wrong. | Nothing. Neither document ever reached the account book. |
| `grn-mislinked` | A goods receipt's `linked_ac_docno` is its **purchase order's** AutoCount number, not its own — a cutover convention. Sending a cancel or an edit would name the wrong document in a live book. | No. | The real GR numbers are on the PO in `linked_ac_grn_docnos`; a PO received in several deliveries has several, and choosing is a decision, not a lookup. |
| `compose-failed` | The ERP could not **read its own document** while composing (`AcReadError`) — a missing column, a PostgREST fault. A read fault, not a refusal. | **Usually yes**, if it was transient. | Send again. If it repeats with the same message, it is a code fault — the message names the table and the PostgREST code. |
| `masters-not-opened` | `/ensure-masters` could not open an item, a salesperson or a customer in AutoCount before the document was sent. | Yes, once the master opens. | See §3 — this one lands on a **`failed`** row, not a skipped one. |
| `unrecognised` | The reason matched no needle above. **This is a finding, not a category** — a code path grew a new refusal and nothing here names it. | Unknown. | Read the raw reason on the row, and add a needle to `AC_SKIP_KINDS` (and its `.mjs` mirror) in the same pass. |

---

## 3. Why a row is `failed` — it was SENT and AutoCount refused it

A `failed` row means the document **is in the ERP and is not in the account
book**, and it means something left the building. `MAX_ATTEMPTS` is 6 on a
five-minute cron, so a retryable failure has had roughly half an hour.

These messages are mostly **AutoCount's own words** or `AcSyncService`'s, so
there is no fixed catalogue of them the way there is for skips — the message is
the diagnosis. The ones seen so far:

| message (or its shape) | source | trigger | can a re-send ever fix it? | what the person should DO |
| --- | --- | --- | --- | --- |
| `Foreign Key Error (Constraint Name=FK_…)` | AutoCount SDK | A master the document names is not in the book — `FK_SO_SalesAgent`, `FK_SODTL_Location`, `FK_PO_Creditor`, `FK_PO_DisplayTerm`. | **Yes, and safely.** A foreign key rejects **before** the insert, so nothing was written and a re-send cannot duplicate. | Fix the named master (assign the salesperson, set the location, give the supplier a code), then Send again. Most of these are now refused *before* sending, as the `missing-*` kinds in §2. |
| `Invalid transfer item.` (`AutoCount.Invoicing.InvalidTransferItemException`) | AutoCount SDK | `AddPartialTransferDetail` was handed line keys belonging to **more than one source document** in a single array. Measured on the live book 2026-08-16 with two sales orders in one array. | **Yes — once the AutoCount host is running the build that fixes it, and not before.** See §5. | **Do not just press Send again** — this row has already burned all six attempts, and until the host is rebuilt a re-send produces the same exception, faster. Rebuild and redeploy `AcSyncService` first (`docs/autocount-service-deploy.md`), confirm with `GET /health`'s `builtAt` / `mvid`, and only then re-send. Send again **does** work on this row (§6): a `failed` conversion is a refusal by the service, not by the document. |
| `no transferable lines on <type> <docNo>` | `AcSyncService.cs` | The source document has no outstanding lines left — everything on it has already been transferred downstream. | Only if the source really does still have lines. | Check the source document in AutoCount. If it is fully transferred there and not here, the two have diverged and that is the thing to fix. |
| `of N line key(s) given, only M exist on a <type>` | `AcSyncService.cs` | The ERP named line keys the book does not have on a document of that type. Refuses the whole request rather than transferring a smaller set. | Not until the stored keys are right. | The stored `linked_ac_dtlkey` values are wrong or stale — re-derive them for that document. |
| `REFUSED: line N of M … carries no DtlKey and does not declare IsNewLine` | `AcSyncService.cs` | An `/edit` reached the service with an unidentifiable line. The ERP normally refuses this earlier as `keyless-line`. | Not until the key is stored. | Backfill `linked_ac_dtlkey`, then save the document again. |
| `AutoCount refused to cancel <type> <docNo> (already transferred to a downstream document, or already cancelled)` | `AcSyncService.cs` | The book will not cancel a document it has already transferred — the mirror image of the ERP's own downstream lock. | **No.** | Cancel the downstream document in AutoCount first, or accept the divergence and record why. |
| `<type> <docNo> not found` | `AcSyncService.cs` | The document the ERP is editing or cancelling is not in the book under that number. | Only once the number is right. | Check `linked_ac_docno` on the ERP row. For a GRN this is very likely the `grn-mislinked` cutover convention in §2. |
| `DocNo required for <what>` / `FromDocNo required when DtlKeys is not given` / `CreditorCode required for /so-to-po` | `AcSyncService.cs` | The payload is missing a field the route needs. | No — this is a code fault, not a data fault. | Report it. A composer produced an incomplete payload. |
| `AutoCount login failed` | `AcSyncService.cs` | The service could not log into the book. | **Yes** — transient. It is retried automatically. | Nothing, unless it persists: then the AutoCount host or its licence needs attention. |
| `masters not opened, document not sent: …` | `autocount-outbox.ts` drain | `/ensure-masters` failed, so the document was never sent. Retried under the attempt cap, then failed. | **Yes**, once the master can be opened. | The message carries what `/ensure-masters` said. Fix that item / salesperson / customer, then Send again. |
| `Gave up after 6 attempts. Last error: …` | `autocount-outbox.ts` drain | A **retryable** error (a 5xx or a transport failure) that never stopped happening. | **Yes**, if whatever was down is now up. | Read what follows `Last error:` — the real diagnosis is there. Usually the tunnel or the AutoCount host. |
| a bare transport message (`fetch failed`, a timeout) | `callAcService` | The AutoCount host is a Windows box on the shop floor behind a tunnel, and it reboots. Always treated as retryable. | **Yes.** | Check the host is up, then Send again. |
| `AutoCount service responded <status>` | `callAcService` | A non-2xx with no JSON body. 4xx is not retried (configuration or a bad payload); 5xx is. | Depends on the status. | A 4xx is a code or configuration fault. Report it. |
| `AC_SYNC_URL is not configured` | `callAcService` | The Worker has no service URL. | No. | Configuration. Nothing about the document is wrong. |

> **A `failed` row is not automatically safe to re-send, and that is why the
> button asks first.** `AcSyncService`'s create has **no guard against a
> duplicate ERP document number**. A foreign-key rejection is the clear safe
> case — it rejects before the insert, so nothing was written. An ambiguous 500
> carrying AutoCount's own words is **not** that case: if the document landed
> and only the reply was lost, re-sending writes a second one. When the message
> is ambiguous, **look in the book first.**

---

## 4. The two live examples, in full

Both of these are in the queue right now and both are in the catalogue above.
They are here because they are the two shapes the page must get right.

### `Invalid transfer item.` on a `so_to_do` — six attempts, all failed

`reason_kind`: none (a `failed` row carries AutoCount's own words).
Catalogue row: §3, `Invalid transfer item.`

**The catalogue must not say "retry".** It has already been retried six times,
which is the whole attempt budget. The cause was a delivery order built from
**two** sales orders: `AddPartialTransferDetail` requires every key in one array
to belong to the same source document, and a mixed array answers
`AutoCount.Invoicing.InvalidTransferItemException`.

The C# now groups the keys by the document they actually belong to and calls the
transfer once per group (`AcSyncService.cs`, `KeysBySourceDoc`), so the shape is
supported. **That fix is source, not deployment.** `AcSyncService.cs` does not
build in CI — it needs the licensed AutoCount 2.2 assemblies — so it reaches the
shop-floor host only when somebody builds and copies it. Until then a re-send
produces the same exception, faster.

**What the person should do:** rebuild and redeploy the service
(`docs/autocount-service-deploy.md`), confirm the host is running the new build
via `GET /health`'s `builtAt` and `mvid`, and only then Send again.

> **2026-08-16 — the host WAS rebuilt, and Send again then refused it.** The new
> build went live and answered `/health` with
> `{"ok":true,"book":"AED_HOUZS","builtAt":"2026-08-16T14:35:08Z","mvid":"a6a91dd5-…"}`,
> and the re-queue ladder still said *"a conversion refusal is not re-queued
> here"* — because it treated every conversion refusal as permanently
> unrecoverable. §6 is the rule that separates the two kinds, and both delivery
> orders are re-sendable under it.

> **THE DIAGNOSIS ABOVE IS REFUTED FOR THESE TWO ROWS. Measured 2026-08-16,
> after the rebuild, and this paragraph is the finding — not a new theory.**
>
> Both delivery orders were re-queued and the 5-minute cron sent them to the new
> build. It answered `Invalid transfer item.` again, and the new build's own
> diagnostic says why the "two sales orders in one array" explanation cannot be
> the cause **here**:
>
> ```
> DO HC-DO-2608-001 (attempt 2) last error: Invalid transfer item. || source SO
> lines as the book holds them: 906306 on SO HC-SO-2608-003 [AK-ULTIMATE MATT (K)]
> Qty=1 TransferedQty=0 Transferable=T docCancelled=F outstanding=1; 906307 on SO
> HC-SO-2608-003 [HOK-1013 (K)] Qty=1 TransferedQty=0 Transferable=T
> docCancelled=F outstanding=1
>
> DO HC-DO-2608-002 (attempt 2) last error: Invalid transfer item. || source SO
> lines as the book holds them: 905348 on SO HC-SO-2608-002 …; 905349 on SO
> HC-SO-2608-002 …
> ```
>
> Each key array is **single-source** — both keys of `-001` on `HC-SO-2608-003`,
> both keys of `-002` on `HC-SO-2608-002` — and every line is `Transferable=T`
> with a full outstanding quantity. So `KeysBySourceDoc` had nothing to group,
> and the grouping fix, whatever else it is worth, did not cure these two.
>
> **The real cause is UNKNOWN**, and it is deliberately not guessed at here. What
> IS known: the request reaches the host, AutoCount itself throws, and the four
> line keys it is thrown over are all present, all outstanding and all on the
> document the ERP names. Investigating it needs the AutoCount side, not the ERP
> side. The rows retry to `MAX_ATTEMPTS` and land back in `failed` carrying this
> much better message, and under §6 they stay re-queueable for whenever the cause
> IS found — which is the property this change was for.

### A delivery-order-to-invoice raised with no source delivery order

`reason_kind`: `no-source-document`. Catalogue row: §2.

AutoCount's 2.2 SDK has **no create** for a Delivery Order, GRN, Invoice or
Purchase Invoice. The only construction primitive for all four is
`AddPartialTransferDetail(fromType, dtlKeys)` — you build one by transferring a
source document's lines. `AcSyncService` therefore has `/create-so`,
`/create-po` and no third create, and could not sensibly be given one.

So this is not a bug awaiting a fix. It is a **permanent shape mismatch**: the
ERP can raise a parentless document and AutoCount cannot hold one. The row
exists so the divergence is written down and findable, which is the only thing
that was ever wrong about it.

**A re-send can never fix it, and the page must say so plainly** — not "try
again later", not a remedy. The document stays ERP-only. If the account book
needs it, it has to be raised there by hand, against a source document.

---

## 5. Open items — recorded so they are not re-discovered

1. **The ERP still refuses merged conversions the AutoCount service now
   accepts.** As of 2026-08-16 `AcSyncService` groups transfer keys by source
   document and invokes the transfer once per group, so a DO from several SOs is
   native on that side. The SIX ERP call sites that record a merged conversion
   (`delivery-orders-mfg.ts`, `grns.ts` ×2, `sales-invoices.ts`,
   `purchase-invoices.ts`, and `scm/lib/si-autocount-source.ts` since
   2026-08-17) still write a `skipped` row. Whether the ERP should
   follow is an owner decision, not a cleanup — until it is made, §2's
   `no-autocount-shape` row is accurate.
2. **`masters-not-opened` never classifies.** The route only runs
   `classifyAcSkip` on rows whose status is `skipped`, and the drain writes that
   message onto a `failed` row. So the kind exists, its remedy is written, and no
   row will ever carry it. Left as-is deliberately: changing which rows get a
   `reason_kind` changes what the page renders, and that is a separate change.
3. **`AC_SKIP_KINDS` has no self-test against the writers.** Every needle in it
   is a string typed twice — once where the reason is written and once here —
   and `no-autocount-shape`'s was wrong from the day it shipped because it was
   copied from a doc comment rather than from the writer. A generated check
   (`audit:`-style) over the reason-producing call sites would close the class.
4. **The outbox does not record WHICH BUILD refused a row.** `/health` answers
   `builtAt` and `mvid` and nothing stores either, so "was this refused by a
   service that no longer exists" is not answerable from `scm.autocount_outbox`.
   §6 explains why that is not the gate and why it would still be worth
   recording; the proposal is two columns stamped by the drain.
5. **`Invalid transfer item.` on `HC-DO-2608-001` / `-002` is unexplained.** The
   recorded cause (line keys spanning two source documents) is refuted for both
   — see the measurement in §4. Open on the AutoCount side.
6. **Nothing asks the account book whether a `failed` document landed.** The one
   residual risk on any re-send is a document that was accepted and whose reply
   was lost. A read-only probe on the ERP's own `DocNo` — which every create and
   every conversion now sends — would settle it before the queue writes, and
   would retire the "look in the book first" instruction in §3.

---

## 6. Who refused it — the rule that decides a conversion

**Added 2026-08-16.** Until this date the ladder refused *every* conversion, on
grounds that read as one reason and are really two:

> a parentless DO / GR / IV / PI can never exist in AutoCount at all, a merged
> conversion has no AutoCount shape, and a DtlKey-subset refusal is fixed by the
> line-key backfill and then re-raising the document.

All three of those are true and all three are **still refused**. What the blanket
rule missed is that each of them is a property of the **document**, and a
document does not change because somebody rebuilt a Windows box on the shop
floor. A refusal by the **service** does: it stops being true the moment the
service is replaced, and rebuilding that host is routine here. Under the blanket
rule, every host fix needed the outbox edited by hand.

### What the ERP already records, and what it does not

The discriminator is not a new field and is **not somebody asserting it in a
form**. It is two facts the queue already writes, which agree by construction:

| | who refused it | what the row looks like | re-sendable |
| --- | --- | --- | --- |
| `skipped` + `payload` of `{"body":{}}` | **the ERP** | Written by `recordConvertSkipped` — directly for a merged conversion, through `recordParentlessCreate` for a parentless one, and from `readConvertSourceKeys`'s refusal for a DtlKey subset. All three, and nothing else. | **No.** The row never reached the drain, so the service has never seen this document and cannot be what refused it. |
| `failed` + a composed payload | **the service** | Only `dispatchOne` writes `failed`, and it is reached only from a `pending` row — which for a transfer op is only ever `enqueueConvert`'s success path. | **Yes.** |

**Both conditions are required**, and that is the point rather than a belt-and-
braces flourish: a `failed` row with an empty payload would be a code path
nobody has written, and there would be nothing in it to send; a `skipped` row
carrying a real payload was still never dispatched. Either mismatch is refused.

**And the re-send is the recorded payload, not a rebuild.** Migration 0277 says
it plainly — the payload is a snapshot of what the save produced, never
recomposed at drain. For a transfer that snapshot is the *whole* instruction:
its own `DocNo`, the `DtlKeys` naming which lines moved, the parent to resolve
`FromDocNo` from, the row to write the AutoCount number back onto. Sending it
again is a retry in the plainest sense, and no route logic is copied into the
re-queue tool to do it — which was the third of the original three objections.

### Why `mvid` is not the gate, though it should be recorded

`GET /health` returns `builtAt` and `mvid`, added so "which build refused this"
is answerable, and the obvious rule is *a refusal recorded against an `mvid`
that is no longer running is a refusal by a service that no longer exists*. It
is not the gate here, for three reasons:

1. **Nothing records it.** `callAcService` never probes `/health` and
   `scm.autocount_outbox` has no column for it, so no existing row carries one —
   including the two this change exists to recover. A gate that only works for
   rows written after it shipped is not a gate for the backlog it was built for,
   and back-filling the field by hand would be exactly the "trust me" flag this
   rule is supposed to avoid.
2. **It answers a different question.** `mvid` says the service was *replaced*.
   It does not say the refusal was the service's: a rebuild does not give a
   parentless delivery order a parent, so an `mvid`-only gate would happily
   re-send all three permanent shapes.
3. **It refuses things it should not.** `AutoCount login failed` and a dropped
   tunnel are service refusals on the *same* build; an `mvid` gate would hold
   them back for no reason.

**It is still worth recording** — as information for the person, not as the
gate. Two columns on the outbox row (`service_mvid`, `service_built_at`),
stamped by the drain from the same probe, would let the page say *"refused by a
build that is no longer running"* next to a `failed` row, which is precisely
what somebody needs to know before pressing Send again on a transfer. Logged as
open item 4 above.

### What this does NOT claim

`failed` means the service **answered**. It does not prove the account book was
left untouched: if a document landed and only the reply was lost, a re-send
writes a second one. That is the identical residual risk the create path already
carries and documents — see the blockquote at the end of §3 — and it is why the
message is the diagnosis. A refusal naming a shape AutoCount would not accept
wrote nothing; an ambiguous transport failure might have. **When it is
ambiguous, look in the book first.** Open item 6 is what would retire this
paragraph.

`sent` is refused outright and has no exception of any kind. That refusal now
lives in the ladder itself and not only in its two callers, so a third caller
cannot lose it.
