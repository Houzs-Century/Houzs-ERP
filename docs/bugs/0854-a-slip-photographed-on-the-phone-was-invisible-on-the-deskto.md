## A slip photographed on the phone was invisible on the desktop order [high]

**Symptom.** The owner, 2026-09-13: 「如果电话版本我用 upload 照片 OCR 的话，那这个
照片 OCR 它是会秀在我的电脑版本的哪里呢？」

The honest answer was: nowhere he would look. A salesperson photographs the
customer's handwritten slip on the phone, the scan creates the order from it, and
the office opens that order on the computer and sees no photo at all.

**Root cause (traced).** The photo is kept correctly — `slip_image_key` on
`scm.mfg_sales_orders` (mig 0033) — and the phone renders it as an "Order slip
photo" card. The DESKTOP rendering lived in `SalesOrderDetail.tsx`, and that page
is not what the router serves: `/scm/sales-orders/:docNo` renders
`SalesOrderDetailV2`, which carried NO reference to the slip.

**Measured on PRODUCTION, not inferred**: the shipped chunk
`assets3/SalesOrderDetailV2-DJLLOye0.js` contains zero occurrences of
`Order Slip` or `slip_image_key`.

So the only way to see it on a computer was to press Edit, which forwards to the
older page. A photo that exists, is paid for by someone's time on a phone, and is
reachable only by editing the document is a photo the office does not have.

**Fix.** `OrderSlipPhoto` (`vendor/scm/components/OrderSlipPhoto.tsx`) — the card,
lifted out of the old page so the two desktop surfaces cannot drift apart again —
mounted on `SalesOrderDetailV2`'s aside as "Order slip".

The phone keeps its own thumbnail-and-viewer treatment, which is right for a
touch screen. The parity that matters is that the photo is REACHABLE on both, not
that the markup matches.

A failure is said out loud rather than rendered as an empty card: "this order has
no slip" and "the slip would not load" look identical when a failure is silent,
and on a document the first one is a fact about the order. Same rule as
`docs/bugs/0848-a-change-log-that-could-not-load-said-no-history-yet.md`.

**Pinned** by `orderSlipPhoto.test.tsx`: the image renders and links full size,
the key is passed through, a failure is stated rather than swallowed, and a
loading line shows rather than nothing.

**Ref.** feat/status-reads-submitted, 2026-09-13.
