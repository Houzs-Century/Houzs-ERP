/* The manager sign-in on the POS front: an ERP account that may manage POS
 * (owner / admin) signs in with email + password, gets into the POS as a
 * supervisor, and sets the device up from Settings (terminal + fair from
 * lists, one button). Before the device is set up the POS runs on a
 * provisional state: company block and settings from the ERP, no terminal,
 * no items, no token, nothing saved and nothing synced. The ERP token lives
 * in sessionStorage for the browser session only. */
import { adminApi } from "./api";
import type { BundleCashier, DeviceState, PosBundle } from "./types";

const KEY = "houzs-pos-manager";

export type ManagerContext = { user: { id: number; name: string }; company: PosBundle["company"]; settings: PosBundle["settings"] };
export type Manager = { token: string; user: { id: number; name: string } };

const store = (): Storage | null => (typeof sessionStorage === "undefined" ? null : sessionStorage);

export function currentManager(): Manager | null {
  try {
    const raw = store()?.getItem(KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as Manager;
    return m.token && m.user ? m : null;
  } catch {
    return null;
  }
}
export const forgetManager = (): void => { try { store()?.removeItem(KEY); } catch { /* storage blocked */ } };

/** Sign in; a staff account without pos.manage is refused by the context call. */
export async function managerLogin(email: string, password: string): Promise<{ manager: Manager; context: ManagerContext }> {
  const r = await adminApi.login(email.trim(), password);
  let context: ManagerContext;
  try {
    context = await adminApi.get<ManagerContext>(r.token, "/api/pos-admin/device/context");
  } catch (e) {
    void adminApi.logout(r.token);
    throw new Error(/403|forbid/i.test(e instanceof Error ? e.message : "") ? "This account may not manage POS. Ask the owner for the POS Admin permission." : e instanceof Error ? e.message : "Sign-in failed");
  }
  const manager = { token: r.token, user: context.user };
  try { store()?.setItem(KEY, JSON.stringify(manager)); } catch { /* storage blocked */ }
  return { manager, context };
}

export async function managerLogout(): Promise<void> {
  const m = currentManager();
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
