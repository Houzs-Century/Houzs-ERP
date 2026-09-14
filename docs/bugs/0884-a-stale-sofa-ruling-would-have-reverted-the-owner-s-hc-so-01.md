## A stale sofa ruling would have reverted the owner's HC-SO-013497 build [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner 2026-09-14, shown the order-slip photo on HC-SO-013497
(model 9058): 「这个是1AL+C+1NA+1AR」 = 1A(LHF) + CNR + 1NA + 1A(RHF). Staff had
already written exactly that build the same morning through the amendment
screen (HC-SO-013497/A1 "ERP convert wrong item code", and its PO follow-up
HC-PO-2609-064/A1, approved 01:19 UTC). Production read correct — and the
sofa corrections files still said the opposite.

**Root cause (traced).** Two entries keyed to book line 926847 still carried our
own 2026-09-10 reading `L(LHF)+1NA+1NA+1A(RHF)`: the LIKELY drawing read in
`sofa-compartment-corrections-drawings.json`, re-mirrored by the TV round in
`sofa-compartment-corrections-tv-direction.json`. The applier matches the build
by line key, not by who wrote it last, so it treats an amendment made on the
screen as drift to undo. Observed, not inferred: prod dry-run 34808142625 on
main (`DOC=HC-SO-013497`) planned both entries as
`change 1A(LHF) -> L(LHF)`, `change CNR -> 1NA`, refused 0. Any apply run, or a
full run without `DOC`, would have put the mirrored build back on the sales
order and carried it onto the PO lines dedicated to it.

**Fix.** Both stale entries are removed. The owner's ruling goes into
`sofa-compartment-corrections-owner-not-in-file.json` with his words, the photo
key, and the run ids, so one address carries one answer. Against today's rows
the entry is inert: the pieces already match. No code changed. The lib tests
(`node --test backend/scripts/lib/*.test.mjs`) pass except
`the 1ELT build says L(LHF) on BOTH its documents`, which fails the same way on
untouched main (3 builds match, the test expects 2) and is not touched here.

Not fixed here, found on the way: HC-PO-2609-064 lines #1 and #2 still carry
`supplier_sku` `5536-L(LHF)` and `5536-1NA` under codes 1A(LHF) and CNR (trace
run 34808053694). The amendment's PO re-derive moves `item_code` and
`material_name` but not the supplier code, which is the class docs/bugs/0822
fixed for the script writers.

**Ref.** fix/so-013497-sofa-build, 2026-09-14.
