// Small IndexedDB key-value store for data too large for localStorage (terrain edits).
// Every call fails soft: if storage is unavailable the game simply runs without saving.

const DB_NAME = 'zt2web';
const STORE = 'kv';
let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function loadValue(key) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveValue(key, value) {
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

export async function deleteValue(key) {
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* storage unavailable */ }
}

// All values whose key starts with `prefix` (e.g. save slot details), as [key, value] pairs.
export async function listValues(prefix) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const out = [];
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).openCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(out); return; }
        out.push([c.key, c.value]);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}
