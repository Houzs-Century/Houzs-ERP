// Read-only post-deploy proof for the Pages frontend.
// Verifies that the root shell, a deep SPA route, its emitted entry chunk and
// the service worker are mutually consistent after Cloudflare propagation.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run smoke -- https://frontend.example.com");
  process.exit(2);
}

let base;
try {
  base = new URL(target);
  if (!/^https?:$/.test(base.protocol)) throw new Error("unsupported protocol");
} catch {
  console.error(`[frontend-smoke] invalid URL: ${target}`);
  process.exit(2);
}

base.pathname = base.pathname.replace(/\/$/, "");
const attempts = Math.max(1, Number(process.env.FRONTEND_SMOKE_ATTEMPTS ?? 8));
const retryDelayMs = Math.max(0, Number(process.env.FRONTEND_SMOKE_RETRY_MS ?? 2_000));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// _headers asks for 300s, and as of 2026-07-31 the zone finally delivers it:
// Browser Cache TTL was sitting on "4 hours" and rewriting every short max-age
// to 14400 (Cache Rules were empty — that one dropdown was the whole override),
// and it is now "Respect Existing Headers". Verified live: entry chunk 300,
// sw.js 0, index.html 0, fonts still a year.
//
// The ceiling is 3600 rather than exactly 300 so a deliberate policy tweak
// (300 -> 600) does not need a second edit here. What it still catches is the
// thing that matters: a chunk TTL measured in HOURS. If the dashboard setting
// is ever put back, live goes to 14400 and this goes red — which is the signal
// we want, not noise to widen away.
const MAX_CHUNK_TTL_SECONDS = 3_600;
const get = (path) => fetch(new URL(path, `${base.href}/`), {
  cache: "no-store",
  redirect: "follow",
  headers: { "user-agent": "houzs-frontend-release-smoke/1" },
});

function entryPath(html) {
  return html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+\.js)["']/i)?.[1]
    ?? html.match(/<script[^>]+src=["']([^"']+\.js)["'][^>]+type=["']module["']/i)?.[1];
}

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
let expectedEntry;
let expectedVersion;
try {
  expectedEntry = entryPath(readFileSync(join(dist, "index.html"), "utf8"));
  expectedVersion = readFileSync(join(dist, "sw.js"), "utf8")
    .match(/const VERSION = "([^"]+)";/)?.[1];
} catch {
  // The actionable message below covers both a missing and malformed build.
}
if (!expectedEntry || !expectedVersion || expectedVersion.includes("__SW_BUILD_ID__")) {
  console.error("[frontend-smoke] local dist is missing or unstamped; run `npm run build` before smoke.");
  process.exit(2);
}

async function proveRelease() {
  const rootResponse = await get("/");
  const rootBody = await rootResponse.text();
  if (!rootResponse.ok || !rootResponse.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`root returned ${rootResponse.status} ${rootResponse.headers.get("content-type") ?? "no content-type"}`);
  }
  const rootEntry = entryPath(rootBody);
  if (!rootEntry) throw new Error("root HTML has no module entry chunk");
  if (rootEntry !== expectedEntry) {
    throw new Error(`latest build has not propagated: expected ${expectedEntry}, received ${rootEntry}`);
  }

  const deepResponse = await get("/scm/sales-orders");
  const deepBody = await deepResponse.text();
  if (!deepResponse.ok || !deepResponse.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`deep route returned ${deepResponse.status} ${deepResponse.headers.get("content-type") ?? "no content-type"}`);
  }
  const deepEntry = entryPath(deepBody);
  if (deepEntry !== rootEntry) {
    throw new Error(`root/deep route build mismatch: ${rootEntry} vs ${deepEntry ?? "<missing>"}`);
  }

  const chunkResponse = await get(rootEntry);
  const chunkBody = await chunkResponse.text();
  const chunkType = chunkResponse.headers.get("content-type") ?? "";
  if (!chunkResponse.ok || !/(?:java|ecma)script/i.test(chunkType) || /^\s*<!doctype html/i.test(chunkBody)) {
    throw new Error(`entry chunk returned ${chunkResponse.status} ${chunkType || "no content-type"}`);
  }
  // The hashed bundles deliberately carry a BOUNDED TTL and NO `immutable` — see
  // the warning block in frontend/public/_headers. Pages answers an unknown path
  // with index.html at 200, so a request landing mid-deploy caches HTML *under the
  // asset URL*; `immutable` pins that poisoned copy for a year, which is what took
  // the ERP down on 2026-07-31. This assertion enforces the policy that replaced
  // it: the copy must be able to expire. It used to demand the opposite and went
  // red on every deploy from 2026-07-31 08:22 once _headers dropped `immutable`.
  const chunkCache = chunkResponse.headers.get("cache-control") ?? "";
  if (/immutable/i.test(chunkCache)) {
    throw new Error(`entry chunk is served immutable (${chunkCache}) — a poisoned copy could never expire`);
  }
  const chunkMaxAge = Number(/max-age=(\d+)/i.exec(chunkCache)?.[1] ?? NaN);
  if (!Number.isFinite(chunkMaxAge) || chunkMaxAge > MAX_CHUNK_TTL_SECONDS) {
    throw new Error(`entry chunk cache policy is unbounded or too long (${chunkCache || "no cache-control"})`);
  }

  const swResponse = await get("/sw.js");
  const swBody = await swResponse.text();
  if (!swResponse.ok || swBody.includes("__SW_BUILD_ID__")) {
    throw new Error(`service worker is unavailable or unstamped (${swResponse.status})`);
  }
  // _headers asks for `max-age=0, must-revalidate` and the zone now delivers it
  // (see MAX_CHUNK_TTL_SECONDS above — Browser Cache TTL moved off "4 hours" on
  // 2026-07-31, live sw.js is `public, must-revalidate, max-age=0`).
  //
  // This used to also accept a bare `must-revalidate`, because the zone rewrote
  // the number to 14400 and left the rest — a deliberately weaker assertion to
  // get past an override that has since been removed. Back to the real bar: the
  // SW script is the ONLY lever that moves a client stuck on a bad shell (that
  // file carries thirteen one-shot VERSION purges), so a cacheable copy of it is
  // a release defect, not a nit.
  const swCache = swResponse.headers.get("cache-control") ?? "";
  if (!/max-age=0|no-cache|no-store/i.test(swCache)) {
    throw new Error(`service worker can be served without revalidation (${swCache || "no cache-control"})`);
  }
  const version = swBody.match(/const VERSION = "([^"]+)";/)?.[1];
  if (!version) throw new Error("service worker has no release version");
  if (version !== expectedVersion) {
    throw new Error(`latest service worker has not propagated: expected ${expectedVersion}, received ${version}`);
  }

  return { entry: rootEntry, version, finalUrl: rootResponse.url };
}

let lastError;
let passedRelease;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    passedRelease = await proveRelease();
    break;
  } catch (error) {
    lastError = error;
    console.warn(`[frontend-smoke] attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`);
    if (attempt < attempts) await pause(retryDelayMs);
  }
}

if (passedRelease) {
  console.log(`[frontend-smoke] PASS ${passedRelease.finalUrl} entry=${passedRelease.entry} sw=${passedRelease.version}`);
} else {
  console.error(`[frontend-smoke] FAIL ${base.href}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  process.exitCode = 1;
}
