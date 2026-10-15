/* The device backup file, houzs_pos_T02_backup.json (layout P14 / E8):
 * every receipt on this terminal, encrypted with AES-GCM under a key both
 * sides can derive, the SHA-256 of the device token (the ERP stores that
 * hash, the device holds the token), so the file is useless to a bystander
 * and readable by Import backup in the ERP. The cipher itself lives in the
 * shared module both sides import. Written after every sale to a folder the
 * admin picked once (File System Access API, Chrome), else downloaded on
 * demand. */
import { decryptBackupPayload, encryptBackupPayload, posBackupFileName, sha256Hex, type PosBackupFile } from "@shared/pos-backup-crypto";
import type { SaleRecord } from "./sale";

export type BackupFile = PosBackupFile;

export const tokenHash = (token: string): Promise<string> => sha256Hex(token);

export async function encryptBackup(sales: readonly SaleRecord[], meta: { terminal: string; project_id: number; receipt_counter: number }, tokenHashHex: string): Promise<BackupFile> {
  const real = sales.filter((s) => !s.is_test);
  const { iv, data } = await encryptBackupPayload(JSON.stringify(real), tokenHashHex);
  return {
    format: "houzs-pos-backup/1", terminal: meta.terminal, project_id: meta.project_id, exported_at: new Date().toISOString(),
    count: real.length, total_sen: real.filter((s) => s.status === "PAID").reduce((t, s) => t + s.total_sen, 0), receipt_counter: meta.receipt_counter,
    iv, data,
  };
}

export async function decryptBackup(file: BackupFile, tokenHashHex: string): Promise<SaleRecord[]> {
  return JSON.parse(await decryptBackupPayload(file, tokenHashHex)) as SaleRecord[];
}

export const backupFileName = posBackupFileName;
/* ── where it goes ─────────────────────────────────────────────────────── */

type DirHandle = { name: string; queryPermission?(o: { mode: string }): Promise<string>; requestPermission?(o: { mode: string }): Promise<string>; getFileHandle(name: string, o: { create: boolean }): Promise<{ createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> }> };
type WinWithPicker = Window & { showDirectoryPicker?: (o?: unknown) => Promise<DirHandle> };
const win = (): WinWithPicker | null => (typeof window === "undefined" ? null : (window as WinWithPicker));

export const backupFolderSupported = (): boolean => typeof win()?.showDirectoryPicker === "function";

/** Ask once for the folder (the browser remembers the choice for an installed app). */
export async function pickBackupFolder(): Promise<DirHandle | null> {
  const w = win();
  if (!w?.showDirectoryPicker) return null;
  try {
    return await w.showDirectoryPicker({ mode: "readwrite", startIn: "downloads" });
  } catch {
    return null;
  }
}

export async function writeBackupToFolder(dir: DirHandle, file: BackupFile): Promise<boolean> {
  try {
    if (dir.queryPermission && (await dir.queryPermission({ mode: "readwrite" })) !== "granted") {
      if (!dir.requestPermission || (await dir.requestPermission({ mode: "readwrite" })) !== "granted") return false;
    }
    const fh = await dir.getFileHandle(backupFileName(file.terminal), { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(file));
    await w.close();
    return true;
  } catch {
    return false;
  }
}

export function downloadBackup(file: BackupFile): void {
  const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = backupFileName(file.terminal);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
