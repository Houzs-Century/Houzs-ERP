## The delivery order sheet is reverted to its previous form at the owner's request [low]

**Symptom.** Not a defect — a deliberate revert. The owner, 2026-08-26, looking
at a freshly printed Delivery Order: 「我记得我的 DO 的东西全部都不一样了，你跟我
revert 回来先」 and, when asked which part, 「就是pdf啊」 / 「那个document」 /
「revert 回来之后，我要先看到旧的那个文件」.

**What changed today, and is now undone.** Two things reached
`frontend/src/vendor/scm/lib/delivery-order-pdf.ts` on 2026-08-25/26:

| PR | change | reverted here |
|---|---|---|
| #2722 | the QR encodes the PUBLIC `/d/<token>` link and the caption became `SCAN AT EACH STEP` | yes — back to `/scm/do-load?id=<uuid>` and `SCAN · MARK LOADED` |
| #2736 | the Status row prints `statusLabel('do', …)` so paper matches screen | yes — back to title-casing the stored value |

`frontend/src/lib/printDocumentPdf.ts` goes back to stamping `loadScanId` so the
QR still prints; without that the reverted generator would print no QR at all,
which is not what "the old document" means.

**What is NOT reverted, and still works.** The public no-login token, the
`/d/<token>` driver page, the three-scan ladder, the packing list and its sheet,
and the `Shipped` → `Loaded` relabel on every screen. **Only the printed
Delivery Order went back.**

**The consequence, stated rather than buried.** The Delivery Order is now the
ONE printed document whose status disagrees with the screen: the sheet prints
`LOADED` for the state every screen calls **Confirmed**, while **Loaded** is what
the screen calls stored `DISPATCHED`. One word, two rungs, depending on whether
you are reading paper or a screen. That is the previous behaviour, restored on
purpose — it is not an oversight, and
`frontend/src/vendor/scm/lib/pdf-status-label.test.ts` pins it by name so nobody
"fixes" it back without a decision.

The other eight printed documents keep #2736's fix. The clean-generator scan
still runs over all of them, with this one file exempted explicitly, so a tenth
generator written tomorrow is still caught.

**Undoing the revert is two edits.** Swap `loadScanId` back for `armDoScanToken`
in `printDocumentPdf.ts`, and restore `statusLabel('do', header.status)` in the
generator. Delete the two `docType !== 'do'` filters in the test at the same
time — they are commented to say so.

**Ref.** revert/the-delivery-order-pdf-goes-back, 2026-08-26.
