## The PO bedframe variant sweep never said what it would erase [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `docs/bugs/0667` gave the SO arm an erase census on 2026-09-07
(PR #3074). The PO arm did not get one, and it shares the very function that
makes the census necessary. `refresh-po-variants.mjs` had last been APPLIED on
2026-08-31; nobody running it could tell whether it would close the PO variant
backlog or delete operator corrections made since.

**Root cause (traced).** Identical mechanism to 0667, same two lines:
`buildBedframeVariantPatch` (`scripts/lib/variant-merge.mjs`) returns `null` for
every owned axis the parse does not yield, and the write is
`variants = COALESCE(variants,'{}') || patch`. `jsonb || jsonb` overwrites the
keys on the right *including the null-valued ones*, so an axis the ERP holds and
the Desc2 does not state is DELETED.

**The existing counters could not see it, and that is the specific defect.**
`refresh-po-variants.mjs` already reported `fills` and `changes` — but both do
`if (after == null || String(after) === "") continue;`, and a blank `after` over
a non-blank `before` is *exactly* the erase case. The sweep counted everything it
would add and nothing it would take away.

A defect class half-fixed is the one that bites next; the DtlKey collision noted
in this file's own header was fixed on both arms together for that reason.

**Fix.** The same census as 0667, computed from the same `updates` array the
apply consumes — one plan, two readers. Dry-run against production, run
**34131447837**:

```
WHAT THE WRITE WOULD DO, per owned key: 20 would FILL a blank; 18 would CHANGE a value
WOULD ERASE: 5 value(s) the ERP holds and the AutoCount Desc2 does not state
   fabricId 1 / colourId 1 / fabricCode 1 / colourLabel 1 / fabricLabel 1
      PO-009922 FENRIR-(Q): "KS-08 SEA PINK" -> null
```

Five values, one line, one colour block. Small — and it was only knowable
because somebody printed it. That single line then turned out to be a real
matcher defect rather than an acceptable loss: see `0671`, which removes the
erase entirely rather than accepting it.

The 18 CHANGEs are the 2026-08-11 fabric renumbering being applied correctly
(`"KS-15 COOL SILVER" -> "KS-15"`, dropping a `[superseded by ...]` label).

**Ref.** fix/variants-specials-close, 2026-09-07.
