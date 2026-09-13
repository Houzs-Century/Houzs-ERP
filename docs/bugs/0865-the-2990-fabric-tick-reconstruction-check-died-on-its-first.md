## The 2990 fabric-tick reconstruction check died on its first production run: text = uuid [low]

**Symptom.** `Check 2990 fabric tick reconstruction (read-only)`, run 34764445910
on production, exited 1 with `operator does not exist: text = uuid`. No answer
reached the owner's question about his original 28 / 36 colour ticks. Nothing
was written: the script is four selects.

**Root cause (traced).** The join `scm.mfg_products p ON p.id = f.product_id`
compared columns of different types. `mfg_products.id` is TEXT shaped
`mfg-<hex>` (stated in the 2990 POS `apps/pos/src/lib/queries.ts` [external]);
the other side is not. The script was never run before merge — the
`workflow_dispatch` registration lag hid that for twenty minutes.

**Fix.** Both sides of the join, and every id the script later keys a Map on,
are cast to text. The script now also prints how many `product_fabrics` rows the
company has and how many joined to a Model, so a join that matches nothing reads
as "no join" rather than as "no series". Proved by re-dispatching on production;
the run id goes in the PR.

A caveat recorded here because it bears on the verdict: the POS's
`Configurator.tsx` reads `product_fabrics` only for products whose id does NOT
start with `mfg-` — for Modular sofas it reads the pool. So `product_fabrics` may
be sparse for exactly these Models, and a low join count is a real answer, not a
defect.

**Ref.** fix/reconstruct-ticks-join-cast, 2026-09-13.
