## Proof of delivery attached on only one of the ways to close a delivery order [high]

<!-- area: Delivery, DO, returns -->

**Symptom.** The same delivery, closed from a different screen, either carried a
customer signature and a GPS fix or carried nothing at all — and no screen said
which was about to happen. Five surfaces PATCH `/delivery-orders-mfg/:id/status`;
exactly one of them (`MobilePOD.tsx`, the driver screen) sent evidence.

Worse, the delivery-planning board's "POD complete" confirm told the driver
*"Open the order afterwards to attach the POD photo and signature."* That remedy
did not exist: `MobilePOD` withholds its entire capture path once the DO is
delivered (`!delivered && !cancelled && canOperate`), so after that tap there was
no afterwards. The screen named a fix that could not be performed.

**Root cause (traced).** A TYPE, not four careless call sites. The shared hook
`useUpdateMfgDeliveryOrderStatus` was declared `{ id: string; status: string }`
and posted `JSON.stringify({ status })`, so evidence could not travel through it
even if a caller held some. `MobilePOD`'s raw `authedFetch` was therefore not
sloppiness — it was the only way to send a signature at all. Every screen that
used the shared hook correctly (`DeliveryOrderDetailV2`, `MfgDeliveryOrdersListV2`)
filed a delivery with no customer-side proof, and `MobileDeliveryPlanning` had
copied the raw-fetch shape without the evidence.

The backend was never the problem: `patchDeliveryOrderStatusHandler` has accepted
`signatureData` / `podKey` / `podLat` / `podLng` / `podAccuracyM` / `podLocatedAt`
on any status PATCH since migration 0249, writing each only when present.

**Fix.** Widen the hook, not the call sites — a second bypass would have made
three implementations of one PATCH. `DoDeliveryEvidence` is now an optional
parameter on the shared hook; `MobilePOD` and `MobileDeliveryPlanning` both moved
onto it, cutting the raw writers from four to one declared exception.

Evidence is **allowed everywhere and required nowhere**, argued rather than
assumed: the office legitimately closes deliveries it did not attend (2990's
imported deliveries have no POD step at all), the server already DROPS a bad GPS
reading rather than refusing — *"a bad sensor reading must never be the reason a
driver cannot close a delivery"* — and the owner's standing rule is to loosen
rather than restrict. What was wrong was the silence, so every path now names the
loss before it writes: `doCloseWithoutEvidenceWarning` on both desktop surfaces,
a "No customer signature has been captured" line in MobilePOD's confirm, and the
planning board's button now opens the POD screen instead of closing blind.

Pinned by `frontend/src/vendor/scm/lib/do-status-evidence.test.tsx`, proved RED
on the unfixed tree: evidence was dropped from the payload (`expected { status:
'DELIVERED' } to deeply equal { status: 'DELIVERED', signatureData: … }`) and the
source scan listed three raw writers where the fixed tree lists one.

**Known-open, deliberately not silent.** `MobileModuleDetail.tsx`'s declarative
action table still writes `SIGNED` with no evidence. SIGNED counts as delivered
in every downstream reader and satisfies the Sales-Invoice gate, so that is the
same hole one rung lower. It is an allowlisted exception in the test above, with
the reason, rather than an accident — see `0481`.

**Ref.** fix/pod-evidence-and-service-actions, 2026-08-21.
