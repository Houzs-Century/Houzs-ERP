## A sofa piece kept as its own book line was folded alone and refused [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** A resend plan against production on 2026-09-14 (run 34865251149)
still refused two purchase orders with `SofaCollapseError`:

- HC-PO-2609-063: *"sofa 8030: cannot spell [1A(LHF)] ... sofa 8030: cannot
  spell [1A(RHF)]"*. This order also carries the 0889 swap on its pillow line,
  quantity 1 in the book against 2 in the ERP, so the refusal kept a wrong
  quantity and cost in the book.
- HC-PO-2609-047: *"sofa 9028: cannot spell [2A(RHF)]"*.

**Root cause (traced).** Both documents keep their sofa pieces as SEPARATE book
lines, each under its own key:

- HC-PO-2609-063: 8030 1A(LHF) is line 929346 and 1A(RHF) is line 929348, with
  the pillow line 929350 between them.
- HC-PO-2609-047: 9028 L(LHF) is line 928220 and 2A(RHF) is line 928221. They
  sit next to each other, but their specials differ.

`collapseSofaLines` (`backend/src/services/autocount-sofa-collapse.ts`) forms
runs by adjacency and breaks a run on a Desc2 change, so each piece became a run
of one. A single keyed compartment always folds, on the stated reasoning that
it "is a build the book holds as one line". An armed end, corner or chaise has
no solo spelling (`2ER` decodes to [2S], measured 2026-09-14), so the fold was
refused. A document that holds another piece of the same model under a different
key is not holding a folded one-piece build.

**Fix.** A single keyed compartment goes through as itself when both of these
hold:

- its piece has no solo spelling;
- the same document holds another compartment of that model under a different
  key.

Everything else folds as before.

Pinned in `backend/src/services/autocount-sofa-collapse.piece-lines.test.ts`,
built from both orders' production rows. It fails on the unfixed tree (2 failed:
`expected [ …(2) ] to deeply equal []`) and passes after. Two controls still
fold: a lone keyed armed end with no other piece of its model, and pieces that
share one key. The seven sofa and write-back contract suites pass (135 tests).

**Ref.** fix/ac-sofa-piece-lines, 2026-09-14.
