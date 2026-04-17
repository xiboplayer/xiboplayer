// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
// @vitest-environment node
/**
 * Unit tests for ContentStoreBrowser.
 *
 * Uses the Node environment rather than jsdom. Rationale: jsdom's
 * Response polyfill stringifies Blob bodies instead of reading their
 * bytes — a confirmed jsdom defect that breaks round-trip tests of
 * `assembleChunks` (which builds a Blob from chunks, wraps in
 * Response, then expects the bytes back). Node 18+ ships a compliant
 * Response/Blob from undici; combined with fake-indexeddb/auto for
 * IndexedDB it's the minimal environment ContentStoreBrowser needs.
 *
 * The class uses two browser-native APIs:
 *   - CacheStorage (not provided by Node either) — mocked in-memory below
 *   - IndexedDB (via fake-indexeddb/auto, loaded from root setup)
 *
 * Tests cover: init, put / getResponse round-trip, existence checks,
 * chunk lifecycle (put → hasChunk → assemble → clean up), range
 * requests, delete, list, and the write-lock guard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContentStoreBrowser } from './content-store-browser.js';

// ── Minimal in-memory CacheStorage mock ────────────────────────────
//
// jsdom does not implement the Cache / CacheStorage Web APIs. This
// mock covers the subset ContentStoreBrowser uses: open, put, match,
// delete. Requests are keyed by URL or raw string; responses are
// cloned on match() so callers can consume the body repeatedly.

class MockCache {
  constructor() {
    this._entries = new Map();
  }
  async put(req, res) {
    const key = typeof req === 'string' ? req : req.url;
    // Mirror browser CacheStorage semantics: Cache.put locks the
    // passed-in body (it's considered consumed by the browser). Here
    // we snapshot the bytes as a Blob so match() can rebuild a fresh
    // Response each time with a live body. jsdom's Response wrapper
    // handles Blob bodies correctly; passing an ArrayBuffer directly
    // to `new Response()` gets string-coerced (= "[object Blob]") in
    // older jsdom versions, which is why we funnel through Blob here.
    const ab = await res.arrayBuffer();
    const headers = Object.fromEntries(res.headers);
    const contentType = headers['content-type'] || 'application/octet-stream';
    this._entries.set(key, {
      bytes: new Uint8Array(ab),
      contentType,
      headers,
    });
  }
  async match(req, opts = {}) {
    const key = typeof req === 'string' ? req : req.url;
    if (opts.ignoreSearch) {
      const path = key.split('?')[0];
      for (const [k, v] of this._entries) {
        if (k.split('?')[0] === path) return this._makeResponse(v);
      }
      return undefined;
    }
    const entry = this._entries.get(key);
    return entry ? this._makeResponse(entry) : undefined;
  }
  async delete(req) {
    const key = typeof req === 'string' ? req : req.url;
    return this._entries.delete(key);
  }
  _makeResponse({ bytes, contentType, headers }) {
    const blob = new Blob([bytes], { type: contentType });
    return new Response(blob, { headers });
  }
}

class MockCacheStorage {
  constructor() {
    this._caches = new Map();
  }
  async open(name) {
    if (!this._caches.has(name)) this._caches.set(name, new MockCache());
    return this._caches.get(name);
  }
  async delete(name) {
    return this._caches.delete(name);
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('ContentStoreBrowser', () => {
  let store;

  beforeEach(async () => {
    globalThis.caches = new MockCacheStorage();
    store = new ContentStoreBrowser();
    await store.init();
  });

  afterEach(async () => {
    // Close the IDB connection so the next test's deleteDatabase (if it
    // ran one) wouldn't block; in practice each test uses the same DB
    // name, so keys are flushed by explicit delete() calls in the
    // methods-under-test rather than a full wipe between tests.
    if (store && store._db) store._db.close();
    // Wipe IDB for the NEXT test — deleteDatabase needs all connections
    // closed; we just closed this test's, so it's safe.
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('xibo-content-store');
      req.onsuccess = resolve;
      req.onerror = resolve;
      req.onblocked = resolve;
    });
    delete globalThis.caches;
  });

  // ── init ─────────────────────────────────────────────────────────

  it('opens an IndexedDB and becomes usable', async () => {
    // init() happened in beforeEach; a subsequent meta lookup should not throw
    const meta = await store.getMetadata('no-such-key');
    expect(meta).toBeNull();
  });

  // ── put + getResponse round-trip ─────────────────────────────────

  it('stores a buffer and returns a Response with the same bytes', async () => {
    const data = new TextEncoder().encode('hello world').buffer;
    await store.put('media/file/1', data, { contentType: 'text/plain' });

    const res = await store.getResponse('media/file/1');
    expect(res).not.toBeNull();
    const text = await res.text();
    expect(text).toBe('hello world');
    expect(res.headers.get('Content-Type')).toBe('text/plain');
  });

  it('persists metadata with the stored buffer', async () => {
    const data = new Uint8Array([1, 2, 3, 4]).buffer;
    await store.put('media/file/2', data, {
      contentType: 'application/octet-stream',
      md5: 'abc123',
    });

    const meta = await store.getMetadata('media/file/2');
    expect(meta).toMatchObject({
      key: 'media/file/2',
      size: 4,
      contentType: 'application/octet-stream',
      md5: 'abc123',
    });
    expect(typeof meta.createdAt).toBe('number');
  });

  // ── has ──────────────────────────────────────────────────────────

  it('reports exists=false for a missing key', async () => {
    const result = await store.has('does-not-exist');
    expect(result).toEqual({ exists: false, chunked: false, metadata: null });
  });

  it('reports exists=true for a stored whole file', async () => {
    await store.put('media/file/3', new Uint8Array([9]).buffer);
    const result = await store.has('media/file/3');
    expect(result.exists).toBe(true);
    expect(result.chunked).toBe(false);
  });

  // ── chunk lifecycle ──────────────────────────────────────────────

  it('records chunks individually and reports hasChunk + missingChunks', async () => {
    await store.putChunk('big-media', 0, new Uint8Array([1]).buffer, { numChunks: 3 });
    await store.putChunk('big-media', 2, new Uint8Array([3]).buffer, { numChunks: 3 });

    expect(await store.hasChunk('big-media', 0)).toBe(true);
    expect(await store.hasChunk('big-media', 1)).toBe(false);
    expect(await store.hasChunk('big-media', 2)).toBe(true);

    const missing = await store.missingChunks('big-media');
    expect(missing).toEqual([1]);
  });

  it('assembles chunks into a whole file and cleans up chunk entries', async () => {
    await store.putChunk('big-media', 0, new Uint8Array([1, 2, 3]).buffer,
      { numChunks: 2, contentType: 'application/octet-stream' });
    await store.putChunk('big-media', 1, new Uint8Array([4, 5]).buffer,
      { numChunks: 2 });

    const ok = await store.assembleChunks('big-media');
    expect(ok).toBe(true);

    // Whole file now readable
    const res = await store.getResponse('big-media');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);

    // Chunks cleaned up
    expect(await store.hasChunk('big-media', 0)).toBe(false);
    expect(await store.hasChunk('big-media', 1)).toBe(false);

    // Metadata marked complete, numChunks dropped
    const meta = await store.getMetadata('big-media');
    expect(meta.complete).toBe(true);
    expect(meta.numChunks).toBeUndefined();
    expect(meta.size).toBe(5);
  });

  it('refuses to assemble when a chunk is missing', async () => {
    // numChunks=3, only 2 stored
    await store.putChunk('big-media', 0, new Uint8Array([1]).buffer, { numChunks: 3 });
    await store.putChunk('big-media', 2, new Uint8Array([3]).buffer, { numChunks: 3 });
    const ok = await store.assembleChunks('big-media');
    expect(ok).toBe(false);
  });

  // ── range requests ───────────────────────────────────────────────

  it('serves a byte range with 206 status + Content-Range header', async () => {
    const data = new TextEncoder().encode('abcdefghij').buffer;
    await store.put('media/file/4', data, { contentType: 'text/plain' });

    const res = await store.getResponse('media/file/4', { start: 2, end: 5 });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 2-5/10');
    // Use arrayBuffer → TextDecoder rather than Response.text():
    // jsdom's Blob-bodied Response mishandles .text() in some versions.
    const buf = await res.arrayBuffer();
    expect(new TextDecoder().decode(new Uint8Array(buf))).toBe('cdef');
  });

  // ── delete ───────────────────────────────────────────────────────

  it('delete removes whole file, chunks, and metadata', async () => {
    await store.put('media/file/5', new Uint8Array([1]).buffer);
    await store.putChunk('media/file/5', 0, new Uint8Array([2]).buffer,
      { numChunks: 1 });

    const deleted = await store.delete('media/file/5');
    expect(deleted).toBe(true);

    expect((await store.has('media/file/5')).exists).toBe(false);
    expect(await store.hasChunk('media/file/5', 0)).toBe(false);
    expect(await store.getMetadata('media/file/5')).toBeNull();
  });

  // ── list ─────────────────────────────────────────────────────────

  it('list returns all stored metadata entries', async () => {
    await store.put('a', new Uint8Array([1]).buffer, { contentType: 'x/a' });
    await store.put('b', new Uint8Array([2, 3]).buffer, { contentType: 'x/b' });

    const list = await store.list();
    const byKey = Object.fromEntries(list.map((e) => [e.key, e]));
    expect(byKey.a).toMatchObject({ size: 1, contentType: 'x/a', chunked: false });
    expect(byKey.b).toMatchObject({ size: 2, contentType: 'x/b', chunked: false });
  });

  // ── write-lock ───────────────────────────────────────────────────

  it('isWriteLocked reflects in-flight putChunk operations', async () => {
    // Start a putChunk that holds briefly, check lock state mid-flight
    const data = new Uint8Array([7]).buffer;

    // We can't easily pause putChunk from outside, but the public
    // predicate is read-only; drive it via direct _writeLocks mutation
    // the same way production code does.
    store._writeLocks.add('some-key:chunk-0');
    expect(store.isWriteLocked('some-key', 0)).toBe(true);
    expect(store.isWriteLocked('some-key', 1)).toBe(false);
    store._writeLocks.delete('some-key:chunk-0');
    expect(store.isWriteLocked('some-key', 0)).toBe(false);

    // Sanity: a normal putChunk still completes (no lock held for this one)
    await store.putChunk('ok-key', 0, data, { numChunks: 1 });
    expect(await store.hasChunk('ok-key', 0)).toBe(true);
  });
});
