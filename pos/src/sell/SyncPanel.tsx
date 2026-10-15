/* The sync panel (layout P14), opened by tapping Last sync anywhere:
 * connection, pending count / RM, last successful sync, last attempt, last
 * error, catalog version, backup file time; Export backup · Refresh catalog
 * · Sync now. And the "leaving with unsynced sales" dialog. */
import { useEffect, useState } from "react";
import { backupFolderSupported, downloadBackup, pickBackupFolder } from "../backup";
import { refreshBundle } from "../deviceStore";
import { fmtMyt } from "../loginRules";
import { buildBackup, heartbeat, onSyncStatus, setBackupFolder, syncNow, type SyncStatus } from "../sync";
import type { DeviceState } from "../types";
import { Modal } from "./Modal";

const rm = (sen: number) => (sen / 100).toFixed(2);

export function useSyncStatus(): SyncStatus {
  const [s, setS] = useState<SyncStatus>(() => ({ phase: "idle", online: null, pending: 0, pending_sen: 0, last_sync_at: null, last_attempt_at: null, last_error: null, last_result: null, catalog_version: null, catalog_update_available: false, backup_at: null, backup_folder: null }));
  useEffect(() => onSyncStatus(setS), []);
  return s;
}

/** The top-bar / status-bar words. */
export function syncIndicator(s: SyncStatus): string {
  if (s.phase === "syncing") return "Syncing…";
  if (s.online === false) return `Offline · ${s.pending} pending`;
  if (s.pending > 0) return `Online · ${s.pending} pending`;
  return "Online · synced";
}

export function SyncPanel({ state, onStateChanged, onClose, say }: { state: DeviceState; onStateChanged: (s: DeviceState) => void; onClose: () => void; say: (t: string, bad?: boolean) => void }) {
  const s = useSyncStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const row = (k: string, v: string, bad = false) => <div className="status-line"><span className="muted" style={{ width: 170 }}>{k}</span><span className={bad ? "err" : ""}>{v}</span></div>;
  return (
    <Modal title="Sync" onClose={onClose} width={520}>
      {row("Connection", s.phase === "syncing" ? "Syncing…" : s.online == null ? "checking…" : s.online ? "ERP reachable" : "Offline")}
      {row("Pending", `${s.pending} sale(s) · RM ${rm(s.pending_sen)}`, s.pending > 0)}
      {row("Last successful sync", s.last_sync_at ? fmtMyt(s.last_sync_at) : "never")}
      {row("Last attempt", s.last_attempt_at ? fmtMyt(s.last_attempt_at) : "--")}
      {row("Last error", s.last_error ?? "none", !!s.last_error)}
      {s.last_result && row("Last result", `${s.last_result.accepted} accepted · ${s.last_result.duplicates} already there · ${s.last_result.rejected} rejected`)}
      {row("Catalog version", `v${state.bundle.event.catalog_version}${s.catalog_update_available ? " (newer available)" : ""}`)}
      {row("Backup file", s.backup_at ? `${fmtMyt(s.backup_at)} in ${s.backup_folder ?? "folder"}` : s.backup_folder ? `folder ${s.backup_folder}, not written yet` : "no folder chosen")}
      <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
        <button type="button" className="btn primary" disabled={busy !== null || s.phase === "syncing"} onClick={() => { setBusy("sync"); syncNow("manual").then(heartbeat).then(() => say("Sync finished")).finally(() => setBusy(null)); }}>Sync now</button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => { setBusy("catalog"); refreshBundle(state).then((n) => { onStateChanged(n); say(`Catalog v${n.bundle.event.catalog_version}: ${n.bundle.items.length} items`); }).catch((e) => say(e instanceof Error ? e.message : "Refresh failed", true)).finally(() => setBusy(null)); }}>Refresh catalog</button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => { setBusy("export"); buildBackup().then((f) => { if (f) { downloadBackup(f); say(`Backup exported: ${f.count} receipt(s)`); } }).finally(() => setBusy(null)); }}>Export backup</button>
        {backupFolderSupported() && <button type="button" className="btn" disabled={busy !== null} onClick={() => { pickBackupFolder().then((h) => { if (h) { void setBackupFolder(h); say(`Backups go to ${h.name} after every sale`); } }); }}>{s.backup_folder ? "Change backup folder" : "Choose backup folder"}</button>}
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>Sales stay on this device until the ERP confirms them; a confirmed sale is never sent twice. The backup file is encrypted and restored in the ERP under POS Admin › Import backup.</p>
    </Modal>
  );
}

export function LeaveDialog({ pending, onCancel, onSyncNow, onLeave }: { pending: number; onCancel: () => void; onSyncNow: () => void; onLeave: () => void }) {
  return (
    <Modal title="Unsynced sales on this device" onClose={onCancel} width={420}>
      <p style={{ marginTop: 0 }}>{pending} sale(s) have not reached the ERP yet. They stay saved on this device either way.</p>
      <div className="row">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <span className="grow" />
        <button type="button" className="btn primary" onClick={onSyncNow}>Sync now</button>
        <button type="button" className="btn" onClick={onLeave}>Logout anyway</button>
      </div>
    </Modal>
  );
}
