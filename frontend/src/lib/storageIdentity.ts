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
