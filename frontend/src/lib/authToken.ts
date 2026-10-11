// Where the bearer token lives — the single answer, for both the Houzs-native
// fetch layer (src/api/client.ts) and the vendored SCM one (src/vendor/scm/...).
//
// There are TWO backing stores, because login offers a choice:
//   • "Remember me" checked  → localStorage   (survives browser close)
//   • unchecked              → sessionStorage (dies with the tab)
//   • the owner's view-as hand-off (src/main.tsx) → sessionStorage, always
// A reader that knows about only one of them is not reading "the token", it is
// reading "the token IF the user happened to tick a box". Every reader must go
// through readAuthToken so that choice stays invisible to callers.
//
// This module exists because the vendored layer read localStorage directly and
// five call sites went silently unauthenticated for session-only logins, taking
// the whole /scm/* surface down with a raw `not_authenticated`. Do not inline
// `localStorage.getItem('auth:token')` anywhere — call this instead.

export const AUTH_TOKEN_KEY = "auth:token";
const LOCAL_TOKEN_SUPPRESSED_KEY = "auth:local-token-suppressed";

export type AuthTokenChangeSource = "same-tab" | "storage";
type AuthTokenListener = (token: string, source: AuthTokenChangeSource) => void;
const authTokenListeners = new Set<AuthTokenListener>();

/** The current bearer token, from whichever store login put it in. "" = none. */
export function readAuthToken(): string {
  try {
    const tabToken = sessionStorage.getItem(AUTH_TOKEN_KEY);
    if (tabToken) return tabToken;
    if (sessionStorage.getItem(LOCAL_TOKEN_SUPPRESSED_KEY) === "1") return "";
    return localStorage.getItem(AUTH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/** Subscribe to explicit token lifecycle changes made through tokenStore. */
export function subscribeAuthTokenChange(listener: AuthTokenListener): () => void {
  authTokenListeners.add(listener);
  return () => authTokenListeners.delete(listener);
}

let lastEffectiveToken = readAuthToken();

function emitAuthTokenChange(source: AuthTokenChangeSource): void {
  const token = readAuthToken();
  if (token === lastEffectiveToken) return;
  lastEffectiveToken = token;
  for (const listener of authTokenListeners) listener(token, source);
}

// localStorage is shared by every tab, but a `storage` event is delivered only
// to the OTHER documents. Re-emit it into this module's lifecycle so a login,
// logout or impersonation in tab A immediately invalidates tab B's user-scoped
// caches. sessionStorage is tab-local and deliberately has no cross-tab event.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === AUTH_TOKEN_KEY || event.key === null) emitAuthTokenChange("storage");
  });
}

/** Store a token in exactly one backing store, then notify session-scoped caches. */
export function writeAuthToken(token: string, persistent = true): void {
  try {
    if (persistent) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      sessionStorage.removeItem(LOCAL_TOKEN_SUPPRESSED_KEY);
    } else {
      sessionStorage.setItem(AUTH_TOKEN_KEY, token);
      // A tab-only login must not log every remembered-login tab out. The
      // session token has precedence in this tab; the shared token stays put.
      sessionStorage.setItem(LOCAL_TOKEN_SUPPRESSED_KEY, "1");
    }
  } catch {}
  emitAuthTokenChange("same-tab");
}

/** Clear this tab's effective session, then notify session-scoped caches. */
export function clearAuthToken(): void {
  try {
    if (sessionStorage.getItem(AUTH_TOKEN_KEY)) {
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      // Do not fall through into another account's remembered token after a
      // session-only logout/expiry in this tab.
      sessionStorage.setItem(LOCAL_TOKEN_SUPPRESSED_KEY, "1");
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      sessionStorage.removeItem(LOCAL_TOKEN_SUPPRESSED_KEY);
    }
  } catch {}
  emitAuthTokenChange("same-tab");
}

/** Stable non-secret bucket for browser storage isolation. */
export function authSessionFingerprint(): string {
  const token = readAuthToken();
  if (!token) return "";
  let hash = 5381;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) + hash + token.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
