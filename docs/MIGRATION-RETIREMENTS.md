# Migration retirement manifest

`backend/scripts/lib/migration-retirements.mjs` is the immutable exception list
for migration files that were applied to at least one tracker and later removed
from Git's live migration tree.

This preserves `_pg_migrations` history. Do **not** delete those tracker rows and
do not restore the old SQL files into `src/db/migrations-pg/`.

## Reviewed 2026-07-20 retirement

The manifest contains 17 obsolete SCM filenames removed together by commit
`dfa1111a` on 2026-06-18. The deletion commit described them as never-applied,
but production inspection recorded all 17 filenames in `_pg_migrations`, so the
tracker is the stronger evidence.

## Reviewed 2026-07-22 addition (0077 / 0078)

Two further filenames were added: `0077_multicompany_company_id.sql` [gone] and
`0078_multicompany_views.sql` [gone]. Commit `7368843b` put them on `main` at
22:18 +0800 on 2026-07-11 and `d2378e5f` removed them at 22:25 — a seven-minute
window in which a push-to-`main` deploy could apply and track them.

They were found by deriving the complete candidate set from Git rather than
from a database dump. A tracker row can only exist for a filename that was
present at some **first-parent tip of `main`**, because `deploy.yml` runs
`pg-migrate.mjs` on push to `main` and nowhere else:

```bash
D=backend/src/db/migrations-pg
for c in $(git rev-list --first-parent origin/main); do
  git ls-tree --name-only "$c" "$D/"
done | sed 's#.*/##' | grep '\.sql$' | sort -u > ever.txt

git ls-tree --name-only origin/main "$D/" \
  | sed 's#.*/##' | grep '\.sql$' | sort -u > now.txt

comm -23 ever.txt now.txt
```

On 2026-07-22 this yields exactly the 19 manifest filenames. The same command
against `origin/staging` yields the identical 19. Re-run it whenever a migration
file is deleted, and whenever this manifest is edited.

Files that existed only *inside* a feature branch are correctly excluded —
`0093_branding_2990.sql` [gone] and `0093_restore_timestamp_defaults.sql` [gone] were
renumbered before their branch's merge commit, so no deploy ever saw them. This
is why the derivation walks first-parent tips and not `git log --diff-filter=A`.

Each manifest entry pins:

- the complete filename (no prefix/range matching);
- the canonical SHA-256 of the last Git version before deletion; and
- the Git blob id from `dfa1111a^` for content recovery and audit provenance.

The SQL remains recoverable with `git cat-file blob <gitBlob>` without placing it
where the migration runner can execute it. This matters because historical
`0023_drop_adapted_scm_island.sql` [gone] contains `DROP TABLE ... CASCADE` statements.

## Gate behaviour

A tracker row whose file is absent from the tree is classified in exactly this
order — the first match wins:

1. **Exact manifest filename, legacy `NULL` checksum** — accept as a reviewed
   retirement; leave the tracker row unchanged.
2. **Exact manifest filename, archived checksum** — accept as a reviewed
   retirement.
3. **Exact manifest filename, any other checksum** — fail closed.
4. **Checksum is the `legacy-adopted` sentinel** — already adopted by an earlier
   genesis run; carry it forward without re-adopting.
5. **Checksum matches exactly one pending local file's checksum**, unambiguously
   on both sides — a rename (a renumber), not a deletion. Repoint the tracker
   row to the new filename and do **not** re-run the SQL, which provably already
   ran. See "Renumbers" below.
6. **Checksum set, no match, but a pending file shares the name after the
   number** — fail closed as `probable_renumber`, naming both filenames and
   printing the exact `UPDATE` to run.
7. **Checksum set, nothing else matches** — fail closed as `file_deleted`.
8. **No checksum, and this is the genesis run** — adopt once, stamp
   `legacy-adopted`, print it. See "Genesis" below.
9. **No checksum, past genesis** — fail closed as
   `legacy_file_deleted_unverifiable`.

Independently of the above: a retired filename reappearing anywhere in the live
migration directory fails closed, even when its bytes match the archived file.

A fresh database is not required to contain retirement rows. It simply must not
contain or introduce a live migration using a retired name.

## Genesis: the one-time trust-on-first-use pass

The first run of the checksum runner against an existing tracker inherits rows
written by the old runner. Those rows carry no checksum, so nothing — including
a production dump — can verify them. That trust is unavoidable; what matters is
that it happens once and is recorded.

`isGenesisTracker()` returns true only while **no** tracker row carries a
checksum. On that run the runner:

- prints every pre-existing row under a `TOFU` prefix, which is the dump,
  produced by the runner at the moment it matters;
- backfills a checksum for every row whose file is still present; and
- for a row with no checksum **and** no file that is not in the manifest, stamps
  `checksum = 'legacy-adopted'` and prints an `ADOPT` line naming it.

After that run, at least one row has a checksum, genesis is false forever, and
an unexplained row with no checksum is hard drift. A filename that was adopted
reappearing in the tree is `content_changed` drift.

Adoption exists because failing closed on an unverifiable row buys no safety and
costs the whole deploy: `pg-migrate.mjs` aborts on the first failure, so one
unknown row would block every later migration. The manifest is still the right
place to record a *reviewed* retirement — adoption is the backstop for the ones
review missed, not a replacement for review.

## Renumbers

Migration numbers in this repo are assigned at merge time against whatever
`main` looks like that minute, so `git mv 0165_x.sql [gone] 0167_x.sql` [gone] is routine. The
`staging` branch deploys before `main`, so an old number can already be applied
and tracked in staging when `main` merges the new one. Fail-closed on the
missing old name would brick staging permanently.

- **Byte-identical renumber** (`git mv` with no edit): the runner recognises it
  by checksum and repoints the tracker row. Requires the checksum to match
  exactly one orphan and exactly one pending file; anything ambiguous is not
  guessed.
- **Renumber that also edited the file** (typically a header comment naming the
  old number): the checksum moved, so it cannot be proven. The runner reports
  `probable_renumber`, names both filenames, and prints the exact `UPDATE`
  needed. It does not apply it — an edited applied migration and a renumbered
  one are indistinguishable from checksums alone, and only one of them is safe.

To keep renumbers in the automatic case, renumber with `git mv` alone and put no
migration number inside the file.

## Adding a retirement

Do not add an entry just to make a deploy pass. A new retirement requires a
separate review proving all of the following:

- the exact file and deletion commit;
- evidence that at least one tracker applied it;
- the last canonical checksum and Git blob;
- why keeping the SQL in the live tree is unsafe or incorrect; and
- tests pinning the exact filename and preventing reuse.

An unknown missing file remains release-blocking drift on any tracker that is
past genesis. The genesis adoption pass is a one-time backstop so that a gap in
this manifest cannot block a production deploy — it is not permission to skip
the review above, and every row it adopts is named in the deploy log.
