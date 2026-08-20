## Desktop bulk "Convert to DO" carried no Idempotency-Key while mobile's identical call did [medium]

<!-- area: Delivery, DO, returns -->

**白话.** 桌面「送货规划」板上的「转成送货单」，同一个 API、同一个扣库存后果，手机
那边有防重复的钥匙 (Idempotency-Key)，桌面这边没有 —— 而桌面才是那个一次可以框选
四张单批量转的画面。补上钥匙，并且钥匙是「每张销售单一把」，不是「每次开画面一把」。

**Symptom.** `useConvertSosToDo` (`delivery-planning-queries.ts`) posted
`/delivery-orders-mfg/from-sos` as a bare
`{ method: 'POST', body: JSON.stringify({ picks }) }`. The idempotency
middleware is OPT-IN (`backend/src/middleware/idempotency.ts`) — a pure
pass-through unless the client sends the header — so this call had none of it,
while the mobile board's identical call (`MobileDeliveryPlanning.tsx`) did. The
desktop call is fired from BOTH a single-row action and a bulk bar that converts
four SOs at a time (`DeliveryPlanning.tsx`).

**HONEST SCOPE — this was depth, not an open double-ship.** Stated plainly
because the audit that raised it framed it as an unguarded double-deduction, and
that overstates what the tree does. Three defences already existed and were read
before changing anything:

1. the client disables the button on `convertSos.isPending` and `runConvert`
   returns early while pending, so a literal double-click is largely absorbed;
2. Phase B's `over_remaining` check refuses a SEQUENTIAL duplicate outright;
3. **Edge #E** re-derives remaining AFTER inserting the DO lines and rolls the
   document back with 409 `race_conflict` when any line has gone negative — and
   it runs BEFORE `deductInventoryForDo`, so the concurrent read-then-write race
   does not reach the stock ledger.

No scenario was found in this tree where the missing header alone deducts stock
twice, and none is claimed. What the key adds is a decision the CLIENT can make:
under Edge #E a true tie rolls BOTH inserts back, so two racing clicks can
convert NOTHING and report `race_conflict`; with a key the retry REPLAYS the
first DO instead of racing for a rollback. That, plus removing a mobile/desktop
divergence on a stock-writing call, is the whole of the justification.

**Root cause (traced).** The idempotency module was introduced for money-
mutating writes and rolled out call site by call site; this one was simply never
visited. Its own header states the scope it should have caught — "MINTS A SOURCE
DOCUMENT money hangs off" — and a DO is exactly that.

**Fix.** `useConvertSosToDo` mints keys through the existing
`newIdempotencyKey` / `idempotentInit` helpers — no second scheme — held in a
ref `Map` keyed by SO **doc_no**.

Per-ORDER, not per-mount, and that is mobile's own instruction rather than a
variation on it. `MobileDeliveryPlanning`'s key is per-mount only because
StopDetail sits behind an early return, so a mount is exactly one stop; its
comment says "If that early return is ever replaced ... this key MUST move onto
the order identity". The desktop board IS that case — one mount, many SOs — so a
copied per-mount key would post SO #2 under SO #1's claim with a different
payload, be answered `idempotency_key_reused`, and break bulk convert by
converting the first order and failing the rest. A test pins that specifically.

Keys are never rotated for the life of the mount, per the module's rule that a
key is retired by the INTENT ending and not by the write succeeding: the two
halves of a double-fire must find the SAME key. A genuine later re-convert of the
same SO (its DO cancelled, remaining restored) carries a different payload and is
refused rather than silently replayed — the safe direction, and a board refresh
mints fresh keys.

Pinned by `frontend/src/vendor/scm/lib/delivery-planning-idempotency.test.tsx`.
Verified RED on the unfixed tree (two concurrent converts created 2 DOs; a retry
created a second; all keys were `undefined`).

**No surface change** — no new route, permission, status or required field; the
board behaves identically for every non-duplicate conversion.

**Ref.** fix/stock-movement-parity, 2026-08-20.
