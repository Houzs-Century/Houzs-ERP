## A new workflow was wired to two secrets that do not exist, by copying the one workflow that already was [medium]

**Symptom** - the first dispatch of "Re-queue skipped AutoCount documents" died
immediately:

```
Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the Houzs Supabase REST creds).
env:
  SUPABASE_URL:
  SUPABASE_SERVICE_ROLE_KEY:
```

Both empty. Not misconfigured — absent.

**Root cause** - two things, and the second is the one that will repeat.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` exist nowhere in this repository:
not at repo level, not in Production, Staging, or the third environment. What
does exist is `DATABASE_URL`, used by **286** workflows, and
`SOURCE_SUPABASE_URL` / `SOURCE_SERVICE_ROLE_KEY`, which are a different thing
again — they point at the 2990 SOURCE system.

The script needed a PostgREST-shaped client, correctly: it imports the real
`enqueueSoCreate` from `src/` instead of re-implementing it, so it must hand
that function the client it expects. It then reached for PostgREST CREDENTIALS,
which is a different requirement, and looked for a precedent. There are exactly
two workflows in the repo referencing those secrets, and it found the other one:
`recompute-2990-so-allocation.yml`, broken for the same reason and never run.
The one that works, `recompute-so-allocation.yml`, is three characters away by
name and reaches the same kind of function through
`backend/scripts/lib/pgrest-shim.mjs` over `DATABASE_URL`.

**Fix** - the re-queue script builds its client with `pgrestShim(pg, 'scm')`.
Nothing else changed; the enqueue cannot tell the difference. `CLAUDE.md` now
states the rule under "Never ask the owner to run a query" — DATABASE_URL is the
credential, the shim supplies the shape — and names the file not to copy.
`recompute-2990-so-allocation.yml` carries a header saying it is broken, why,
and how to fix it, so the trap cannot be sprung a third time.

**What the audit ruled out** - the owner was sure the credentials existed
("Supabase 还有 Service Role Key 我之前 create 过了, 一定有"), and they are
probably right: they are Cloudflare WORKER secrets, a store GitHub Actions
cannot read. Both statements are true at once, which is why the first search
came back with a flat "they do not exist" that read as wrong. That answer was
also under-verified when first given — two of at least four stores had been
checked. `wrangler secret list` could not settle the Worker side either: the
authenticated account (`27cd35c9...`) does not match the `account_id` in
`wrangler.toml` (`816e4573...`), which is its own unresolved issue.

**Lesson** - **a precedent is evidence only if it ran.** "Another workflow does
it this way" was true and worthless: that workflow had never executed. When
copying an access pattern, prefer the one with successful runs behind it, and
where a repo has 286 examples of one thing and 1 of another, the 1 needs a
reason. Related: this system's state is spread over GitHub repo secrets, three
GitHub environments, Cloudflare Worker secrets and `scm.app_config`, and nothing
enumerates them — the same shape as the write-back toggle that could not be
answered from documents until the health check learned to read it.

**Ref** - `fix/requeue-use-database-url`, 2026-08-13

---
