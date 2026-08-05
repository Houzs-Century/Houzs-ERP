// ---------------------------------------------------------------------------
// Face ID / Touch ID unlock for a session kept in the iOS Keychain.
//
// WHY. Owner, 2026-08-03: "我要可以用到指纹解锁、面部解锁，然后他们的 ESS 是
// permanent 的". Today the bearer token lives in localStorage (`authToken.ts`),
// which means a lost or borrowed phone is a logged-in session — open the app and
// you are inside. The Keychain is hardware-backed and can require a biometric
// before it hands anything back.
//
// THE DESIGN, and why it is small. `readAuthToken()` is SYNCHRONOUS and called
// from everywhere; the Keychain API is asynchronous. Swapping the backing store
// would mean rewriting every call site in the auth path — the highest
// blast-radius change in this app. So the Keychain is NOT the live store. It is
// a vault:
//
//   boot  -> biometric -> read vault -> seed the EXISTING store -> React mounts
//   login -> write vault (fire-and-forget)
//   out   -> clear vault
//
// `readAuthToken()` does not change at all.
//
// THE SAFETY PROPERTY, which is the whole reason this is safe to ship untested
// on a device: **restore can only ADD a token, never remove or replace one.**
// Every failure path — no plugin, flag off, no enrolled biometric, user
// cancels, empty vault, plugin throws — returns quietly and leaves the app
// exactly as it is today. The worst case is the login screen, which is the
// current behaviour.
//
// FLAG-GATED, DEFAULT OFF. `localStorage['native:biometric-session'] === '1'`.
// A runtime flag rather than a build constant so it can be turned on for one
// device on a TestFlight build without shipping a new binary — and turned off
// again from the same place if it misbehaves.
//
// NO npm DEPENDENCY. The plugin (capacitor-native-biometric) lives in `native/`.
// A Capacitor plugin's JS wrapper is a thin shim over
// `window.Capacitor.Plugins.<Name>`, so calling that directly costs zero bytes
// in the web bundle — the size gate is at its ceiling on main. The types below
// mirror the plugin's own definitions, narrowed to what is used here.
// ---------------------------------------------------------------------------

/* authToken, NOT api/client's tokenStore: client.ts imports authToken, so going
   through the store would put a cycle on the boot path. Same two functions the
   store delegates to. */
import { readAuthToken, writeAuthToken } from "./authToken";

/** Keychain service name. Constant — changing it orphans every saved session. */
const KEYCHAIN_SERVER = "erp.houzscentury.com";

export const BIOMETRIC_FLAG_KEY = "native:biometric-session";

type Credentials = { username: string; password: string };

type BiometricPlugin = {
  isAvailable(): Promise<{ isAvailable: boolean; biometryType?: number }>;
  verifyIdentity(opts: { reason?: string; title?: string; subtitle?: string; description?: string }): Promise<void>;
  getCredentials(opts: { server: string }): Promise<Credentials>;
  setCredentials(opts: { username: string; password: string; server: string }): Promise<void>;
  deleteCredentials(opts: { server: string }): Promise<void>;
};

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  Plugins?: { NativeBiometric?: BiometricPlugin };
};

const cap = (): CapacitorGlobal | undefined =>
  (globalThis as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;

const plugin = (): BiometricPlugin | undefined => {
  try {
    if (cap()?.isNativePlatform?.() !== true) return undefined;
    return cap()?.Plugins?.NativeBiometric;
  } catch {
    return undefined;
  }
};

/** Opt-in, per device. Off unless explicitly turned on. */
export function biometricSessionEnabled(): boolean {
  try {
    return localStorage.getItem(BIOMETRIC_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function setBiometricSessionEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(BIOMETRIC_FLAG_KEY, "1");
    else localStorage.removeItem(BIOMETRIC_FLAG_KEY);
  } catch { /* private mode — the feature simply stays off */ }
}

/** Device capability alone — in the app, plugin present, a biometric enrolled —
 *  IGNORING the opt-in flag. The settings toggle needs this: it has to render
 *  while the flag is still off, or nobody could ever turn it on. */
export async function nativeBiometricSupported(): Promise<boolean> {
  const p = plugin();
  if (!p) return false;
  try {
    return (await p.isAvailable()).isAvailable === true;
  } catch {
    return false;
  }
}

/** Is the whole thing usable here: in the app, flag on, plugin present, and a
 *  biometric actually enrolled on the device. */
export async function biometricAvailable(): Promise<boolean> {
  const p = plugin();
  if (!p || !biometricSessionEnabled()) return false;
  try {
    return (await p.isAvailable()).isAvailable === true;
  } catch {
    return false;
  }
}

/**
 * Boot step. Awaited BEFORE React mounts, so the first authed request already
 * carries the restored token rather than firing unauthenticated and bouncing
 * the user to a login screen they did not need.
 *
 * Returns true only when a token was actually restored. NEVER throws, and never
 * touches an existing token.
 */
export async function restoreNativeSession(): Promise<boolean> {
  try {
    const p = plugin();
    if (!p || !biometricSessionEnabled()) return false;

    // A token already present wins: a fresh login, an SSO hand-off or a
    // view-as token must not be overwritten by a stale vault entry.
    if (readAuthToken()) return false;

    if ((await p.isAvailable()).isAvailable !== true) return false;

    await p.verifyIdentity({
      reason: "Unlock Houzs ERP",
      title: "Unlock Houzs ERP",
      subtitle: "",
      description: "Use Face ID or your fingerprint to continue where you left off.",
    });

    const creds = await p.getCredentials({ server: KEYCHAIN_SERVER });
    const token = creds?.password ?? "";
    if (!token) return false;

    // persistent: true — the point of the vault is a session that survives.
    writeAuthToken(token, true);
    return true;
  } catch {
    // Cancelled, not enrolled, nothing saved, plugin missing — all the same
    // outcome: the app boots exactly as it does today.
    return false;
  }
}

/**
 * Save the current session to the vault after a successful login.
 *
 * Fire-and-forget on purpose: a Keychain write that fails must not fail the
 * login. The cost of losing it is one password entry on the next launch.
 */
export function rememberNativeSession(token: string, username = "session"): void {
  const p = plugin();
  if (!p || !biometricSessionEnabled() || !token) return;
  void p.setCredentials({ username, password: token, server: KEYCHAIN_SERVER }).catch(() => {});
}

/**
 * Clear the vault on logout.
 *
 * NOT flag-gated, and deliberately: if the flag is turned off while a session is
 * already saved, logout must still erase it. A gate here would strand a live
 * token in the Keychain of a phone whose user believes they have signed out.
 */
export function forgetNativeSession(): void {
  const p = plugin();
  if (!p) return;
  void p.deleteCredentials({ server: KEYCHAIN_SERVER }).catch(() => {});
}
