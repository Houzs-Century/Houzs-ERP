
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
  drafts: MailDraft[];
};

const EMPTY: MailLocalState = {
  drafts: [],
};

let state: MailLocalState = load();

export function sanitizeDrafts(value: unknown): MailDraft[] {
  if (!Array.isArray(value)) return [];
  const out: MailDraft[] = [];
  for (const d of value) {
    if (!d || typeof d !== "object") continue;
    const r = d as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) continue;
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
    }
  }
}

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

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSnapshot(): MailLocalState {
  return state;
}

export function saveDraft(draft: MailDraft): void {
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
  }
}
