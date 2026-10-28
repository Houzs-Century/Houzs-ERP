import { adoptActiveCompanyForUser, releaseActiveCompanyBinding } from "./activeCompany";

export type BrowserStorageIdentity = {
  userId: number;
  companyId: number;
};

type Listener = () => void;
const listeners = new Set<Listener>();
let identity: BrowserStorageIdentity | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

// Adopting the company BEFORE reading it is load-bearing: /auth/me is the first
// moment we know who this tab is, and the durable per-user company record can
// only be claimed once that id exists. Reading first would stamp companyId 0 on
// every identity-scoped key for the rest of the session — which is how a user's
// own payment-retry drafts and preferences become unreadable after a re-login.
export function bindBrowserStorageIdentity(userId: number): void {
  const next = { userId, companyId: adoptActiveCompanyForUser(userId) ?? 0 };
  if (identity?.userId === next.userId && identity.companyId === next.companyId) return;
  identity = next;
  emit();
}

export function clearBrowserStorageIdentity(): void {
  releaseActiveCompanyBinding();
  if (!identity) return;
  identity = null;
  emit();
}

export function getBrowserStorageIdentity(): BrowserStorageIdentity | null {
  return identity;
}

export function identityStorageKey(base: string): string | null {
  return identity ? `${base}:u${identity.userId}:c${identity.companyId}` : null;
}

export function subscribeBrowserStorageIdentity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
