import { useSyncExternalStore } from "react";


export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "houzs.theme";

const listeners = new Set<() => void>();

function readStored(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
  }
  return "light";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

let current: ThemePreference = "light";

function apply(): void {
  const resolved = resolveTheme(current, systemPrefersDark());
  const root = document.documentElement;
  root.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", resolved);
  listeners.forEach((l) => l());
}

export function initTheme(): void {
  current = readStored();
  apply();
  if (typeof window.matchMedia === "function") {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (current === "system") apply();
    });
  }
  window.addEventListener("storage", (e) => {
    if (e.key !== THEME_STORAGE_KEY) return;
    current = readStored();
    apply();
  });
}

export function getThemePreference(): ThemePreference {
  return current;
}

export function setThemePreference(pref: ThemePreference): void {
  current = pref;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
  }
  apply();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useThemePreference(): [ThemePreference, (p: ThemePreference) => void] {
  const pref = useSyncExternalStore(subscribe, getThemePreference, () => "light" as ThemePreference);
  return [pref, setThemePreference];
}
