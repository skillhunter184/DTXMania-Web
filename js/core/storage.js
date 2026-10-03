// 設定の永続化(localStorage)と、最後に読み込んだ ZIP・読み込んだスキンの画像の保管(IndexedDB)。

const LS_PREFIX = 'dojo.';

export function loadJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export function saveJSON(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch (e) {
    /* 容量超過など */
  }
}

const DB_NAME = 'dtxmania-dojo';
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 最後に読み込んだ ZIP を保存する(モバイルでリロードしても選び直さずに済むように)。 */
export async function saveLastZip(blob, name) {
  let db = null;
  try {
    db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ blob, name, savedAt: Date.now() }, 'lastZip');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted')); // 容量超過はコミット時に abort で来る
    });
    return true;
  } catch (e) {
    return false;
  } finally {
    if (db) db.close();
  }
}

/** @returns {Promise<{blob: Blob, name: string, savedAt: number}|null>} */
export async function loadLastZip() {
  let db = null;
  try {
    db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('lastZip');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  } catch (e) {
    return null;
  } finally {
    if (db) db.close();
  }
}

export async function clearLastZip() {
  let db = null;
  try {
    db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('lastZip');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  } catch (e) {
    /* ignore */
  } finally {
    if (db) db.close();
  }
}

/**
 * 読み込んだスキンの画像を保存する(設定の「読み込んだ画像」。リロードしても選び直さずに済むように)。
 * @param {{name: string, blob: Blob}[]} files
 */
export async function saveSkinFiles(files) {
  let db = null;
  try {
    db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ files, savedAt: Date.now() }, 'skinFiles');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
    return true;
  } catch (e) {
    return false;
  } finally {
    if (db) db.close();
  }
}

/** @returns {Promise<{name: string, blob: Blob}[]|null>} */
export async function loadSkinFiles() {
  let db = null;
  try {
    db = await openDb();
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('skinFiles');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
    return rec && Array.isArray(rec.files) ? rec.files : null;
  } catch (e) {
    return null;
  } finally {
    if (db) db.close();
  }
}
