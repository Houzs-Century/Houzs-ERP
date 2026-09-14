// Carry the previous builds' hashed files into this Cloudflare Pages deployment.
//
//   node scripts/retain-previous-assets.mjs --base https://erp.houzscentury.com
//
// Runs in deploy.yml after `npm run build` and before `pages deploy ./dist`.
//
// THE STORE IS THE LIVE SITE. Every deployment ships `asset-manifest.json`: each
// hashed file it carries, its sha256, its size and when a build last PRODUCED it.
// The next deploy reads that manifest from production, downloads every listed
// file its own build lacks (still being served at that moment), verifies each one
// byte-for-byte against the manifest, and writes it into dist beside the new
// build. No bucket, no cache, no secret beyond what the deploy already has.
//
// RULES (scripts/lib/asset-retention.mjs, pinned by retain-previous-assets.test.mjs):
//   • never overwrite: a file the new build has is never replaced — index.html,
//     sw.js and every non-asset file come from the NEW build only;
//   • a body that is HTML, the wrong size, or the wrong sha256 is not written;
//   • a file no build has produced for --retention-days is dropped;
//   • the deployment stays under --max-files (Pages allows 20,000), dropping the
//     OLDEST carried files first.
//
// FAIL-SAFE. This step must never block a release. Every failure — the site
// unreachable, a bad manifest, a download error, the deadline — is a warning,
// and the process exits 0 with the new build intact in dist. deploy.yml also
// marks the step continue-on-error with a timeout, for a crash this file does
// not anticipate.

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASSET_PATH_RE,
  MANIFEST_NAME,
  acceptDownload,
  finalizeManifest,
  parseManifest,
  planRetention,
  sha256,
} from "./lib/asset-retention.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024;

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}

async function fetchWithTimeout(fetchImpl, url, ms) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    const res = await fetchImpl(url, {
      cache: "no-store",
      redirect: "follow",
      signal: abort.signal,
      headers: { "user-agent": "houzs-frontend-asset-retention/1" },
    });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, contentType: res.headers.get("content-type"), body };
  } finally {
    clearTimeout(timer);
  }
}

function writeNew(dist, path, body) {
  const target = join(dist, path);
  if (existsSync(target)) return false;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.retain-tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, target);
  return true;
}

export async function retainPreviousAssets({
  dist,
  base,
  fetch: fetchImpl,
  now,
  sha,
  retentionMs,
  maxFiles,
  logger,
  concurrency = 16,
  requestTimeoutMs = 20_000,
  deadlineMs = 240_000,
}) {
  const started = Date.now();
  const report = { built: 0, carried: 0, failed: {}, pruned: {}, collisions: 0, totalFiles: 0, totalBytes: 0, largest: null, warning: null };

  const allFiles = listFiles(dist).filter((p) => p !== MANIFEST_NAME);
  const built = allFiles
    .filter((p) => ASSET_PATH_RE.test(p))
    .map((path) => {
      const bytes = readFileSync(join(dist, path));
      return { path, sha256: sha256(bytes), size: bytes.length };
    });
  report.built = built.length;

  // Ship a manifest of THIS build first, so even a crash below leaves the next
  // deploy something to read.
  writeFileSync(join(dist, MANIFEST_NAME), JSON.stringify(finalizeManifest({ built, carried: [], now, sha, previous: null })));

  let previous = null;
  try {
    const res = await fetchWithTimeout(fetchImpl, `${base}/${MANIFEST_NAME}?t=${Date.parse(now)}`, requestTimeoutMs);
    if (res.status === 404) {
      report.warning = `no live ${MANIFEST_NAME} (first deploy with retention) - nothing to carry this time`;
    } else if (res.status !== 200) {
      report.warning = `live ${MANIFEST_NAME} answered HTTP ${res.status} - nothing carried`;
    } else {
      const parsed = parseManifest(res.body.toString("utf8"));
      if (!parsed.manifest) report.warning = `live ${MANIFEST_NAME} unusable (${parsed.reason}) - nothing carried`;
      else {
        previous = parsed.manifest;
        if (parsed.reason) logger.warn(`[retain-assets] ${parsed.reason}`);
      }
    }
  } catch (e) {
    report.warning = `could not read live ${MANIFEST_NAME}: ${e?.message ?? e} - nothing carried`;
  }

  const plan = planRetention({
    built,
    previous,
    now,
    retentionMs,
    maxFiles: maxFiles - 1, // the manifest itself is a file too
    otherFileCount: allFiles.length - built.length,
    maxFileBytes: PAGES_MAX_FILE_BYTES,
  });
  report.collisions = plan.collisions.length;
  for (const [reason, paths] of Object.entries(plan.pruned)) if (paths.length) report.pruned[reason] = paths.length;
  for (const path of plan.collisions) logger.warn(`[retain-assets] COLLISION: ${path} has different bytes in the new build; the new build wins`);

  const carried = [];
  const fail = (reason) => {
    report.failed[reason] = (report.failed[reason] ?? 0) + 1;
  };
  let next = 0;
  const worker = async () => {
    while (next < plan.carry.length) {
      const entry = plan.carry[next++];
      if (Date.now() - started > deadlineMs) {
        fail("deadline");
        continue;
      }
      try {
        const res = await fetchWithTimeout(fetchImpl, `${base}/${entry.path}`, requestTimeoutMs);
        const refused = acceptDownload(res, entry);
        if (refused) {
          fail(refused);
          continue;
        }
        if (writeNew(dist, entry.path, res.body)) carried.push(entry);
        else fail("exists");
      } catch (e) {
        fail(e?.name === "AbortError" ? "timeout" : "network");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  report.carried = carried.length;

  writeFileSync(join(dist, MANIFEST_NAME), JSON.stringify(finalizeManifest({ built, carried, now, sha, previous })));

  const finalFiles = listFiles(dist);
  report.totalFiles = finalFiles.length;
  for (const path of finalFiles) {
    const size = statSync(join(dist, path)).size;
    report.totalBytes += size;
    if (!report.largest || size > report.largest.size) report.largest = { path, size };
  }
  report.seconds = Math.round((Date.now() - started) / 100) / 10;
  return report;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", arg("dist", "dist"));
  const base = arg("base", "https://erp.houzscentury.com").replace(/\/$/, "");
  const retentionDays = Number(arg("retention-days", "7"));
  const maxFiles = Number(arg("max-files", "19000"));
  const logger = { log: (m) => console.log(m), warn: (m) => console.log(`::warning::${m}`) };
  try {
    const report = await retainPreviousAssets({
      dist,
      base,
      fetch: globalThis.fetch,
      now: new Date().toISOString(),
      sha: process.env.GITHUB_SHA ?? "local",
      retentionMs: retentionDays * DAY_MS,
      maxFiles,
      logger,
    });
    if (report.warning) logger.warn(`[retain-assets] ${report.warning}`);
    const failedTotal = Object.values(report.failed).reduce((a, b) => a + b, 0);
    if (failedTotal) logger.warn(`[retain-assets] ${failedTotal} previous file(s) not carried: ${JSON.stringify(report.failed)}`);
    const lines = [
      `new build hashed files: ${report.built}`,
      `carried from previous builds: ${report.carried}`,
      `not carried (failed): ${JSON.stringify(report.failed)}`,
      `pruned: ${JSON.stringify(report.pruned)}`,
      `collisions: ${report.collisions}`,
      `deployment files: ${report.totalFiles} (Pages limit 20000, this step's ceiling ${maxFiles})`,
      `deployment bytes: ${report.totalBytes}`,
      `largest file: ${report.largest?.path} ${report.largest?.size} bytes (Pages limit ${PAGES_MAX_FILE_BYTES})`,
      `retention window: ${retentionDays} days; took ${report.seconds}s`,
    ];
    for (const line of lines) console.log(`[retain-assets] ${line}`);
    console.log(`::notice title=Asset retention::carried ${report.carried}, deployment files ${report.totalFiles}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### Asset retention\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`, { flag: "a" });
    }
  } catch (e) {
    // The contract: never block the release. dist still holds the new build.
    console.log(`::warning::[retain-assets] step failed, deploying the new build alone: ${e?.stack ?? e}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
