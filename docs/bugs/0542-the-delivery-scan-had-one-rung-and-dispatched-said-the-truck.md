## The delivery scan had one rung and DISPATCHED said the truck had left [medium]

<!-- area: Delivery, DO, returns -->

**Symptom.** Two halves of the same wrong picture of where a delivery has got
to.

The QR on the delivery order print — the whole point of which is that the paper
travels with the goods — could record exactly one event: a DRAFT becoming
Confirmed. Once the delivery order was Confirmed, which is what the office
raising it already makes it, scanning the paper did nothing at all. The
storekeeper putting the pallet on the lorry, the driver pulling out and the
driver arriving had no scan between them; those three steps were only reachable
from a desktop right-click menu, by somebody who was not there.

And the word on screen was a step ahead of the goods. Stored `DISPATCHED` read
**"Shipped"** on the list, the pill and the consignment note, **"Dispatched"** on
the delivery-order detail page, and the mobile shell's button verb for it was
**"Dispatch"** — three words for one value, and all three claimed departure. The
owner asked directly: 「dispatch就是出发了啊?」

**Root cause (traced).** Not a defect in one line — a vocabulary that was
settled before the flow it describes existed.

`frontend/src/vendor/scm/lib/status-pill.ts` had carried
`DISPATCHED: { label: 'Shipped' }` since the canonical map was written, with a
header saying it "keeps its own word" because "the goods are on the road". That
was a reasonable reading of a value nothing wrote by machine. It stopped being
true the moment the three-scan flow was specified: on that flow DISPATCHED is
written when the goods go ON the lorry, and departure is the NEXT rung
(`IN_TRANSIT`).

The label then drifted because it is not held anywhere.
`docs/modules/document-status-vocabulary.md` already records that sixteen list
and detail pages declare their own `{ tone, label }` map rather than reading the
canonical one, and calls that root fix OPEN — so the previous sweep aligned them
BY HAND, and a hand-aligned list is one nobody re-checks. That is measurable
rather than asserted: writing the source scan for this fix immediately turned up
a seventeenth site the hand-sweep had missed, `MobileModuleList.tsx`'s delivery
order filter chip, still reading "Dispatched".

The scan page's single rung has its own trace and it is not carelessness either.
`DoLoadScan.tsx` was written on 2026-08-21 for one job, and `do-next-step.ts`'s
`doAdvanceStep` — the office's ladder, correctly narrowed to DRAFT→Confirm on
the same day "Mark signed" was removed — was the only "what next" function in the
codebase. There was no ladder for a person standing at a lorry, so the scan page
had none.

**Fix.** Two halves, display and behaviour, and the stored value is untouched in
both.

*The word.* `DISPATCHED` reads **Loaded** everywhere: the canonical map, the DO
list's own map and tab strip and KPI subtitle, the DO detail page's stage label,
the consignment note list, the DO right-click menu's `Mark Loaded`, the mobile
shell's button verb and the mobile DO filter chip. The consignment note DETAIL
page needed no edit — it already renders `<StatusPill docType="do">` and inherits
the canonical map, which is what that layer is for. The stored value stays
`DISPATCHED` for ever: Postgres enum labels are permanent and every report,
export and AutoCount read goes to the stored value. Same option A as the
2026-08-21 "Confirmed" sweep.

*The scan.* `DoLoadScan` offers the next rung and only the next rung —
DRAFT→`LOADED`, LOADED→`DISPATCHED`, DISPATCHED→`IN_TRANSIT`,
IN_TRANSIT→`DELIVERED` — from `doScanStep` in `do-next-step.ts`, beside the
office's ladder rather than as a second copy of it. No status literal is
hand-typed: `DoScanStep['status']` is an `Extract<DoStatus, …>`, so a target the
`scm.do_status` enum does not define fails to COMPILE. That is bug `0530`'s
class — `status.eq.ON_HOLD` against an enum with no such label is a 22P02 and a
400, not an empty match, and it took the Delivery Orders page down for two days —
answered with a type instead of a comment. **Stock is untouched by every rung
past the confirm.**

`SIGNED` is never produced. It is a legal member that counts as delivered
everywhere (`doCountsAsDelivered`), which is exactly why the bare button writing
it was bug `0481`; nothing has written it since 2026-08-21 and this does not
reopen it. A row that already holds it is answered as finished.

The third rung writes `DELIVERED` and collects no signature, no photo and no
GPS — the same shape as `0481`'s "Mark Signed". It is not left silent: the note
beside the button, before it is pressed, names all three losses and names Proof
of Delivery as the screen that captures a real one. Capturing here instead was
rejected on `0480`'s reasoning — a second capture path is the divergence that
entry was written about, and evidence is allowed everywhere and required nowhere.

Pinned by two tests, both proved RED on the unfixed tree:

- `frontend/src/pages/scm-v2/DoLoadScan.ladder.test.tsx` (23) — mounts the REAL
  page and asserts the label and the PATCH body per rung, through the rendered
  button rather than by calling the helper the page is supposed to call. 16 of 23
  fail on `origin/main`. Every guard was then deleted one at a time — each of the
  four rungs, the hold refusal, the refusal sentences, the evidence note, the
  one-scan-one-step state, and a mutant where the page ignores the ladder
  entirely: **11 of 11 mutants RED**.
- `frontend/src/pages/scm-v2/doDispatchedReadsLoaded.test.ts` (5) — the two label
  maps, the enum's untouched membership, and a source scan over every
  `frontend/src` file for a line naming `DISPATCHED` beside a `Shipped` /
  `Dispatch`-shaped label. 3 of 5 fail on `origin/main`, and the scan is what
  found the missed `MobileModuleList.tsx` chip.

**Known-open, deliberately not silent.** `row-menus.ts`'s `Mark Loaded` and
`Mark In Transit` are the manual stopgaps for machines that did not exist; those
machines exist now. That block's own rule is that each entry retires itself "the
day its machine goes into use", and EXISTING is not IN USE — whether the
storekeepers and drivers actually scan is the owner's fact to give, not one this
change may assume. Left standing, with the sentence corrected in place rather
than left to teach the old shape.

`frontend/src/mobile/MobileSalesOrders.tsx` still shows a Shipped chip. That is
the SALES ORDER's own `SHIPPED`, a different document whose Shipped folded into
Delivered separately in #2655 — stale for its own reasons and out of scope here.

**Ref.** `feat/the-driver-scans-three-times`, 2026-08-26.
