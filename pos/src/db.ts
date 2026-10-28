/* IndexedDB, promisified, with the stores the POS keeps. Everything the booth
 * owns lives here (never only in memory, never in localStorage): the device
 * state and bundle, and later the sales queue, held bills and the receipt
 * counter. Persistent storage is requested once so the browser does not evict
 * it under pressure. */
const DB_NAME = "houzs-pos";
const DB_VERSION = 1;

export const STORES = ["device", "sales", "holds", "meta"] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB blocked by another tab"));
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
      }),
  );
}

export const idb = {
  get: <T>(store: StoreName, key: IDBValidKey) => tx<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>),
  put: (store: StoreName, key: IDBValidKey, value: unknown) => tx(store, "readwrite", (s) => s.put(value, key)),
  del: (store: StoreName, key: IDBValidKey) => tx(store, "readwrite", (s) => s.delete(key)),
  all: <T>(store: StoreName) => tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>),
  keys: (store: StoreName) => tx<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys()),
  count: (store: StoreName) => tx<number>(store, "readonly", (s) => s.count()),
  clear: (store: StoreName) => tx(store, "readwrite", (s) => s.clear()),
};

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean }> {
  try {
    const est = (await navigator.storage?.estimate?.()) ?? {};
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted };
  } catch {
    return { usage: 0, quota: 0, persisted: false };
  }
}
