/* The offline sync engine (layout P14). Sales save locally first (step 5);
 * this module pushes what is pending to the ERP in the background, FIFO,
 * idempotent on the device uuid, and never blocks the sell screen.
 *
 * Triggers: the `online` event (verified by a ping, because a captive-portal
 * WiFi says online and answers HTML), every sale once online, Sync now, and
 * a timer. Then the heartbeat every N minutes while online. A sale the ERP
 * rejects keeps its reason on the record and stops blocking the rest. */
import { deviceApi, erpReachable } from "./api";
import { encryptBackup, tokenHash, writeBackupToFolder, type BackupFile } from "./backup";
import { idb, storageEstimate } from "./db";
import { loadDeviceState, platformName, refreshBundle, saveDeviceState } from "./deviceStore";
import { APP_VERSION } from "./pwa";
import type { SaleRecord } from "./sale";
import { currentCounter, listSales, pendingSummary, saveSale } from "./salesStore";
import type { DeviceState } from "./types";

export type SyncStatus = {
  phase: "idle" | "syncing";
  online: boolean | null;
  pending: number;
  pending_sen: number;
  last_sync_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  last_result: { accepted: number; duplicates: number; rejected: number } | null;
  catalog_version: number | null;
  catalog_update_available: boolean;
  backup_at: string | null;
  backup_folder: string | null;
};

type BatchResult = { uuid: string; status: "accepted" | "duplicate" | "updated" | "rejected"; reason?: string; stock_warning?: string | null };

let status: SyncStatus = { phase: "idle", online: null, pending: 0, pending_sen: 0, last_sync_at: null, last_attempt_at: null, last_error: null, last_result: null, catalog_version: null, catalog_update_available: false, backup_at: null, backup_folder: null };
const listeners = new Set<(s: SyncStatus) => void>();
let running: Promise<void> | null = null;
let timer: number | null = null;
let heartbeatTimer: number | null = null;
let backoffMs = 0;
let cashierName: string | null = null;
const stateListeners = new Set<(s: DeviceState) => void>();

export function onSyncStatus(fn: (s: SyncStatus) => void): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}
export function onDeviceStateChanged(fn: (s: DeviceState) => void): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}
function set(p: Partial<SyncStatus>) {
  status = { ...status, ...p };
  for (const fn of listeners) fn(status);
}
export const syncStatus = (): SyncStatus => status;
export const setSyncCashier = (name: string | null) => { cashierName = name; };

async function refreshCounts(): Promise<void> {
  const p = await pendingSummary();
  set({ pending: p.count, pending_sen: p.amount_sen });
}

const pendingSales = async (): Promise<SaleRecord[]> => (await listSales()).filter((s) => !s.is_test && !s.synced_at).sort((a, b) => (a.sold_at < b.sold_at ? -1 : a.sold_at > b.sold_at ? 1 : a.local_seq - b.local_seq));

/** Push everything pending, FIFO, in batches of 50; mark each acked record. */
export function syncNow(reason: string): Promise<void> {
  if (running) return running;
  running = (async () => {
    const state = await loadDeviceState();
    if (!state || state.demo) return;
    set({ phase: "syncing", last_attempt_at: new Date().toISOString() });
    try {
      if (!(await erpReachable())) { set({ online: false, last_error: "ERP not reachable" }); return; }
      set({ online: true });
      const queue = await pendingSales();
      let accepted = 0; let duplicates = 0; let rejected = 0; let lastError: string | null = null;
      for (let i = 0; i < queue.length; i += 50) {
        const batch = queue.slice(i, i + 50);
        const remaining = queue.length - i - batch.length;
        const res = await deviceApi.salesBatch(state.token, { sales: batch.map(({ synced_at: _s, sync_error: _e, ...rest }) => rest), remaining, receipt_counter: await currentCounter(state.bundle.terminal.receipt_counter) });
        const byUuid = new Map(res.results.map((r) => [r.uuid, r]));
        for (const s of batch) {
          const r = byUuid.get(s.uuid);
          if (!r) continue;
          if (r.status === "rejected") { rejected += 1; lastError = `${s.receipt_no}: ${r.reason ?? "rejected"}`; await saveSale({ ...s, sync_error: r.reason ?? "rejected" }); continue; }
          if (r.status === "accepted") accepted += 1; else duplicates += 1;
          await saveSale({ ...s, synced_at: res.at, sync_error: r.stock_warning ?? null });
        }
      }
      const next = { ...state, last_sync_at: new Date().toISOString() };
      await saveDeviceState(next);
      for (const fn of stateListeners) fn(next);
      set({ last_sync_at: next.last_sync_at, last_result: { accepted, duplicates, rejected }, last_error: lastError });
      backoffMs = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "sync failed";
      set({ last_error: `${reason}: ${msg}` });
      backoffMs = Math.min(5 * 60_000, backoffMs ? backoffMs * 2 : 15_000);
    } finally {
      await refreshCounts();
      set({ phase: "idle" });
      running = null;
      if (backoffMs > 0 && status.pending > 0) { if (timer) window.clearTimeout(timer); timer = window.setTimeout(() => void syncNow("retry"), backoffMs); }
    }
  })();
  return running;
}

/** The heartbeat (vitals only); a newer catalog version refreshes the bundle. */
export async function heartbeat(): Promise<void> {
  const state = await loadDeviceState();
  if (!state || state.demo) return;
  if (!(await erpReachable())) { set({ online: false }); return; }
  set({ online: true });
  try {
    const p = await pendingSummary();
    const storage = await storageEstimate();
    const total = await idb.count("sales");
    const r = await deviceApi.heartbeat(state.token, {
      device_name: state.device_name, platform: platformName(), app_version: APP_VERSION, cashier: cashierName, last_sale_at: p.last_sale_at,
      pending_count: p.count, pending_amount_sen: p.amount_sen, last_sync_at: state.last_sync_at, receipt_counter: await currentCounter(state.bundle.terminal.receipt_counter),
      storage, catalog_version: state.bundle.event.catalog_version, db_empty: total === 0,
    });
    const newer = r.catalog_version != null && r.catalog_version > state.bundle.event.catalog_version;
    set({ catalog_version: r.catalog_version, catalog_update_available: newer });
    if (newer) {
      const next = await refreshBundle(state);
      set({ catalog_update_available: false, catalog_version: next.bundle.event.catalog_version });
      for (const fn of stateListeners) fn(next);
    }
  } catch (e) {
    set({ last_error: e instanceof Error ? e.message : "heartbeat failed" });
  }
}

/** After every sale: the encrypted backup to the chosen folder (when one was
 *  picked), and a push if online. */
export async function afterSale(): Promise<void> {
  await refreshCounts();
  void writeBackup();
  void syncNow("after sale");
}

export async function buildBackup(): Promise<BackupFile | null> {
  const state = await loadDeviceState();
  if (!state || state.demo) return null;
  const sales = await listSales();
  return encryptBackup(sales, { terminal: state.bundle.terminal.code, project_id: state.bundle.event.project_id, receipt_counter: await currentCounter(state.bundle.terminal.receipt_counter) }, await tokenHash(state.token));
}

export async function writeBackup(): Promise<boolean> {
  try {
    const dir = await idb.get<{ name: string }>("meta", "backup_dir");
    if (!dir) return false;
    const file = await buildBackup();
    if (!file) return false;
    const ok = await writeBackupToFolder(dir as never, file);
    if (ok) set({ backup_at: file.exported_at, backup_folder: dir.name });
    return ok;
  } catch {
    return false;
  }
}

export async function setBackupFolder(handle: { name: string } | null): Promise<void> {
  if (handle) await idb.put("meta", "backup_dir", handle); else await idb.del("meta", "backup_dir");
  set({ backup_folder: handle?.name ?? null });
  if (handle) void writeBackup();
}

/** Wire the triggers once at boot. */
export function startSyncEngine(heartbeatMinutes: number): () => void {
  void refreshCounts();
  idb.get<{ name: string }>("meta", "backup_dir").then((d) => set({ backup_folder: d?.name ?? null })).catch(() => {});
  loadDeviceState().then((s) => { if (s) set({ last_sync_at: s.last_sync_at, catalog_version: s.bundle.event.catalog_version }); }).catch(() => {});
  const onOnline = () => { void syncNow("reconnect").then(heartbeat); };
  const onOffline = () => set({ online: false });
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  void syncNow("start").then(heartbeat);
  heartbeatTimer = window.setInterval(() => { void heartbeat(); if (status.pending > 0) void syncNow("timer"); }, Math.max(1, heartbeatMinutes) * 60_000);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    if (heartbeatTimer) window.clearInterval(heartbeatTimer);
    if (timer) window.clearTimeout(timer);
  };
}
