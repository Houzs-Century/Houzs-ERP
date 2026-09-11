# Handoff — AutoCount DO dates + keyless-conversion relink (2026-09-11)

Owner asked to finish what's mergeable and hand the rest off. This is the map of
what shipped, what's queued, and the exact next actions per thread. Everything
here was traced/observed against production unless labelled LIKELY/UNKNOWN.

---

## THREAD 1 — DO delivery dates follow AutoCount (PR #3615) — CODE DONE, repair PENDING

**Business problem.** A delivery order showed the customer's ORIGINAL requested
date as its delivery date instead of AutoCount's. `HC-DO-011559` (customer ref
HC12445): our ERP showed Expected/Customer/Scheduled = **05/09**; AutoCount
`DO-011559` and the DO's own document date said **19/09**. Owner 2026-09-11:
「全部要跟 autocount」.

**Root cause (PROVEN, code-traced).** The DO's `expected_delivery_at` +
`customer_delivery_date` were copied from the SALES ORDER's
`customer_delivery_date`, in two places (both a deliberate 2026-09-08 default,
docs/bugs/0716/0723):
- `backend/src/scm/routes/delivery-orders-mfg.ts` — the SO->DO conversion insert.
- `backend/scripts/lib/customer-block.mjs` `DO_SALES_CARRY` — the migrated backfill.

The delivery-planning board's demand order runs off the SO's date, not the DO's,
so this was a DISPLAY defect (the DO's "Scheduled"/"Expected" labels + DO-list
sort), not scheduling.

**What PR #3615 does.** Both sources now use the DO's own `do_date`
(= AutoCount DocDate). The customer's ask stays on the SO. Ledger `docs/bugs/0804`,
guide `docs/modules/delivery-order.md` updated, pinned by
`doDeliveryDateFollowsAutocount.test.ts`. All local gates green.

### >>> NEXT ACTION (the one still owed): run the one-time repair <<<
The code fixes NEW/converted DOs. Existing rows need the catch-up repair, which is
a SEPARATE workflow (ships with the PR, does nothing on merge):
1. After #3615 merges: Actions -> **Repair DO delivery dates to follow AutoCount**
   -> Run, `mode=plan`. It prints how many AutoCount-linked DOs differ + samples.
2. Review the count with the owner.
3. Run again `mode=apply`, `confirm=DO-DATES-FOLLOW-AUTOCOUNT`. It verifies zero
   remain on a fresh connection.
Script: `backend/scripts/repair-do-delivery-dates-to-autocount.mjs` (scope
`linked_ac_docno IS NOT NULL`; sets both date fields = `do_date`).

**Known caveat.** AutoCount's per-LINE delivery date is NOT mirrored (the DO
header pull `doMirror.ts` carries only `DocDate`; `ACDeliveryOrder` in
`backend/src/types.ts` has no delivery date). `do_date` is the faithful proxy —
right whenever AutoCount's line delivery date = its doc date (the norm, and this
case). If a DO ever has AutoCount line-delivery != doc-date, that needs the
line-level date mirrored (a bigger change; not this defect).

---

## THREAD 2 — Keyless-conversion relink: Fix A (DONE) + the sweep (SHIPPED, but did NOT clear the docs)

**Fix A (MERGED + DEPLOYED).** "Match up lines" now works for DO/GR/IV/PI, not
just SO/PO (`backend/src/scm/routes/autocount-relink.ts`). Ledger 0792.

**The hands-free sweep (PR #3598, MERGED + DEPLOYED, currently OFF).**
`backend/src/scm/lib/autocount-relink-sweep.ts` on the 5-min cron, gated by
`scm.app_config 'scm.autocount_relink_sweep'` (off/plan/apply), set via the
**Set AutoCount relink sweep** workflow. It stamps line keys it can prove, then
queues a keyed edit — unit-proven safe (only fully-keyed docs are ever queued, so
it cannot append a duplicate).

**What happened when it ran (apply, 2026-09-11 ~01:20-01:30 UTC): NOTHING changed.**
The 5 keyless docs stayed keyless (before == after; queue totals identical, no
duplicates — so no harm). Flag was set back to OFF.

**Why it didn't work — UNKNOWN, needs a clear-headed re-diagnosis:**
- It is NOT the office PC being off. I claimed that from "nothing synced since
  11:40pm" — WRONG (that only means nothing NEEDED sending). The inbound pull is
  HEALTHY (autocount-pull-health: 0 days behind), so the PC is reachable.
- Two blind spots stopped me proving the real cause: (a) `wrangler tail` on
  `autocount-sync-api` is DENIED for this account's token (Cloudflare API refuses
  the tails scope), so the sweep's own `[cron ac-relink-sweep]` logs are
  invisible; (b) I did not read the live book.
- LIKELY cause: **these are SOFAS.** GRN-2609-008 (8060-*) and DO-2609-020 (9028-*)
  are per-compartment lines in our ERP but AutoCount keeps a sofa as ONE line
  (memory `sofa-is-one-book-line`), so `planLineRelink` (matches by item_code)
  can't pair 8 ERP lines to 1 book line. That would explain 0 stamped. The other
  3 (DO-021/022/028) are mixed items and MIGHT be relinkable — but all 5 stamped
  0, which points at book-read or matching failing for all, not a per-doc thing.

### >>> NEXT ACTIONS for Thread 2 <<<
1. **Make the sweep observable** — it writes to a live book and we cannot watch
   it, which is exactly what the repo warns against. Add a run-summary the health
   workflow (or a read-only workflow) can read: per doc, book-lines-read, stamped,
   refused-and-why. THEN re-run `plan` and read it. This is the missing piece.
2. With that, confirm the sofa hypothesis. If sofas can't relink by item_code,
   they need a different match (the sofa is one book line; our lines are its
   compartments) — likely out of scope for line-by-line relink.

---

## THREAD 3 — The date-comparison tool (main has a BROKEN copy)

`compare-ac-erp-dates` (PR #3600 merged) compares our DO/SO dates vs AutoCount's
two mirrors. **The version on `main` is buggy** (wrong schema, wrong column). The
WORKING version is on branch `chore/ac-erp-date-compare` (3 fix commits: mirrors
are in `public` not `scm`; `delivery_orders` has `do_number` not `doc_no`; find
the DO by `so_doc_no`; ISO dates). **Next: open a tiny PR to land those fixes on
main, or delete the tool** — it served its purpose (answered the date question).

**What it proved (PROVEN):** across all **70** AutoCount-linked delivery orders,
our document date matches AutoCount's — **0 differ**. The SO snapshot
(`ac_snapshot_sales_orders`) is EMPTY (the full `/getAll` pull never populated it),
so SO doc-dates and any delivery-date comparison from the mirrors is blind — the
delivery-date defect is Thread 1, found from the screenshots instead.

---

## Facts the next person should not re-derive

- **AutoCount mirrors live in the `public` schema**, not `scm`:
  `public.autocount_delivery_orders` (mig 0215, DO headers, `doc_date` only) and
  `public.ac_snapshot_sales_orders` (mig 0288, SO headers + `raw`). The SCM tables
  (`scm.delivery_orders`, `scm.mfg_sales_orders`) are in `scm`.
- **`scm.delivery_orders`** keys on `do_number` (no `doc_no` column); links to
  AutoCount via `linked_ac_docno`; links to its SO via `so_doc_no`.
- **The office AutoCount PC is reachable** (pull healthy). Do not assume "off"
  from a quiet send window.
- **`wrangler` is authed** (weisiang329@gmail.com) but **`wrangler tail` is denied**
  (token lacks the tails scope) — you cannot read the Worker's cron logs this way.
- **The real not-in-AutoCount backlog (health check, 2026-09-11)** is ~11 docs, not
  the raw 40 queue rows (most already arrived): 5 keyless conversion (2 sofas),
  3 rebuild-refused (the book itself says "match the lines up", NOT rebuild —
  HC-SO-000814, HC-PO-006690, HC-PO-2609-055), 2 item-code binding (CELENE (A)-(K),
  DIVAN ONLY-(Q)), 1 Desc2-too-long DO (9050-1A), + a couple that self-resolve.
- **Read-only backlog view:** Actions -> **AutoCount write-back queue — health**.

## PRs from this session
- #3584 Fix A relink DO/GR/IV/PI (merged) · #3598 relink sweep (merged, flag OFF)
  · #3600 date-compare tool (merged, buggy on main; fixes on `chore/ac-erp-date-compare`)
  · #3615 DO dates follow AutoCount (queued) — **repair still to run**.
