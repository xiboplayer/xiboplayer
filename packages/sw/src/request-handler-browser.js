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
 *
 * ─────────────────────────────────────────────────────────────────
 *  SW ↔ main-thread protocol (browser mode only)
 * ─────────────────────────────────────────────────────────────────
 *
 * The main thread owns CMS authentication (OAuth2 → JWT bearer via
 * the REST client in `@xiboplayer/xmds`). The Service Worker must
 * inject that same bearer on every cache-miss fetch. To avoid
 * duplicating the auth flow in the SW, the main thread sends the
 * current token over `navigator.serviceWorker.controller.postMessage`.
 *
 * Message shape (both directions use the same `type` discriminator):
 *
 *   {@link AuthTokenMessage}
 *
 * Main thread sends:
 *   controller.postMessage({ type: 'AUTH_TOKEN', token: '<jwt>' })
 *
 * SW receives (in `sw-pwa.js` message handler) and calls:
 *   requestHandler.setAuthToken(token)
 *
 * SW optionally acknowledges via the MessageChannel port:
 *   event.ports[0]?.postMessage({ ok: true })
 *
 * Token rotation: the main thread hooks the REST client's
 * `_authenticate` method so every fresh auth posts the new token.
 * The SW holds the latest token in memory only (no persistence —
 * on SW restart the main thread re-sends on first auth).
 *
 * Proxy-mode safety: the message handler in `sw-pwa.js` gates on
 * `!isProxyMode` before dispatching AUTH_TOKEN so the legacy
 * RequestHandler (which does not expose setAuthToken) never
 * receives it.
 *
 * @typedef {Object} AuthTokenMessage
 * @property {'AUTH_TOKEN'} type
 * @property {string} token  - JWT bearer (no 'Bearer ' prefix)
 */

import { createLogger, PLAYER_API } from '@xiboplayer/utils';
import {
  isStaticPage,
  isXmdsFileRequest,
  isCacheableApiPath,
  rewriteXmdsToApiPath,
} from './routing.js';

export class RequestHandlerBrowser {
  /**
   * @param {Object} contentStore - ContentStoreBrowser instance
   */
  constructor(contentStore) {
    this.contentStore = contentStore;
    this.log = createLogger('SW');
    this._authToken = null;
  }

  /**
   * Receives a JWT bearer from the main thread over the
   * {@link AuthTokenMessage} protocol. Called by the SW message
   * handler in `sw-pwa.js` on every `AUTH_TOKEN` postMessage.
   *
   * The token is held in memory only — on SW restart the main thread
   * re-sends on its next successful auth. No persistence, no TTL
   * tracking here: token expiry is the CMS's concern and will
   * surface as a 401 on the next cache-miss, triggering the main
   * thread's refresh flow.
   *
   * @param {string} token - JWT bearer (no 'Bearer ' prefix)
   */
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
    if (isStaticPage(url)) {
      return fetch(event.request);
    }

    // Player API cacheable resources — cache-through
    if (url.pathname.startsWith(PLAYER_API + '/')) {
      return this._handleApiRequest(event, url);
    }

    // XMDS file downloads — cache-through
    if (isXmdsFileRequest(url)) {
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

    if (!isCacheableApiPath(path)) {
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

    // Try cache first. getResponse handles both whole-file and
    // chunked regimes internally via getStream (#373), so the caller
    // no longer needs a separate `_serveChunked` path — chunked reads
    // flow through a lazy ReadableStream that pulls one chunk at a
    // time. However, chunked entries need completeness verified
    // before serving so a half-populated item doesn't error mid-stream
    // on the first missing chunk.
    const cached = await this.contentStore.has(cacheKey);
    let chunkedReady = !cached.chunked || !!cached.metadata?.complete;
    if (cached.exists && cached.chunked && !chunkedReady) {
      // Probe completeness; marks complete if all chunks are in.
      chunkedReady = await this.contentStore.assembleChunks(cacheKey);
    }
    if (cached.exists && chunkedReady) {
      this.log.debug('Cache hit:', cacheKey);
      const response = await this.contentStore.getResponse(cacheKey, range);
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
   * Handle XMDS file downloads — same as proxy mode but cache locally.
   */
  _handleXmdsFile(event, url) {
    const apiPath = rewriteXmdsToApiPath(url);
    if (!apiPath) return fetch(event.request);

    this.log.info(
      `XMDS redirect: ${url.searchParams.get('type')}/${url.searchParams.get('file')} → ${apiPath}`,
    );

    // Rewrite to API path and handle via cache-through
    const newUrl = new URL(apiPath, event.request.url);
    const newEvent = { request: new Request(newUrl, event.request) };
    return this._handleApiRequest(newEvent, newUrl);
  }
}
