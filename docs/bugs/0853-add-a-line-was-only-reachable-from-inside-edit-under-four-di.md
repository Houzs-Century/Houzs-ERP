## "Add a line" was only reachable from inside Edit, under four different names [medium]

**Symptom.** The owner, 2026-09-13, on a goods receipt he had converted from a
purchase order: 「我用 convert 过来，怎么我不能用 manually 加？这个也是扩散到全部
地方了吗？」

He could, and yes it had spread.

**Root cause (traced, on STAGING).** Opened `HC-GRN-2609-069` on staging and read
the page's own buttons: GRNs, History, Print PDF, Cancel GRN, Transfer to
Purchase Invoice, Transfer to Purchase Return. Nothing about lines. Pressed Edit
— which reads as "change what is here", not "add something new" — and a button
appeared at the bottom of the line list called **"Add manual item"**.

So the feature existed and was unfindable, which for the person using it is the
same as absent.

It had spread because every V2 detail page forwards `?edit=1` to a separate
editor, and each editor named the affordance differently: **"Add manual item"**
on the goods receipt, **"Add item"** on the purchase invoice and the purchase
order, **"+ Add Line Item"** on the sales order. Four names for one action, none
of them visible from the page you start on.

**Fix.** An **Add line** button on the detail page itself, beside Edit, that
hands the operator straight to the editor's add row.

The handoff is a contract rather than a copy-pasted navigate:
`vendor/scm/lib/add-line-handoff.ts` builds the URL, recognises the intent, and
strips it once consumed. A `#add-line` FRAGMENT rather than a query parameter on
purpose — it is a one-shot intent, not page state, so it must not survive a
reload or be restored by the back button into a form that is already open. The
editor consumes it once and `replace()`s it away; left on the URL it re-opens
the add row on every remount, which on a page that remounts after a save is a
form that will not stay shut.

`ADD_LINE_LABEL` is exported so the four names become one.

**What is NOT fixed here, said plainly.** This PR wires the goods receipt, which
is the document he was holding. The purchase invoice, the purchase order and the
sales order have the same editor-side add row and still need the button on their
detail page. And the SALES INVOICE has no add-line path at all on any surface:
`useAddSalesInvoiceItem` exists in the query layer with **zero call sites** in
`frontend/src`, so its backend `POST /:id/items` is unreachable from the app.
That is a separate gap, recorded here so the next reader does not assume it was
covered.

**Ref.** feat/status-reads-submitted, 2026-09-13.
