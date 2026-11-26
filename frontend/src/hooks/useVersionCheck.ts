
import { useEffect, useRef, useState } from "react";
import { BUILD_ID_META, readBuildId } from "../lib/buildId";


/** The build id stamped into a served index.html's <meta name="houzs-build-id">,
    or null when the html carries no stamp (never treat a stampless page as a new
    build). Exported for the unit test — a silent regression here is the whole
    failure mode, so it is pinned directly. */
export function latestBuildIdFrom(html: string): string | null {
  const tag = html.match(new RegExp(`<meta[^>]*\\bname=["']${BUILD_ID_META}["'][^>]*>`, "i"))?.[0];
  const content = tag?.match(/\bcontent=["']([^"']*)["']/i)?.[1]?.trim();
  return content ? content : null;
}

function bootBuildId(): string | null {
  if (typeof document === "undefined") return null;
  const id = readBuildId(document);
  return id !== "dev" ? id : null;
}

export interface VersionCheckOptions {
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
  const checkNow = useRef<() => void>(() => {});

  useEffect(() => {
    const boot = bootBuildId();
    if (!boot) return;
    let stopped = false;

    const check = async () => {
      if (stopped || document.hidden || updateReady) return;
      try {
        const res = await fetch(`/index.html?_=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const latest = latestBuildIdFrom(await res.text());
        if (latest && latest !== boot) {
          setUpdateReady(true);
          stopped = true;
        }
      } catch {
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
    void check();

    return () => {
      stopped = true;
      checkNow.current = () => {};
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs, updateReady]);

  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    checkNow.current();
  }, [routeKey]);

  return { updateReady };
}
