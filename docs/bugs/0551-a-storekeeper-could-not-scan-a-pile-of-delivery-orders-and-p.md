## A storekeeper could not scan a pile of delivery orders and press once [medium]

**Symptom.** Not a defect — a missing capability, asked for by the owner on
2026-08-26: 「我不能 scan 好几个 DO，然后一起点 load 吗？包括我的 dispatch 也是
一样，它应该可以支持连续扫描的。当我扫描越来越多的时候，不一定要只扫一张。」

Loading a lorry means holding thirty papers. Walking each of them through its
own page — scan, wait, press, scan the next — is the work the QR was supposed to
remove.

**Root cause, and it is the interesting part: THIS REPO HAD NO SCANNER.** Every
"scan" in the system was the phone's OWN camera app opening the URL printed on
the paper. Nothing in `frontend/` decoded a QR; `jsqr` was not a dependency and
`BarcodeDetector` appeared nowhere. That design cannot be batched at any effort,
because each scan NAVIGATES AWAY and takes the basket with it. Continuous
scanning is only possible inside a page that never leaves — so the feature
needed a camera before it could need anything else.

**What was copied from Hookka, and why that was the cheap way in.** The owner's
standing instruction is 「源代码能抄的就抄」, and Hookka's `/r/<rack>` page runs
this exact loop on a floor today. Three of its rules are the ones it learned by
shipping the opposite first, and all three are carried across with their reasons:

1. **The loop never early-returns on a hit.** Returning after the first decode
   is what makes a "continuous" scanner stop after one item — and it looks like
   a working scanner, because the first scan succeeds.
2. **De-dupe by value with a cooldown.** A paper held in front of the lens
   decodes on every frame; without the 1500ms window one physical scan becomes a
   dozen additions.
3. **Resolution and focus ARE the sensitivity.** The owner's 2026-07-03
   complaint on Hookka was 「上下左右斜角不敏感」, and the answer was not a
   decoder setting — it was asking for 1440p instead of the lens's default and
   turning on continuous autofocus.

`use-qr-scanner.test.tsx` pins rules 1 and 2 through the real hook with a
hand-cranked `requestAnimationFrame`. Both were checked RED: breaking rule 1
fails two of the three tests, breaking rule 2 fails one.

**The server half — one decision function, not a third copy.** Three surfaces now
move a delivery order with nobody logged in: one paper, a packing list, a
basket. The five checks that decide whether one document may move (already past
the rung / no step at all / off-rung / forward-only / write) were written out
twice already; the basket would have been the third. They now live in
`advanceOneDocument`, and only the off-rung SENTENCE varies by caller.

**An oversized basket is refused, not truncated,** and the first version got that
wrong: it stopped adding at the cap and returned what it had, so eighty papers
would have moved sixty and reported success. A silent cap on a delivery floor is
worse than a refusal because the refusal is visible. The test caught it.

**`READ_MAX` 30 → 300.** `clientIp` is the PUBLIC address and a warehouse is one
address for every phone in it, so 30 reads per quarter-hour was 30 for the whole
floor — the second person to pick up a phone found the code dead. The WRITE
limits are untouched and stay pinned to `survey_submit`'s.

**DRAFT → LOADED IS NOT OFFERED IN A BATCH.** It is the rung that confirms a
delivery order and takes the goods out of stock; doing that to a pile at once
from a page with no login is a different class of risk from moving papers that
already left the warehouse. Everything a basket holds is past the deduction.

**THE FIRST PAPER SETS THE RUNG, AND A PAPER ON A DIFFERENT RUNG IS NOT LET IN.**
The owner, 2026-08-27, after being shown what a mixed pile did:
「不同状态你就不要给它扫描进来吧，就当做它还没扫描到。同样的东西不能在不同状态下
重复扫描。它应该根据第一个状态来扫描。」

「就当做它还没扫描到」 is the load-bearing half: a refused scan leaves the basket
exactly as it was — the optimistic row removed, the count unchanged, the token
free to be scanned again into a pile it belongs to. Adding the row and greying it
out would satisfy a looser reading and would still be wrong.

This is STRICTER than the server, deliberately, and the server keeps all of its
own checks: a document can move between the scan and the press, and the basket is
not the thing that decides whether a write is legal. What the rule buys is that
the refusal happens at the lorry with the paper still in hand, instead of
afterwards in a list of reasons.

It also collapses three buttons to ONE — a uniform pile has exactly one next
rung, so there is nothing to choose and no way to press the wrong thing. Emptying
the basket releases the rung, or a storekeeper could not start a second pile
without reloading the page.

**THE REVERT WAS DROPPED (2026-08-27).** An earlier draft of this entry warned
that a sheet printed after `docs/bugs/0549` would carry the logged-in link and
could not go into the basket. The owner then said 「DO PDF revert 不需要了 就用最
新的」, so 0549 was closed unmerged and the printed delivery order keeps the
public `/d/<token>` QR. Freshly printed sheets scan into the basket. The
paragraph is kept rather than deleted because the conflict was real and would
return if the revert were ever reopened.

**A code the basket cannot read is still NAMED, not ignored,** because an operator scanning repeatedly with nothing happening decides the
scanner is broken. The basket reads `/d/<64 hex>` and says so about anything
else.

**Ref.** feat/scan-a-pile-of-papers-and-press-once, 2026-08-26.
