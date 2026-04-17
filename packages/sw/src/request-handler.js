// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * RequestHandler - Handles fetch events for cached content
 *
 * With CMS mirror routes on the proxy, the SW's role is minimal:
 * - ${PLAYER_API}/* requests pass through to Express (mirror routes serve them)
 * - Static pages pass through to network
 *
 * No URL translation needed — the proxy serves at CMS paths directly.
 * Widget HTML is served by the Express mirror route at ${PLAYER_API}/widgets/{L}/{R}/{M}.
 */

import { createLogger, PLAYER_API } from '@xiboplayer/utils';
import { isStaticPage, isXmdsFileRequest, rewriteXmdsToApiPath } from './routing.js';

export class RequestHandler {
  /**
   * @param {Object} downloadManager - DownloadManager instance
   */
  constructor(downloadManager) {
    this.downloadManager = downloadManager;
    this.log = createLogger('SW');
  }

  /**
   * Handle fetch request
   */
  async handleRequest(event) {
    const url = new URL(event.request.url);

    // Static pages — pass through to Express
    if (isStaticPage(url)) {
      return fetch(event.request);
    }

    // Player API — pass through to Express mirror routes
    if (url.pathname.startsWith(PLAYER_API + '/')) {
      return fetch(event.request);
    }

    // XMDS file downloads — route through Express cache-through
    if (isXmdsFileRequest(url)) {
      return this._handleXmdsFile(event, url);
    }

    // Not a cache request — pass through to network
    return fetch(event.request);
  }

  /**
   * Route XMDS file downloads to the local Express cache-through proxy.
   *
   * XMDS RequiredFiles returns cross-origin signed URLs like:
   *   https://cms/xmds.php?file=42.mp4&type=M&X-Amz-Signature=...
   *
   * We rewrite these to local proxy mirror paths so the download goes through
   * ContentStore caching, avoiding CORS issues and enabling chunked downloads.
   */
  _handleXmdsFile(event, url) {
    const proxyPath = rewriteXmdsToApiPath(url);
    if (!proxyPath) return fetch(event.request);

    const fileType = url.searchParams.get('type');
    const filename = url.searchParams.get('file');
    this.log.info(`XMDS redirect: ${fileType}/${filename} → ${proxyPath}`);

    // Pass original XMDS URL so proxy can fetch from CMS on cache miss
    const headers = new Headers(event.request.headers);
    headers.set('X-Cms-Download-Url', url.href);

    return fetch(proxyPath, { headers });
  }
}
