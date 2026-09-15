## An amendment raised before the service-line fix stayed on the Purchaser, with no way to move it [low]

<!-- area: Sales orders + pricing -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15, on the HC-SO-012757/A1 quick view (Approver =
PURCHASER, one added line TRANSPORTATION CHARGES × 1, RM150): 「不是改了service
category amendment是Logistic approver吗？怎么还是到purchaser？」. The rule fix for
exactly this line (`docs/bugs/0895-an-amendment-that-added-a-service-line-went-to-the-purchaser.md`,
PR #3916) had merged at 06:45Z the same day and deployed at 06:50Z (`success`).
A1 had been raised at 2026-09-14 09:12Z, before it. Owner's ruling on being told:
「那就把这张 A1 改到 Logistic」.

**Root cause (traced).** Not a regression of 0895. `scm.so_amendments.lane` is
written ONCE, by `POST /mfg-sales-orders/:docNo/amendments`
(`backend/src/scm/routes/mfg-sales-orders.ts`, the `so_amendments` insert), and
nothing reads the lane rule again afterwards: the approve / reject / withdraw
routes (`routes/so-amendments.ts`) gate on the STORED lane's key, and the inbox
lists by the stored lane. 0895 recorded this deliberately ("a lane already stored
stays — A1 keeps LINES") and offered two exits — let the Purchaser approve (the
order has 0 bound POs, so no PO follow-up), or withdraw and re-raise. The owner
chose neither: the request should sit on the desk the rule names, and there was
no tool to put it there. No screen re-routes an amendment by design (an approver
must not be able to hand a request to a different signer), so the gap was a
missing REPAIR, not a missing feature.

**Fix.** `backend/scripts/relane-so-amendment.mjs` + Actions workflow *Relane SO
amendment (DRY-RUN gated)* (`.github/workflows/relane-so-amendment.yml`): inputs
`amendment_no`, `to_lane`, `apply`. Dry-run by default. It refuses a row that is
not `REQUESTED`, a legacy (lane NULL) row, a target lane already holding an open
request on the order (the `uq_so_amendment_open_lane` index would refuse anyway),
an amendment carrying header changes, a move to DELIVERY when any line is a
product line, and a move to LINES when every line is a service line — service-ness
judged as the submit route judges it today (SO line `item_group='service'`,
catalogue `category='SERVICE'` in the order's company, or the `SVC-` prefix). On
apply, one transaction: `UPDATE ... SET lane` guarded by the lane it read, plus
one `mfg_so_audit_log` row (action `AMENDMENT_RELANED`, source `repair`) so the
order's History shows the move. No notice is posted: the Logistic inbox reads by
lane, and the announcements banner sits behind a KV cache a script cannot bust.
Output prints lanes and counts only — the repository is public.

Same PR, owner's second ruling 2026-09-15 (「SO amendment reason 换成一定 fill
in」): the submit route now refuses 400 `reason_required` on a blank reason,
before the SO is read, and stores the trimmed text (was `body.reason ?? null`);
both submit prompts (`pages/scm-v2/SalesOrderDetail.tsx`, `mobile/MobileNewSO.tsx`)
validate it with the shared `AMENDMENT_REASON_REQUIRED` message. Pinned by
`routes/amendment-submit-reason.test.ts` (source pin on the handler; RED on the
unfixed tree — the `?? null` fallback and the absent guard both fail it).

**Ref.** `fix/relane-so-amendment-0895`, PR #3950, merged 2026-09-15 10:40Z. Module
guide: `docs/modules/so-amendment.md` §1 (the relane workflow) and §2 (reason
required).

**Production run (2026-09-15 10:43Z, dry run, Actions run 34959398513).** The tool
REFUSED: `Found: status=REJECTED lane=LINES` → `only a REQUESTED amendment can move
lanes`. Read-only on `anogrigyjbduyzclzjgn`: staff had already withdrawn A1 at 09:47Z
(`resolution=WITHDRAWN`, reason "assigned to wrong approver") and re-raised the same
RM150 charge after #3916 deployed — A2 (ADD `MISC`, 09:21Z, lane DELIVERY), A3 (SPEC →
`TRANSPORTATION CHARGES`, price 0), A4 (SPEC price RM150), all three `SO_APPROVED` on
the DELIVERY lane by 09:55Z. So A1 needed no relane; the refusal is the tool doing
its job. It stays for the next amendment stored on a stale lane.
