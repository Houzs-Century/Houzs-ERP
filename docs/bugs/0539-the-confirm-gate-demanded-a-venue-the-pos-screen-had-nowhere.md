## The confirm gate demanded a venue the POS screen had nowhere to supply [high]

**Symptom.** A salesperson could not place ANY order from the 2990 POS. Pressing
**Complete order** — after the customer had already signed — returned
*"Order placement failed: A venue is required before this order can be
confirmed."*, and no screen in the handover flow had a Venue field to satisfy
it. Reported by the owner 2026-08-25: *"现在 Adrian 基本上开不到单，因为有跳这个
venue 挂在 2990S 那一边。他发现 Venue 那一边是没有挂的"* — and both halves of that
sentence turned out to be literally true of the data.

**Root cause (traced).** `scm/lib/so-confirm-gate.ts:126` refuses a confirm when
the venue TEXT and `venue_id` are both blank (owner ruling 2026-08-08, *"venue is
compulsory的"*). Four sources can fill them on create
(`scm/routes/mfg-sales-orders.ts`): the client body, the salesperson's
`scm.staff.venue_id` via `scm.venues`, the caller's own home venue, and
`lib/venue-binding.ts` (running PMS project → parked showroom → NOTHING). The
POS sends none — `PosHandoffPayload` in the 2990 repo carried no venue field at
all — so everything rested on the resolver, and on 2026-08-25 every leg of it
was empty.

Measured, not reasoned: `probe-so-venue-gate` (added by #2701 / #2703, read-only,
`workflow_dispatch`), runs **32827817087** and **32826133061**:

| measured on 2026-08-25 | value |
| --- | --- |
| PMS projects with a venue RUNNING that day | **0** (31 ended in the previous 30 days; the last batch 2026-08-23) |
| warehouses carrying a `venue_name` | **1** — `PJ SHOWROOM`, company **2**, `"2990s PJ"` |
| HOUZS (company 1) showrooms | 2, **both with `venue_name` blank** |
| active `scm.staff` rows | 90 |
| …resolving NO venue from any source that day | **83** (82 with a `sales` role) |
| `public.project_venues` | company 1 = **92** active; company 2 = **0 rows** |

So this was never one person's setup gap. Between exhibitions the showroom leg is
the only one left, and it is configured for exactly one warehouse in the other
company. Mig 0186 is why the two HOUZS rows are flagged showrooms with no venue:
it backfilled `is_showroom = (type = 'showroom')` over rows that had never been
through `WarehouseFormDrawer`, which has required a Venue name since it was
written (`:103`).

**The asymmetry that made it look like one person's problem.** The Houzs desktop
New-SO has a Venue dropdown over those 92 rows (`SalesOrderNew.tsx:1911`, owner
2026-06-22 *"houzs 的 venue 是 manually 選的"*), so a desktop operator picks one
and the gate passes. The POS had no such field, so its users had no way out.
Same gate, one surface with an answer and one without.

**Fix.** No Houzs code change — the two endpoints the POS needed already existed
(`GET /api/scm/venues`, company-scoped; `GET /mfg-sales-orders/active-venue`).
The Venue picker was added to the POS handover's Customer step in the 2990 repo
(`wenwei4046/2990s#774`): seeded from `active-venue`, editable, listing the
master, blocking at THAT step rather than after the signature.

Two traps found while building it, both pinned by tests that were proved RED on
the unfixed tree:

1. **An order can pass this gate and still be venue-less.** `venue_id` is a uuid
   column and `project_venues` ids are INTEGERS, so `venueIdUuidOrNull`
   (`mfg-sales-orders.ts:746`) nulls any id a client sends. A payload carrying
   only `venueId` satisfies `collectSoConfirmProblems` — which checks venue OR
   venueId — and lands with a blank venue and nothing reporting it. The POS
   therefore validates on the NAME and sends both, as the desktop does.
2. **Requiring it unconditionally would have blocked the only unblocked people.**
   The 7 reps parked at `PJ SHOWROOM` resolve `"2990s PJ"` server-side and could
   always sell — but company 2 has zero venue-master rows, so a client-side
   requirement would strand them with an empty picker. The requirement is now
   conditional on a choice existing, and the required marker follows it.

**Still open, and it is a decision not a defect.** The two HOUZS showrooms have
no `venue_name`, and 83 of 90 staff are parked nowhere. The picker means nobody
is stuck, but the venue on a between-fairs order is now whatever the salesperson
picks. Whether to hang venues on those showrooms, park people, or keep the PMS
calendar current ahead of each roadshow is the owner's call.

**Ref.** docs/venue-gate-unsatisfiable, 2026-08-25. Probe: #2701, #2703
(`backend/scripts/probe-so-venue-gate-for-staff.mjs`,
`.github/workflows/probe-so-venue-gate.yml`). POS fix: `wenwei4046/2990s#774`.
