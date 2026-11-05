/* The manager sign-in on the POS front: an ERP account that may manage POS
 * (owner / admin) signs in with email + password, gets into the POS as a
 * supervisor, and sets the device up from Settings (terminal + fair from
 * lists, one button). Before the device is set up the POS runs on a
 * provisional state: company block and settings from the ERP, no terminal,
 * no items, no token, nothing saved and nothing synced.
 *
 * What the device remembers: the last email (always), and, with "Keep me
 * signed in on this device" ticked, the ERP session token in localStorage so
 * the front offers "Continue as <name>" with one tap. The password is never
 * stored; the ERP can end the session at any time. Without the tick the token
 * lives in sessionStorage for the browser session only. */
import { adminApi } from "./api";
import type { BundleCashier, DeviceState, PosBundle } from "./types";

const KEY = "houzs-pos-manager";
const EMAIL_KEY = "houzs-pos-manager-email";

export type ManagerContext = { user: { id: number; name: string }; company: PosBundle["company"]; settings: PosBundle["settings"] };
export type Manager = { token: string; user: { id: number; name: string } };

const session = (): Storage | null => (typeof sessionStorage === "undefined" ? null : sessionStorage);
const local = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);
const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

const parse = (raw: string | null | undefined): Manager | null => {
  if (!raw) return null;
  const m = safe(() => JSON.parse(raw) as Manager, null as Manager | null);
  return m && m.token && m.user ? m : null;
};

/** The remembered manager, if any: the session first, then the kept one. */
export const currentManager = (): Manager | null => parse(safe(() => session()?.getItem(KEY), null)) ?? parse(safe(() => local()?.getItem(KEY), null));

export const lastEmail = (): string => safe(() => local()?.getItem(EMAIL_KEY) ?? "", "");

export function forgetManager(): void {
  safe(() => session()?.removeItem(KEY), undefined);
  safe(() => local()?.removeItem(KEY), undefined);
}

function remember(m: Manager, keep: boolean, email: string): void {
  forgetManager();
  safe(() => (keep ? local() : session())?.setItem(KEY, JSON.stringify(m)), undefined);
  safe(() => local()?.setItem(EMAIL_KEY, email.trim()), undefined);
}

const contextFor = async (token: string): Promise<ManagerContext> => adminApi.get<ManagerContext>(token, "/api/pos-admin/device/context");

/** Sign in; a staff account without pos.manage is refused by the context call. */
export async function managerLogin(email: string, password: string, keep: boolean): Promise<{ manager: Manager; context: ManagerContext }> {
  const r = await adminApi.login(email.trim(), password);
  let context: ManagerContext;
  try {
    context = await contextFor(r.token);
  } catch (e) {
    void adminApi.logout(r.token);
    throw new Error(/403|forbid/i.test(e instanceof Error ? e.message : "") ? "This account may not manage POS. Ask the owner for the POS Admin permission." : e instanceof Error ? e.message : "Sign-in failed");
  }
  const manager = { token: r.token, user: context.user };
  remember(manager, keep, email);
  return { manager, context };
}

/** "Continue as <name>": the kept session, checked against the ERP first.
 *  Null when it has expired or was ended; the front then shows the form. */
export async function resumeManager(): Promise<{ manager: Manager; context: ManagerContext } | null> {
  const m = currentManager();
  if (!m) return null;
  try {
    const context = await contextFor(m.token);
    return { manager: { token: m.token, user: context.user }, context };
  } catch {
    forgetManager();
    return null;
  }
}

/** End the manager session. A session kept with "Keep me signed in" survives a
 *  Logout (the next shift taps Continue); `all` ends it everywhere. */
export async function managerLogout(all = false): Promise<void> {
  const kept = parse(safe(() => local()?.getItem(KEY), null));
  const m = currentManager();
  if (kept && !all) { safe(() => session()?.removeItem(KEY), undefined); return; }
  forgetManager();
  if (m) await adminApi.logout(m.token);
}

/** The supervisor tile an ERP account becomes inside the POS. */
export const managerCashier = (m: Manager): BundleCashier => ({ id: -Math.abs(m.user.id || 1), code: "ERP", name: m.user.name, role: "SUPERVISOR", pin_hash: "", max_discount_pct: 100 });

/** The in-memory state of a device that is signed in but not set up yet. */
export function provisionalState(ctx: ManagerContext): DeviceState {
  const now = new Date().toISOString();
  return {
    token: "",
    provisional: true,
    bundle: {
      terminal: { id: 0, code: "--", device_name: null, receipt_counter: 0 },
      event: { project_id: 0, code: null, name: "No fair set up yet", start_date: null, end_date: null, venue: null, receipt_header: null, sst_default: false, catalog_version: 0, stock_source_warehouse_id: null },
      company: ctx.company,
      items: [],
      cashiers: [],
      settings: ctx.settings,
      prepared_at: now,
    },
    prepared_at: now,
    last_sync_at: null,
    last_login: null,
    test_mode: false,
    device_name: "",
  };
}
