// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * RequestHandlerBrowser — Service Worker fetch handler for direct CMS mode.
 *
 * Replaces the proxy passthrough with CacheStorage-backed cache-through:
 *   1. Check ContentStoreBrowser for cached response
 *   2. On hit → return cached response (with Range support)
 *   3. On miss → fetch from CMS with JWT auth → cache → return
 *
 * Used when PWA runs directly on the CMS (no Node.js proxy).
 */

import { BASE } from './sw-utils.js';
import { createLogger, PLAYER_API } from '@xiboplayer/utils';

export class RequestHandlerBrowser {
  /**
   * @param {Object} contentStore - ContentStoreBrowser instance
   */
  constructor(contentStore) {
    this.contentStore = contentStore;
    this.log = createLogger('SW');
    this._authToken = null;
  }

  /** Called by message handler when main thread sends a fresh token */
  setAuthToken(token) {
    this._authToken = token;
  }

  _authHeaders() {
    if (!this._authToken) return {};
    return { Authorization: `Bearer ${this._authToken}` };
  }

  /**
   * Handle fetch event
   */
  async handleRequest(event) {
    const url = new URL(event.request.url);

    // Static pages — always network (they change on deploy)
    if (url.pathname === BASE + '/' ||
        url.pathname === BASE + '/index.html' ||
        url.pathname === BASE + '/setup.html') {
      return fetch(event.request);
    }

    // Player API cacheable resources — cache-through
    if (url.pathname.startsWith(PLAYER_API + '/')) {
      return this._handleApiRequest(event, url);
    }

    // XMDS file downloads — cache-through
    if (url.pathname.includes('xmds.php') && url.searchParams.has('file')) {
      return this._handleXmdsFile(event, url);
    }

    // Everything else — network
    return fetch(event.request);
  }

  /**
   * Cache-through for /player/api/v2/ requests.
   * Media, layouts, widgets, dependencies — cache in ContentStoreBrowser.
   * Other API calls (displays, schedule, auth) — pass through.
   */
  async _handleApiRequest(event, url) {
    const path = url.pathname;

    // Cacheable resource patterns
    const cacheablePatterns = [
      /\/media\/file\//,
      /\/media\/\d+/,
      /\/layouts\/\d+/,
      /\/widgets\/\d+\/\d+\/\d+/,
      /\/dependencies\//,
    ];

    const isCacheable = cacheablePatterns.some(p => p.test(path));
    if (!isCacheable) {
      // Non-cacheable API calls (auth, displays, schedule, inventory) — pass with auth
      const headers = new Headers(event.request.headers);
      Object.entries(this._authHeaders()).forEach(([k, v]) => headers.set(k, v));
      return fetch(new Request(event.request, { headers }));
    }

    // Cache key = pathname (without query params for signed URLs)
    const cacheKey = path;

    // Check Range header for partial content
    const rangeHeader = event.request.headers.get('Range');
    let range = null;
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        range = { start: parseInt(match[1]) };
        if (match[2]) range.end = parseInt(match[2]);
      }
    }

    // Try cache first
    const cached = await this.contentStore.has(cacheKey);
    if (cached.exists) {
      this.log.debug('Cache hit:', cacheKey);
      const response = cached.chunked
        ? await this._serveChunked(cacheKey, range, cached.metadata)
        : await this.contentStore.getResponse(cacheKey, range);
      if (response) return response;
    }

    // Cache miss — fetch from CMS with auth
    this.log.debug('Cache miss:', cacheKey);
    try {
      const headers = new Headers(event.request.headers);
      Object.entries(this._authHeaders()).forEach(([k, v]) => headers.set(k, v));

      const response = await fetch(new Request(event.request.url, {
        method: 'GET',
        headers,
      }));

      if (!response.ok) {
        // If CMS returns error but we have stale cache, serve it
        if (cached.exists) {
          this.log.warn('CMS error, serving stale cache:', cacheKey);
          return this.contentStore.getResponse(cacheKey, range);
        }
        return response;
      }

      // Clone response before consuming body (one for cache, one for client)
      const cloned = response.clone();

      // Cache in background (don't block response)
      event.waitUntil(this._cacheResponse(cacheKey, cloned));

      return response;
    } catch (err) {
      // Network error — try stale cache
      if (cached.exists) {
        this.log.warn('Network error, serving stale cache:', cacheKey, err.message);
        return this.contentStore.getResponse(cacheKey, range);
      }
      throw err;
    }
  }

  /**
   * Cache a response in ContentStoreBrowser.
   */
  async _cacheResponse(key, response) {
    try {
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      await this.contentStore.put(key, buffer, {
        contentType: response.headers.get('Content-Type') || 'application/octet-stream',
        size: buffer.byteLength,
      });
      this.log.debug('Cached:', key, `(${buffer.byteLength} bytes)`);
    } catch (err) {
      this.log.warn('Failed to cache:', key, err.message);
    }
  }

  /**
   * Serve a chunked file — find the right chunk for the requested range.
   */
  async _serveChunked(key, range, metadata) {
    if (!range) {
      // No range — try to assemble and serve whole file
      const assembled = await this.contentStore.assembleChunks(key);
      if (assembled) return this.contentStore.getResponse(key);
      return null;
    }

    // For range requests on chunked files, find which chunk covers the range
    const chunkSize = metadata?.chunkSize || (50 * 1024 * 1024);
    const startChunk = Math.floor(range.start / chunkSize);
    const offsetInChunk = range.start - (startChunk * chunkSize);

    const chunkRange = { start: offsetInChunk };
    if (range.end != null) {
      chunkRange.end = range.end - (startChunk * chunkSize);
    }

    return this.contentStore.getChunkResponse(key, startChunk, chunkRange);
  }

  /**
   * Handle XMDS file downloads — same as proxy mode but cache locally.
   */
  _handleXmdsFile(event, url) {
    const filename = url.searchParams.get('file');
    const fileType = url.searchParams.get('type');
    const itemId = url.searchParams.get('itemId');

    let apiPath;
    if (fileType === 'L') {
      apiPath = `${PLAYER_API}/layouts/${itemId}`;
    } else if (fileType === 'P') {
      apiPath = `${PLAYER_API}/dependencies/${filename}`;
    } else {
      apiPath = `${PLAYER_API}/media/file/${filename}`;
    }

    this.log.info(`XMDS redirect: ${fileType}/${filename} → ${apiPath}`);

    // Rewrite to API path and handle via cache-through
    const newUrl = new URL(apiPath, event.request.url);
    const newEvent = { request: new Request(newUrl, event.request) };
    return this._handleApiRequest(newEvent, newUrl);
  }
}
