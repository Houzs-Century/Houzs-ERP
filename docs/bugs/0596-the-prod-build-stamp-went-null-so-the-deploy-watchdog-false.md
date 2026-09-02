## the prod build stamp went null so the deploy watchdog false-alarmed [medium]

**Symptom.** The Deploy watchdog run at 2026-09-01 07:46 failed:
`prod Worker (stamp none) does not match main (5926694a1) — dispatching
redeploy`. Live `GET https://autocount-sync-api.houzs-erp.workers.dev/health`
returned `{"ok":true,"sha":null}` (consistently, cache-busted). The app itself was
healthy — only the build-identity stamp was missing — but the watchdog reads a
null stamp as a rogue/unidentified deploy, so it kept failing and dispatching
redeploys that skipped the Worker (backend/ unchanged since the last backend
deploy) and never re-stamped it: the "needs a human, not a retry storm" loop the
watchdog's own comment names.

**Root cause (traced).** The backend deploy stamps the sha with
`wrangler deploy --var GIT_SHA:<sha>` and THEN runs a separate
`wrangler secret bulk` step (deploy-first-secrets-second, the 10215 ordering).
The deploy log confirmed wrangler set `env.GIT_SHA ("(hidden)")`; the secret bulk
ran 1s later. The last Worker deploy (02:40, run 33463449108, commit 6bb87771a =
#2843, a positionPolicy change unrelated to deploy config) left GIT_SHA null,
while the BYTE-IDENTICAL pipeline on 2026-08-31 18:46 (run 33426836520, same
wrangler 4.112.0, same `--var`, same secret bulk) left it SET — proven by the
watchdog being green at 19:45. So `wrangler secret bulk` non-deterministically
redeploys a Worker version that drops a CLI `--var`: a `--var` is not persisted
config, so a follow-up secret redeploy can base its new version off one predating
the injection. Ruled out first and rejected: the /health handler (unchanged since
#1006), the deploy command (correctly passes `--var`), #2838 (touched only CORS
headers), and wrangler.toml / wrangler version (neither changed).

**Fix.** Move the stamp from an ephemeral env var to a value compiled INTO the
bundle, which no var/secret operation can drop. `backend/src/build-info.ts`
exports `GIT_SHA` (committed placeholder `"dev"`); `deploy.yml` and
`deploy-staging.yml` `sed` the real commit sha onto that export line right before
`wrangler deploy`, failing loudly if the stamp does not land. `/health` reads the
bundled constant via `resolveBuildSha`, falling back to the legacy `--var` env,
then null — so the rogue-deploy detection is preserved (a bare clone carries
`"dev"`/an old sha) while a CI build always reports its exact commit.
`buildInfoSha.test.ts` (3) pins the precedence: a real bundled sha wins; `"dev"`
falls back to the env; neither present → null (what the watchdog reads as
un-stamped). The regression is a pipeline race, not a unit-testable code path, so
the proof it is fixed is post-merge: this PR touches `backend/`, so its own deploy
runs the backend job, stamps `/health` with the merge commit, and the watchdog
goes green.

**Ref.** fix/bake-git-sha-into-bundle-0901, 2026-09-01.
