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

import { useEffect, useState } from "react";

// Vite emits ONE hashed entry module (e.g. /assets3/index-AbC123.js). Its
// filename changes on every build, so it's a free build id.
//
// The DIRECTORY is build.assetsDir and it moves: the 2026-07-31 edge-poison
// outage took it "assets" -> "assets2" -> "assets3" inside an hour, and this
// hook had "/assets/" written into three places — so the update prompt went
// silently dead on the very deploy where "a new version is live, reload"
// mattered most. Match ANY single-segment directory instead of naming it.
//
// The pattern is anchored to the WHOLE pathname and allows exactly ONE
// directory segment, which is what a Vite asset URL looks like. That anchoring
// is load-bearing: unanchored, it also matches the dev server's
// /node_modules/.vite/deps/react.js (on its /deps/ segment) and this hook would
// compare "react.js" against the deployed entry forever.
const ENTRY_ASSET = /^\/[A-Za-z0-9_-]+\/([A-Za-z0-9_.-]+\.js)$/;

/** Exported for the unit test: the assetsDir-agnostic parse is the whole point
    of this hook working after a namespace move, and nothing else would catch it
    going silently dead again. */
export function assetHashFrom(src: string): string | null {
  let pathname: string;
  try {
    // Accepts both the absolute src the DOM gives us and the root-relative path
    // parsed out of the served index.html; the base is never used for the
    // former and irrelevant for the latter.
    pathname = new URL(src, "http://build-id.invalid").pathname;
  } catch {
    return null;
  }
  const m = pathname.match(ENTRY_ASSET);
  return m?.[1] ?? null;
}

/** The entry-chunk filename this tab booted with (null if we can't tell — e.g.
    the dev server serves /src/main.tsx, not a hashed asset — then version
    checking is simply skipped, never wrong). */
function bootBuildId(): string | null {
  const scripts = Array.from(
    document.querySelectorAll('script[type="module"][src]'),
  ) as HTMLScriptElement[];
  for (const s of scripts) {
    const h = assetHashFrom(s.src);
    if (h) return h;
  }
  return null;
}

/** Exported for the unit test — see assetHashFrom above. */
export function latestBuildIdFrom(html: string): string | null {
  // Match the ENTRY module <script ... src="/<assetsDir>/xxx.js"> specifically,
  // so we compare like-for-like with bootBuildId() (NOT a <link modulepreload>,
  // which would differ from the entry and false-positive every check).
  const m = html.match(
    /<script[^>]+type=["']module["'][^>]*\bsrc=["'](\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.js)["']/i,
  );
  return m?.[1] ? assetHashFrom(m[1]) : null;
}

/** Poll the deployed index.html for a changed entry chunk. Returns
    `updateReady` once a newer build is live; the caller decides when to reload
    (we never reload from under the operator). Pauses while the tab is hidden. */
export function useVersionCheck(intervalMs = 5 * 60_000): { updateReady: boolean } {
  const [updateReady, setUpdateReady] = useState(false);

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
    void check(); // once on mount

    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs, updateReady]);

  return { updateReady };
}
