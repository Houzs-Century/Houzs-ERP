// Read-only: calls every ACTIVE public share link (contractor + brand) the way
// the share page does, from wherever this runs, and prints what came back.
//
// Why it exists (2026-09-09): the owner reported "all links cannot access" and
// nothing in this repo could observe the HTTP answer — the sandbox cannot reach
// production, and the Worker's request log lives in Cloudflare. GitHub Actions
// CAN reach it, and already holds DATABASE_URL to read the tokens, so the
// question is answered here without anyone handling a token or a DSN.
//
// It prints the PARTY, the HTTP status, the time, and the body's `error` /
// `message` or the event count. It NEVER prints a token: the repository is
// public and a token is the whole credential for a link.
//
// One SELECT, no writes, no transaction. Exit 0 for every legitimate answer —
// a 429 or a 500 from the link IS the answer. Non-zero only when the database
// itself cannot be read.
//
// RE-RUN: safe and free — it reads and prints.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveDsn() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveDsn();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const BASE = (process.argv[2] || process.env.PROBE_BASE || "https://erp.houzscentury.com").replace(/\/$/, "");
const SEGMENT = { contractor: "contractor-calendar", brand: "brand-calendar" };

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
let links;
try {
  links = await pg.unsafe(
    `SELECT 'contractor' AS kind, contractor AS party, token FROM contractor_share_tokens WHERE revoked_at IS NULL
     UNION ALL
     SELECT 'brand' AS kind, brand AS party, token FROM brand_share_tokens WHERE revoked_at IS NULL
     ORDER BY 1, 2`
  );
} finally {
  await pg.end({ timeout: 5 });
}

console.log(`base ${BASE} — ${links.length} active link(s) read`);
if (links.length === 0) console.log("no active links: nothing to probe (that is the finding, not an error)");

for (const l of links) {
  const target = `${BASE}/api/public/${SEGMENT[l.kind]}/${encodeURIComponent(l.token)}`;
  const t0 = Date.now();
  let line;
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
    const ms = Date.now() - t0;
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON: report the shape below */
    }
    if (res.ok && body && Array.isArray(body.events)) {
      line = `HTTP ${res.status} ${ms}ms events=${body.events.length}` + (body.exportScope ? ` exportScope=${body.exportScope}` : "");
    } else if (body && typeof body === "object") {
      line = `HTTP ${res.status} ${ms}ms error=${JSON.stringify(body.error ?? null)} message=${JSON.stringify(body.message ?? null)}` +
        (body.retryAfterSec ? ` retryAfterSec=${body.retryAfterSec}` : "");
    } else {
      line = `HTTP ${res.status} ${ms}ms non-JSON body (${text.length} bytes, content-type ${res.headers.get("content-type") ?? "none"})`;
    }
  } catch (e) {
    line = `FETCH FAILED after ${Date.now() - t0}ms: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.log(`${l.kind.padEnd(10)} ${l.party.padEnd(28)} ${line}`);
}
