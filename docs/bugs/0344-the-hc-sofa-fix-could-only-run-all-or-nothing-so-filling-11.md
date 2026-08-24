## The HC sofa fix could only run all-or-nothing, so filling 11 SKUs meant re-stamping 1,012 SO lines nobody had approved [low]

**Symptom.** The owner asked for the 11 unbranded `5526-*` sofa SKUs to be filled
with ZANOTTI, so the stored catalogue would agree with the display rule that
hardcodes it (PR #2402). `fix-hc-sofa-branding.mjs` exists for exactly that job.

**What the dry-run showed, which is why this entry exists.** The script's phase
(b) re-stamps every Houzs SOFA line row that is blank or 'Houzs' — **1,012 rows
across 463 documents**. Those are not the 11 SKUs' own lines: only 8 lines carry
a `5526-*` code. Phase (b) walks the WHOLE sofa catalogue. So "fill 11 SKUs"
would have written 1,024 rows, 1,012 of them being the Houzs line backfill the
owner had already declined ("Houzs 的不需要").

The script had no way to say no to that half: catalogue and lines were one unit.

**Fix.** `SCOPE=catalog` restricts the write set to `mfg_products` +
`product_models`. `all` stays the DEFAULT, so every earlier dispatch keeps its
meaning and the narrow set has to be asked for. Three things move together or
the flag would be a lie:

- phase (b) is skipped, and **prints the count it did not write**, so choosing
  the narrow set can never hide how much was left behind;
- the post-verify residual query drops its two line-table terms under
  `catalog` — otherwise the run would fail its own check for leaving alone
  exactly what it was told to leave alone;
- an unrecognised `SCOPE` exits 2 rather than falling back to a default, because
  guessing which set was meant is the whole failure this flag exists to prevent.

**Ref.** 2026-08-18, branch `fix/hc-sofa-catalog-only`.
