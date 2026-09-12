## Staging could not reproduce a production lock because the refresh copied the rows but not the switches [high]

<!-- area: Deploy, CI, migrations -->

**Symptom.** A salesperson (WhatsApp, 2026-09-12 18:17 MYT) could not edit the
balance on an order: the SO detail showed **Edit** greyed out. Asked to explain
it, this session walked the same shape on staging and could not reproduce
anything — staging let the write through. The owner's reaction is the finding:

> 旧单 migrate 进来了就是当作我们的系统的单了啊？要不然怎么叫 migrate 呢？

**Root cause (traced).** Two separate facts, and the second is why the first
took a day to see.

1. `scm.app_config['scm.migrated_so_lock']` was `'1'` on **production** — set
   2026-09-10 14:04 MYT, seeded `'1'` by `20260908T0014_scm_migrated_so_lock.sql`
   for the owner's 2026-09-08 ruling 「只开新单，旧单暂时不能改」. With it on,
   `migratedSoReadonly` refuses **every** write on the 2,882 AutoCount-imported
   Houzs orders — header, lines **and payments** — while the staff message on the
   row told people to record the money in AutoCount instead.
2. The same key was `'off'` on **staging**. `staging-refresh-data.yml` copies
   production's DATA (471 tables truncated, 466 COPY blocks restored) but the
   operational switches are one row each in `scm.app_config`, and staging's row
   kept its own value. So staging was rehearsing a system whose **rules** differ
   from production's: the exact class of refusal a rehearsal exists to catch is
   the one it could not see.

The owner's ruling on (1), 2026-09-12: a migrated order **is** one of our orders
— "所有东西肯定在我们 ERP 的" — and Inisate / AutoCount are the OLD systems.
Nobody may be told to record a payment in them.

**Fix.**
- Lock lifted on production: `set-migrated-so-lock.yml` run 34689675812 —
  `"1" -> "off"`, `1 HOUZS migrated=2882 shut -> open`. Staff message replaced
  (run 34689885454) with "ERP 是记录的地方。旧单跟新单一样可以改、可以录款。"
- `staging-refresh-data.yml` now carries the switches with the data: the dump job
  writes `prod-switches.txt` (`scm.write_freeze`, `scm.migrated_so_lock`) beside
  `prod-data.sql.gz`, and the restore job applies them to staging, printing
  `production | staging before | staging after` into the run summary and a
  `::notice` on every change. A refresh that cannot read the switches warns and
  leaves staging's own values rather than pretending.

Verified by dispatching the refresh from this branch — see the PR for the run and
the switch table it printed.

**Ref.** fix/staging-config-switch-parity, 2026-09-12.
