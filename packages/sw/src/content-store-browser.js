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
 *  Large-media strategy (#373)
 * ─────────────────────────────────────────────────────────────────
 *
 * Chunks stay in CacheStorage forever — `assembleChunks` only verifies
 * presence + marks complete (it does NOT concatenate). Reads go
 * through `getStream`, which builds a `ReadableStream` that pulls one
 * chunk at a time on demand. Memory peak during playback = one chunk
 * size (default 50 MB), regardless of total file size. Video range
 * requests seek-and-read into the correct chunk without loading
 * surrounding chunks.
 *
 * `getResponse` keeps a fast path for non-ranged whole-file reads
 * (cache entry returned verbatim, zero wrapping) and flows everything
 * else through `getStream`.
 *
 * Still TODO in this branch:
 *   - navigator.storage.persist() on activate (prevent eviction
 *     during long-running kiosk sessions)
 *   - navigator.storage.estimate() monitoring + LRU prune hook
 *   - integration test with a synthetic 200 MB fixture verifying
 *     memory peak stays under one chunk size during playback
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
   * the cached content, pulling one chunk at a time. Memory peak =
   * one chunk size regardless of total file size — the whole-blob
   * assembly that caps the legacy `getResponse` path at ~50 MB is
   * gone.
   *
   * Returns `null` when the key is missing or has no bytes yet.
   *
   * Three regimes:
   *   - whole file stored (no chunks): re-uses the cache entry's
   *     existing `Response.body` stream (no copy)
   *   - chunked file (numChunks set): builds a pull-source that walks
   *     chunks from `firstChunk` to `lastChunk`, trimming first+last
   *     chunks to fit the exact range
   *   - partial chunked file: errors the stream on the first missing
   *     chunk
   *
   * @param {string} key
   * @param {import('@xiboplayer/cache').ChunkRange} [range]
   * @returns {Promise<ReadableStream<Uint8Array>|null>}
   */
  async getStream(key, range) {
    const cache = await caches.open(CACHE_NAME);

    // Whole-file regime — single cache entry, re-use its body stream.
    const whole = await cache.match(keyToPath(key));
    if (whole) {
      if (!range || (range.start == null && range.end == null)) {
        return whole.body;
      }
      // Range over a non-chunked entry: slice once. O(file size) in
      // memory but only triggered when callers explicitly request a
      // range on a small-media whole-file entry.
      const blob = await whole.blob();
      const start = range.start ?? 0;
      const end = range.end != null ? range.end + 1 : blob.size;
      return blob.slice(start, end).stream();
    }

    // Chunked-file regime
    const meta = await this._getMeta(key);
    if (!meta || !meta.numChunks) return null;
    const chunkSize = meta.chunkSize || (50 * 1024 * 1024);
    const total = meta.size;
    const start = range?.start ?? 0;
    const end = range?.end != null ? range.end + 1 : total;
    const firstChunk = Math.floor(start / chunkSize);
    const lastChunk = Math.floor((end - 1) / chunkSize);
    const keyBase = keyToPath(key);

    let cur = firstChunk;
    return new ReadableStream({
      async pull(controller) {
        if (cur > lastChunk) {
          controller.close();
          return;
        }
        const resp = await cache.match(`${keyBase}:chunk-${cur}`);
        if (!resp) {
          controller.error(new Error(`Missing chunk ${cur} for ${key}`));
          return;
        }
        let bytes = new Uint8Array(await resp.arrayBuffer());
        // Trim the first emitted chunk to [start, chunk_end)
        if (cur === firstChunk) {
          const offset = start - firstChunk * chunkSize;
          bytes = bytes.subarray(offset);
        }
        // Trim the last emitted chunk to [chunk_start, end)
        if (cur === lastChunk) {
          const chunkAbsStart = Math.max(cur * chunkSize, start);
          bytes = bytes.subarray(0, end - chunkAbsStart);
        }
        controller.enqueue(bytes);
        cur++;
      },
    });
  }

  async getResponse(key, range) {
    const cache = await caches.open(CACHE_NAME);
    const wholeEntry = await cache.match(keyToPath(key));

    // Fast path: non-ranged whole-file — return the cached Response
    // verbatim. The browser reads the body as a stream natively, no
    // wrapping needed. Equivalent to the pre-#373 behaviour.
    if (wholeEntry && !(range && (range.start != null || range.end != null))) {
      return wholeEntry;
    }

    // Everything else (range requests, chunked files) flows through
    // getStream() so we never load the whole blob into memory.
    const stream = await this.getStream(key, range);
    if (!stream) return null;

    const meta = await this._getMeta(key);
    const contentType =
      meta?.contentType ||
      wholeEntry?.headers.get('Content-Type') ||
      'application/octet-stream';

    // No range requested → serve whole (chunked) file as a 200
    if (!range || (range.start == null && range.end == null)) {
      const total = meta?.size;
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          ...(total != null ? { 'Content-Length': String(total) } : {}),
        },
      });
    }

    // Range requested → 206 with Content-Range
    const total = meta?.size ?? (wholeEntry ? undefined : null);
    if (total == null) {
      // Unknown total — still serve the stream but without
      // Content-Range (caller should have avoided this path).
      return new Response(stream, {
        status: 206,
        headers: { 'Content-Type': contentType },
      });
    }
    const start = range.start ?? 0;
    const end = range.end != null ? range.end + 1 : total;
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(end - start),
        'Content-Range': `bytes ${start}-${end - 1}/${total}`,
      },
    });
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

  /**
   * Verify every chunk is present and mark the item complete.
   *
   * Contrast with the filesystem `ContentStore.assembleChunks` which
   * concatenates chunks into one whole file — the browser backend
   * deliberately does NOT concatenate. Reads serve from chunks
   * directly via `getStream`, so assembly would waste memory
   * (peak 2 × file size) and duplicate storage (chunks + assembled).
   *
   * Returns `true` when all `numChunks` chunk entries exist in the
   * cache, `false` otherwise. On true, metadata is updated with
   * `complete: true` + `completedAt`, but `numChunks` is retained
   * so reads know they're still serving from chunks.
   */
  async assembleChunks(key) {
    const meta = await this._getMeta(key);
    if (!meta || !meta.numChunks) return false;

    const cache = await caches.open(CACHE_NAME);
    for (let i = 0; i < meta.numChunks; i++) {
      const exists = await cache.match(`${keyToPath(key)}:chunk-${i}`);
      if (!exists) {
        log.warn(`Missing chunk ${i} for ${key}, cannot mark complete`);
        return false;
      }
    }

    meta.complete = true;
    meta.completedAt = Date.now();
    await this._putMeta(key, { ...meta, key });

    log.info(
      `All ${meta.numChunks} chunks present for ${key} ` +
        `(${meta.size} bytes, served via getStream)`,
    );
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
