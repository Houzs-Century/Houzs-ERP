/* Houzs POS service worker.
 *
 * The whole app shell is precached at install (the list below is stamped by
 * the build), so the POS opens with no signal at all. Navigations and shell
 * files are served cache-first; /api is never cached (the app keeps its own
 * data in IndexedDB and queues its sales itself). A new build is a new cache
 * name: it installs in the background, the page shows "Update available" on
 * the login screen, and only a "Restart now" tells this worker to take over
 * (skipWaiting) - never in the middle of a sale. */
const VERSION = "houzs-pos-__SW_BUILD_ID__";
const PRECACHE = __SW_PRECACHE__;
const SHELL = new Set(PRECACHE);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then(async (cache) => {
      await cache.addAll(PRECACHE.concat(["/"]));
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      if (req.mode === "navigate") {
        const shell = await cache.match("/");
        if (shell) return shell;
      }
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && SHELL.has(url.pathname)) cache.put(req, res.clone());
        return res;
      } catch (e) {
        const shell = await cache.match("/");
        if (shell && req.headers.get("accept")?.includes("text/html")) return shell;
        throw e;
      }
    })(),
  );
});
