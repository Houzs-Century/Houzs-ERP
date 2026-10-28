// ---------------------------------------------------------------------------
// Mail Center — client-side state for compose DRAFTS only.
//
// Star / labels / trash / mark-unread are DB-backed:
//   • star        → email_threads.starred         (PATCH { starred })
//   • labels      → email_threads.labels (JSON)    (PATCH { labels })
//   • trash       → email_threads.trashed_at       (PATCH { trashed })
//   • mark unread → email_threads.unread           (PATCH { unread })
// so they sync across users/devices via the API (see mail-actions.ts).
//
// Compose DRAFTS remain LOCAL: there is no draft table this round, so saved
// drafts are kept in localStorage under the resolved user + company identity,
// with a tiny pub/sub so the inbox Drafts folder and compose dialog stay in
// sync within and across tabs. The old ownerless v1 key is quarantined: it is
// never auto-claimed by the next login and never silently deleted. Drafts still
// do not sync between devices and are lost if site data is cleared. Promoting
// them needs an email_drafts table + CRUD endpoints.
// ---------------------------------------------------------------------------

import {
  getBrowserStorageIdentity,
  subscribeBrowserStorageIdentity,
} from "../../lib/storageIdentity";

const LEGACY_KEY = "houzs-mail-local:v1";
const KEY_PREFIX = "houzs-mail-local:v2";
export const MAIL_DRAFT_MAX_COUNT = 100;
export const MAIL_DRAFT_MAX_BYTES = 1_000_000;

function currentKey(): string | null {
  const identity = getBrowserStorageIdentity();
  return identity
    ? `${KEY_PREFIX}:u${identity.userId}:c${identity.companyId}`
    : null;
}

export type MailDraft = {
  id: string;
  to: string;
  subject: string;
  body: string;
  fromAddress: string;
  updatedAt: number;
};

type MailLocalState = {
  // saved compose drafts (local only — no backend draft store)
  drafts: MailDraft[];
};

const EMPTY: MailLocalState = {
  drafts: [],
};

let state: MailLocalState = load();

/* WHY EVERY ELEMENT IS VALIDATED, NOT JUST THE ARRAY.
   `Array.isArray(parsed.drafts)` proves the CONTAINER is well-formed and says
   nothing about what is inside it. A single element missing `updatedAt` was
   enough to unmount the whole Mail Center, because the Drafts list fed that
   value straight into `new Date(x).toISOString()` — which throws RangeError on
   an invalid date rather than returning a falsy value the renderer could skip.
   HOOKKA lost two pages to this exact shape (BUG-2026-04-22-001 crash on a
   shared localStorage key written in two incompatible shapes, and
   BUG-2026-05-12-008 toISOString on an undefined field).

   Persisted JSON is UNTRUSTED INPUT: it outlives the code that wrote it, it is
   editable by hand, and it is replayed verbatim into a tab running a newer
   build. The sibling module mail-prefs.ts already validates field-by-field on
   load; this brings drafts to the same bar. A malformed draft is DROPPED rather
   than repaired — a draft we cannot read is not a draft we can let the user
   resume, and silently keeping the readable ones beats crashing on all of them. */
export function sanitizeDrafts(value: unknown): MailDraft[] {
  if (!Array.isArray(value)) return [];
  const out: MailDraft[] = [];
  for (const d of value) {
    if (!d || typeof d !== "object") continue;
    const r = d as Record<string, unknown>;
    // id is the only field with no sane fallback: it keys save/delete, so a
    // draft without one can never be resumed or discarded.
    if (typeof r.id !== "string" || !r.id) continue;
    // A draft that predates a field, or carries a wrong type, is still a
    // usable draft — the text fields degrade to empty rather than dropping it.
    const updatedAt = typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : 0;
    out.push({
      id: r.id,
      to: typeof r.to === "string" ? r.to : "",
      subject: typeof r.subject === "string" ? r.subject : "",
      body: typeof r.body === "string" ? r.body : "",
      fromAddress: typeof r.fromAddress === "string" ? r.fromAddress : "",
      updatedAt,
    });
  }
  return out;
}

function load(): MailLocalState {
  if (typeof window === "undefined") return { ...EMPTY };
  try {
    const key = currentKey();
    if (!key) return { ...EMPTY };
    const raw = window.localStorage.getItem(key);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<MailLocalState>;
    return {
      drafts: sanitizeDrafts(parsed.drafts),
    };
  } catch {
    return { ...EMPTY };
  }
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* a bad subscriber must not break the others */
    }
  }
}

// Cross-tab sync: another tab writing the key fires a storage event here.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== currentKey()) return;
    state = load();
    notify();
  });
}

subscribeBrowserStorageIdentity(() => {
  state = load();
  notify();
});

/** Legacy v1 has no owner/company metadata, so it stays quarantined. */
export function hasQuarantinedLegacyDrafts(): boolean {
  try {
    return window.localStorage.getItem(LEGACY_KEY) !== null;
  } catch {
    return false;
  }
}

function persist(next: MailLocalState): void {
  if (typeof window !== "undefined") {
    const key = currentKey();
    if (key) {
      // Persist before publishing the in-memory snapshot. A rejected write must
      // leave the composer open instead of claiming a reload-safe save.
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        throw new Error("Draft could not be saved in this browser. Free some site storage and try again.");
      }
    }
  }
  state = next;
  notify();
}

// ── Subscription (for useSyncExternalStore) ────────────────────────────────
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSnapshot(): MailLocalState {
  return state;
}

// ── Draft mutators ───────────────────────────────────────────────────────
export function saveDraft(draft: MailDraft): void {
  // Re-read before a read/modify/write so a draft saved by another tab since
  // our last storage event is not erased by this tab's stale in-memory array.
  if (!currentKey()) {
    throw new Error("Draft storage is not ready yet. Please wait a moment and try again.");
  }
  const base = load();
  const rest = base.drafts.filter((d) => d.id !== draft.id);
  const drafts = [draft, ...rest];
  if (drafts.length > MAIL_DRAFT_MAX_COUNT) {
    throw new Error(`This browser already has ${MAIL_DRAFT_MAX_COUNT} drafts. Delete one before saving another.`);
  }
  const next = { ...state, drafts };
  const bytes = new TextEncoder().encode(JSON.stringify(next)).byteLength;
  if (bytes > MAIL_DRAFT_MAX_BYTES) {
    throw new Error("This draft is too large for reliable browser storage. Shorten it and try again.");
  }
  persist(next);
}

export function deleteDraft(id: string): void {
  const base = currentKey() ? load() : state;
  const next = { ...state, drafts: base.drafts.filter((d) => d.id !== id) };
  persist(next);
}

/** A sent email must stay successful even when cleanup of its local draft
 * fails. Explicit user-driven Discard uses deleteDraft() and reports failure;
 * only post-send cleanup may use this best-effort variant. */
export function deleteDraftBestEffort(id: string): void {
  try {
    deleteDraft(id);
  } catch {
    // Keep the persisted snapshot intact. The draft can be discarded later
    // after browser storage is available again.
  }
}
