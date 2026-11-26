// Workspace tab store — the in-app tab strip (owner ask 2026-07-23: "可以在erp
// 里面有tab version吗? 比如一个开sales order, 一个开service case").
//
// TABS BEHAVE LIKE BROWSER TABS (owner refinement, same day: drilling from a
// hub into Delivery Orders must STAY in the tab — "我要它在同一个 tab 里面,
// 不要开一个新的 tab"). A tab is a workspace that follows every in-content
// navigation — hub cards, table rows, back buttons, programmatic redirects all
// re-point the ACTIVE tab. Only an explicit "open" gesture spawns or activates
// another tab: clicking a SIDEBAR destination (which marks an open-intent just
// before the route changes), with Ctrl/Cmd+click still escalating all the way
// to a real browser window. The strip renders each tab's label from wherever
// that tab currently is.
//
// Sidebar open-intent dedup: if some tab is already sitting in the clicked
// destination's section, that tab is activated instead of spawning a
// duplicate. In-content wandering deliberately skips this dedup — two tabs may
// wander onto the same section (exactly like two browser tabs on one page),
// and yanking the user onto another tab mid-navigation would lose their spot.
//
// Persistence: sessionStorage, ONE key, per browser tab — the same per-window
// philosophy as the active-company pick (lib/activeCompany.ts): each window
// owns its own strip, a reload restores it, and two windows on two companies
// never share tabs. The blob records {user, company} and is dropped whenever
// either changes (re-login as somebody else, company switch reload) — tabs are
// navigation state, and another identity's last-visited URLs must not leak
// across.
//
// Plain module + pub/sub (useSyncExternalStore-ready), mirroring
// lib/activeCompany.ts.

import { getBrowserStorageIdentity } from "./storageIdentity";
import { resolveAlias } from "./routeAliases";

export const WORKSPACE_TABS_KEY = "houzs.workspaceTabs.v1";

export interface WorkspaceTab {
  id: string;
  href: string;
  /** The tab, and the page in it, a DOCUMENT tab was opened from (a document
      link — Merchant Recon's order numbers, Fair Links, a relationship map).
      The document's own Back returns there (owner 2026-10-21: 我从 merchant
      recon 点开 SO，返回也要返回 merchant recon). Absent on every other tab. */
  opener?: { id: string; href: string };
}

export interface WorkspaceTabsSnapshot {
  tabs: readonly WorkspaceTab[];
  activeId: string | null;
}

interface StoredBlob {
  user: number | null;
  company: number | null;
  tabs: WorkspaceTab[];
  activeId: string | null;
  nextId: number;
}

let state: StoredBlob | null = null;
let snapshot: WorkspaceTabsSnapshot = { tabs: [], activeId: null };

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn();
}

function refreshSnapshot(): void {
  snapshot = { tabs: state?.tabs ?? [], activeId: state?.activeId ?? null };
}


const OPEN_INTENT_TTL_MS = 1500;
let openIntent: { at: number; doc: boolean } | null = null;

/** Call from a plain left-click on a sidebar destination (or, with `doc`,
 *  before opening a document in its own tab), BEFORE the route changes.
 *  Modified clicks (Ctrl/Cmd/Shift/middle) must NOT mark — they open a real
 *  browser window and this tab never navigates. */
export function markWorkspaceOpenIntent(doc = false): void {
  openIntent = { at: Date.now(), doc };
}

function consumeOpenIntent(): { doc: boolean } | null {
  const pending = openIntent;
  openIntent = null;
  return pending !== null && Date.now() - pending.at <= OPEN_INTENT_TTL_MS ? pending : null;
}


function canonicalPath(pathname: string): string {
  const bare = (pathname || "/").split("?")[0].split("#")[0];
  const trimmed = bare.length > 1 && bare.endsWith("/") ? bare.slice(0, -1) : bare;
  return resolveAlias(trimmed) ?? trimmed;
}

/**
 * The section a path belongs to — used for tab LABELS (a tab on a document
 * detail keeps its list's name) and for the sidebar open-intent dedup. Mirrors
 * how the sidebar carves the app: top-level routes group by first segment
 * (/assr/123 → /assr), /scm/* by its second segment, and the two deeper SCM
 * families (/scm/reports/<slug>, /scm/hr/<leaf>) by their leaf — those leaves
 * are distinct sidebar destinations, not children of one page. /reports/<slug>
 * keeps two segments for the same reason.
 */
export function sectionKeyFor(pathname: string): string {
  const path = canonicalPath(pathname);
  if (path === "/") return "/";
  const segs = path.split("/").filter(Boolean);
  if (segs[0] === "scm") {
    if (segs.length === 1) return "/scm";
    if ((segs[1] === "reports" || segs[1] === "hr") && segs[2]) {
      return `/scm/${segs[1]}/${segs[2]}`;
    }
    return `/scm/${segs[1]}`;
  }
  if (segs[0] === "reports" && segs[1]) return `/reports/${segs[1]}`;
  return `/${segs[0]}`;
}

/** Tab label for a section key — the same strings the breadcrumb fallback
 *  uses, so the strip and the navbar can never disagree about a page's name. */
export { labelForPath as workspaceTabLabel } from "./routeLabels";


const validTab = (value: unknown): value is WorkspaceTab => {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<WorkspaceTab>;
  return (
    typeof t.id === "string" &&
    /^t\d+$/.test(t.id) &&
    typeof t.href === "string" &&
    /^\/(?!\/)/.test(t.href)
  );
};

function readStored(): StoredBlob | null {
  try {
    const raw = sessionStorage.getItem(WORKSPACE_TABS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const blob = parsed as Partial<StoredBlob>;
    const user = typeof blob.user === "number" && Number.isFinite(blob.user) ? blob.user : null;
    const company =
      typeof blob.company === "number" && Number.isFinite(blob.company) ? blob.company : null;
    const tabs = (Array.isArray(blob.tabs) ? blob.tabs.filter(validTab) : []).map((t): WorkspaceTab => {
      const o = t.opener;
      const ok = !!o && typeof o === "object" && typeof o.id === "string" && /^t\d+$/.test(o.id)
        && typeof o.href === "string" && /^\/(?!\/)/.test(o.href);
      return ok ? { id: t.id, href: t.href, opener: { id: o.id, href: o.href } } : { id: t.id, href: t.href };
    });
    const seen = new Set<string>();
    const deduped = tabs.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
    const activeId =
      typeof blob.activeId === "string" && deduped.some((t) => t.id === blob.activeId)
        ? blob.activeId
        : null;
    const maxId = deduped.reduce((m, t) => Math.max(m, Number(t.id.slice(1))), 0);
    const nextId =
      typeof blob.nextId === "number" && Number.isFinite(blob.nextId) && blob.nextId > maxId
        ? Math.floor(blob.nextId)
        : maxId + 1;
    return { user, company, tabs: deduped, activeId, nextId };
  } catch {
    return null;
  }
}

function persist(): void {
  try {
    if (state === null || state.tabs.length === 0) sessionStorage.removeItem(WORKSPACE_TABS_KEY);
    else sessionStorage.setItem(WORKSPACE_TABS_KEY, JSON.stringify(state));
  } catch {
  }
}

function currentIdentity(): { user: number | null; company: number | null } {
  const id = getBrowserStorageIdentity();
  return { user: id?.userId ?? null, company: id?.companyId ?? null };
}

function ensureLoaded(): StoredBlob {
  const identity = currentIdentity();
  if (state === null) {
    const stored = readStored();
    if (
      stored &&
      (stored.user === null || identity.user === null || stored.user === identity.user) &&
      (stored.company === null || identity.company === null || stored.company === identity.company)
    ) {
      state = stored;
    } else {
      state = { ...identity, tabs: [], activeId: null, nextId: 1 };
      if (stored) persist();
    }
    refreshSnapshot();
  }
  if (identity.user !== null) {
    if (state.user === null) {
      state = { ...state, ...identity };
      persist();
    } else if (state.user !== identity.user || state.company !== identity.company) {
      state = { ...identity, tabs: [], activeId: null, nextId: 1 };
      persist();
      refreshSnapshot();
    }
  }
  return state;
}


/** Stable snapshot for useSyncExternalStore. */
export function getWorkspaceTabsSnapshot(): WorkspaceTabsSnapshot {
  ensureLoaded();
  return snapshot;
}

export function subscribeWorkspaceTabs(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Record a navigation — the strip calls this on every route change.
 *
 *  · First location of the session → create the first tab.
 *  · Open-intent pending (sidebar click) → activate the tab already sitting in
 *    the destination's section, else spawn a new tab there.
 *  · Document intent pending (a relationship-map click) → activate the tab
 *    already on that exact document, else spawn a new tab for it.
 *  · Otherwise → the active tab follows: its href re-points to the location.
 */
export function recordWorkspaceVisit(pathname: string, search: string): void {
  const s = ensureLoaded();
  const href = `${canonicalPath(pathname)}${search || ""}`;
  const intent = consumeOpenIntent();

  if (s.tabs.length === 0) {
    const id = `t${s.nextId}`;
    state = { ...s, tabs: [{ id, href }], activeId: id, nextId: s.nextId + 1 };
  } else if (intent) {
    const section = sectionKeyFor(pathname);
    const existing = intent.doc
      ? s.tabs.find((t) => t.href === href)
      : s.tabs.find((t) => sectionKeyFor(t.href) === section);
    const from = s.tabs.find((t) => t.id === s.activeId) ?? null;
    const openerFor = (tabId: string) =>
      intent.doc && from && from.id !== tabId ? { opener: { id: from.id, href: from.href } } : {};
    if (existing) {
      if (existing.href === href && s.activeId === existing.id) return;
      state = {
        ...s,
        tabs: s.tabs.map((t) => (t.id === existing.id ? { ...t, href, ...openerFor(t.id) } : t)),
        activeId: existing.id,
      };
    } else {
      const id = `t${s.nextId}`;
      state = { ...s, tabs: [...s.tabs, { id, href, ...openerFor(id) }], activeId: id, nextId: s.nextId + 1 };
    }
  } else {
    const active = s.tabs.find((t) => t.id === s.activeId) ?? null;
    if (active === null) {
      const id = `t${s.nextId}`;
      state = { ...s, tabs: [...s.tabs, { id, href }], activeId: id, nextId: s.nextId + 1 };
    } else {
      if (active.href === href) return;
      state = {
        ...s,
        tabs: s.tabs.map((t) => (t.id === active.id ? { ...t, href } : t)),
      };
    }
  }
  persist();
  refreshSnapshot();
  emit();
}

/**
 * Activate a tab (strip click). Returns its href for the caller to navigate —
 * activation happens FIRST so the ensuing route change finds the clicked tab
 * already active and re-points nothing.
 */
export function activateWorkspaceTab(id: string): string | null {
  const s = ensureLoaded();
  const tab = s.tabs.find((t) => t.id === id);
  if (!tab) return null;
  if (s.activeId !== id) {
    state = { ...s, activeId: id };
    persist();
    refreshSnapshot();
    emit();
  }
  return tab.href;
}

/**
 * Move a tab to a new position in the strip (drag reorder, owner ask
 * 2026-07-23: "可以自主拖拽前后"). Pure order change: the active pointer and
 * every href are untouched, and the close-neighbour semantics simply follow
 * the NEW order (that is the point of reordering). Index is clamped; a
 * same-position move is a no-op so live drag-over calls stay cheap.
 */
export function moveWorkspaceTab(id: string, toIndex: number): void {
  const s = ensureLoaded();
  const from = s.tabs.findIndex((t) => t.id === id);
  if (from === -1) return;
  const to = Math.max(0, Math.min(s.tabs.length - 1, Math.floor(toIndex)));
  if (to === from) return;
  const tabs = [...s.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  state = { ...s, tabs };
  persist();
  refreshSnapshot();
  emit();
}

/**
 * Close a tab. Returns where the caller should navigate: closing the ACTIVE
 * tab hands back its left neighbour's href (right when it was first, "/" when
 * it was the only one); closing a background tab navigates nowhere (null).
 */
export function closeWorkspaceTab(id: string): { navigateTo: string | null } {
  const s = ensureLoaded();
  const index = s.tabs.findIndex((t) => t.id === id);
  if (index === -1) return { navigateTo: null };
  const wasActive = s.activeId === id;
  const tabs = s.tabs.filter((t) => t.id !== id);
  const neighbour = wasActive ? tabs[index - 1] ?? tabs[index] ?? null : null;
  state = {
    ...s,
    tabs,
    activeId: wasActive ? neighbour?.id ?? null : s.activeId,
  };
  persist();
  refreshSnapshot();
  emit();
  if (!wasActive) return { navigateTo: null };
  return { navigateTo: neighbour ? neighbour.href : "/" };
}

/** Test seam — forget the in-memory state so the next read re-hydrates. */
export function resetWorkspaceTabsForTests(): void {
  state = null;
  openIntent = null;
  snapshot = { tabs: [], activeId: null };
}
