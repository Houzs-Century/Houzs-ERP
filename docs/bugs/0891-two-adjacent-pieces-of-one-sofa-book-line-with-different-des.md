## Two adjacent pieces of one sofa book line with different Desc2 were refused one piece at a time [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The 0888 requeue plan (run 34823021667) refused HC-SO-013320 and
HC-PO-010008 with `SofaCollapseError: sofa 8069: cannot spell [1A(LHF)] ...
decodes to [nothing]; sofa 8069: cannot spell [1B(RHF)] ...`.

**Root cause (traced).** Probe run 34827560743: both 8069 pieces carry ONE book
key (910573 on the SO, 910869 on the PO) — AutoCount holds the sofa as one folded
line. Before HC-SO-013320/A1 both pieces carried the same imported text
(`col: HR805-20 / Nilon bottom`); the amendment changed `1A(RHF)` to `1B(RHF)`
and re-derived each piece's Desc2 from its own special order, so the texts now
differ. `collapseSofaLines` breaks an adjacency run on a Desc2 change, and
`scatteredByBookLine` (`services/autocount-sofa-collapse.ts`) skipped any
CONTIGUOUS key group on the assumption the adjacency rule had already formed it.
Neither gathered the pair; each piece was collapsed alone, and a lone `1A(LHF)`
cannot be spelled.

Reproduced locally with the production rows through the real
`collapseSofaLines` before changing anything: the exact two refusals.

**Fix.** A contiguous key group is left to the adjacency rule only when its
pieces share one Desc2; otherwise it is gathered like a scattered one. The
gathered build composes `1EL + 1B (32") / COL: HR805-20 / Special Order: Refer to
ERP` and passes the decode gate. Pinned in
`src/services/autocount-sofa-collapse.split-text.test.ts`: RED on the unfixed
tree (`expected [ …(2) ] to deeply equal []`), green after, with two controls.

**Noticed, not changed.** A lone keyed piece still always folds (flush()'s
single-compartment rule), so two adjacent pieces with DIFFERENT keys and
different Desc2 are still refused one at a time. No production document of that
shape was measured; UNVERIFIED whether any exists.

**Ref.** fix/ac-refused-amendment-docs, 2026-09-14.
