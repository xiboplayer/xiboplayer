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
