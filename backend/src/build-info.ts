// THE build stamp — baked INTO the Worker bundle at deploy time.
//
// WHY A BUNDLED CONSTANT, not a `--var GIT_SHA` env var (the old mechanism).
// The Deploy job runs `wrangler deploy --var GIT_SHA:<sha>` and THEN a separate
// `wrangler secret bulk` step. That secret step non-deterministically redeploys
// a Worker version that DROPS a CLI-injected `--var` — proven 2026-09-01: the
// IDENTICAL pipeline kept the stamp on 2026-08-31 and lost it on 2026-09-01,
// leaving `GET /health`'s sha `null`. The Deploy watchdog reads a null stamp as a
// rogue/unidentified deploy and false-alarms + dispatches redeploys in a loop
// ("needs a human, not a retry storm" — its own words). A value COMPILED INTO the
// bundle survives every var/secret operation, so the stamp cannot be dropped.
//
// The committed value is the "dev" placeholder — a local or un-stamped build. The
// Deploy and Deploy (Staging) workflows overwrite THIS FILE with the real commit
// sha immediately before `wrangler deploy`, so a CI-built Worker always reports
// the exact commit it was built from. A rogue bare `wrangler deploy` from a stale
// clone carries this placeholder (or an old sha), so the watchdog still catches
// it — the rogue-deploy detection the `--var` stamp gave us is preserved.
//
// Typed `string` (not the inferred `"dev"` literal) on purpose: CI rewrites the
// value, so `/health`'s "is this the placeholder?" check must be a real runtime
// comparison, not one TypeScript folds to a constant `false`.
export const GIT_SHA: string = "dev";

/** The sha GET /health reports: the bundled stamp above when it is a real commit,
 *  else the legacy `--var GIT_SHA` env (kept as a fallback), else null. "dev" is
 *  the un-stamped placeholder and counts as no stamp. */
export function resolveBuildSha(
  bundled: string,
  envSha: string | null | undefined,
): string | null {
  return (bundled !== "dev" ? bundled : null) ?? envSha ?? null;
}
