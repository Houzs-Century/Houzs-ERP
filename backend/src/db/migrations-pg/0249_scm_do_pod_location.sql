-- 0249 — where the delivery actually happened.
--
-- WHY. Owner, 2026-08-03: "我要提取他们在什么地方，才能知道...他们送到哪一个地方".
--
-- The driver's phone ALREADY takes this reading. MobilePOD.tsx has a Capture
-- button, asks for geolocation, and prints the coordinates on screen next to the
-- signature pad — and then throws them away. Its own file header says so:
-- "GPS stays client-side (no server column)", and the markup at line 354 repeats
-- it: "no server field yet". Every proof of delivery since that screen shipped
-- was signed at a known place, and none of them recorded it.
--
-- So this is not a new capture. It is four columns for a number the phone is
-- already holding at exactly the right moment: the driver is standing at the
-- door with the page open, which is the ONE instant no background-location
-- permission is needed to get a good fix.
--
-- ACCURACY IS STORED, AND THAT IS THE POINT. A fix with a 2 km radius is not
-- evidence of anything — it is a phone guessing from cell towers. Without the
-- radius beside them, two coordinates look equally authoritative whether they
-- came from GPS on a clear street or from a wifi guess inside a warehouse. Any
-- screen showing this MUST show the accuracy too.
--
-- pod_located_at is separate from delivered_at on purpose: the reading can be
-- taken minutes before the driver finishes the paperwork, and a stale fix that
-- silently reads as "the delivery moment" is worse than an honest gap.
--
-- ALL NULLABLE. A denied permission, an indoor delivery with no signal, or a
-- driver on an old handset must never block a delivery from being completed.
-- Location is evidence when it is there, not a precondition.
--
-- NO BACKFILL — the readings were discarded, not stored somewhere else.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, one transaction.
-- RE-CHECK THE NUMBER AT MERGE — 0249 was next free above 0248.

SET search_path = scm, public;

ALTER TABLE scm.delivery_orders
  ADD COLUMN IF NOT EXISTS pod_lat         DOUBLE PRECISION NULL,
  ADD COLUMN IF NOT EXISTS pod_lng         DOUBLE PRECISION NULL,
  ADD COLUMN IF NOT EXISTS pod_accuracy_m  DOUBLE PRECISION NULL,
  ADD COLUMN IF NOT EXISTS pod_located_at  TIMESTAMPTZ NULL;

-- Range guards. A latitude of 91 is not a place; it is a parsing bug, and it
-- would plot somewhere plausible-looking on a map that clamps.
ALTER TABLE scm.delivery_orders
  DROP CONSTRAINT IF EXISTS delivery_orders_pod_latlng_range;

ALTER TABLE scm.delivery_orders
  ADD CONSTRAINT delivery_orders_pod_latlng_range
  CHECK (
    (pod_lat IS NULL OR (pod_lat  BETWEEN  -90 AND  90)) AND
    (pod_lng IS NULL OR (pod_lng  BETWEEN -180 AND 180)) AND
    (pod_accuracy_m IS NULL OR pod_accuracy_m >= 0)
  );
