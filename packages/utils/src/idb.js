// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Shared IndexedDB open helper — avoids duplicating the open/upgrade
 * boilerplate across stats, core, and config packages.
 *
 * @param {string} dbName - Database name
 * @param {number} version - Schema version
 * @param {string} storeName - Object store to create on upgrade
 * @param {Object} [options]
 * @param {string} [options.keyPath] - Key path for the store (auto-increment if set)
 * @param {string} [options.indexName] - Index to create on the store
 * @param {string} [options.indexKey] - Key for the index
 * @returns {Promise<IDBDatabase>}
 */
export function openIDB(dbName, version, storeName, options = {}) {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB not available'));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) {
        const storeOpts = options.keyPath
          ? { keyPath: options.keyPath, autoIncrement: true }
          : undefined;
        const store = db.createObjectStore(storeName, storeOpts);
        if (options.indexName && options.indexKey) {
          store.createIndex(options.indexName, options.indexKey, { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Query records from an IndexedDB index with a cursor, up to a limit.
 * @param {IDBDatabase} db - IndexedDB database instance
 * @param {string} storeName - Object store name
 * @param {string} indexName - Index name
 * @param {any} value - Key to query (passed to openCursor)
 * @param {number} limit - Maximum records to return
 * @returns {Promise<Array>}
 */
export function queryByIndex(db, storeName, indexName, value, limit) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    const index = tx.objectStore(storeName).index(indexName);
    const request = index.openCursor(value);
    const results = [];

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => reject(new Error(`Index query failed: ${request.error}`));
  });
}

/**
 * Delete records by ID from an IndexedDB object store.
 * @param {IDBDatabase} db - IndexedDB database instance
 * @param {string} storeName - Object store name
 * @param {Array} ids - Array of record IDs to delete
 * @returns {Promise<number>} Number of deleted records
 */
export function deleteByIds(db, storeName, ids) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], 'readwrite');
    const store = tx.objectStore(storeName);
    let deleted = 0;

    for (const id of ids) {
      if (id) {
        const req = store.delete(id);
        req.onsuccess = () => { deleted++; };
        req.onerror = () => { /* individual delete failed — tx.onerror handles fatal */ };
      }
    }

    tx.oncomplete = () => resolve(deleted);
    tx.onerror = () => reject(new Error(`Delete failed: ${tx.error}`));
  });
}
