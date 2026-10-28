import { useSyncExternalStore } from "react";
import {
  identityStorageKey,
  subscribeBrowserStorageIdentity,
} from "./storageIdentity";

const PREFERENCE_KEY = "notifications:browserPush";

type Listener = () => void;
const listeners = new Set<Listener>();
const memoryFallback = new Map<string, boolean>();

function emit(): void {
  for (const listener of listeners) listener();
}

function currentKey(): string | null {
  return identityStorageKey(PREFERENCE_KEY);
}

function parsedPreference(value: string | null): boolean | null {
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}

/** Ownerless notification values cannot be safely attributed on a shared ERP
 * device. Quarantine by deleting them; every identity starts explicitly off. */
function discardLegacyDesktopPreference(): void {
  try {
    window.localStorage.removeItem(PREFERENCE_KEY);
  } catch {
    // Disabled storage is harmless; the ownerless value is never read.
  }
}

export function getBrowserNotificationPreference(): boolean {
  if (typeof window === "undefined") return false;
  const key = currentKey();
  if (!key) return false;

  try {
    const stored = parsedPreference(window.localStorage.getItem(key));
    if (stored !== null) return stored;
  } catch {
    // Fall through to the session-only copy.
  }

  discardLegacyDesktopPreference();
  return memoryFallback.get(key) ?? false;
}

export function setBrowserNotificationPreference(enabled: boolean): void {
  if (typeof window === "undefined") return;
  const key = currentKey();
  if (!key) return;

  memoryFallback.set(key, enabled);
  try {
    window.localStorage.setItem(key, enabled ? "1" : "0");
    window.localStorage.removeItem(PREFERENCE_KEY);
  } catch {
    // The live tab still follows memoryFallback.
  }
  emit();
}

export type BrowserNotificationPermission = NotificationPermission | "unsupported";

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  return typeof window !== "undefined" && "Notification" in window
    ? window.Notification.permission
    : "unsupported";
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (getBrowserNotificationPermission() === "unsupported") return "unsupported";
  const result = await window.Notification.requestPermission();
  // Permission denial does not write the preference, so explicitly notify
  // both desktop/mobile consumers instead of leaving their UI at "default".
  emit();
  return result;
}

export function isBrowserPushEnabled(): boolean {
  return (
    getBrowserNotificationPermission() === "granted" &&
    getBrowserNotificationPreference()
  );
}

export function subscribeBrowserNotificationPreference(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBrowserNotificationPreference(): boolean {
  return useSyncExternalStore(
    subscribeBrowserNotificationPreference,
    getBrowserNotificationPreference,
    () => false,
  );
}

export function useBrowserNotificationPermission(): BrowserNotificationPermission {
  return useSyncExternalStore(
    subscribeBrowserNotificationPreference,
    getBrowserNotificationPermission,
    () => "unsupported",
  );
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    const key = currentKey();
    if (event.key === null) {
      if (key) memoryFallback.delete(key);
      emit();
      return;
    }
    if (event.key === key) emit();
  });
  window.addEventListener("focus", emit);
  document.addEventListener("visibilitychange", emit);
}

subscribeBrowserStorageIdentity(() => {
  const key = currentKey();
  if (typeof window !== "undefined" && key) discardLegacyDesktopPreference();
  emit();
});
