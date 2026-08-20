## A bedframe SO line was stamped with a DIFFERENT line's build, because the Desc2 lookup was keyed on the document instead of the line [high]

**Symptom** - 14 migrated bedframe sales-order lines disagreed with the purchase
order raised from them on colour, mattress gap or divan height, while the
AutoCount `Desc2` was **byte-identical on both documents** (md5 confirmed per
line in production). It was first read as a commercial dispute - the customer's
order and the factory's naming different fabrics - which it never was.

**Root cause (traced, not guessed)** - `refresh-so-variants.mjs` built its
parsed-`Desc2` lookup as

```js
parsed.set(`${r.DocNo}|${erp.toUpperCase()}`, parseBedframe(r.Desc2))
```

`(AutoCount DocNo | ERP item code)` is **not a line identity**. One order
routinely carries several rows of the same SKU in different colours or heights,
so `Map.set` kept only the LAST of them, and the lookup at the write site then
stamped that single parse onto EVERY database line sharing the key. Measured on
the checked-in export with no database access: **183 keys collide carrying a
genuinely different `Desc2`, losing 298 lines**. `SO-006572` / `NK-1046 (Q)` is
the defect in one document - three lines, `PC151-01`/gap 10", `PC151-02`/gap 10"
and `PC151-14`/gap 12" - all three stamped `PC151-14`/gap 12", which is exactly
the double conflict reported against that order's PO.

The PO arm carried the identical defect and mostly escaped it: a RECEIVED PO is
not "outstanding", so `ac-outstanding-po.json.gz` holds only 338 rows and nearly
every PO line fell through to the per-line `description2` fallback, which is
line-accurate by construction. That asymmetry is the whole reason `Desc2` backed
the PO on **27 of 27** conflicting axes, and why the SO looked like the liar.

`DtlKey` - unique across all 13,588 export rows - was in the export the entire
time. The database side (`linked_ac_dtlkey`) only arrived at 17:57Z on
2026-08-11, three and a half hours AFTER the variant write at 14:17Z, so the
script had no line identity to key on when it ran.

Two claims in the handover were refuted by the same evidence. `HC-SO-012781` was
listed as an exception where `Desc2` backed the SO's 12"; it does not.
`Hydraulic2pcs12”inner` states the INNER depth, and the owner's own rule
(#1883, "inner的话就是inner+2") converts an inner-only figure at +2, so that bed's
divan is 14" and the PO was right - the SO's 12" is its sibling line's
`frontdrawerdivan12”`, stamped on by the collision. The reported `divanHeight`
of 151" is not on either document; both PO lines read 14" and 12".

**Blast radius** - the 14 were the visible tip. Of 2,381 migrated bedframe SO
lines, 92 disagree with their own line's AutoCount text and **85 are exactly
what the collided key would have produced**. The rest were invisible only
because no PO happened to contradict them.

**Fix** - both refresh scripts key on `DtlKey` and resolve each line by its own
`linked_ac_dtlkey`, falling back to that line's own `description2`; the
AutoCount-to-ERP code CSV is retired from both, since a line identity needs no
code translation. `cross-fill-so-po-variants.mjs` carried the same collision on
both of its indexes and now pairs on `purchase_order_items.so_item_id`, refusing
any leftover `(SO no | code)` group that is not one-to-one rather than taking
the last. `repair-collided-so-variants.mjs` rewrites the affected rows from
their own line's text, gated on the row currently holding exactly what the
collided key produced, MERGING into `variants` so specials and unknown keys
survive, guarded by `jsonb_typeof(variants) = 'object'`, counting `RETURNING`
rather than the command tag and re-reading every row on a fresh connection.
`bedframeVariantLineIdentity.test.ts` pins the invariant.

**CLOSED 2026-08-11.** The remaining 71 rows were repaired after the evidence
that was missing arrived. The repair joins the line's own `linked_ac_dtlkey`,
but that key was itself set by a POSITIONAL zip over the same
`(DocNo | item code)` pair that collided (`backfill-ac-line-keys.mjs`), so
joining on it inherits the guess rather than escaping it. A third gate settles
it: the row's own `description2`, written per line by the importer from the very
export row it created that line from and never written by either refresh script,
must match the export row the stored key addresses. Production reads **2363
corroborated, 0 contradicted** - the zip recovered every binding it claimed.

All 71 passed the gate, 71/71 were returned by the UPDATE and read back on a
fresh connection. The diagnostic moved **agree 2289 -> 2360, mismatch 78 -> 7,
collision-attributable 71 -> 0**. The 7 that remain are a different fault
entirely, recorded in its own entry (an unresolved colour, not wrong data). 14
lines carry no `DtlKey` at all and were NOT
repaired by position: 13 of them were checked against their own `description2`
and agree, and one (`HC-SO-000015 JAGER-(Q)`) has no text to check.

**Ref** - 2026-08-11, PR #1951 (diagnostic), PR #1958 (writer), PR #1964
(the remaining 71 + gate 3). Prod evidence: apply run 31432521529, verification
run 31432632597.
