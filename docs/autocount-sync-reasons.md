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

## 1. What "Send again" answers — the re-queue outcome codes

`POST /api/scm/autocount-outbox/:id/requeue` always answers with
`{ accepted, code, message, … }`. `code` is stable and is the only thing the UI
may branch on. `accepted` is true for exactly one code.

| code | accepted | what happened | what the person should do |
| --- | --- | --- | --- |
| `requeued` | **yes** | A fresh attempt was queued and the old row was marked as history. | Nothing. It goes on the next five-minute sweep. |
| `already-sent` | no | **AutoCount already has this document.** Refused before anything is read or composed. | Nothing, and do not look for a way around it — see §4. |
| `row-pending` | no | This row is already queued and waiting for the next sweep. | Wait. If the age keeps climbing past about half an hour, the AutoCount host is down. |
| `already-requeued` | no | Somebody already pressed this. The document is queued or sent under a newer row. | Find the newer row; this one is the record of what happened. |
| `already-queued` | no | A different live attempt for the same document already exists. | Same — work the live row, not this one. |
| `already-in-autocount` | no | The ERP document carries a `linked_ac_docno`, so the account book has it under that number (a cutover import, or an earlier send whose row is gone). | Nothing. Creating it again would duplicate it. |
| `still-refused` | no | The ERP composed it and refused it **again**. `reason` carries the blocker **as it stands now**. | Read `reason` — it may be a *different* cause from the one just fixed. Look it up in §2. |
| `not-recoverable` | no | An `edit` or a conversion. Neither has a create to re-attempt. | §3 says what to do instead for each. |
| `switch-off` | no | `scm.autocount_writeback` is off, so nothing can be queued at all. | Turn it on (Actions → *AutoCount write-back (on/off)*), then press again. |
| `document-gone` | no | The ERP document behind the row cannot be read. | Nothing to send. If the document should exist, that is the thing to investigate. |
| `declined` | no | The composer accepted it on the probe and refused on the real run, without writing a reason. | Press once more. If it repeats, it is a code fault, not a data fault. |
| `row-not-found` | no | No such row in **this company's** queue. Answered identically whether the id is unknown or belongs to the other company. | Refresh the page. |
| `read-failed` | no | The queue could not be read, so no verdict was reached. | Try again in a moment. |
| `would-requeue` | no | **The button never returns this.** It is the DRY RUN's success, from the batch workflow (`requeue-autocount-skipped.yml`), and it means nothing was written. It is in the shared vocabulary so both callers speak one language; a UI that read it as accepted would tell somebody a document had been queued when nothing had. | Nothing — you are reading a workflow log, not the page. Re-run with `apply=1`. |

**The button is only OFFERED where an answer other than a flat no is possible.**
`can_requeue` on each list row is `true` only for a `create_so` / `create_po`
row whose state is `failed` or `skipped` and which carries no re-queue marker
(`acRowIsRequeueable`). It is a hint; the POST re-checks everything.

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
| `dtlkey-subset` | A conversion took a **strict subset** of the parent's lines and some source line has no `DtlKey`, so the ERP cannot name the subset. Sending it without one would make AutoCount transfer *every* outstanding line — goods moving in the book that did not move here. | Not by this button (a conversion). | Backfill `linked_ac_dtlkey` on the **source** document, then raise this document again. |
| `no-source-document` | A Delivery Order / GRN / Invoice / Purchase Invoice was created with **no parent**. | **NEVER.** See §4. | Nothing. It stays ERP-only, permanently. |
| `no-autocount-shape` | A conversion merged **several** source documents into one (a DO from two SOs, a GRN batched from three POs). The ERP records it rather than inventing documents. | Not today. See §5 — the AutoCount service side learned to do this on 2026-08-16, the ERP side has not followed. | Raise the matching document in AutoCount by hand, or split the ERP document. |
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
| `Invalid transfer item.` (`AutoCount.Invoicing.InvalidTransferItemException`) | AutoCount SDK | `AddPartialTransferDetail` was handed line keys belonging to **more than one source document** in a single array. Measured on the live book 2026-08-16 with two sales orders in one array. | **Not until the AutoCount host is rebuilt.** See §5 — this is fixed in the C# source and the fix is not on the shop-floor machine until somebody deploys it. | **Do not just press Send again** — this is the row that has already burned all six attempts. Rebuild and redeploy `AcSyncService` first (`docs/autocount-service-deploy.md`), confirm with `GET /health`'s `builtAt` / `mvid`, and only then re-send. |
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
   native on that side. The five ERP call sites that record a merged conversion
   (`delivery-orders-mfg.ts`, `grns.ts` ×2, `sales-invoices.ts`,
   `purchase-invoices.ts`) still write a `skipped` row. Whether the ERP should
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
