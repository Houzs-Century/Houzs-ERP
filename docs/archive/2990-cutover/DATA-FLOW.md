> **ARCHIVED 2026-08-13.** The open question here (full replace vs one-way mirror vs both) was settled by the **2026-07-21** flip: Houzs owns the 2990 write path (`HOUZS_OWNS_2990="true"`) *and* the one-way mirror receivers stay mounted (`/api/sync/*-mirror` in `backend/src/index.ts`). Recorded in `docs/2990-cutover/HANDOFF.md`; the mirror's live design is `docs/2990-live-sync/00_DESIGN.md`. Kept for history; do not follow it as a current instruction.

# 2990 ⇄ Houzs data flow — model + the open bidirectional question

Owner described (2026-07-13, going to sleep): "POS data enters the OLD 2990
backend AND Houzs at the same time; meanwhile some Houzs data reverts back to
2990; this amounts to fully folding the 2990 backend into houzs-entry."

That describes a **dual-write + bidirectional coexistence** during transition. It
sits in tension with the earlier decision (**fully replace + retire the 2990
backend**). Both can't be the end state. Here is the honest read so the owner can
resolve it — I did NOT build a bidirectional engine blind (it's the bug-prone bit).

## Three coherent models

**A. Full replace (earlier decision, what P1–P5 build).** POS → Houzs only; 2990
backend retired. One source of truth. No sync at all. Cleanest end state. Cost:
the POS-side rewire (P4) + a real cutover (P5).

**B. One-way mirror (already built, dormant).** POS keeps writing 2990 natively;
a trigger+outbox forwards each SO to Houzs (company_2), zero-loss. Houzs = live
read-mirror for the unified view. 2990 stays authoritative + alive. Low risk, but
2990 backend never retires — the "坑" the owner flagged.

**C. Dual-write + bidirectional (what the sleep message describes).** POS writes
BOTH systems; changes sync both directions so they stay consistent. This is the
hardest and most bug-prone: write conflicts, echo loops (A→B→A), ordering,
double-apply. Industry avoids true bidirectional unless unavoidable. If pursued,
it must be **field-scoped and idempotent with origin tags + conflict rules**, never
a naive "copy everything both ways."

## Recommendation (for the owner to confirm)

- **End state = A (full replace).** It's what "彻底代替 2990 backend" means and it's
  the only model without permanent sync cost. P1 (auth) + P2 (endpoints) are DONE
  on prod; P3 nearly done; P4 (POS-side) + P5 (test+flip) remain.
- **Transition = B (one-way mirror), NOT C.** During the cutover window, let the
  POS keep writing 2990 AND mirror one-way into Houzs (already built) so the owner
  can watch both match. Do NOT build bidirectional回传 — if a specific Houzs-side
  field genuinely must reach 2990 (e.g. a status the POS displays), handle THAT
  one field explicitly, not a general reverse sync.
- Net: dual-write during transition (POS→2990 native + one-way mirror→Houzs), then
  flip POS fully to Houzs (P5) and retire 2990. No permanent bidirectional layer.

## Why not C overnight
A naive bidirectional sync built unsupervised would risk corrupting live 2990
retail data (echo loops / conflicting overwrites). That violates "POS must never
break." So this is flagged for an explicit owner decision rather than built.

## What IS shared vs separate (unchanged, for reference)
Shared (one copy): TMS drivers/helpers/lorries, staff roster, chart of accounts,
currencies, Service *operational* module. Separate (per company): SO/DO/PO/GRN/
invoices, products, warehouses, letterhead, User Management, Mail Center,
Announcements, Service *pricing catalog* (0% overlap — cannot merge).
