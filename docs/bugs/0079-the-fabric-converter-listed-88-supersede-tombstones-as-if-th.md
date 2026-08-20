## The Fabric Converter listed 88 supersede tombstones as if they were fabrics [low]

**Symptom** - the owner opened the Fabric Converter and read `AVANI-01`
immediately above `AVANI-01 [merged into AVANI-01 on 2026-08-11]`, and the same
for AVANI-02..08, BO315-1-PEARL, BO315-11-METAL and dozens more - "why does my
code have this twice?". The `Fabrics (827)` badge counted them too.

**Root cause (traced, not guessed)** - the rows are correct. They are the losers
of the 2026-08-11 merge pass, kept with `is_active = false` and a note recording
what absorbed them, exactly as the never-delete-only-retire rule requires.
`GET /fabric-tracking` returns `is_active` but does not filter on it, and neither
the Converter page nor the Maintenance Fabrics panel filtered either - so 88 of
~830 rows were tombstones presented as live fabrics.

**Fix** - `useFabricTrackings` gains `includeRetired`, filtering in a `select` so
both views derive from ONE cached fetch. The Maintenance panel passes false; the
Converter hides them behind a `N retired hidden` checkbox.

**The default is a deliberate change to the 2026-06-12 spec**
(`fabric-queries.ts:164`: "rows stay on the converter"). That spec's intent -
retiring is not deleting, and the rows stay manageable - still holds: they are one
click away. But it was written before a merge pass put 88 tombstones in the list,
and a master list that reads as if every code is duplicated serves nobody. Flagged
for the owner to veto if the original default was load-bearing.

**Ref** - `fix/converter-hide-retired`, 2026-08-12

---
