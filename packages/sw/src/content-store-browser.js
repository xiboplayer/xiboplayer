// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * ContentStoreBrowser — CacheStorage/IndexedDB backend for the PWA Service Worker.
 *
 * Same API as ContentStore (filesystem), but uses browser-native storage:
 *   - CacheStorage: file blobs (keyed by path)
 *   - IndexedDB: metadata + chunk state
 *
 * Used when the PWA runs directly on the CMS without a Node.js proxy.
 * The Service Worker imports this instead of the filesystem ContentStore.
 *
 * ─────────────────────────────────────────────────────────────────
 *  Practical size limit: ~50 MB per media file (this revision)
 * ─────────────────────────────────────────────────────────────────
 *
 * The current impl has two in-memory chokepoints that break for
 * large files:
 *
 *   1. `assembleChunks(key)` concatenates all chunks into a single
 *      `new Blob([...])` — peak RAM ≈ 2 × file size during assembly.
 *   2. `getResponse(key, range)` reads the whole cached blob into
 *      memory to `.slice()` for range serving. Video playback issues
 *      many range requests; each one reloads the full blob.
 *
 * Combined with per-origin CacheStorage quotas that cap individual
 * `Response` bodies (~1 GB on Safari, ~2 GB on Chrome desktop, much
 * less on mobile/WebView), this limits practical media to ~50 MB.
 *
 * Beyond that size, use one of:
 *   - Electron/Chromium kiosk deployments (fs-backed ContentStore
 *     via @xiboplayer/proxy — streams via Node, no limit).
 *   - Wait for the large-media streaming rewrite tracked in
 *     xibo-players/xiboplayer#373: keep chunks separate in
 *     CacheStorage permanently, build a `ReadableStream` that pulls
 *     chunks lazily. Memory peak becomes one chunk size regardless
 *     of total file size.
 *
 * @implements {import('@xiboplayer/cache').BrowserContentStore}
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('ContentStore');
const CACHE_NAME = 'xibo-media-v1';
const DB_NAME = 'xibo-content-store';
const DB_VERSION = 1;
const META_STORE = 'metadata';
const CHUNK_STORE = 'chunks';

function keyToPath(key) {
  return key.startsWith('/') ? key : '/' + key;
}

/**
 * Open (or create) the IndexedDB database.
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        db.createObjectStore(CHUNK_STORE, { keyPath: ['key', 'chunkIndex'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export class ContentStoreBrowser {
  constructor() {
    this._db = null;
    this._writeLocks = new Set();
  }

  async init() {
    this._db = await openDB();
    log.info('Browser ContentStore initialized (CacheStorage + IndexedDB)');
  }

  isWriteLocked(key, chunkIndex) {
    const lockKey = chunkIndex != null ? `${key}:chunk-${chunkIndex}` : key;
    return this._writeLocks.has(lockKey);
  }

  // ── Existence checks ──────────────────────────────────────────────

  async has(key) {
    const cache = await caches.open(CACHE_NAME);
    const path = keyToPath(key);

    // Check whole file
    const match = await cache.match(path);
    if (match) {
      const meta = await this._getMeta(key);
      return { exists: true, chunked: false, metadata: meta };
    }

    // Check chunked metadata
    const meta = await this._getMeta(key);
    if (meta && meta.numChunks) {
      return { exists: true, chunked: true, metadata: meta };
    }

    return { exists: false, chunked: false, metadata: null };
  }

  async hasChunk(key, chunkIndex) {
    const cache = await caches.open(CACHE_NAME);
    const match = await cache.match(`${keyToPath(key)}:chunk-${chunkIndex}`);
    return !!match;
  }

  async missingChunks(key) {
    const meta = await this._getMeta(key);
    if (!meta || !meta.numChunks) return [];
    const cache = await caches.open(CACHE_NAME);
    const missing = [];
    for (let i = 0; i < meta.numChunks; i++) {
      const match = await cache.match(`${keyToPath(key)}:chunk-${i}`);
      if (!match) missing.push(i);
    }
    return missing;
  }

  // ── Read operations ───────────────────────────────────────────────

  /**
   * Return a `ReadableStream` covering `[range.start, range.end]` of
   * the cached content, pulling one chunk at a time rather than
   * loading the whole blob into memory.
   *
   * Design per #373. Not implemented yet — throws so callers who
   * probe ahead of the streaming rewrite surface the gap loudly.
   *
   * @param {string} _key
   * @param {import('@xiboplayer/cache').ChunkRange} [_range]
   * @returns {Promise<ReadableStream<Uint8Array>|null>}
   */
  async getStream(_key, _range) {
    throw new Error(
      'ContentStoreBrowser.getStream not implemented yet (see xibo-players/xiboplayer#373)',
    );
  }

  async getResponse(key, range) {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(keyToPath(key));
    if (!response) return null;

    if (range && (range.start != null || range.end != null)) {
      const blob = await response.blob();
      const start = range.start || 0;
      const end = range.end != null ? range.end + 1 : blob.size;
      const slice = blob.slice(start, end);
      const meta = await this._getMeta(key);
      return new Response(slice, {
        status: 206,
        headers: {
          'Content-Type': meta?.contentType || response.headers.get('Content-Type') || 'application/octet-stream',
          'Content-Length': String(slice.size),
          'Content-Range': `bytes ${start}-${end - 1}/${blob.size}`,
        },
      });
    }

    return response;
  }

  async getChunkResponse(key, chunkIndex, range) {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(`${keyToPath(key)}:chunk-${chunkIndex}`);
    if (!response) return null;

    if (range && (range.start != null || range.end != null)) {
      const blob = await response.blob();
      const start = range.start || 0;
      const end = range.end != null ? range.end + 1 : blob.size;
      return new Response(blob.slice(start, end), {
        status: 206,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(end - start),
          'Content-Range': `bytes ${start}-${end - 1}/${blob.size}`,
        },
      });
    }

    return response;
  }

  async getMetadata(key) {
    return this._getMeta(key);
  }

  // ── Write operations ──────────────────────────────────────────────

  async put(key, buffer, metadata) {
    const cache = await caches.open(CACHE_NAME);
    const path = keyToPath(key);
    const contentType = metadata?.contentType || 'application/octet-stream';

    const response = new Response(buffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buffer.byteLength || buffer.size || 0),
      },
    });
    await cache.put(path, response);

    const meta = {
      key,
      size: buffer.byteLength || buffer.size || 0,
      contentType,
      md5: metadata?.md5 || null,
      createdAt: Date.now(),
    };
    await this._putMeta(key, meta);
  }

  async putChunk(key, chunkIndex, buffer, metadata) {
    const lockKey = `${key}:chunk-${chunkIndex}`;
    if (this._writeLocks.has(lockKey)) return;
    this._writeLocks.add(lockKey);

    try {
      const cache = await caches.open(CACHE_NAME);
      const chunkPath = `${keyToPath(key)}:chunk-${chunkIndex}`;

      const response = new Response(buffer, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      await cache.put(chunkPath, response);

      // Update metadata
      if (metadata) {
        const existing = await this._getMeta(key) || {};
        const merged = { ...existing, ...metadata, key, updatedAt: Date.now() };
        if (!merged.createdAt) merged.createdAt = Date.now();
        await this._putMeta(key, merged);
      }
    } finally {
      this._writeLocks.delete(lockKey);
    }
  }

  async markComplete(key) {
    const meta = await this._getMeta(key) || {};
    meta.complete = true;
    meta.completedAt = Date.now();
    await this._putMeta(key, { ...meta, key });
  }

  async assembleChunks(key) {
    const meta = await this._getMeta(key);
    if (!meta || !meta.numChunks) return false;

    const cache = await caches.open(CACHE_NAME);
    const blobs = [];

    for (let i = 0; i < meta.numChunks; i++) {
      const resp = await cache.match(`${keyToPath(key)}:chunk-${i}`);
      if (!resp) {
        log.warn(`Missing chunk ${i} for ${key}, cannot assemble`);
        return false;
      }
      blobs.push(await resp.blob());
    }

    // Combine all chunks into one blob
    const assembled = new Blob(blobs, { type: meta.contentType || 'application/octet-stream' });

    // Store as whole file
    await cache.put(keyToPath(key), new Response(assembled, {
      headers: {
        'Content-Type': meta.contentType || 'application/octet-stream',
        'Content-Length': String(assembled.size),
      },
    }));

    // Update metadata
    meta.size = assembled.size;
    meta.complete = true;
    meta.completedAt = Date.now();
    delete meta.numChunks;
    await this._putMeta(key, { ...meta, key });

    // Clean up chunk entries
    for (let i = 0; ; i++) {
      const chunkPath = `${keyToPath(key)}:chunk-${i}`;
      const exists = await cache.match(chunkPath);
      if (!exists) break;
      await cache.delete(chunkPath);
    }

    log.info(`Assembled ${blobs.length} chunks for ${key} (${assembled.size} bytes)`);
    return true;
  }

  async delete(key) {
    const cache = await caches.open(CACHE_NAME);
    let deleted = false;

    // Delete whole file
    if (await cache.delete(keyToPath(key))) deleted = true;

    // Delete chunks
    for (let i = 0; ; i++) {
      const chunkPath = `${keyToPath(key)}:chunk-${i}`;
      if (!(await cache.delete(chunkPath))) break;
      deleted = true;
    }

    // Delete metadata
    if (this._db) {
      await idbDelete(this._db, META_STORE, key);
    }

    return deleted;
  }

  async list() {
    if (!this._db) return [];
    const allMeta = await idbGetAll(this._db, META_STORE);
    return allMeta.map(meta => ({
      key: meta.key,
      size: meta.size || 0,
      contentType: meta.contentType,
      chunked: !!meta.numChunks,
      complete: meta.complete || !meta.numChunks,
    }));
  }

  // ── Internal helpers ──────────────────────────────────────────────

  async _getMeta(key) {
    if (!this._db) return null;
    return idbGet(this._db, META_STORE, key);
  }

  async _putMeta(key, meta) {
    if (!this._db) return;
    meta.key = key;
    await idbPut(this._db, META_STORE, meta);
  }
}
