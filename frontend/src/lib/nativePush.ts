// ---------------------------------------------------------------------------
// APNs registration for the native iOS app.
//
// The counterpart of backend routes/push.ts: after a signed-in user grants
// notification permission, the device token goes to POST /api/push/devices and
// the daily fleet-reminder job (backend services/pushFleetReminders.ts) takes
// it from there. What a push may contain is decided server-side — this file
// only moves the token.
//
// SAME ZERO-DEPENDENCY PATTERN as nativeSession.ts / native-location.ts: the
// plugin (@capacitor/push-notifications) lives in `native/`, and its JS wrapper
// is a thin shim over `window.Capacitor.Plugins.PushNotifications` — calling
// that directly costs zero bytes in the web bundle, which sits at its size
// ceiling. Types below mirror the plugin's definitions, narrowed to what is
// used here.
//
// EVERY failure path returns quietly: no plugin, permission denied, network
// down — the app keeps working exactly as it does today; only the lock-screen
// banner is lost. The token is remembered in localStorage so logout can delete
// the SERVER row even though the OS token itself stays valid on the phone.
// ---------------------------------------------------------------------------

import { api } from "../api/client";

const PUSH_TOKEN_KEY = "native:push-token";

type PermissionState = { receive: "prompt" | "prompt-with-rationale" | "granted" | "denied" };

type PushPlugin = {
  checkPermissions(): Promise<PermissionState>;
  requestPermissions(): Promise<PermissionState>;
  register(): Promise<void>;
  addListener(
    event: "registration",
    cb: (token: { value: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: "registrationError",
    cb: (err: { error: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
};

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  Plugins?: { PushNotifications?: PushPlugin };
};

const cap = (): CapacitorGlobal | undefined =>
  (globalThis as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;

const plugin = (): PushPlugin | undefined => {
  try {
    if (cap()?.isNativePlatform?.() !== true) return undefined;
    return cap()?.Plugins?.PushNotifications;
  } catch {
    return undefined;
  }
};

// The registration listener outlives any one call (iOS can re-issue tokens);
// attach it once per page lifetime.
let listenersAttached = false;

function rememberToken(token: string): void {
  try {
    localStorage.setItem(PUSH_TOKEN_KEY, token);
  } catch { /* private mode — logout cleanup just has nothing to do */ }
}

function recallToken(): string {
  try {
    return localStorage.getItem(PUSH_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Ask for permission (first time only) and register this device for the
 * signed-in user. Call AFTER auth is established — the token POST rides the
 * normal authed api client. Safe to call repeatedly; never throws.
 */
export async function registerNativePush(): Promise<void> {
  const p = plugin();
  if (!p) return;
  try {
    if (!listenersAttached) {
      listenersAttached = true;
      await p.addListener("registration", (token) => {
        const value = token?.value ?? "";
        if (!value) return;
        rememberToken(value);
        void api.post("/api/push/devices", { token: value }).catch(() => {});
      });
      await p.addListener("registrationError", (err) => {
        console.warn("[push] registration error", err?.error);
      });
    }
    let { receive } = await p.checkPermissions();
    if (receive === "prompt" || receive === "prompt-with-rationale") {
      receive = (await p.requestPermissions()).receive;
    }
    if (receive !== "granted") return;
    await p.register();
  } catch {
    // Push is an enhancement; a failure must never disturb sign-in.
  }
}

/**
 * Remove this device's SERVER registration on logout, so a signed-out phone
 * stops receiving work notifications. The api call must happen while the
 * session token is still valid — call BEFORE the token is cleared.
 */
export function unregisterNativePush(): void {
  if (!plugin()) return;
  const token = recallToken();
  if (!token) return;
  try {
    localStorage.removeItem(PUSH_TOKEN_KEY);
  } catch { /* still attempt the server delete */ }
  void api.del(`/api/push/devices/${token}`).catch(() => {});
}
