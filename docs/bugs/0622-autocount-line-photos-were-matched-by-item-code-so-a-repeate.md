## AutoCount line photos were matched by item code, so a repeated code left the second line blank [medium]

**Symptom.** A document lists the same product twice. The first line shows two
photographs; the second line shows none. On prod, 34 AutoCount lines across 30
documents look like this — 25 of them show nothing at all, and 9 show a single
broken tile. Examples: `HC-SO-013384` (two lines, one photo each in AutoCount,
both landed on the first), `HC-PO-009875` (a sofa build whose three pictures all
went to one compartment row).

**Root cause (traced).** `backend/scripts/import-so-line-photos.mjs` and
`import-po-line-photos.mjs` find the ERP row for a photograph by ITEM CODE and
take the first match — `byDocCode.get(\`${m.DocNo}|${norm(erp)}\`)` then
`cands[0]`, with `byDocModel` doing the same thing for sofa on the code up to
the first dash. AutoCount does not identify a photograph by item code; it
identifies it by LINE (`DtlKey`). So when one document carries the same code —
or the same sofa model — on two lines, every photograph for that code is minted
onto the first row and the later rows get nothing.

Observed, not inferred. Instrumented copies of both importers were run in
RESOLVE mode against production on 2026-09-03 with the read-only DSN, printing
the bucket and target row for every manifest entry. All 25 of the lines the gap
probe reports as photo-less (run 33659147683) came back in the `planned` bucket,
not in `sofa held` / `order-not-imported` / `unmapped` — the matcher resolves
every one of them, onto a row whose own `linked_ac_dtlkey` is a different line.
Cross-checking those planned keys against an R2 object listing: 30/30 are
attached and 30/30 resolve, so the photographs were never missing.

**Fix.** Both importers now build `byDocDtl` from `i.linked_ac_dtlkey` and try
the row that OWNS the AutoCount line first, falling back to the existing
item-code path when the line carries no key (244 SO lines carry none, so the
fallback is load-bearing). Sofa is untouched: a build's compartment rows all
share the key and the photo still lands on the first of them.

Measured before/after on prod, RESOLVE mode, 2026-09-03:

| | SO before | SO after | PO before | PO after |
|---|---|---|---|---|
| photo keys planned | 599 | 602 | 235 | 238 |
| sofa held | 1124 | 1121 | 1236 | 1233 |
| target row unchanged | — | 576 | — | 204 |
| retargeted onto the owning row | — | 23 | — | 31 |
| moved to a different sofa compartment | — | **0** | — | **0** |

`backend/scripts/lib/line-photo-keys.mjs` holds the pure decisions with
`line-photo-keys.test.mjs` pinning them — including the sofa case, which fails
if the "one build, one photo, first piece" rule is ever dropped.

**The existing data is repaired separately and needs no upload.**
`backend/scripts/repoint-line-photos-to-owning-line.mjs` attaches the address
that already exists in R2 to the line that owns the key; the read routes
authorise by MEMBERSHIP of `photo_urls`, never by key shape. Plan run on prod
2026-09-03: `34 line(s) would gain 39 address(es)`. Running the FIXED importer's
`APPLY=1` instead would mint 66 addresses with no object behind them (53
retargets + 13 slot renumbers) and needs the upload step first — the importer's
contract is resolve -> upload -> apply.

**Ref.** `fix/line-photo-repair`, 2026-09-03.
