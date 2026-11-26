import type { SavedClipMeta, SavedClipRecord } from '../types/audio';

const DB_NAME = 'TapeLoopStorageDB';
const DB_VERSION = 1;
const STORE_NAME = 'clips';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open device storage'));
  });
}

export async function saveClipToDB(record: SavedClipRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('Failed to save clip'));
    };
  });
}

export async function getAllClipMetasFromDB(): Promise<SavedClipMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const records = (req.result as SavedClipRecord[]) || [];
      const metas: SavedClipMeta[] = records
        .map(({ audioBlob: _blob, ...meta }) => meta)
        .sort((a, b) => b.createdAt - a.createdAt);
      db.close();
      resolve(metas);
    };
    req.onerror = () => {
      db.close();
      reject(req.error ?? new Error('Failed to read clips'));
    };
  });
}

export async function getClipBlobFromDB(id: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => {
      const record = req.result as SavedClipRecord | undefined;
      db.close();
      resolve(record?.audioBlob ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error ?? new Error('Failed to load clip audio'));
    };
  });
}

export async function updateClipMetaInDB(
  id: string,
  updates: Partial<Pick<SavedClipMeta, 'title' | 'notes' | 'isCheckpoint'>>
): Promise<SavedClipMeta | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as SavedClipRecord | undefined;
      if (!existing) {
        db.close();
        resolve(null);
        return;
      }
      const updated: SavedClipRecord = { ...existing, ...updates };
      store.put(updated);
      tx.oncomplete = () => {
        const { audioBlob: _blob, ...meta } = updated;
        db.close();
        resolve(meta);
      };
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('Failed to update clip'));
    };
  });
}

export async function deleteClipFromDB(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('Failed to delete clip'));
    };
  });
}

export async function getDeviceStorageUsage(): Promise<{ usedBytes: number; quotaBytes: number | null }> {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      return {
        usedBytes: estimate.usage ?? 0,
        quotaBytes: estimate.quota ?? null,
      };
    }
  } catch {
    // Fallback below
  }
  return { usedBytes: 0, quotaBytes: null };
}
