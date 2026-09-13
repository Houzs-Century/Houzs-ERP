## The 2990 sofa colour ticks were never restored: the refill gave every Model all 58 [high]

**Symptom.** The owner, 2026-09-13: 「原本是 28 到 36 个，现在突然变 56 个了」 and
「为什么你会去 edit 改掉我的这些 Modular 里面勾的这些东西呢？」. After the 2990 POS
lost every sofa colour (`docs/bugs/0858-the-2990-pos-lost-every-sofa-colour-because-our-picker-and-t.md`),
the refill put all 58 active colours on every 2990 sofa Model. The POS worked
again, but each Model offered colours he had deliberately not ticked.

**Root cause (traced).** `open-model-fabric-pools.mjs` took no backup and printed
only `company 2: 16 model(s), pool size 28/36`, so the per-Model ticks were in no
backup in this database. Production run 34764445910 / 34765055452 of
`check-2990-fabric-tick-reconstruction.mjs` proved the obvious second source is
empty: `product_fabrics rows for this company: 0`. Production run 34765704752
then read the 2990 SOURCE system this company was migrated from: 16 of 17 SOFA
Models hold 28 or 36 colours, every one of those colour ids is an active colour
of company 2, and "16 Models at 28/36" is exactly what the clear recorded.
MAKOTO holds no pool there.

**Fix.** `backend/scripts/restore-2990-fabric-ticks-from-source.mjs` +
`.github/workflows/restore-2990-fabric-ticks.yml`. Company 2, SOFA Models, the
`fabrics` key only. A Model is written only when its source pool is non-empty and
every colour id is active here; MAKOTO is skipped and keeps its current colours.
Plan by default, `CONFIRM="RESTORE-2990-TICKS"`, backup of every SOFA Model's
current `allowed_options` to `scm.app_config['scm.sofa_fabric_pools_before_source_restore']`
before the write, fresh-connection verify that each restored pool is a JSON
array equal as a set to its source pool. The run ids of staging and production
are recorded in the PR.

**What it cannot prove.** A tick changed inside this ERP after the migration is
not in the source. The counts match the clear's own record; that is strong
evidence, not per-colour proof.

**Ref.** fix/restore-2990-fabric-ticks-from-source, 2026-09-13.
