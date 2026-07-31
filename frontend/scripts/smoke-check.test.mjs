import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(frontend, "dist");
const smokeScript = join(frontend, "scripts", "smoke-check.mjs");
const index = readFileSync(join(dist, "index.html"), "utf8");
const entry = index.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+\.js)["']/i)?.[1];
assert.ok(entry, "built index must expose its module entry");

function runSmoke(baseUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [smokeScript, baseUrl], {
      cwd: frontend,
      env: { ...process.env, FRONTEND_SMOKE_ATTEMPTS: "1", FRONTEND_SMOKE_RETRY_MS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Mirrors the live policy in frontend/public/_headers: bounded, never immutable.
const ENTRY_CACHE = "public, max-age=300";

async function withServer(stale, callback, entryCache = ENTRY_CACHE) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/" || path === "/scm/sales-orders") {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "max-age=0" });
      response.end(stale ? index.replace(entry, "/assets/stale-entry.js") : index);
      return;
    }
    if (path === "/sw.js") {
      response.writeHead(200, { "content-type": "application/javascript", "cache-control": "max-age=0, must-revalidate" });
      response.end(readFileSync(join(dist, "sw.js")));
      return;
    }
    if (path === entry) {
      response.writeHead(200, { "content-type": "application/javascript", "cache-control": entryCache });
      response.end(readFileSync(join(dist, entry)));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("passes only when the live release matches the emitted dist", async () => {
  await withServer(false, async (baseUrl) => {
    const result = await runSmoke(baseUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[frontend-smoke\] PASS/);
  });
});

// A poisoned chunk (HTML cached under an asset URL) can only self-heal if the
// copy expires. `immutable` pins it for a year — the 2026-07-31 outage.
test("fails when the entry chunk is served immutable", async () => {
  await withServer(false, async (baseUrl) => {
    const result = await runSmoke(baseUrl);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /immutable/i);
  }, "public, max-age=31536000, immutable");
});

test("fails when the entry chunk TTL is longer than the poison window we accept", async () => {
  await withServer(false, async (baseUrl) => {
    const result = await runSmoke(baseUrl);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unbounded or too long/i);
  }, "public, max-age=86400");
});

test("accepts the zone's current 4-hour ceiling", async () => {
  await withServer(false, async (baseUrl) => {
    const result = await runSmoke(baseUrl);
    assert.equal(result.code, 0, result.stderr);
  }, "public, max-age=14400");
});

test("fails when an older entry is internally consistent but not the emitted dist", async () => {
  await withServer(true, async (baseUrl) => {
    const result = await runSmoke(baseUrl);
    assert.equal(result.code, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /latest build has not propagated/);
  });
});
