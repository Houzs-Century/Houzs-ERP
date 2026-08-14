// Which TLS mode a Postgres connection gets. One rule, in one place, because
// the caller is pg-migrate.mjs — the tool that writes to the production
// database — and "when is it safe to turn TLS off" is not a question anyone
// should answer inline at a call site.
//
// NO SHEBANG: this module is imported by a test, and a `#!` that is not at byte
// 0 after vitest inlines the source is a SyntaxError on Windows only. See
// CLAUDE.md and BUG-HISTORY #2062.

/**
 * TLS is REQUIRED unless the target is a throwaway database on this machine.
 *
 * Why the exception exists: CI replays every migration into a scratch
 * `postgres:16` service container, which serves no TLS at all. Without this the
 * replay dies in 0.06s with "Client network socket disconnected before secure
 * TLS connection was established" — which is what it did on the first run of
 * the migration-replay gate.
 *
 * Why it is keyed on the HOSTNAME and not on an env var: a hostname comes from
 * the target itself, so it cannot be switched on by ambient configuration
 * leaking in from elsewhere. `PGSSL=disable` in the wrong environment file
 * would silently downgrade a production connection; `localhost` cannot be a
 * production DSN.
 *
 * It FAILS CLOSED. An unparseable URL, an empty string, anything unexpected —
 * all of them return 'require'. The only inputs that disable TLS are the two
 * loopback names, spelled exactly.
 *
 * @param {string} url a Postgres connection string
 * @returns {'require'|false} the `ssl` option for the `postgres` client
 */
export function pgSslMode(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'require';
  }
  return host === 'localhost' || host === '127.0.0.1' ? false : 'require';
}
