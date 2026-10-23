/* The device's own record in IndexedDB: token, bundle, prepared time, last
 * sync, last login, test mode. One key, read at boot, written on every
 * change. Also the per-boot heartbeat. */
import { deviceApi, erpReachable } from "./api";
import { idb, storageEstimate } from "./db";
import { APP_VERSION } from "./pwa";
import type { DeviceState, PosBundle } from "./types";

const KEY = "state";

export const loadDeviceState = () => idb.get<DeviceState>("device", KEY).then((s) => s ?? null);
export const saveDeviceState = (s: DeviceState) => idb.put("device", KEY, s);
export const clearDeviceState = () => idb.del("device", KEY);

export function stateFromBundle(token: string, bundle: PosBundle, prev: DeviceState | null, deviceName: string): DeviceState {
  return {
    token,
    bundle,
    prepared_at: bundle.prepared_at,
    last_sync_at: bundle.prepared_at,
    last_login: prev?.last_login ?? null,
    test_mode: prev?.demo ? false : prev?.test_mode ?? false,
    device_name: deviceName,
  };
}

/** Refresh catalog: the same bundle again with the device token; the token
 *  and the device's own fields survive. */
export async function refreshBundle(state: DeviceState): Promise<DeviceState> {
  const res = await deviceApi.prepare<PosBundle>(state.token);
  const next = { ...state, bundle: res.bundle, last_sync_at: res.bundle.prepared_at };
  await saveDeviceState(next);
  return next;
}

export async function sendHeartbeat(state: DeviceState, cashier: string | null): Promise<{ catalog_version: number | null } | null> {
  if (!(await erpReachable())) return null;
  try {
    const storage = await storageEstimate();
    const r = await deviceApi.heartbeat(state.token, {
      device_name: state.device_name,
      platform: platformName(),
      app_version: APP_VERSION,
      cashier,
      last_sale_at: null,
      pending_count: 0,
      pending_amount_sen: 0,
      last_sync_at: state.last_sync_at,
      receipt_counter: state.bundle.terminal.receipt_counter,
      storage,
      catalog_version: state.bundle.event.catalog_version,
    });
    return { catalog_version: r.catalog_version };
  } catch {
    return null;
  }
}

export function platformName(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Android tablet";
  if (/iPad|iPhone/i.test(ua)) return "iPad";
  if (/Windows/i.test(ua)) return "Windows laptop";
  if (/Mac/i.test(ua)) return "Mac";
  return "Other";
}
