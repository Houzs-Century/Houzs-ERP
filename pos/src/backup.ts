/* The device backup file, houzs_pos_T02_backup.json (layout P14 / E8):
 * every receipt on this terminal, encrypted with AES-GCM under a key both
 * sides can derive, the SHA-256 of the device token (the ERP stores that
 * hash, the device holds the token), so the file is useless to a bystander
 * and readable by Import backup in the ERP. Written after every sale to a
 * folder the admin picked once (File System Access API, Chrome), else
 * downloaded on demand. */
import type { SaleRecord } from "./sale";

const SALT = "houzs-pos-backup";

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function tokenHash(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

export async function backupKey(tokenHashHex: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(tokenHashHex), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: new TextEncoder().encode(SALT), iterations: 100_000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export type BackupFile = {
  format: "houzs-pos-backup/1";
  terminal: string;
  project_id: number;
  exported_at: string;
  count: number;
  total_sen: number;
  receipt_counter: number;
  iv: string;
  data: string;
};

export async function encryptBackup(sales: readonly SaleRecord[], meta: { terminal: string; project_id: number; receipt_counter: number }, tokenHashHex: string): Promise<BackupFile> {
  const key = await backupKey(tokenHashHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const real = sales.filter((s) => !s.is_test);
  const plain = new TextEncoder().encode(JSON.stringify(real));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return {
    format: "houzs-pos-backup/1", terminal: meta.terminal, project_id: meta.project_id, exported_at: new Date().toISOString(),
    count: real.length, total_sen: real.filter((s) => s.status === "PAID").reduce((t, s) => t + s.total_sen, 0), receipt_counter: meta.receipt_counter,
    iv: b64(iv), data: b64(cipher),
  };
}

export async function decryptBackup(file: BackupFile, tokenHashHex: string): Promise<SaleRecord[]> {
  const key = await backupKey(tokenHashHex);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(file.iv) }, key, unb64(file.data));
  return JSON.parse(new TextDecoder().decode(plain)) as SaleRecord[];
}

export const backupFileName = (terminal: string): string => `houzs_pos_${terminal}_backup.json`;

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
