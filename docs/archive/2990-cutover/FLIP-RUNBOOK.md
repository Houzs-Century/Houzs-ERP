> **ARCHIVED 2026-08-13.** The flip this runbook executes was performed **2026-07-21** — `HOUZS_OWNS_2990 = "true"` in `backend/wrangler.toml`. Outcome in `docs/2990-cutover/HANDOFF.md`. Kept for history; do not follow it as a current instruction.

# 2990 → Houzs POS cutover — FLIP RUNBOOK (task #15)

The flip makes Houzs the **writer** for 2990 and repoints the POS at Houzs. It is
**prod-irreversible-ish** (see Rollback) and must be executed as ONE atomic
change: the mirror guards lift **in the same deploy** the POS repoints, or the
tablet 409s on its first order.

## The switch (already built — pre-flip default is safe)
- **Backend:** `HOUZS_OWNS_2990` in `backend/wrangler.toml` `[vars]`
  (`companyScope.houzsOwns2990`). `"false"` (current) = read-only mirror, guards
  active. `"true"` = Houzs owns the `2990-` namespace, guards lift. Gates all 4
  mirror-guard sites: SO readonly + create-block (`mfg-sales-orders.ts`),
  amendment gates (`so-amendments.ts loadAmendmentForWrite`), revision engines
  (`so-revision.ts assertNotMirrored`).
- **POS:** `VITE_BACKEND_TARGET=houzs` (`apps/pos/.env.houzs`) — build-time.

## PRE-FLIP checklist (all must be GREEN)
1. **Members + PINs.** The 5 POS salespeople onboarded as company-2 **Sales
   Executive** members (owner, member UI); their `2990S-00x` staff stubs adopted
   (user_id grafted, history preserved) and PIN=000000 seeded. Verify
   `/api/pos/sales-staff` (X-Company-Id:2) lists exactly them with `has_pin=true`.
2. **Staging rehearsal.** On staging set `HOUZS_OWNS_2990="true"` +
   `VITE_BACKEND_TARGET=houzs`, run the full POS flow (pin-login → catalog →
   create SO → payment/slip → KPI). Confirm a `2990-SO-…` create SUCCEEDS
   (no 409) and the price passes the drift gate (combos via
   `/pos-pools/sofa-combos`).
3. **Photos (#11b).** R2 blobs copied 2990→Houzs (or accept photoless catalog).
4. **Drain the 2990 SO outbox to ZERO.** Doc-number continuity depends on Houzs's
   minter (`max(2990-SO-YYMM-%)+1`) seeing 2990's LATEST number. Any un-mirrored
   2990 SO ⇒ Houzs could re-mint a number 2990 already handed out. Drain fully,
   THEN stop 2990's minter.
5. **Doc-number integrity** (verified 2026-07-21 on prod `anogrigyjbduyzclzjgn`):
   0 duplicate `doc_no`; every company-2 SO is `2990-`prefixed; no company-1 SO
   uses `2990-`; current max = `2990-SO-2607-018` (next = -019). Re-run right
   before flip to confirm still clean after the final drain.

## FLIP (atomic — land together)
1. Stop 2990's SO minter + ALL 2990-side crons: SO outbox drain, masters outbox,
   amendment down-mirror, reconcile sentinel (`cron.unschedule` / clear
   `houzs_url`). Turn OFF `sync_config.maintenance_push_enabled` (#692) +
   `sync_config.mirror_commands_enabled` (#726).
2. Backend: `HOUZS_OWNS_2990="true"` → `npx wrangler deploy` (from a branch
   rebased on `origin/main` — see the deploy lesson).
3. POS: build with `VITE_BACKEND_TARGET=houzs` → deploy the PWA (CF Pages).
   Remind the showroom to hard-refresh the tablet PWA.

## POST-FLIP smoke (the owner gate — do BEFORE trusting the fleet)
pin-login → catalog + photos render → create an SO (should mint
`2990-SO-2607-019`) → add a payment slip → KPI tiles populate. Watch for any
`so_owned_by_2990` / `so_create_blocked_2990` 409 (means the flag didn't take).

## ROLLBACK
Set `HOUZS_OWNS_2990="false"` + revert `VITE_BACKEND_TARGET` → redeploy both, and
re-enable 2990's minter/crons. Orders Houzs already minted post-flip stay in
Houzs; re-syncing them back to 2990 is manual, so roll back FAST if the smoke
fails, before volume accumulates.

## Still OUTSIDE this runbook
- #16 downstream data re-sync (DO/PO/GRN/PI/inventory) + setup tables — owner
  deferred to LAST (2990 keeps drifting until flip).
- #19 Houzs HR/commission UI — the long pole to fully RETIRE 2990's backend
  (APIs are ported; UI pending).
