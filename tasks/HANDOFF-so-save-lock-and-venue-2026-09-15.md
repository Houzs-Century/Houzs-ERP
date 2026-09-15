# Handoff: sales-order save lock, Fair/venue field, HC-SO-2609-071 — 2026-09-15

State at about 13:30Z. Every number below came from a command run between 12:04Z
and 13:25Z; re-run before quoting.

## What the owner asked

On HC-SO-2609-071 (desktop):

> 「我第一次 save 的时候可以，可是不确定是不是在短时间内要多一两轮再 save 多一次却不行。帮我检查全套系统，关于这个问题也。是要解决掉。」

and, on the same order's Fair field showing "Others — pick a place instead" with
"MID VALLEY" typed in: 「应该是venue的」.

The owner was told (before this file) not to save HC-SO-2609-071 again until the
fix is live.

## 1. The save lock — PR #3977, OPEN

Branch `fix/so-consecutive-save`, worktree
`houzs-work-worktrees/so-consecutive-save`. Ledger
`docs/bugs/0936-a-save-that-reported-success-left-the-order-s-lock-behind-so.md`
has the full trace; the guide section is "The save lock" in
`docs/modules/sales-order.md`.

Three faults, each proved RED on the unfixed tree:

1. A save that reported success left its lease on the order (the last request
   carried one field the server dropped, and no end flag). PROVEN in production:
   the lease reserved 12:01:10.572Z was never released.
2. The same person's own leftover lease refused their next Saves: mig 0348's
   takeover had never reached the header PATCH reservation.
3. Save returned to the detail page before the order was re-read, so an instant
   Edit opened on the pre-save copy.

**CI at 13:25Z, and what was done about it:**

| check | result | cause | fix |
| --- | --- | --- | --- |
| `backend-typecheck` (required) | failed | `audit:empty-state-claims` flagged the test name "a token with nothing left to write ENDS the save" | renamed in `backend/src/scm/lib/so-edit-lease.test.ts`; audit exit 0 locally. Committed with this file |
| `backend` | failed | only aggregates `backend-typecheck` | follows the above |
| `completeness-claim` | failed | PR body said "Both screens" | body reworded with `gh pr edit`; local check PASS |
| `frontend` | pending at 13:25Z | — | — |

Locally after the rename: every later `backend-typecheck` step through
`typecheck` exit 0; `test:light` was still running when this was written.

**Next, in order:**

1. Push; wait for `backend-typecheck` + `frontend` green (read the newest run, not the rollup).
2. Merge through the queue with plain `gh pr merge 3977` (no `--auto`).
3. Find the Deploy run whose head contains the merge commit; its `backend` AND `frontend` jobs must both be `success`. Check `https://autocount-sync-api.houzs-erp.workers.dev/health` for the sha.
4. Frontend proof: the change adds no new string literal, so scan the live JS assets for the key ORDER only `so-save-lease.ts` writes — regex `lineWriteLeaseToken:[\w$]+,completeLineWrites:!0` (the older release calls put `completeLineWrites` first). UNTESTED probe: the minified shape was not checked locally.
5. Production proof (read only, after the owner's next Save of HC-SO-2609-071): `scm.mfg_sales_orders.edit_lease_token` is NULL after the save, and the order's audit rows show the save. Until then the fix is UNTESTED against a live save.
6. Tell the owner in plain Chinese that the order can be saved again.

## 2. HC-SO-2609-071 data, read only at 13:22Z

- `version` 15; lease token still on the row but expired 12:02:10.572Z (an expired lease blocks nothing).
- No write to the order since 12:01:11Z.
- Special Order notes:

| line | fabric | note now | what happened |
| --- | --- | --- | --- |
| SB02 | HR805-40 | empty | cleared by the 12:01:11 save; was "HR805-40" |
| BC05-MF | GD526-16 | empty | cleared by the 12:01:11 save; was "Special Fabric-GD526-16 (BEETEX Chenille)" |
| AR01 | GD526-16 | empty | same as BC05-MF |
| AR02 | GD526-16 | "Special Fabric-GD526-16 (BEETEX Chenille)" | untouched |
| SQUARE PILLOW | MODENZA-01 | "MODENZA-01" | untouched in the database |

Each cleared note only restated the line's fabric, and the three lines carry
`extraAddonAmountRM: 0`, which only the Special Orders **Clear** button writes
(desktop `SpecialOrders.tsx`, phone `MobileNewSO.tsx`). LIKELY the owner cleared
them on purpose: the same day the Sofa Accessory data run filled `fabricCode`
from these notes, and PDFs printed the colour twice (docs/bugs/0934-a-special-order-note-that-only-repeats-the-line-s-colour-pri.md).
The owner's screenshot after the failed saves shows SQUARE PILLOW's note cleared
on screen but the database still holds it: **the second round of edits was never
saved** and must be done again once #3977 is live. Not yet confirmed with the
owner; nothing has been restored or written.

## 3. Fair / venue field — local commit, NOT PUSHED

Worktree `houzs-work-worktrees/so-fair-others-venue`, branch
`fix/so-fair-others-venue`, commit `61376e521` at 13:09Z:
"fix(so): a saved venue shows as the Fair field's value, not as "Others" (0936)".
Files: `frontend/src/components/FairPicker.tsx` (+ test),
`frontend/src/vendor/scm/lib/fair-options-queries.ts`, `docs/modules/sales-order.md`,
and its own ledger entry `docs/bugs/0936-every-saved-venue-opened-as-others-in-the-sales-order-fair-f.md`.

- Written by a background agent started in the session before this one. At 13:25Z the branch was not on origin and had no PR; the agent is most likely gone with that session.
- **Next:** read the commit and its ledger entry, run `FairPicker.test.tsx` and `npm --prefix frontend run typecheck` in that worktree, push, open the PR, merge, verify the deploy the same way as #3977.
- Its ledger ordinal 0936 equals #3977's and another merged entry's. `scripts/new-bug.mjs` says a shared ordinal is fine; cite entries by full filename.
- Touches the same guide file as #3977 (`docs/modules/sales-order.md`), in a different section; expect a clean merge, but check.

## 4. Still open, not started

- Status change, draft discard and amendment apply still refuse a live lease even when it is the caller's own. After #3977 a lease is only left by a save that crashed, for at most a minute.
- The desktop editor adopts a venue-master option by name (`SalesOrderDetail.tsx`, the "Imported-order venue seeding" effect). A project venue's id is a number, which the header PATCH drops, so that save sends a field that never lands. Harmless for the lock after #3977; the adoption itself does nothing for such orders.
- The deferred allocation recompute can bump an order's version right after a save; an instant Edit can still meet that real change. Frequency UNKNOWN.
- The 504 on the owner's page load (`HC-SO-2609-071?edit=1`) is unexplained. UNKNOWN.

## Earlier in the same session, done

- ERP #3910 — DIVAN ONLY no longer needs a Gap; a refused line add no longer locks its own Save key. Live, proven on HC-SO-011153.
- ERP #3941 — Sofa Accessory: badge, Special Order panel, PDF heading, phone category. Live.
- ERP #3848 — docs corrections.
- Houzs Connect #20 / #21 — business-profile editor, Houzs number assigned. The owner said 「剩下的我来」: the owner fills the profiles, switches on auto replies and sets `WHATSAPP_APP_SECRET`.
