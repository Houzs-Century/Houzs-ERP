## DO line delivery date silently dropped by payload key mismatch + no SO default seed [high]

**Symptom.** Owner 2026-09-11, relayed via Syu: on Delivery Orders — both
desktop and mobile — the per-line "Delivery Date" the operator typed did
not survive a Save, and lines that came from converting an SO landed with
their delivery dates blank. The header field held its value; the line
column always read `—`. Owner's stated rule, clarified across the same
morning:「我开DO之前我改SO就行 …… 顾客每次换的话，我也会跟着换（SO 的），
所以当我开 DO 的时候，你就跟着 default 这个 date 来开」 — DO delivery
date should default to the SO's, so the operator does not have to retype
it, and if the customer moves the date it is the SO that gets updated
first.

**Root cause (traced).** Three holes on the DO channel, each ruling out
the operator as the source. Reading only:

1. `frontend/src/pages/scm-v2/DeliveryOrderNewV2.tsx:631` built the item
   payload with key `deliveryDate: l.lineDeliveryDate ?? ""`. The backend
   item-row builder at `backend/src/scm/lib/do-item-row.ts:136` reads
   `it.lineDeliveryDate` — the two names never met. Every desktop DO
   create AND edit (the same builder feeds both) dropped the line date
   silently: the row was inserted with `line_delivery_date = null`, no
   error to the client, no server log. `poSoCoverageReadShape.test.ts`
   selects `line_delivery_date` and returns whatever landed there —
   `null` in every DO created since the field went in.
2. `backend/src/scm/routes/delivery-orders-mfg.ts` `/from-sos` route,
   lines 4021–4069, built its `delivery_order_items` rows without
   `line_delivery_date` at all. So a DO created by the mobile
   ConvertWizard (which posts to that route) — or the desktop line
   picker — landed every line with `null` regardless of what any client
   sent.
3. `DeliveryOrderNewV2.tsx` seeded new SO-sourced lines at both
   `?fromPicks=1` (line 648) and `?fromSo=` (line 738) with
   `newDoLine(null)` — `null` on purpose, from before the owner's rule
   was written down. So even in edit mode the field opened blank, and
   the operator was expected to retype it on every line.

**Fix.**

- `DeliveryOrderNewV2.tsx:631` — payload key is now `lineDeliveryDate`
  (matches `do-item-row.ts:136`), and the sibling `lineDeliveryDateOverridden`
  is sent alongside so an operator's explicit change survives round-trip.
- `DeliveryOrderNewV2.tsx:648, 738` — new SO-sourced lines seed
  `newDoLine(customerDelDate || null)`, i.e. the header the SO pre-fill
  effect already loaded. So the operator sees "default = SO's delivery
  date" from the moment the form opens; they can still edit per line.
- `delivery-orders-mfg.ts` `/from-sos` — insert rows now carry
  `line_delivery_date: (head.customer_delivery_date as string | null) ?? null`,
  so the mobile ConvertWizard path (which never sends a per-line date)
  stops writing `null` and starts writing the header's date on every
  line, same as the desktop path after the client fix.

The change is behaviour-preserving in the direction that matters: an
operator who typed a per-line date now sees it saved, where before it
disappeared; an operator who did nothing now inherits the SO's date,
which is the owner's stated default. Neither previously-null case
becomes a wrong value — a DO on `main` today never had a line date, so
recomputing to the SO's header on the next edit is a strict improvement.

**Ref.** `fix/do-line-date-cascade`, 2026-09-11.
