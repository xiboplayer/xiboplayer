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

import { BASE } from './sw-utils.js';
import { createLogger, PLAYER_API } from '@xiboplayer/utils';

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
    if (url.pathname === BASE + '/' ||
        url.pathname === BASE + '/index.html' ||
        url.pathname === BASE + '/setup.html') {
      return fetch(event.request);
    }

    // Player API — pass through to Express mirror routes
    if (url.pathname.startsWith(PLAYER_API + '/')) {
      return fetch(event.request);
    }

    // Not a cache request — let browser handle
    return null;
  }
}
