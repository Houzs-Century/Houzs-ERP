// Deterministic release gate for the emitted service worker.
//
// This runs against dist/sw.js after `vite build`, so it proves both that the
// build-id stamping happened and that the exact worker being deployed keeps
// the two safety invariants that previously caused production incidents:
//   1. a dead/poisoned JS URL is never answered with the HTML app shell;
//   2. an offline navigation can still fall back to the cached shell.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const workerPath = join(root, "sw.js");

let source;
try {
  source = readFileSync(workerPath, "utf8");
} catch {
  console.error(`[service-worker] no emitted worker at ${workerPath}; run \`npm run build\` first.`);
  process.exit(1);
}

if (source.includes("__SW_BUILD_ID__")) {
  console.error("[service-worker] build id token was not stamped; old and new deploys could share a cache.");
  process.exit(1);
}

const version = source.match(/const VERSION = "([^"]+)";/)?.[1];
if (!version || !/^houzs-erp-v\d+-[a-z0-9]+$/i.test(version)) {
  console.error(`[service-worker] emitted cache version is missing or malformed: ${version ?? "<missing>"}`);
  process.exit(1);
}

const handlers = new Map();
let cachedResponse = null;
let cachePutCount = 0;
const cache = {
  match: async () => cachedResponse?.clone() ?? undefined,
  put: async () => {
    cachePutCount += 1;
  },
};
const context = {
  AbortController,
  DOMException,
  Promise,
  Request,
  Response,
  URL,
  caches: {
    open: async () => cache,
    keys: async () => [],
    delete: async () => true,
  },
  console,
  fetch: async () => {
    throw new TypeError("offline");
  },
  setTimeout,
  clearTimeout,
  self: {
    location: { hostname: "erp.houzscentury.com", origin: "https://erp.houzscentury.com" },
    registration: { unregister: async () => true },
    clients: { claim: async () => undefined },
    skipWaiting: () => undefined,
    addEventListener: (name, handler) => handlers.set(name, handler),
  },
};

vm.runInNewContext(source, context, { filename: workerPath });
const onFetch = handlers.get("fetch");
if (typeof onFetch !== "function") {
  console.error("[service-worker] emitted worker did not register a fetch handler.");
  process.exit(1);
}

async function dispatch(request) {
  let responsePromise;
  onFetch({
    request,
    respondWith(value) {
      responsePromise = Promise.resolve(value);
    },
  });
  return responsePromise;
}

const html = new Response("<!doctype html><title>Houzs</title>", {
  status: 200,
  headers: { "content-type": "text/html" },
});

// Cloudflare's SPA fallback may return index.html with status 200 for a dead
// hashed chunk. The worker must turn that into an honest no-store failure.
context.fetch = async () => html.clone();
cachedResponse = null;
const deadChunk = await dispatch(new Request("https://erp.houzscentury.com/assets/dead-hash.js"));
if (!(deadChunk instanceof Response) || deadChunk.status !== 504 || (await deadChunk.text()) !== "") {
  console.error("[service-worker] a dead code URL was not rejected with the clean 504 response.");
  process.exit(1);
}
if (cachePutCount !== 0) {
  console.error("[service-worker] an HTML response for a code URL was written to cache.");
  process.exit(1);
}

// A poisoned cache entry from an older worker must also never escape as JS.
context.fetch = async () => {
  throw new TypeError("offline");
};
cachedResponse = html;
const poisonedChunk = await dispatch(new Request("https://erp.houzscentury.com/assets/poisoned.js"));
if (!(poisonedChunk instanceof Response) || poisonedChunk.status !== 504) {
  console.error("[service-worker] cached HTML could still be served for a code URL.");
  process.exit(1);
}

// API and cross-origin reads belong to the page/browser, never this cache.
if (await dispatch(new Request("https://erp.houzscentury.com/api/orders")) !== undefined) {
  console.error("[service-worker] a same-origin API read was intercepted.");
  process.exit(1);
}
if (await dispatch(new Request("https://fonts.example.com/font.woff2")) !== undefined) {
  console.error("[service-worker] a cross-origin request was intercepted.");
  process.exit(1);
}

// Navigations have the opposite contract: when offline, the cached shell is a
// valid recovery path for a deep link.
cachedResponse = html;
const offlineNavigation = await dispatch({
  url: "https://erp.houzscentury.com/scm/sales-orders/SO-1",
  method: "GET",
  mode: "navigate",
  destination: "document",
});
if (!(offlineNavigation instanceof Response) || offlineNavigation.status !== 200) {
  console.error("[service-worker] offline navigation did not recover from the cached shell.");
  process.exit(1);
}

// Online navigation must prefer the new shell and refresh both cache keys.
cachedResponse = new Response("<!doctype html><title>old</title>", {
  headers: { "content-type": "text/html" },
});
cachePutCount = 0;
context.fetch = async () => new Response("<!doctype html><title>fresh</title>", {
  headers: { "content-type": "text/html" },
});
const freshNavigation = await dispatch({
  url: "https://erp.houzscentury.com/scm/sales-orders/SO-2",
  method: "GET",
  mode: "navigate",
  destination: "document",
});
if (!(freshNavigation instanceof Response) || !(await freshNavigation.text()).includes("fresh")) {
  console.error("[service-worker] online navigation did not prefer the fresh shell.");
  process.exit(1);
}
await Promise.resolve();
if (cachePutCount !== 2) {
  console.error(`[service-worker] fresh navigation updated ${cachePutCount} shell cache keys instead of 2.`);
  process.exit(1);
}

// Mutations are never intercepted or replayed by the service worker.
const mutation = await dispatch({
  url: "https://erp.houzscentury.com/api/orders",
  method: "POST",
  mode: "cors",
  destination: "",
});
if (mutation !== undefined) {
  console.error("[service-worker] a mutating request was intercepted.");
  process.exit(1);
}

// A print preview is a DOCUMENT path served from its own cache. Two invariants:
//
//   • the probe must answer with the sentinel header — it is the only signal the
//     page has that this route exists. Without it the page falls back to a blob
//     tab: still correct, but the address bar goes back to being a GUID.
//   • a MISS must fail honestly. This path is a navigation, so if it ever fell
//     through to navigationNetworkFirst the operator would be handed the ERP app
//     shell where a PDF was expected — the same class of bug this file already
//     guards against for code URLs.
const probe = await dispatch(new Request("https://erp.houzscentury.com/print-preview/__probe"));
if (!(probe instanceof Response) || probe.headers.get("X-Houzs-Print-Preview") !== "1") {
  console.error("[service-worker] the print-preview probe did not answer with its sentinel header.");
  process.exit(1);
}
cachedResponse = null; // nothing stored under this name — the expiry case
context.fetch = async () => html.clone(); // ...and the network would offer the shell
const missedPreview = await dispatch({
  url: "https://erp.houzscentury.com/print-preview/DO-1.pdf",
  method: "GET",
  mode: "navigate",
  destination: "document",
});
if (!(missedPreview instanceof Response) || missedPreview.status !== 404) {
  console.error(
    `[service-worker] an expired print preview returned ${
      missedPreview instanceof Response ? missedPreview.status : "no response"
    } instead of an honest 404 — the app shell can reach a PDF tab.`,
  );
  process.exit(1);
}

console.log(
  `[service-worker] PASS ${version}: stamped cache, code/API isolation, fresh/offline shell, print-preview isolation, mutation bypass.`,
);
