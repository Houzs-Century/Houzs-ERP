## Controls named Mark signed for a signature the product no longer captures [medium]

<!-- area: Delivery, DO, returns -->

**白话.** 老板说签收签名不用了，叫我们拿掉。拿掉之后剩下一个更麻烦的问题：电脑版
那颗按钮写着「Mark signed」（标记为已签收），手机上那颗写着「Mark Signed」——
可是系统里已经没有签名这回事了，而且那颗电脑版的按钮**从来就没有写过「已签收」这
个状态**，它一直写的是「已送达」。按钮讲的话跟它做的事是两件事。现在按钮改成「Mark
delivered」（标记为已送达），讲的就是它真正做的事。**送货照片和 GPS 定位都保留**，
老板只说了签名。

**Symptom.** Owner, 2026-08-21: **「签收签名不需要 先 delete掉」**. Removing the
capture left three controls whose words named it:

| surface | label | what it actually wrote |
|---|---|---|
| desktop detail header + phone action bar | "Mark signed" | `DELIVERED` |
| desktop list quick-view drawer | "Mark signed" | `DELIVERED` |
| mobile shell action bar | "Mark Signed" | `SIGNED`, with no capture of any kind |

The desktop mismatch was not new — it was logged when `do-next-step.ts` was
written and deliberately left, because both targets satisfy the Sales-Invoice
gate so the operator's outcome was correct either way. What the ruling changed is
that the word stopped being merely inaccurate and became false: it named evidence
that exists nowhere in the product.

**Root cause (traced, not guessed).** Two separate places, one shape.

1. `doAdvanceStep` (`frontend/src/vendor/scm/lib/do-next-step.ts:189`) returned
   `{ status: 'DELIVERED', label: 'Mark signed' }`. The three desktop-side
   surfaces render `advanceStep?.label`, so one string fed all of them.
2. `statusActionsFor` (`frontend/src/mobile/MobileModuleDetail.tsx`) holds a
   declarative table; its DO row read `IN_TRANSIT: ["SIGNED", "Mark Signed"]`.

**Why the zero was disuse and not breakage — measured, not assumed.** Census run
`32462178224` over `backend/scripts/check-pod-evidence.mjs`: across **39 delivery
orders, every status, all time**, the counts are `signature 0, photo 0, gps 0`.
The twelve closed rows were all flipped `DISPATCHED → DELIVERED` inside a single
minute on 2026-07-24 by `backend/scripts/backfill-2990-delivered-dos.mjs` — a
script, not a person. Nothing downstream reads the evidence back, and a delivery
is already complete at `DISPATCHED`. So the capture path was never broken; it was
never travelled.

**Fix — the signature, removed.** The pad and its `SignaturePad` component in
`MobilePOD.tsx`, the `signatureData` field on `DoDeliveryEvidence`
(`vendor/scm/lib/delivery-order-queries.ts`), and the server's writer in
`patchDeliveryOrderStatusHandler` (`backend/src/scm/routes/delivery-orders-mfg.ts`).
`POD_CHASE` in `backend/src/services/agents/delivery-agent.ts` — the only
CONSUMER of these columns in the system — now tests the photo alone, because
asking whether a retired column is null answers "always" for a reason that has
nothing to do with the delivery.

**Fix — the controls, renamed.** All three now read **"Mark delivered"**. No
status value and no write target changed. The mobile rung still writes `SIGNED`:
dropping it or repointing it at `DELIVERED` removes or redirects an action
drivers may be using and contradicts the decision recorded two lines above it
("DELIVERED is the POD screen's job, so it is never offered here"). That is the
owner question raised in
`docs/bugs/0481-mark-signed-on-the-mobile-shell-closes-a-delivery-with-no-si.md`,
which stays **OPEN**. Only the words moved.

**Deliberately KEPT.** The delivery **photo** and the **GPS** fix. The owner named
the signature only, and it came out without disturbing either — proved by tests
that were GREEN before and after (photo → `podKey`, GPS → the `pod_*` quartet).

**Deliberately NOT DONE, and why.** `scm.delivery_orders.signature_data` is **not
dropped**. It holds 0 rows, but a column drop is irreversible and is a separate
deliberate decision for the owner. It survives with no writer, and
`backend/tests/doSignatureRetired.test.ts` is what keeps it writerless. The
follow-up, whenever he wants it: drop the column, then remove it from the
`HEADER` select in `delivery-orders-mfg.ts`.

**The honest warning stays honest.** Work merged the day before made evidence
allowed on every closing path and required on none, with each path naming what it
is losing. That property is preserved rather than undone — the sentences simply
stop mentioning a signature. `doCloseWithoutEvidenceWarning` now names the photo;
MobilePOD's confirm names the photo and the location separately. A closing path
that stops naming what it loses is the silence this rule exists to end.

**Tests, every one proved RED on the unfixed tree first.**

- `frontend/src/vendor/scm/lib/do-next-step.test.ts` — 3 red:
  `expected 'Mark signed' not to match /sign/i`; the label equality against
  `Mark delivered`; and
  `expected 'This delivery order has no customer s…' not to match /signature|signed/i`.
- `frontend/src/mobile/MobileDoStatusActions.test.ts` (new) — 2 red:
  `expected 'Mark Signed' to be 'Mark delivered'` and
  `IN_TRANSIT → Mark Signed: expected 'Mark Signed' not to match /sign/i`.
  `statusActionsFor` was exported to make this behavioural rather than a source
  scan; the export is scaffolding, not the fix.
- `backend/tests/doSignatureRetired.test.ts` (new) — 3 red: the handler body
  matched `/signatureData/` and `/signature_data/`, and the agent matched
  `/signature_data/`. A source scan because `delivery-orders-mfg.ts` is ~5,900
  lines and its status handler needs a live PostgREST client, a company scope and
  an inventory ledger — standing all that up would test the mocks. Same precedent
  as `doDeliveredOneHome.test.ts`. Its fourth test asserts the photo and GPS
  fields are still THERE, so an over-broad removal fails too.

**What happened to the capture test.**
`frontend/src/mobile/MobilePodSignatureCapture.test.tsx` pinned the pad → latch →
payload chain in both directions. It was **repurposed, not deleted**, as
`frontend/src/mobile/MobilePodEvidenceCapture.test.tsx`: its three signature
assertions had their SUBJECT removed by the ruling, but two things it covered are
still real — the photo and GPS travel through the same payload, and the removal
itself now needs a guard (no pad, no `signatureData`, ever). Deleting the file
would have taken the only end-to-end coverage of the surviving evidence path with
it, on the day that path was edited.

**Ref.** `fix/delivery-signature-retire`, 2026-08-21.
