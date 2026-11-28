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
