## The PostgREST page ceiling was asserted for weeks and never once observed — it is now measurable from the Worker, and the number is still UNKNOWN [medium]

<!-- area: Database + schema -->

**白话.** 全系统 52 个档案读资料时都靠 `paginateAll` 一页一页拿，每页 1000 行，拿到
不足 1000 行就当作「读完了」。问题是：PostgREST 到底一次最多给几行？程式码注解写死
「1000」，但**从来没有人真的量过**。如果真实上限低于 1000，第一页就会看起来「不足」，
整个回圈立刻停掉 —— 全部读取都只拿到一小截，而且不会报错。本周两个生产 bug 就是
「读取悄悄只回传一部分」造成的。本来写来量这个数字的脚本，那一半**一次都没跑过**
(GitHub 没有那两个密钥)。现在把量测搬到 Worker(密钥在那里)，并附上测试证明它两种
答案都讲得出来。**但数字目前还是 UNKNOWN** —— 我没有连上生产环境，不敢用推理充数。

**Symptom.** `backend/src/scm/lib/paginate-all.ts`'s header stated PostgREST caps a
response at 1000 rows as settled fact. Nothing had ever observed it. That number is
load-bearing twice over: `paginateAll` pages in `PAGE = 1000` windows and stops on
the first page shorter than `PAGE`, so a real ceiling **below** `PAGE` makes page one
look final and truncates every paged read in the tree — silently, in exactly the
shape `paginateAll` exists to prevent. 52 files import it. Two production bugs this
week traced to a read quietly returning a subset.

**Root cause (traced).** The instrument written to settle it could never run.
`backend/scripts/probe-mrp-read-ceiling.mjs`'s REST half needed `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY`; runs `31941352447` and `31942066593` both printed
`SKIPPED — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set` and the workflow
reported **success** both times. Verified today: `gh secret list` holds neither at
repo level, and `--env Production` holds only `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_API_TOKEN`, `VITE_API_URL` — so the `environment: Production` line added
to fix it fixed nothing. The credentials are real but are **Worker** secrets
(`wrangler secret list --name autocount-sync-api` lists both), and they must stay
that way: the repo is public, non-admin collaborators can read repository secrets,
and the service-role key bypasses RLS on the single database both tenants share.
Rewriting the probe over `DATABASE_URL` would have measured **Postgres**, not the
REST edge — `backend/src/db/supabase.ts:66` builds a real `createClient`, and every
`sb.from(...)` in the SCM module is a PostgREST call, so the edge is the thing under
test.

**Fix.** The measurement moved to where the credentials already are, as a read-only
diagnostic on the existing System Health surface rather than a new one:
`GET /api/admin/health/rest-page-ceiling` (`backend/src/routes/systemHealth.ts`),
gated on `*` — the existing admin capability (`services/permissions.ts:7`) this file
already uses for its other heavy admin routes, because an unauthenticated heavy read
is a DoS lever. It counts the candidate tables head-only, runs a `.limit()` ladder
(500 / 1000 / 1001 / 5000) against the largest, and reports rows-returned against the
`Content-Range` total at each rung; a rung whose total is `<=` its limit is marked
`inconclusive` and excluded, because a read that ran out of *table* says nothing
about a *ceiling*. It also issues `paginateAll`'s own `.range(0, PAGE-1)` window and
imports the real `PAGE` (now exported) rather than restating `1000`, so the verdict
cannot agree with itself by construction. **Counts only** — no row, id, doc_no or
name reaches the payload.

**The number is UNKNOWN and is deliberately not guessed.** Production could not be
reached from here: the endpoint is not deployed yet, and calling it needs an
authenticated production session. Staging was tried and is dead — its remote preview
answers Cloudflare `error code: 1105` on every route, consistent with staging deploys
being paused since 2026-07-31 with a revoked token. The one adjacent reading
available (`no *max-rows* GUC set on any role`, run `31942066593`) is **not** the
measurement: Supabase sets PostgREST's `db-max-rows` in PostgREST's own config, so an
absent role GUC does not prove the default applies. To get the number: deploy, then
call the endpoint as an owner. If it returns `TRUNCATES_SILENTLY`, `paginateAll` is
wrong and that is a separate finding, not a fix to fold in here.

**The trap is retired, not annotated.** The workflow
recompute-2990-so-allocation.yml was DELETED, together with the
now-unreachable recompute-2990-so-allocation.mjs it was the only caller of.
(Both are named without backticks on purpose — they no longer exist, and
`check-docs-drift.mjs --strict` correctly fails a doc that cites a missing
file.) Evidence it is dead: `gh run list` shows **zero runs ever**; its capability is already
covered by `recompute-so-allocation.yml`, which runs the same canonical global function
over `DATABASE_URL` + `pgrest-shim.mjs`, prints `GLOBAL (both companies)`, and has five
successful runs. A header comment did not stop it being copied on 2026-08-13, so the
file is gone. Surviving citations were repointed to the working sibling.
`probe-mrp-read-ceiling.yml` lost the half that could never run — a permanently-SKIPPED
step reads as coverage that does not exist — and now points at the Worker endpoint.
`CLAUDE.md` said these secrets "do not exist here", which is true of GitHub and FALSE
of the Worker; that half-truth is what sent two authors down this path, and it now
states both halves plus the prohibition.

**Pinned by** `backend/src/routes/systemHealthRestCeiling.test.ts` (6 cases): a
1000-cap edge reports ceiling 1000 / `CORRECT`; a **500**-cap edge reports
`TRUNCATES_SILENTLY` off `paginateAll`'s own short first window; an uncapped
small-table edge reports `ceiling: null` / `UNKNOWN` rather than inventing one; the
largest table is chosen so a small one cannot mask the cap; a non-`*` caller gets 403;
and no row content reaches the payload. Proven not vacuous by mutation — forcing the
verdict to `CORRECT`, treating inconclusive rungs as evidence, and dropping the gate
each turn exactly one case red.
