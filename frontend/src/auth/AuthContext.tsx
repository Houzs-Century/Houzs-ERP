import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, tokenStore, passStore, onUnauthorized } from "../api/client";
import { clearAll as clearApiCache } from "../api/cache";
import { queryClient } from "../lib/queryClient";
import { clearQuerySnapshots } from "../lib/query-persist";
import { authTokenIsPersistent, subscribeAuthTokenChange } from "../lib/authToken";
import {
  bindBrowserStorageIdentity,
  clearBrowserStorageIdentity,
} from "../lib/storageIdentity";
import { clearAllScmHandoffs } from "../lib/scmHandoffStorage";
import { writeRememberedEmail } from "../lib/rememberedEmail";
import { hydrateTableLayouts } from "../lib/tableLayouts";
import { headStartFailed } from "../lib/lazyPage";
import { forgetNativeSession, rememberNativeSession } from "../lib/nativeSession";

function storeSessionPass(res: unknown, persistent?: boolean): void {
  const sp = (res as { session_pass?: string } | null)?.session_pass;
  if (sp) passStore.set(sp, persistent);
}
import { registerNativePush, unregisterNativePush } from "../lib/nativePush";
import type { AccessLevel, AuthUser } from "../types";

function resetMemoryCaches(): void {
  queryClient.clear();
  clearApiCache();
}

function resetSessionCaches(): void {
  clearAllScmHandoffs();
  clearBrowserStorageIdentity();
  resetMemoryCaches();
  clearQuerySnapshots();
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  hasUsers: boolean | null;
}

/** Login either completes, or stops at a 2FA challenge that needs a code. */
export type LoginResult = { kind: "ok" } | { kind: "totp"; challenge: string };

interface AuthContextValue extends AuthState {
  login: (email: string, password: string, remember?: boolean) => Promise<LoginResult>;
  pinLogin: (login: string, pin: string) => Promise<LoginResult>;
  verifyTotpLogin: (challenge: string, code: string, remember?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  bootstrap: (email: string, name: string, password: string) => Promise<void>;
  acceptInvite: (token: string, name: string, password: string) => Promise<void>;
  can: (perm: string) => boolean;
  canAny: (perms: readonly string[]) => boolean;
  canAll: (perms: readonly string[]) => boolean;
  pageAccess: (page: string) => AccessLevel;
  reload: () => Promise<void>;
  completePasswordChange: (current: string, next: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

let primedMe: { token: string; request: Promise<{ user: AuthUser }> } | null = null;

export function primeAuthMe(): void {
  const token = tokenStore.get();
  if (!token || primedMe) return;
  const request = api.get<{ user: AuthUser }>("/api/auth/me");
  request.catch(headStartFailed);
  primedMe = { token, request };
}

function takePrimedMe(): Promise<{ user: AuthUser }> | null {
  const primed = primedMe;
  primedMe = null;
  return primed && primed.token === tokenStore.get() ? primed.request : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    hasUsers: null,
  });

  const fetchMe = useCallback(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await ((attempt === 0 ? takePrimedMe() : null) ?? api.get<{ user: AuthUser }>("/api/auth/me"));
        bindBrowserStorageIdentity(res.user.id);
        setState((prev) => ({ ...prev, user: res.user, loading: false }));
        return;
      } catch (e) {
        if ((e as { status?: number })?.status === 401) {
          tokenStore.clear();
          resetSessionCaches();
          setState((prev) => ({ ...prev, user: null, loading: false }));
          return;
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        setState((prev) => ({ ...prev, loading: false }));
        return;
      }
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.get<{ has_users: boolean }>("/api/auth/status");
      setState((prev) => ({ ...prev, hasUsers: res.has_users }));
    } catch {
      setState((prev) => ({ ...prev, hasUsers: null }));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = tokenStore.get();
      if (!token) {
        await fetchStatus();
        if (cancelled) return;
        setState((prev) => ({ ...prev, loading: false }));
        return;
      }
      await Promise.all([fetchStatus(), fetchMe()]);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchMe, fetchStatus]);

  useEffect(() => {
    if (!state.user) return;
    void hydrateTableLayouts();
  }, [state.user?.id]);

  useEffect(() => {
    return onUnauthorized(() => {
      tokenStore.clear();
      resetSessionCaches();
      setState((prev) => ({ ...prev, user: null }));
    });
  }, []);

  // Another tab logging in/out (a `storage`-sourced token change) reboots this
  // tab into the new session. A company switch in another tab deliberately does
  // NOT — each window owns its company for its whole lifetime (multi-window,
  // owner ask 2026-07-23; see lib/activeCompany.ts).
  useEffect(() => {
    let reloading = false;
    return subscribeAuthTokenChange((_token, source) => {
      if (source !== "storage" || reloading) return;
      reloading = true;
      clearAllScmHandoffs();
      clearBrowserStorageIdentity();
      resetSessionCaches();
      setState((prev) => ({ ...prev, user: null, loading: true }));
      window.location.reload();
    });
  }, []);

  const login = useCallback(
    async (email: string, password: string, remember = true): Promise<LoginResult> => {
      const res = await api.post<{
        token?: string;
        totp_required?: boolean;
        challenge?: string;
        password_change_required?: boolean;
      }>(
        "/api/auth/login",
        // `remember` now reaches the SERVER too (owner 2026-09-02: "cant keep
        // permanently?"). Ticked mints a rolling session that renews on use, so
        // the device stays signed in; unticked keeps the fixed 7-day session.
        // It used to be a client-only choice between localStorage and
        // sessionStorage, which is why everyone was signed out weekly.
        { email, password, remember },
      );
      try {
        writeRememberedEmail(remember ? email : null);
      } catch { }
      if (res.totp_required && res.challenge) {
        return { kind: "totp", challenge: res.challenge };
      }
      resetSessionCaches();
      tokenStore.set(res.token!, remember);
      storeSessionPass(res, remember);
      if (!res.password_change_required) rememberNativeSession(res.token!);
      void registerNativePush();
      await fetchMe();
      await fetchStatus();
      return { kind: "ok" };
    },
    [fetchMe, fetchStatus]
  );

  const pinLogin = useCallback(
    async (login: string, pin: string): Promise<LoginResult> => {
      const res = await api.post<{ token?: string; totp_required?: boolean; challenge?: string }>(
        "/api/auth/pin-login",
        { login, pin },
      );
      if (res.totp_required && res.challenge) return { kind: "totp", challenge: res.challenge };
      resetSessionCaches();
      tokenStore.set(res.token!, true);
      storeSessionPass(res, true);
      void registerNativePush();
      await fetchMe();
      await fetchStatus();
      return { kind: "ok" };
    },
    [fetchMe, fetchStatus]
  );

  const verifyTotpLogin = useCallback(
    async (challenge: string, code: string, remember = true) => {
      const res = await api.post<{ token: string }>("/api/auth/totp/login", {
        challenge,
        code,
      });
      resetSessionCaches();
      tokenStore.set(res.token, remember);
      storeSessionPass(res, remember);
      rememberNativeSession(res.token);
      void registerNativePush();
      await fetchMe();
      await fetchStatus();
    },
    [fetchMe, fetchStatus]
  );

  const bootstrap = useCallback(
    async (email: string, name: string, password: string) => {
      const res = await api.post<{ token: string }>("/api/auth/bootstrap", {
        email,
        name,
        password,
      });
      tokenStore.set(res.token);
      storeSessionPass(res);
      await fetchMe();
      await fetchStatus();
    },
    [fetchMe, fetchStatus]
  );

  const acceptInvite = useCallback(
    async (token: string, name: string, password: string) => {
      const res = await api.post<{ token: string }>("/api/auth/accept-invite", {
        token,
        name,
        password,
      });
      resetSessionCaches();
      tokenStore.set(res.token);
      storeSessionPass(res);
      await fetchMe();
      await fetchStatus();
    },
    [fetchMe, fetchStatus]
  );

  const logout = useCallback(async () => {
    unregisterNativePush();
    try {
      await api.post("/api/auth/logout");
    } catch {
      // silent-write-ok: the local token is cleared either way. Reporting a
      // failed server-side session delete would only argue with a person who
      // has already left, and it must never keep them signed in.
    }
    tokenStore.clear();
    forgetNativeSession();
    resetSessionCaches();
    try {
      for (const store of [sessionStorage, localStorage]) {
        for (const k of Object.keys(store)) {
          if (k.startsWith("filters:")) store.removeItem(k);
        }
      }
    } catch {
    }
    window.location.reload();
  }, []);

  const permSet = useMemo(
    () => new Set(state.user?.permissions ?? []),
    [state.user?.permissions],
  );

  const can = useCallback(
    (perm: string) => permSet.has("*") || permSet.has(perm),
    [permSet],
  );

  const canAny = useCallback(
    (perms: readonly string[]) => {
      if (permSet.has("*")) return true;
      for (const p of perms) if (permSet.has(p)) return true;
      return false;
    },
    [permSet],
  );

  const canAll = useCallback(
    (perms: readonly string[]) => {
      if (permSet.has("*")) return true;
      for (const p of perms) if (!permSet.has(p)) return false;
      return true;
    },
    [permSet],
  );

  const pageAccess = useCallback(
    (page: string): AccessLevel => {
      if (permSet.has("*")) return "full";
      return (state.user?.page_access?.[page] ?? "none") as AccessLevel;
    },
    [permSet, state.user?.page_access],
  );

  const reload = useCallback(async () => {
    await fetchMe();
  }, [fetchMe]);

  const completePasswordChange = useCallback(
    async (current: string, next: string) => {
      const persistent = authTokenIsPersistent();
      const res = await api.post<{ ok: boolean; token?: string; session_pass?: string }>(
        "/api/auth/me/password",
        { current, next, remember: persistent },
      );
      if (res.token) {
        resetSessionCaches();
        tokenStore.set(res.token, persistent);
        storeSessionPass(res, persistent);
        rememberNativeSession(res.token);
      }
      await fetchMe();
    },
    [fetchMe],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      pinLogin,
      verifyTotpLogin,
      logout,
      bootstrap,
      acceptInvite,
      can,
      canAny,
      canAll,
      pageAccess,
      reload,
      completePasswordChange,
    }),
    [
      state,
      login,
      pinLogin,
      verifyTotpLogin,
      logout,
      bootstrap,
      acceptInvite,
      can,
      canAny,
      canAll,
      pageAccess,
      reload,
      completePasswordChange,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
