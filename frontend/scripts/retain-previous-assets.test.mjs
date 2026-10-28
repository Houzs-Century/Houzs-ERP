// node --test scripts/retain-previous-assets.test.mjs
//
// The merge / prune rules that decide which of the PREVIOUS builds' hashed files
// ride along in the next Pages deployment. Written red first: every assertion
// here is a way the retention could silently break a release or strand a tab.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  ASSET_PATH_RE,
  MANIFEST_NAME,
  acceptDownload,
  finalizeManifest,
  parseManifest,
  planRetention,
} from "./lib/asset-retention.mjs";
import { retainPreviousAssets } from "./retain-previous-assets.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = "2026-09-14T03:00:00.000Z";
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();
const sha = (s) => createHash("sha256").update(s).digest("hex");

function manifestOf(files) {
  return { version: 1, generatedAt: ago(0), builds: [], files };
}

test("only hashed files directly under an assets dir are eligible", () => {
  for (const ok of ["assets3/sales-order-pdf-C9QaiR37.js", "assets/x-AbCdEf12.css", "assets2/a_b-Z9.js"]) {
    assert.ok(ASSET_PATH_RE.test(ok), ok);
  }
  for (const bad of ["index.html", "sw.js", "assets3/../index.html", "assets3/sub/x.js", "/assets3/x.js", "assetsX/x.js", "fonts/a.woff2", "assets3/.hidden"]) {
    assert.ok(!ASSET_PATH_RE.test(bad), bad);
  }
});

test("a previous file the new build lacks is carried; one it has is never carried (no overwrite)", () => {
  const built = [{ path: "assets3/initial-app-NEW00001.js", sha256: sha("new"), size: 3 }];
  const previous = manifestOf({
    "assets3/sales-order-pdf-C9QaiR37.js": { sha256: sha("old-pdf"), size: 7, lastBuiltAt: ago(DAY) },
    "assets3/initial-app-NEW00001.js": { sha256: sha("new"), size: 3, lastBuiltAt: ago(DAY) },
  });
  const plan = planRetention({ built, previous, now: NOW, retentionMs: 7 * DAY, maxFiles: 20_000, otherFileCount: 10, maxFileBytes: 25 * 1024 * 1024 });
  assert.deepEqual(plan.carry.map((f) => f.path), ["assets3/sales-order-pdf-C9QaiR37.js"]);
  assert.deepEqual(plan.collisions, []);
});

test("a same-name file with DIFFERENT bytes is a collision: reported, and the new build wins", () => {
  const built = [{ path: "assets3/a-AAAAAAAA.js", sha256: sha("new"), size: 3 }];
  const previous = manifestOf({ "assets3/a-AAAAAAAA.js": { sha256: sha("old"), size: 3, lastBuiltAt: ago(DAY) } });
  const plan = planRetention({ built, previous, now: NOW, retentionMs: 7 * DAY, maxFiles: 20_000, otherFileCount: 0, maxFileBytes: 1e9 });
  assert.deepEqual(plan.collisions, ["assets3/a-AAAAAAAA.js"]);
  assert.deepEqual(plan.carry, []);
});

test("files last built longer ago than the window are pruned", () => {
  const previous = manifestOf({
    "assets3/fresh-11111111.js": { sha256: sha("f"), size: 1, lastBuiltAt: ago(6 * DAY) },
    "assets3/stale-22222222.js": { sha256: sha("s"), size: 1, lastBuiltAt: ago(8 * DAY) },
  });
  const plan = planRetention({ built: [], previous, now: NOW, retentionMs: 7 * DAY, maxFiles: 20_000, otherFileCount: 0, maxFileBytes: 1e9 });
  assert.deepEqual(plan.carry.map((f) => f.path), ["assets3/fresh-11111111.js"]);
  assert.deepEqual(plan.pruned.expired, ["assets3/stale-22222222.js"]);
});

test("the Pages file ceiling drops the OLDEST carried files first, never the new build", () => {
  const previous = manifestOf({
    "assets3/older-11111111.js": { sha256: sha("1"), size: 1, lastBuiltAt: ago(3 * DAY) },
    "assets3/newer-22222222.js": { sha256: sha("2"), size: 1, lastBuiltAt: ago(1 * DAY) },
    "assets3/middle-3333333.js": { sha256: sha("3"), size: 1, lastBuiltAt: ago(2 * DAY) },
  });
  const built = [{ path: "assets3/b-44444444.js", sha256: sha("b"), size: 1 }];
  // 10 other files + 1 built + room for exactly 2 carried.
  const plan = planRetention({ built, previous, now: NOW, retentionMs: 7 * DAY, maxFiles: 13, otherFileCount: 10, maxFileBytes: 1e9 });
  assert.deepEqual(plan.carry.map((f) => f.path), ["assets3/newer-22222222.js", "assets3/middle-3333333.js"]);
  assert.deepEqual(plan.pruned.overLimit, ["assets3/older-11111111.js"]);
});

test("an unsafe path or an oversize file in a manifest is refused, not written", () => {
  const previous = manifestOf({
    "assets3/../index.html": { sha256: sha("x"), size: 1, lastBuiltAt: ago(DAY) },
    "assets3/huge-11111111.js": { sha256: sha("h"), size: 26 * 1024 * 1024, lastBuiltAt: ago(DAY) },
  });
  const plan = planRetention({ built: [], previous, now: NOW, retentionMs: 7 * DAY, maxFiles: 20_000, otherFileCount: 0, maxFileBytes: 25 * 1024 * 1024 });
  assert.deepEqual(plan.carry, []);
  assert.deepEqual(plan.pruned.unsafe, ["assets3/../index.html"]);
  assert.deepEqual(plan.pruned.tooLarge, ["assets3/huge-11111111.js"]);
});

test("no previous manifest (the first deploy) carries nothing and still plans", () => {
  const plan = planRetention({ built: [], previous: null, now: NOW, retentionMs: 7 * DAY, maxFiles: 20_000, otherFileCount: 0, maxFileBytes: 1e9 });
  assert.deepEqual(plan.carry, []);
});

test("parseManifest refuses garbage instead of trusting it", () => {
  assert.equal(parseManifest("<!doctype html><html>").manifest, null);
  assert.equal(parseManifest(JSON.stringify({ version: 2, files: {} })).manifest, null);
  assert.equal(parseManifest(JSON.stringify({ version: 1, files: [] })).manifest, null);
  const good = parseManifest(JSON.stringify(manifestOf({ "assets3/a-11111111.js": { sha256: sha("a"), size: 1, lastBuiltAt: ago(0) } })));
  assert.ok(good.manifest);
  // A malformed ENTRY is dropped, the rest survive.
  const mixed = parseManifest(JSON.stringify(manifestOf({
    "assets3/a-11111111.js": { sha256: sha("a"), size: 1, lastBuiltAt: ago(0) },
    "assets3/b-22222222.js": { sha256: "nothex", size: 1, lastBuiltAt: ago(0) },
  })));
  assert.deepEqual(Object.keys(mixed.manifest.files), ["assets3/a-11111111.js"]);
});

test("a downloaded file is accepted only as 200, not-HTML, and the exact bytes recorded", () => {
  const body = Buffer.from("export const a=1;");
  const expected = { sha256: sha(body), size: body.length };
  assert.equal(acceptDownload({ status: 200, contentType: "application/javascript", body }, expected), null);
  assert.equal(acceptDownload({ status: 404, contentType: "text/plain", body }, expected), "http-404");
  // The 2026-07-31 edge-poison shape: the SPA shell at 200 under a .js URL.
  assert.equal(acceptDownload({ status: 200, contentType: "text/html; charset=utf-8", body }, expected), "html");
  assert.equal(acceptDownload({ status: 200, contentType: "application/javascript", body: Buffer.from("tampered") }, expected), "hash-mismatch");
});

test("finalizeManifest stamps the new build NOW and keeps carried files' own dates", () => {
  const m = finalizeManifest({
    built: [{ path: "assets3/new-11111111.js", sha256: sha("n"), size: 1 }],
    carried: [{ path: "assets3/old-22222222.js", sha256: sha("o"), size: 1, lastBuiltAt: ago(2 * DAY) }],
    now: NOW,
    sha: "abc123",
    previous: manifestOf({}),
  });
  assert.equal(m.files["assets3/new-11111111.js"].lastBuiltAt, NOW);
  assert.equal(m.files["assets3/old-22222222.js"].lastBuiltAt, ago(2 * DAY));
  assert.equal(m.builds[0].sha, "abc123");
});

// ---------------------------------------------------------------------------
// The whole step against a real directory and a fake "live site". This is the
// fail-safe contract deploy.yml relies on: whatever goes wrong, the new build in
// dist is intact and the step reports instead of throwing.

function makeDist(files) {
  const dir = mkdtempSync(join(tmpdir(), "retain-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

function fakeSite(routes) {
  return async (url) => {
    const path = new URL(url).pathname.slice(1);
    const hit = routes[path];
    if (hit instanceof Error) throw hit;
    if (!hit) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(hit.body, { status: hit.status ?? 200, headers: { "content-type": hit.type } });
  };
}

const quiet = { log() {}, warn() {} };

test("end to end: carries a previous chunk, keeps the new index.html, writes the next manifest", async () => {
  const dist = makeDist({
    "index.html": "<html>NEW</html>",
    "assets3/initial-app-NEW00001.js": "new",
  });
  const oldPdf = "export const pdf=1;";
  const site = fakeSite({
    [MANIFEST_NAME]: {
      type: "application/json",
      body: JSON.stringify(manifestOf({
        "assets3/sales-order-pdf-C9QaiR37.js": { sha256: sha(oldPdf), size: oldPdf.length, lastBuiltAt: ago(DAY) },
        "assets3/initial-app-NEW00001.js": { sha256: sha("new"), size: 3, lastBuiltAt: ago(DAY) },
        "assets3/gone-99999999.js": { sha256: sha("gone"), size: 4, lastBuiltAt: ago(DAY) },
      })),
    },
    "assets3/sales-order-pdf-C9QaiR37.js": { type: "application/javascript", body: oldPdf },
    "index.html": { type: "text/html", body: "<html>OLD</html>" },
  });

  const report = await retainPreviousAssets({ dist, base: "https://erp.example", fetch: site, now: NOW, sha: "sha1", retentionMs: 7 * DAY, maxFiles: 20_000, logger: quiet });

  assert.equal(readFileSync(join(dist, "index.html"), "utf8"), "<html>NEW</html>");
  assert.equal(readFileSync(join(dist, "assets3/initial-app-NEW00001.js"), "utf8"), "new");
  assert.equal(readFileSync(join(dist, "assets3/sales-order-pdf-C9QaiR37.js"), "utf8"), oldPdf);
  assert.ok(!existsSync(join(dist, "assets3/gone-99999999.js")));
  assert.equal(report.carried, 1);
  assert.deepEqual(report.failed, { "http-404": 1 });

  const next = JSON.parse(readFileSync(join(dist, MANIFEST_NAME), "utf8"));
  assert.deepEqual(Object.keys(next.files).sort(), ["assets3/initial-app-NEW00001.js", "assets3/sales-order-pdf-C9QaiR37.js"]);
  assert.equal(report.totalFiles, 4); // index.html, 2 assets, the manifest
});

test("end to end: the live site unreachable -> the new build is untouched and a manifest still ships", async () => {
  const dist = makeDist({ "index.html": "<html>NEW</html>", "assets3/a-11111111.js": "a" });
  const report = await retainPreviousAssets({
    dist, base: "https://erp.example", fetch: async () => { throw new Error("ECONNRESET"); },
    now: NOW, sha: "sha1", retentionMs: 7 * DAY, maxFiles: 20_000, logger: quiet,
  });
  assert.equal(report.carried, 0);
  assert.match(report.warning ?? "", /manifest/i);
  assert.deepEqual(readdirSync(join(dist, "assets3")), ["a-11111111.js"]);
  assert.ok(JSON.parse(readFileSync(join(dist, MANIFEST_NAME), "utf8")).files["assets3/a-11111111.js"]);
});

test("end to end: an HTML body under a chunk URL is never written into dist", async () => {
  const dist = makeDist({ "index.html": "x" });
  const body = "export const b=2;";
  const site = fakeSite({
    [MANIFEST_NAME]: { type: "application/json", body: JSON.stringify(manifestOf({ "assets3/b-22222222.js": { sha256: sha(body), size: body.length, lastBuiltAt: ago(DAY) } })) },
    "assets3/b-22222222.js": { type: "text/html", body: "<!doctype html>" },
  });
  const report = await retainPreviousAssets({ dist, base: "https://erp.example", fetch: site, now: NOW, sha: "s", retentionMs: 7 * DAY, maxFiles: 20_000, logger: quiet });
  assert.equal(report.carried, 0);
  assert.deepEqual(report.failed, { html: 1 });
  assert.ok(!existsSync(join(dist, "assets3/b-22222222.js")));
});
