const KEY = "houzs:login:lastEmail:v1";
const LEGACY_KEYS = ["auth:lastEmail", "houzs_remember_email"] as const;

function normalize(value: string | null): string {
  return (value ?? "").trim();
}

export function readRememberedEmail(): string {
  try {
    const current = normalize(localStorage.getItem(KEY));
    if (current) return current;
    for (const legacyKey of LEGACY_KEYS) {
      const legacy = normalize(localStorage.getItem(legacyKey));
      if (!legacy) continue;
      localStorage.setItem(KEY, legacy);
      for (const key of LEGACY_KEYS) localStorage.removeItem(key);
      return legacy;
    }
  } catch {
    // Login still works when storage is unavailable.
  }
  return "";
}

export function writeRememberedEmail(email: string | null): void {
  try {
    const normalized = normalize(email);
    if (normalized) localStorage.setItem(KEY, normalized);
    else localStorage.removeItem(KEY);
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  } catch {
    // Remembering an email is best-effort and never blocks authentication.
  }
}
