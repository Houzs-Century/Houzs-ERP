// ---------------------------------------------------------------------------
// Deploy-churn recovery — RUNTIME layer (adapted from 2990's use-version-check,
// itself ported from HOOKKA).
//
// Houzs already recovers from a redeploy two other ways:
//   • the service worker bumps its VERSION (public/sw.js) → the cache layer,
//   • ChunkReloadBoundary (components/RouteFallback.tsx) catches a failed lazy
//     import() of a now-missing hashed chunk and hard-reloads once.
//
// This adds the COMPLEMENTARY piece those two don't cover: detect that a newer
// build is live WHILE the tab is still happily running the old one (no crash,
// no navigation), and offer a non-blocking "Reload now" banner. We never reload
// from under the operator — a deploy mid-data-entry can't wipe their work; they
// click when ready. It does NOT touch the service worker.
//
// No new backend route: reads the static index.html the SPA already serves.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { BUILD_ID_META, readBuildId } from "../lib/buildId";

// HOW A NEW BUILD IS DETECTED. Every build stamps a unique id
// (Date.now().toString(36)) into <meta name="houzs-build-id"> in index.html
// (vite.config.ts) — the SAME id lib/buildId.ts reads for the SW / localStorage
// namespace. We compare the id THIS tab booted with against the id in a
// freshly-fetched index.html; a difference means a newer build is live.
//
// This used to compare the FILENAME of the first <script type=module> instead,
// on the assumption (stated in this comment) that the entry chunk's hash changes
// every build — true for Vite's index-AbC123.js. Under Rolldown the first module
// script is rolldown-runtime-<hash>.js, whose content-hash is STABLE across app
// builds, so boot === latest on every deploy and the prompt went silently dead
// for everyone. The <meta> id is purpose-built per deploy and immune to bundler
// chunk-naming AND to an assetsDir move (assets -> assets2 -> assets3, the
// 2026-07-31 outage) alike. buildId.ts records the twin lesson: it moved OFF a
// hashed chunk for exactly this reason; this hook was the one reader left behind.

/** The build id stamped into a served index.html's <meta name="houzs-build-id">,
    or null when the html carries no stamp (never treat a stampless page as a new
    build). Exported for the unit test — a silent regression here is the whole
    failure mode, so it is pinned directly. */
export function latestBuildIdFrom(html: string): string | null {
  const tag = html.match(new RegExp(`<meta[^>]*\\bname=["']${BUILD_ID_META}["'][^>]*>`, "i"))?.[0];
  const content = tag?.match(/\bcontent=["']([^"']*)["']/i)?.[1]?.trim();
  return content ? content : null;
}

/** The build id this tab booted with, or null on the dev server, where the meta
    is absent (readBuildId → "dev") and version checking is simply skipped. Read
    at call time, not import time, so a test can stamp the document first. */
function bootBuildId(): string | null {
  if (typeof document === "undefined") return null;
  const id = readBuildId(document);
  return id !== "dev" ? id : null;
}

export interface VersionCheckOptions {
  /** The caller's current navigation position — the pathname on the desktop
      shell. REQUIRED, not optional: it decides whether the check runs at the
      one moment that matters most (see below), and an omitted key would
      silently keep the old poll-only behaviour with nothing failing to
      compile. Pass null only where the surface genuinely has no navigation. */
  routeKey: string | null;
  intervalMs?: number;
}

/** Poll the deployed index.html for a changed entry chunk. Returns
    `updateReady` once a newer build is live; the caller decides when to reload
    (we never reload from under the operator). Pauses while the tab is hidden.

    The cadence was 5 minutes and that lost the race it exists to win. `main`
    takes roughly 30-70 merges a day, App.tsx code-splits 100+ routes, and every
    route the tab has NOT visited yet is a chunk that disappears on the next
    deploy — so the operator's odds of being warned before clicking into one
    were poor, and the audit caught five 404-then-reload "flashes" in a single
    session. Sixty seconds plus a check on every navigation narrows that window
    to about one click, and each check is one small same-origin GET of
    index.html. Cost, since nobody measured it before: an operator making N
    navigations in a minute now issues N+1 of those GETs instead of 0.2. */
export function useVersionCheck(
  { routeKey, intervalMs = 60_000 }: VersionCheckOptions,
): { updateReady: boolean } {
  const [updateReady, setUpdateReady] = useState(false);
  /** Lets the navigation effect below fire a check WITHOUT taking routeKey as a
      dependency of the polling effect — that would tear down and rebuild the
      interval on every click, so a busy operator would reset the 60s clock
      forever and the periodic check would never actually run. */
  const checkNow = useRef<() => void>(() => {});

  useEffect(() => {
    const boot = bootBuildId();
    if (!boot) return; // dev server / can't detect — skip silently
    let stopped = false;

    const check = async () => {
      if (stopped || document.hidden || updateReady) return;
      try {
        const res = await fetch(`/index.html?_=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return; // transient / offline — try again next tick
        const latest = latestBuildIdFrom(await res.text());
        if (latest && latest !== boot) {
          setUpdateReady(true);
          stopped = true;
        }
      } catch {
        /* network blip — ignore */
      }
    };

    const id = window.setInterval(() => {
      void check();
    }, intervalMs);
    const onVis = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVis);
    checkNow.current = () => { void check(); };
    void check(); // once on mount

    return () => {
      stopped = true;
      // Drop the handle with the effect that owns it, so a navigation landing
      // after unmount cannot call into a torn-down closure.
      checkNow.current = () => {};
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs, updateReady]);

  // Check on every navigation, NOT only on the 60s tick.
  //
  // Read the ordering honestly, because an earlier version of this comment did
  // not: React.lazy starts the dynamic import during the RENDER phase, and this
  // effect runs after the commit. So the import for the route being entered is
  // already in flight before checkNow() is even dispatched, and the index.html
  // round trip lands later still. This check can never save the navigation that
  // triggered it — it saves the NEXT one.
  //
  // That is still the change worth having. The window between a deploy and the
  // operator's first click into an unvisited chunk was up to five minutes wide;
  // with a check per navigation a busy operator is warned within one click of
  // the deploy instead. Making it genuinely pre-import would mean intercepting
  // the router before render, which is a different and much larger change.
  const mounted = useRef(false);
  useEffect(() => {
    // The polling effect already checks once on mount; without this the very
    // first render would fire two identical requests back to back.
    if (!mounted.current) { mounted.current = true; return; }
    checkNow.current();
  }, [routeKey]);

  return { updateReady };
}
