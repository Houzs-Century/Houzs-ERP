# Repo hygiene — branches and file size

Two mechanical rules keep this repo legible. Both are enforced by CI or reported on
a schedule, because a rule that lives only in prose is a rule that gets skipped by
whoever is in a hurry — which, at this repo's merge rate, is everyone.

---

## 1. Branches

### The state that forced this

On 2026-08-13 there were **183 remote branches**. 101 of them — **55%** — belonged to
pull requests that had already merged or been closed. A branch list that is mostly
dead is a list nobody reads, and a genuinely stale branch (somebody's parked,
half-finished work) hides in it perfectly.

After the cleanup below: **82 branches**, every one of which is either an open PR, a
protected branch, or a branch with no PR that a human still needs to look at.

### The rules

1. **A merged PR's branch is deleted automatically.** This is the repository setting
   `delete_branch_on_merge`.

   > **NOT YET ENABLED — it needs an admin.** As of 2026-08-13 it is `false`. The
   > setting cannot be changed by CI or by a non-admin collaborator: `PATCH
   > /repos/hello-houzs/Houzs-ERP` returns `404` for anyone without admin, and the
   > account that did this cleanup has `admin: false`. **The owner must enable it**,
   > either in Settings → General → "Automatically delete head branches", or with:
   >
   > ```sh
   > gh api -X PATCH repos/hello-houzs/Houzs-ERP -f delete_branch_on_merge=true
   > ```
   >
   > Until that is done, the merged half of this problem grows back at roughly the
   > rate PRs merge. Verify with:
   > `gh api repos/hello-houzs/Houzs-ERP --jq .delete_branch_on_merge`

2. **Branches whose PR closed more than 30 days ago are REPORTED, never deleted.**
   `.github/workflows/stale-branch-report.yml` runs Mondays 01:00 UTC (09:00 in
   Kuala Lumpur) and writes a job summary. It covers what the setting above cannot:
   PRs closed *without* merging, and anything from before the setting was on.

   The report has `permissions: contents: read` and the script has no delete call.
   That is deliberate — a scheduled job that deletes branches is a scheduled job
   that eventually deletes something somebody still wanted.

3. **A branch with NO pull request is never deleted by automation.** With no PR
   there is no record of what it was for or whether the work landed, so the only
   safe output is a list for a human. 49 such branches exist today; they are
   listed at the end of this file.

Run the report locally:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/report-stale-branches.mjs --days 30
```

### How a branch was proved dead before deletion

Per branch, via `gh` — never by name pattern:

- **PR merged, branch tip == the PR's head SHA** → the merge commit is an ancestor
  of `main` and nothing was pushed after the merge. 54 branches.
- **PR merged, but the tip is not reachable from `main`** → a squash merge leaves no
  ancestry, so ancestry proves nothing. For these, every file the branch changed
  since its merge base was diffed against `main` and found **byte-identical**.
  2 branches (`pms/seed-2024`, `probe/fabric-leftovers`) — both had commits pushed
  *after* their PR merged, and both turned out to have landed by another route.
- **PR closed without merging** → the work was rejected or superseded. 45 branches.
  13 of these were the 2026-08-13 batch superseded by #2121, which squash-merged
  their content into `main`.

### Restoring a deleted branch

Every deletion is recorded below with its tip SHA. GitHub keeps unreferenced
objects for a long time but **not forever**, so restore sooner rather than later:

```sh
git push origin <sha>:refs/heads/<branch>
```

One branch is worth calling out: **`nextjs-rewrite`** (PR #1, closed 2026-04-19) was
the abandoned Next.js rewrite. It carried one commit (`Update sidebar.tsx`) that
exists nowhere else — it was never intended to land, but its SHA is recorded like
all the others.

<details>
<summary>All 101 deleted branches with restore SHAs</summary>

| branch | PR | tip SHA |
|---|---|---|
| `audit/so-po-linkage` | #1466 | 4f13243c7c15aad99acc212b27982e141014c081 |
| `chore/compartment-usage-check` | #2046 | 4e0557b71c790b544ce48df074b1c9ac9e721bba |
| `chore/parser-v6` | #1768 | 99e5447df46f4398a65e6eb50d4e16746dd03f0e |
| `chore/sp-mattress` | #1772 | 631e4b0abbded138d1590a075cb79e5eed29d25f |
| `chore/specials-fabric-realign` | #2064 | f1489cfaf1ec388830d7b223d5d4162985c41db0 |
| `docs/autocount-state-correction` | #2066 | 1a3d561c5802dd2eeac461625c1c3dd3b42696c8 |
| `docs/combo-pricing-guide` | #2065 | d71daadd2a6210ae5b03110684c0ffa59520926a |
| `docs/sofa-combo-anchor` | #2048 | ed3b89e43e51dc9bac921b0c152f044251a99b12 |
| `docs/stock-criterion-close` | #1947 | b8e479d7f3dd418895bc4f745e3a2f921efb07b9 |
| `docs/zerotier-reconciliation-correction` | #2068 | f5df4f91b96bcc4a22b430a772b6f97c55164547 |
| `feat/ac-erp-line-identity` | #1943 | 26602d079aa9525b4ba563645b74153bce8ebf79 |
| `feat/ac-processing-date` | #2076 | 9f4ec84bf6b1b642aac657909db642d93d3833c3 |
| `feat/ac-so-writeback-client` | #1696 | 5a2267c5bf94e37e85b8b0cf88265914051c5d56 |
| `feat/ac-writeback-endpoint` | #1707 | 6fbba06c02175f31427edde7d339f49a6c7ea05a |
| `feat/ac-writeback-remaining-cells` | #1979 | c69319ec2dd4159073471b512ae32fca291c15a9 |
| `feat/assr-delivery-date-writeback` | #2059 | 1f1a772442016666e093e72a2302a232590eea54 |
| `feat/assr-list-complaint-column` | #2091 | 092eba01d70073279653a33ff07d7bf6fb3afb41 |
| `feat/autocount-requeue-skipped` | #2120 | 03a71caf7d13860b77eac42cb6de8758ee007f8f |
| `feat/defect-review-by-state` | #2050 | f5b271fa86688760e37577e4e3ab036b3901512a |
| `feat/fabric-colour-dedupe` | #2078 | 65f680a1d377bca3b6eaa009b139478a5ee3c68c |
| `feat/fabric-colour-dedupe-tool` | #2082 | 1a1fd4500ee850f8f074845d4c40255ef2966b29 |
| `feat/fabric-merge-declared-pair` | #2071 | b41f8cce7605ac8a055ee53b8e6d581fbd70b678 |
| `feat/ios-app` | #811 | 950a63ce076ea7fd8f65bc3cc9b12cf220c1c08b |
| `feat/minted-fleet-codes-and-field-formats` | #1543 | 5e4d105f8e3947b981c3d198ae9f697124db296e |
| `feat/mycases-refno` | #2090 | d18831e87bb8d7849b0a38caa2077fd038ebb45f |
| `feat/personal-quick-picks-port` | #393 | c514ea26e139a1995e69a2c706cb42649710ef62 |
| `feat/pms-finance-revenue-rental` | #1327 | 829a59e8712f8724d3da52a7f2d9f33c9bea1404 |
| `feat/pos-cart-port` | #394 | 0a5bb1667e640c1777d7af363127d0997639722f |
| `feat/print-summary-redesign` | #2054 | f78c45d47e3fa124832a5614584a5b5a26ff1db8 |
| `feat/purchaser-exchange-stockin-pending` | #2053 | 262111b0d9498018c4341d1d231dd89cd81e55bb |
| `feat/quotes-port` | #392 | f643bcfc5fa50785ff0f3fc5eb4c962bf4b225ad |
| `feat/sales-analysis-port` | #395 | 67ce4ed892e80fe8990b54964da733f917fb022a |
| `feat/scm-access-by-position` | #105 | 606e2ad9d82525d93f86afde26d70c8bf1e71e4a |
| `feat/sofa-combo-anchor-table` | #2069 | 5f53c2994e6539265bf8f4860de639fb816de956 |
| `feat/unify-processing-date` | #2077 | 4795dcd534aa3884f1f1c6612b0da83a25ccf484 |
| `fix/ac-resolve-via-bindings` | #2024 | 8fea85793ecb890fcbc3e4722967695e5e168c4c |
| `fix/ac-sofa-line-keys` | #2019 | f6e1d577bfa79867bf38103eba6f0d1b59fb1f33 |
| `fix/amendment-add-line-description-0811` | #1994 | 4c6cf105b36cca381273f73821aee4ef52d6dfe6 |
| `fix/array-repair-item-code` | #2098 | d776366b021ac01280e36f844251739a8884ce42 |
| `fix/array-repair-redundant-tail` | #2100 | e137c57571b9eb733b49242a996ba144c9bde613 |
| `fix/array-shaped-variants` | #2096 | b33a883cbb631b6845327f2962571c692add6882 |
| `fix/binding-must-name-a-real-item` | #2095 | 2b5fce0e8b44dc1fea325b7569a3699c86f7d107 |
| `fix/company-scope-writes-and-swallowed-errors` | #2086 | 93fced38b57192a3b9348d0cb440367ce176075e |
| `fix/company-switch-stale-cache` | #448 | e8613b8e8ed96b374bc7ba3bae4623e0223f613b |
| `fix/converter-hide-retired` | #2061 | 1f28d17c9973becad5502aa1c68f0a9914f3f6f7 |
| `fix/date-pair-server-side` | #2102 | 6f774552874333b347b3215cb96bb5c2475c9b5c |
| `fix/declare-env` | #2075 | 0accea827383bec291556a2610e28a729447ac05 |
| `fix/defect-review-state-path` | #2051 | 8dee64d42cbef6a445e25e740cb0266f951dd25b |
| `fix/fabric-description-reaches-picker` | #2081 | 75073fd25b45792129efe038f0301b8d0cd01b7f |
| `fix/fabric-description-tidy` | #2047 | df7686ddfbaf993f36195634e9417bca2914fea3 |
| `fix/fabric-non-fabric-code-guard` | #2104 | b007b0f25303801c5d028307a23ee0af26562d5f |
| `fix/finance-upsert` | #2052 | 2f651bbdfbca207dd5b11f248d01741441156d70 |
| `fix/inventory-reserved-available` | #457 | 8d004c0557a7d6aa942172426adb214e33099e9d |
| `fix/j9833-alias` | #2001 | 0f738972ed634cbbad1da744a5699bbaa4f0509f |
| `fix/main-red-after-integration` | #2124 | b627bc5fc3e852c2ab2b4c0ff6b4df954eb1a96c |
| `fix/normalize-codes-sweeps-everything` | #2085 | 8807113ad8c9e730331fc9b2b9b207a6e9f528e9 |
| `fix/normalize-must-not-erase-colour-names` | #2099 | ac82b3a2270f41b37268e43c5a4697fb42bc0d4a |
| `fix/outbox-health-skip-detail` | #2094 | b3056557a81aafbe5947b310ad0c5d8ec0ced41b |
| `fix/partial-delivery-remaining-qty` | #1847 | 906a40066a93b075f24a256835986833f398cee9 |
| `fix/pgrest-shim-neq` | #2132 | ca36586e9c7e2a7d52ac237cd82985eb1abcc3cf |
| `fix/phone-backfill-batched` | #1064 | 3329481643b1774c4e9f36b407787627944b810b |
| `fix/po-import-enums` | #1828 | 0e8beb4548c38e3e495cb276f210ba57ea5fdacb |
| `fix/print-crew-times-stage` | #2057 | 2fbc39e3b630301fe96379629779022cacf555d2 |
| `fix/proceeded-at-diagnostics` | #2103 | 5a1a62344d554fa9bf214b586b8777ad359078f8 |
| `fix/profitability-scope-default` | #2087 | 80c2ba89ac91537843dd66bcf1b4d4608a69ff6e |
| `fix/requeue-use-database-url` | #2123 | bef4ff31ed607312ed5de11a4d6b2711ff98c796 |
| `fix/route-matrix-drift` | #1440 | c73fbde9f6b0185d7ac81ff32017f6268427c8b6 |
| `fix/salesperson-roster-and-self` | #2049 | 2e3e24eab56880c4ff08df47cc9d2be9e71691d7 |
| `fix/scm-config-write-purchasing` | #776 | 70c8d8cc5c276d3e159d600ac269812b3ee4fcd4 |
| `fix/series-merge-uses-shared-arms` | #2083 | 0f276ea41ee1a42aaf1cc589981fdd6be5beab74 |
| `fix/so-detail-address-usable` | #2117 | cd1d5e57944c08aa2ac506cccd0a73e579b0f7b1 |
| `fix/so-edit-salesperson-seed` | #1611 | 545f0f7e3769cd8e433e5fc614dad2b6265c9278 |
| `fix/so-photo-chain` | #2130 | 1d5db33dcd7a28e1ed0c58f8bba6b67372706b59 |
| `fix/so-stock-location-gate` | #2112 | 086606ea660f1da056087499ae3f96625129fa8c |
| `fix/sofa-audit-multiset` | #1857 | 7475eadf9b924da80a91efc907f39c2eecd7191e |
| `fix/sofa-binding-lookup` | #2093 | be2e7bb274f8cc5e40d71d6ade8530aa2d81fea6 |
| `fix/special-addons-save-sort-categories` | #2044 | c878b11be1d064d12190fb43b3895630fd3a5eac |
| `fix/split-adjustments-permission` | #742 | 5e610c1c8688c93c8714d93cd2eab6f78f494e88 |
| `fix/superseded-colours-still-referenced` | #2084 | c95f1af1065b8b44e6b5fb7a2b45b59fb17f51ca |
| `fix/team-phone-display` | #1060 | 2f4dc52f9ce7bdbb6300e17b2efefdf4bf9b61c3 |
| `fix/unify-pair-rule` | #2079 | c6bdc10ebf42fa184a9f7d7a5a645e6329e06867 |
| `fix/variant-exemption-required-itemcode` | #2072 | 26a1efc7c0b85beecfe13d99baaf2606614a7dcb |
| `fix/warehouse-name-consistency` | #1230 | 2f28bb987ebfc9556a0a1c950100c8b8c238e326 |
| `integ/2026-08-13-batch` | #2121 | a5e468cfd887092e5932e2775a0201ebfe452c12 |
| `nextjs-rewrite` | #1 | 3ffb3ff5e6febf3adf20e61d0993877fafc88379 |
| `pd/overloaded-names` | #2109 | f65b63a1042cc015e9c48a6d300c84eff8fb8531 |
| `pd/rename-internal-expected-dd-to-processing-date` | #2113 | 2f4ab4e763653b70090e72b42558dfb13a9c2c0c |
| `pd/silent-surfaces` | #2111 | 9fa8e0ffd1713b650b1269ce9d6cf3b36eb60da3 |
| `perf/bulk-colour-counts` | #2088 | 9835a9d5864e138a53df484a0ce8513c22226de4 |
| `pms/seed-2024` | #1368 | 5662f00f2130b76ac7e6a9361f87113b8e232b8a |
| `probe/fabric-leftovers` | #2070 | e569d2c6d643c400e49554db03b23a0bd219847c |
| `probe/fabric-leftovers-fix` | #2073 | 7b07e7c2bf7d945bb2d06707add6fe2a5556ea3e |
| `probe/so-date-xor` | #2074 | a3d3c01e621144b1450eb3c6bda0ffcbd6356372 |
| `proceed-is-the-date` | #2105 | c33dff25af75370c91661b1bad3db312603aaa75 |
| `retire-processing-date-aliases` | #2106 | 005860755aece24005c34994775a15109c338b35 |
| `sweep/duplicated-list-drift` | #2114 | 2b43ea42ad5c306c91158ce6f82cb3a8593b3d8d |
| `sweep/non-idempotent-repair` | #2108 | d9a3f33275ba5b9fdfe0ff5a8346f2c1bd0717e1 |
| `sweep/optional-param-noop` | #2115 | 72f09044f34e3bdcd7439c6062d2c792c47622bf |
| `sweep/swallowed-error` | #2107 | d60dbd8b84c11d8c503cc354fafec632759e10fc |
| `sweep/unscoped-write` | #2116 | 7d3cdd8358073d795cfe7aa9df172752dcbd4f01 |
| `wt/moneyguard` | #817 | b0a5c3fa9774016bc9d206cec957661c25212595 |

</details>

### Branches with no PR — 49 needing a human

Not deleted, and not deletable by automation. If one is yours, either open a PR or
delete it:

- `audit/empty-project-fill-map`
- `audit/pms-extras`
- `audit/u1-aggregate-scope`
- `chore/ac-rebind-run`
- `chore/ac-sku-final-status`
- `chore/ac-sofa-clean`
- `chore/ac-sofa-restore`
- `chore/ac-vocab-probe`
- `chore/verify-run-once`
- `diag/company-separation`
- `diag/selling-price-probe`
- `docs/ac-so-writeback`
- `feat/amendment-jobcard`
- `feat/checklist-amendments`
- `feat/delivery-tms-stage2`
- `feat/detail-cost-margin-cards`
- `feat/houzs-parity-consolidated`
- `feat/jobcard-reorg-do-si-amendment`
- `feat/list-search-keys`
- `feat/projects-list-status-filter`
- `feat/rec-warehouse-desktop-p1`
- `feat/scm-columns-phase2`
- `feat/table-unify-t4-racks`
- `feat/v1-venue-unify`
- `feat/variants-from-maintenance-config`
- `fix/commission-cogs-family`
- `fix/mobile-salesdirector-team-403`
- `fix/pi-variant-display-edit`
- `fix/po-alloc-spec-match`
- `fix/po-convert-and-multiselect`
- `fix/project-detail-director-seeall`
- `fix/restore-scm-list-columns`
- `fix/review-backend-batch2`
- `fix/salesdirector-scope-so-maint-project`
- `fix/scan-enum-status`
- `fix/scm-seed-search-path`
- `fix/unbounded-lists-and-invite-reset`
- `fix/variant-display-edit-grn-do`
- `ops/service-config-merge`
- `perf/do-pdf-fabric-and-deadbutton`
- `pms/pms-diff-dump`
- `probe/so-date-xor-where`
- `scm-clone-2990s`
- `tmp/cancel-parity-run-0811`
- `tmp/po-repair-dryrun-0811`
- `tmp/po-repair-dryrun-0811b`
- `ux/tier3-polish`
- `vite-migration`
- `wip/harden-so-po-link-parked`

---

## 2. File size — a ratchet, not a limit

39 source files under `backend/src` + `frontend/src` are over 2,000 lines. The
largest is `frontend/src/pages/Projects.tsx` at 14,867 and the sales-order router
`backend/src/scm/routes/mfg-sales-orders.ts` is 12,094.

**Nothing here splits them.** That is a refactor with real risk, and it is not what
this gate is for. The gate only stops the problem GROWING:

- a file already over 2,000 lines carries its **own ceiling**, recorded in
  `scripts/file-size-ceilings.json` from the tree as it stood on 2026-08-13;
- it may **shrink** freely — that never fails, and never needs a manifest edit;
- it may **not grow** past what it already was **in a diff that touches it** — the gate charges only files this change touched AND grew (`check-file-size.mjs:315-364`). A file already over its ceiling that this diff does not touch is REPORTED and does not fail the run. Observed 2026-08-14: eight files over their ceilings on `main`, `--require-base` exit 0;
- every other file is capped at **2,000 lines**, so a new 3,000-line file fails;
- **a ceiling may only fall.** Raising one by hand fails CI, checked against the
  manifest as it exists on the merge base. Otherwise the cheapest way past a red
  gate is to edit the number, and the ratchet becomes a suggestion.

When a grandfathered file drops to 2,000 lines it leaves the manifest for good and
is capped with everything else from then on. The ratchet only tightens.

```sh
npm run check:file-size          # the gate
npm run check:file-size:list     # ten largest + their ceilings
npm run check:file-size:update   # lower ceilings after a file shrinks
```

`--update` **cannot raise a ceiling.** If a file grew past its limit the only way
back to green is to make the file smaller, or to put the new code in its own module.

Generated files are exempt, detected by a `GENERATED FILE` / `@generated` marker in
their first 5 lines — `autocount-sofa-corpus.ts` (7,933 lines) and
`autocount-item-map.ts` are compiled from data exports and grow when the DATA grows,
which a "may only fall" ceiling would turn into a failing CI run on every refresh.
The gate prints how many files it skipped, so an exemption is never invisible.

**The gate fails loudly if its own scan finds (almost) nothing.** A scanner pointed
at a moved directory finds no files, reports no violations, and passes — forever,
silently. Fewer than 200 source files scanned is a hard error, not a pass.

Enforced by the `file-size` job in `.github/workflows/ci.yml`. It runs no `npm ci`
and no build, so it costs the queue seconds rather than a runner slot.
