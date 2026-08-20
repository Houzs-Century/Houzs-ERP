## Mobile delivery "On the way" and "POD complete" taps failed silently to the driver [low]

**Symptom.** On the mobile delivery-planning stop card, a driver taps "On the way" (IN_TRANSIT) or "POD complete" (DELIVERED); if the PATCH is refused the button simply re-enables and nothing is shown. The owner's own report shape for this class is "the button does nothing" — the arrival/departure the customer is supposed to see never lands and the driver has no idea.

**Root cause (traced, not guessed — read frontend/src/mobile/MobileDeliveryPlanning.tsx).** The three DO-lifecycle useMutation hooks sit together: `start` (~line 1275, status IN_TRANSIT), `arrive` (~line 1298, stamps arrivalAt) and `complete` (~line 1322, status DELIVERED). `arrive` was fixed earlier and carries an `onError` that calls `notify({...})`; `start` and `complete` carried only `onSuccess: async () => { await invalidate(); }` with no error path at all. `notify` (useNotify, line 1162) was already in scope and already used by the DO-create paths and by arrive.onError, so the two hooks were the only silent survivors — the exact "a failure that reaches nobody is worse than a crash" class the repo tracks via check-silent-mutations.

**Fix.** Added an `onError` to both `start` and `complete`, copying the arrive mutation's pattern verbatim: `notify({ title, body: e instanceof Error ? e.message : "Something went wrong. Please try again." })` with titles "Couldn't start the delivery" / "Couldn't complete the delivery". Behaviour-preserving otherwise. Test pins all three taps against silent-failure regression.

**Ref.** 2026-08-18.
