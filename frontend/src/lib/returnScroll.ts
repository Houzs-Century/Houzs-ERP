// Return scroll — where a page was scrolled when a document was opened from it,
// so coming BACK lands on the same spot (owner 2026-10-21: 我从 merchant recon
// 点开 SO，返回也要返回 merchant recon — and back on a report of forty lines,
// "the same report, at the top" is not back).
//
// The page writes its position the moment a document link is clicked; the page
// takes it once when it is shown again at the same address and its content has
// arrived. One entry per address, taken once, and only while fresh — an old
// position must not yank a page someone opened from the menu an hour later.
//
// sessionStorage, per browser tab — navigation state, like the workspace tab
// strip it works with. Registered in lib/browserStorageRegistry.ts.

import { useEffect } from "react";

export const RETURN_SCROLL_KEY = "houzs.returnScroll.v1";
/** Thirty minutes: long enough to read an order, short enough not to haunt. */
const FRESH_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 20;

type Entry = { main: number; window: number; at: number };

function readAll(): Record<string, Entry | undefined> {
  try {
    const raw = sessionStorage.getItem(RETURN_SCROLL_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Entry | undefined>) : {};
  } catch {
    return {};
  }
}

const here = (): string => `${window.location.pathname}${window.location.search}`;
const scroller = (): HTMLElement | null => document.querySelector("main");

/** Note where this page is scrolled, under its address — call as a document
    link is clicked, before the route changes. */
export function rememberReturnScroll(href: string = here()): void {
  try {
    const all = readAll();
    all[href] = { main: scroller()?.scrollTop ?? 0, window: window.scrollY, at: Date.now() };
    const kept = Object.entries(all)
      .filter((e): e is [string, Entry] => e[1] != null)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES);
    sessionStorage.setItem(RETURN_SCROLL_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // storage disabled — the page simply opens at the top
  }
}

/** The position remembered for this address, removed as it is read; null when
    there is none or it has gone stale. */
export function takeReturnScroll(href: string = here()): { main: number; window: number } | null {
  try {
    const all = readAll();
    const hit = all[href];
    if (!hit) return null;
    delete all[href];
    sessionStorage.setItem(RETURN_SCROLL_KEY, JSON.stringify(all));
    return Date.now() - Number(hit.at) <= FRESH_MS ? { main: Number(hit.main) || 0, window: Number(hit.window) || 0 } : null;
  } catch {
    return null;
  }
}

/* ── Return picks ─────────────────────────────────────────────────────────────
   What a page had ticked when a document was opened from it — the bank
   reconciliation's movements and entries (owner 2026-11-10: 我希望这里也可以点开
   so, 点开后也可以返回这里) — kept the way the scroll is: per address, only while
   fresh, the newest twenty. Read without being used up (React may run a state
   initializer twice) and dropped by the page once it has them. */

export const RETURN_PICKS_KEY = "houzs.returnPicks.v1"; // gitleaks:allow — a sessionStorage key's name, not a credential

export type ReturnPicks = { lines: number[]; entries: string[] };
type PicksEntry = ReturnPicks & { at: number };

function readPicks(): Record<string, PicksEntry | undefined> {
  try {
    const raw = sessionStorage.getItem(RETURN_PICKS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, PicksEntry | undefined>) : {};
  } catch {
    return {};
  }
}

/** Note what this page has ticked, under its address — call as a document link
    is clicked, before the route changes. */
export function rememberReturnPicks(picks: ReturnPicks, href: string = here()): void {
  try {
    const all = readPicks();
    all[href] = { lines: [...picks.lines], entries: [...picks.entries], at: Date.now() };
    const kept = Object.entries(all)
      .filter((e): e is [string, PicksEntry] => e[1] != null)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES);
    sessionStorage.setItem(RETURN_PICKS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // storage disabled — the page simply comes back unticked
  }
}

/** The ticks remembered for this address, if fresh; null otherwise. Leaves them in place. */
export function peekReturnPicks(href: string = here()): ReturnPicks | null {
  const hit = readPicks()[href];
  if (!hit || !(Date.now() - Number(hit.at) <= FRESH_MS)) return null;
  const lines = Array.isArray(hit.lines) ? hit.lines.filter((n): n is number => Number.isInteger(n)) : [];
  const entries = Array.isArray(hit.entries) ? hit.entries.filter((s): s is string => typeof s === "string") : [];
  return { lines, entries };
}

/** Forget the ticks remembered for this address — the page has taken them. */
export function dropReturnPicks(href: string = here()): void {
  try {
    const all = readPicks();
    if (!(href in all)) return;
    delete all[href];
    sessionStorage.setItem(RETURN_PICKS_KEY, JSON.stringify(all));
  } catch {
    // storage disabled — nothing was kept
  }
}

/** Put the page back where it was once its content has arrived (`ready`).
    Content can still be laying out for a frame or two, so the position is
    re-applied until it holds. */
export function useReturnScroll(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const spot = takeReturnScroll();
    if (!spot) return;
    let tries = 0;
    const apply = () => {
      const main = scroller();
      if (main) main.scrollTop = spot.main;
      if (spot.window) window.scrollTo(0, spot.window);
      tries += 1;
      const held = !main || Math.abs(main.scrollTop - spot.main) < 2;
      if (!held && tries < 20) requestAnimationFrame(apply);
    };
    requestAnimationFrame(apply);
  }, [ready]);
}
