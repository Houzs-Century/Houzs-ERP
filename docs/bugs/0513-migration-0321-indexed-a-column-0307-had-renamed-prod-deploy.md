## Migration 0321 indexed a column 0307 had renamed — prod deploys blocked [high]

<!-- area: Deploy, CI, migrations -->

**Symptom.** The first main Deploy after PR #2631 merged (run 32561906177,
2026-08-22 08:22Z) failed in `pg-migrate`: `FAILED
0321_pc_inventory_idempotency.sql: column "product_code" does not exist`.
`frontend` had already deployed in the same run, so prod served the new bundle
over the old worker, and every later backend deploy (including #2650's
migration 0322) was blocked behind the failed file.

**Root cause (traced).** `0321` builds its two PC idempotency indexes on
`(source_doc_type, source_doc_id, product_code, variant_key, …)` — the key
shape copied from 0279's header. But `0307_item_code_unify.sql:26` had since
run `ALTER TABLE scm.inventory_movements RENAME COLUMN product_code TO
item_code`, so on prod that column no longer exists. Confirmed against the
LIVE prod catalog (read-only): `_pg_migrations` holds 0307,
`information_schema.columns` shows `item_code` present / `product_code`
absent, and neither `uq_inv_mov_pc_*` index exists. The gap went unnoticed
because the staging rehearsal DB's migration ledger stops at 0281
(2026-08-12) — staging still HAS `product_code`, so the original SQL would
have applied there cleanly. Same class as the 0284 lesson the release gate
quotes: written against remembered vocabulary, never checked against the live
catalog after a rename.

**Fix.** `s/product_code/item_code/` on the three functional references in
`0321` (the ranked-duplicates PARTITION BY and both CREATE UNIQUE INDEX
keys). Edit-in-place is safe: the file failed before being recorded, so no
tracker row exists on any database — prod failed at this file, and staging's
ledger has not reached it. No test pins a live-catalog replay (the D1 mirror
does not carry scm.*); the proof is the failed run above (RED) and the
corrected statements matching the live prod columns verified read-only.
Follow-up worth its own entry: the staging deploy pipeline has not applied a
migration since 0281 — staging stopped rehearsing prod's DDL ten days before
this bite.

**Ref.** hotfix/0321-item-code-0822, 2026-08-22.
