## An approved amendment left HC-PO-010086 ordering SQUARE PILLOW after the sales order became AMN-SOFA PILLOW [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** The hard-bound check found one company-1 purchase-order line whose
category disagrees with the sales-order line it is linked to: HC-PO-010086's
pillow line reads `SQUARE PILLOW` / `fabric_accessory` (a custom pillow with a
chosen colour), linked to HC-SO-013346 line 2, which is `AMN-SOFA PILLOW` /
`accessory`, Description 2 "Random", no colour. Owner rule: a pillow with a colour
is a square pillow, without one it is a sofa pillow — so the sales order is right
and the purchase order is ordering the wrong item. Its follow-up amendment
HC-PO-010086/A1 is APPROVED and its preview line says `SPEC new_item_code=AMN-SOFA
PILLOW` for exactly this line (`775f4ba1-…`).

**Root cause (traced).** Not a later overwrite — the approve never moved the code.

1. HC-SO-013346/A3 (SPEC line 2 SQUARE PILLOW -> AMN-SOFA PILLOW) was approved
   2026-09-10 08:00:44Z; it raised HC-PO-010086/A1, confirmed 08:02:17Z
   (check-so-colour-amendment-trace run 34968226095, sections 4a/4b).
2. A follow-up confirm applies through `reviseBoundPo` (routes/po-amendments.ts,
   `source_so_amendment_id` branch), which re-derives each bound line from the
   revised SO line. On 2026-09-10 its UPDATE did not contain `item_code` or
   `material_name` — that omission is `docs/bugs/0808`, fixed by PR #3629, merged
   2026-09-11 05:05Z, 21 hours AFTER this confirm. So the line kept its code and
   name while `item_group` / variants / Description 2 were taken from the SO line.
3. The `po_revisions` rev-1 snapshot the confirm took before applying (08:02:10Z)
   holds line `775f4ba1-…` as `SQUARE PILLOW` / `accessory` / Description 2
   "Random"; the AutoCount edit queued by that confirm still describes it as
   `HOK- SQUARE PILLOW (16"X16") (CUSTOM)`; the PO's whole entity audit is that one
   `AMENDMENT_PO_APPROVED` row; its header `updated_at` is still 08:02:17Z (read-only
   probe run 34970012997).
4. The 2026-09-14 Sofa Accessory move (`recategorise-fabric-accessory.mjs`) sets
   `item_group = 'fabric_accessory'` on every line whose ITEM CODE is SQUARE PILLOW
   — it keyed on the stale code and turned the category mismatch visible. It did
   what it says; the wrong input was the code.

Still true on today's engine: after #3629 and `docs/bugs/0887` the re-derive moves
the code, name and supplier code, but NOT the line `description`. For a line with
no variant summary (a pillow with no colour) the PO detail page shows that
description under the code, and the AutoCount edit sends it as Description, so a
swap would still read "SQUARE PILLOW (CUSTOM)" under `AMN-SOFA PILLOW`.

Other lines left behind the same way (realign-po-line-to-so-line LIST, probe run
34969734366): 4 live PO lines whose code differs from their SO line — this one, and
three sofa pieces on HC-PO-009630 (RECEIVED) and HC-PO-009940 that are already
received and belong to the sofa-compartment work, not to this repair.

**Fix.**
- The per-line re-derive moved out of `reviseBoundPo` into
  `backend/src/scm/lib/po-line-rederive.ts` (`rederivePoLineFromSoLine`), unchanged
  except that a MOVED item code now also moves `description` to the SO line's
  description (left alone when the code stays, so buyer-typed text survives).
  Test: `so-revision.reviseBoundPo.test.ts` "moves the line description with a
  changed item code, and leaves it alone when the code stays" — the HC-PO-010086
  shape. Proved RED on the unfixed tree (description stayed
  `HOK- SQUARE PILLOW (16"X16") (CUSTOM)`), GREEN after.
- Data: `backend/scripts/realign-po-line-to-so-line.mjs` +
  `.github/workflows/realign-po-line-to-so-line.yml` — runs THAT function over
  `lib/pgrest-shim.mjs` for one named line, plan by default, apply behind a
  CONFIRM phrase, refuses received lines, verifies shape on a fresh connection.
  Its read-only derivation for this line (run 34969734366): code, name and
  description -> `AMN-SOFA PILLOW (RANDOM) (FREE GIFT)`, category -> `accessory`,
  supplier code `HOK-SQUARE PILLOW` -> none (OHANA has no binding for
  AMN-SOFA PILLOW; only ARMANI does), price 0 unchanged, link kept.

**Ref.** fix/po-line-realign-to-so-line, 2026-09-15.
