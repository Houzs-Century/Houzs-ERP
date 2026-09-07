## One code-less purchase-order line killed the whole PO import [high]

**Symptom.** The go-live rehearsal dispatched `Import AutoCount outstanding PO
(go-live)` against production in DRY-RUN on 2026-09-07 and the job died after
reading 512 outstanding PO lines:

```
##[notice]  code-less line imported as accessory: PO-009979 "ERGOTEX PILLOW CASE - FAIR" x20
TypeError: Cannot read properties of null (reading 'toUpperCase')
    at main (backend/scripts/import-ac-outstanding-po.mjs:298:39)
##[error]Process completed with exit code 1
```

Not one line was skipped and the rest imported — **the whole purchase-order
import produced nothing**, on the day of the cutover.

**Root cause (traced).** `import-ac-outstanding-po.mjs:199` sets
`let erp = hit ? hit.erp : null`, so `erp` is NULL whenever the AutoCount<->ERP
binding has no row. `:212` computes `codeless`, and `:217` then deliberately
**accepts** such a line when the book carries a description — the owner's
2026-09-02 ruling 「要进 accessories」 — logging it and falling through. Every
later use honours that: `:308` writes `erp: codeless ? null : erp`, `:309`
falls back to the description for the name.

The one site in between did not. `:298` read
`prodByCode.get(erp.toUpperCase())` with no guard, so the first accepted
code-less line threw. A code-less line has no product to look up; `null` is the
correct answer, not an error.

It had never fired because no accepted code-less line existed in an earlier
export cut. `PO-009979` arrived in the 2026-09-07 re-cut, and one row turned an
accepted case into a total failure.

**Fix.** `const prod = erp ? prodByCode.get(erp.toUpperCase()) : null;` with a
comment naming why `erp` is legitimately null there. Proved by re-dispatching
the same workflow from the fix branch against production in DRY-RUN and reading
the run to completion — the run output is quoted in the PR.

**Ref.** fix/po-import-codeless-crash, 2026-09-07.
