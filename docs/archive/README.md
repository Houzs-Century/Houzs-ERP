# `docs/archive/` — shipped and closed

Everything in here describes work that **has shipped and closed**: a plan that was
built, a runbook whose event was executed, a session baton whose items were
merged, or a review of a branch that landed.

Every file carries a one-line header at the top saying **what superseded it and
when**. Read that header first — several of these documents contain instructions
that were correct on the day they were written and are actively wrong now (the
clearest case: `2990-cutover/SESSION-HANDOFF-2026-07-24-session3.md` opens with
"`main` has NO branch protection — you are the merge gate", which stopped being
true on 2026-07-31).

**Nothing here was deleted, and nothing should be.** A plan is often the only
surviving explanation of *why* a subsystem is shaped the way it is; deleting it
throws that away and leaves only the shape. Moving it out of the live tree is
enough — it stops the file being mistaken for current instruction, which is the
actual problem.

**What is authoritative now:** [`../README.md`](../README.md) maps every subject
to the file that owns it.

---

## What is in here, by the work it closed

| Group | Files | Closed by |
|---|---|---|
| D1 → Supabase cutover | `MIGRATION-D1-TO-SUPABASE.md`, `HANDOFF-supabase-cutover.md`, `HANDOFF-TO-IT.md` | The cutover completed 2026-06-13; the D1 binding is gone from `backend/wrangler.toml`. |
| 2990 → Houzs cutover | `2990-cutover/CUTOVER-PLAN.md`, `2990-cutover/FLIP-RUNBOOK.md`, `2990-cutover/DATA-FLOW.md`, `2990-cutover/SESSION-HANDOFF-2026-07-24.md`, `2990-cutover/SESSION-HANDOFF-2026-07-24-session3.md` | The flip happened 2026-07-21 (`HOUZS_OWNS_2990="true"`). Outcome: `../2990-cutover/HANDOFF.md`. |
| SCM 1:1 clone from 2990 | `scm-clone/PLAN.md`, `scm-v2-vendoring-progress.md` | `pages/scm-v2/` is the canonical `/scm/*` surface; no `-v2` routes remain. |
| User management uplift | `USER-MANAGEMENT-PLAN.md`, `DEPLOY-USER-MGMT.md` | Deployed 2026-06-13. Live: `../USER-MANAGEMENT.md`, `../PERMISSION-MATRIX.md`. |
| Mail Center port | `mail-center-port-plan.md`, `mail-center-admin-plan.md`, `mail-center-golive-guide.md` | Shipped, incl. the admin UI. Live: `../modules/mail-center.md`. |
| Draft/Confirmed lifecycle | `draft-confirm-plan.md` | Shipped for DO, SI, PO, GRN, PI. |
| Mobile strip-to-design | `mobile-strip-to-design.md` | All three deletion targets are gone from the tree. |
| Safety net + URL standardisation | `SAFETY-NET-SETUP.md`, `RUNBOOK-URL-STANDARDIZATION.md` | Staging bench + `main-protection` ruleset exist; canonical domain redirect ships. |
| Hardening batch execution | `HARDENING-EXECUTION-HANDOFF.md` | Batch merged 2026-07-22. Live status: `../HARDENING-COMPLETION-LEDGER.md`. |
| PMS FAIR PNL seed | `pms-fair-pnl-seed-plan.md`, `pms-fair-pnl-rework-handoff.md` | Reconcile completed 2026-07-27. Remaining item: `../../tasks/FAIR-PNL-RENTAL-OPEN.md`. |
| Branch reviews | `reviews/SO-CAS-COVERAGE-REVIEW.md`, `reviews/SO-CAS-CLOSURE-REVIEW-2.md` | Reviews of specific commits on a branch that merged. Kept as the review record. |

## What was deliberately NOT archived

- **Every `*-coe.md`.** A COE is an incident record cited by line from
  `BUG-HISTORY.md` and other COEs; moving one breaks those citations.
- **Docs that live code points at** — `../DB-REPOINT-RUNBOOK.md`,
  `../error-tracking-options.md`, `../IDEMPOTENCY-PHASE2-RUNBOOK.md`. If a source
  comment cites a doc, that doc is still load-bearing.
- **Roadmaps with open items** — `../FOUNDATION-PLAN.md`, `../UPGRADE-PLAN.md`,
  `../UPGRADE-NEXT.md`. Stale in places, but not closed.
- **`../2990-live-sync/`** — the mirror it designs is still running; its receivers
  are mounted at `/api/sync/*-mirror`.
