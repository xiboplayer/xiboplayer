/**
 * RequestHandler - Handles fetch events for cached content
 *
 * Routes all media/layout/widget/static requests to the proxy's /store endpoint,
 * which serves files from the durable ContentStore (filesystem).
 * No Cache API usage — everything goes through the proxy REST API.
 */

import { BASE } from './sw-utils.js';
import { createLogger } from '@xiboplayer/utils';
import { toProxyUrl } from '@xiboplayer/cache/download-manager';

export class RequestHandler {
  /**
   * @param {Object} downloadManager - DownloadManager instance
   */
  constructor(downloadManager) {
    this.downloadManager = downloadManager;
    this.pendingFetches = new Map(); // filename → Promise<Response> for deduplication
    this.log = createLogger('SW');
  }

  /**
   * Handle fetch request
   * - Route media/layout/widget/static to proxy /store
   * - Static pages pass through to network (Express serves them)
   * - Wait for download if in progress
   * - Return 404 if not stored and not downloading
   */
  async handleRequest(event) {
    const url = new URL(event.request.url);
    this.log.info('handleRequest called for:', url.href);

    // Handle static files (player pages) — pass through to network
    if (url.pathname === BASE + '/' ||
        url.pathname === BASE + '/index.html' ||
        url.pathname === BASE + '/setup.html') {
      this.log.info('Static page, passing to network:', url.pathname);
      return fetch(event.request);
    }

    // Handle widget resources (bundle.min.js, fonts)
    if ((url.pathname.includes('xmds.php') || url.pathname.includes('pwa/file')) &&
        (url.searchParams.get('fileType') === 'bundle' ||
         url.searchParams.get('fileType') === 'fontCss' ||
         url.searchParams.get('fileType') === 'font')) {
      return this._handleWidgetResource(event, url);
    }

    // Handle XMDS media requests (XLR compatibility + PWA file downloads)
    if ((url.pathname.includes('xmds.php') || url.pathname.includes('pwa/file')) && url.searchParams.has('file')) {
      const filename = url.searchParams.get('file');
      const fileId = filename.split('.')[0];
      const fileType = url.searchParams.get('type');
      const cacheType = fileType === 'L' ? 'layout' : 'media';

      this.log.info('XMDS request:', filename, 'type:', fileType, '→ /store/' + cacheType + '/' + fileId);

      // Route to proxy's ContentStore
      const proxyUrl = `/store/${cacheType}/${fileId}`;
      try {
        const proxyResp = await fetch(proxyUrl);
        if (proxyResp.ok) {
          return new Response(proxyResp.body, {
            headers: {
              'Content-Type': proxyResp.headers.get('Content-Type') || 'video/mp4',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=31536000',
              'Accept-Ranges': 'bytes'
            }
          });
        }
        proxyResp.body?.cancel();
      } catch (_) {}

      // Not stored — fetch via local proxy (avoids CORS blocks)
      this.log.info('XMDS file not stored, fetching via proxy:', filename);
      return fetch(toProxyUrl(event.request.url));
    }

    // Handle static widget resources (rewritten URLs from widget HTML)
    if (url.pathname.startsWith(BASE + '/cache/static/')) {
      return this._handleStaticResource(url);
    }

    // Only handle /player/pwa/cache/* requests below
    if (!url.pathname.startsWith(BASE + '/cache/')) {
      this.log.info('NOT a cache request, returning null:', url.pathname);
      return null; // Let browser handle
    }

    this.log.info('Cache request:', url.pathname);

    // Handle widget HTML requests
    if (url.pathname.startsWith(BASE + '/cache/widget/')) {
      return this._handleWidgetHtml(url);
    }

    // Extract key and route to proxy
    const storeKey = url.pathname.replace(/\.json$/, '');
    const method = event.request.method;
    const rangeHeader = event.request.headers.get('Range');

    if (rangeHeader) {
      this.log.info(method, storeKey, `Range: ${rangeHeader}`);
    } else {
      this.log.info(method, storeKey);
    }

    // Convert /player/pwa/cache/media/123 → /store/media/123
    const parts = storeKey.replace(BASE + '/cache/', '').split('/');
    const proxyUrl = `/store/${parts.join('/')}`;

    // Route to proxy
    try {
      const fetchOpts = { method };
      if (rangeHeader) {
        fetchOpts.headers = { Range: rangeHeader };
      }

      const proxyResp = await fetch(proxyUrl, fetchOpts);

      if (proxyResp.ok || proxyResp.status === 206) {
        return proxyResp;
      }

      // 404 from proxy — file not on disk yet
      if (proxyResp.status === 404) {
        return this._handleNotStored(storeKey, event, method, rangeHeader);
      }

      return proxyResp;
    } catch (err) {
      this.log.error('Proxy fetch error:', err.message);
      return this._handleNotStored(storeKey, event, method, rangeHeader);
    }
  }

  /**
   * Handle file not yet on disk — check if download is in progress
   */
  async _handleNotStored(storeKey, event, method, rangeHeader) {
    const keyParts = storeKey.split('/');
    const type = keyParts[keyParts.length - 2];
    const id = keyParts[keyParts.length - 1];

    // Check if download is in progress
    let task = null;
    for (const [, activeTask] of this.downloadManager.queue.active.entries()) {
      if (activeTask.fileInfo.type === type && String(activeTask.fileInfo.id) === id) {
        task = activeTask;
        break;
      }
    }

    if (task) {
      this.log.info('Download in progress, waiting:', storeKey);
      try {
        await task.wait();

        // After download, proxy should have the file now — retry
        const parts = storeKey.replace(BASE + '/cache/', '').split('/');
        const proxyUrl = `/store/${parts.join('/')}`;
        const fetchOpts = { method };
        if (rangeHeader) fetchOpts.headers = { Range: rangeHeader };

        const retryResp = await fetch(proxyUrl, fetchOpts);
        if (retryResp.ok || retryResp.status === 206) {
          this.log.info('Download complete, serving from store:', storeKey);
          return retryResp;
        }
      } catch (error) {
        this.log.error('Download failed:', storeKey, error);
        return new Response('Download failed: ' + error.message, { status: 500 });
      }
    }

    this.log.info('Not found:', storeKey);
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  /**
   * Handle widget resources (bundle.min.js, fonts) — fetch from store or CMS
   */
  async _handleWidgetResource(event, url) {
    const filename = url.searchParams.get('file');
    this.log.info('Widget resource request:', filename);

    // Check ContentStore first
    try {
      const storeResp = await fetch(`/store/static/${filename}`);
      if (storeResp.ok) {
        this.log.info('Serving widget resource from store:', filename);
        return storeResp;
      }
      storeResp.body?.cancel();
    } catch (_) {}

    // Deduplicate concurrent fetches for the same resource
    if (this.pendingFetches.has(filename)) {
      this.log.info('Deduplicating widget resource fetch:', filename);
      const pending = await this.pendingFetches.get(filename);
      return pending.clone();
    }

    this.log.info('Fetching widget resource from CMS:', filename);
    const fetchPromise = (async () => {
      try {
        const response = await fetch(toProxyUrl(event.request.url));
        if (response.ok) {
          // Store in ContentStore for future use
          const ext = filename.split('.').pop().toLowerCase();
          const contentType = {
            'js': 'application/javascript',
            'css': 'text/css',
            'otf': 'font/otf', 'ttf': 'font/ttf',
            'woff': 'font/woff', 'woff2': 'font/woff2',
            'eot': 'application/vnd.ms-fontobject',
            'svg': 'image/svg+xml'
          }[ext] || response.headers.get('Content-Type') || 'application/octet-stream';

          const responseClone = response.clone();
          const blob = await responseClone.blob();
          fetch(`/store/static/${filename}`, {
            method: 'PUT',
            headers: { 'Content-Type': contentType },
            body: blob,
          }).then(r => r.body?.cancel())
            .catch(e => this.log.warn('Failed to store widget resource:', filename, e));

          this.log.info('Stored widget resource:', filename, `(${contentType})`);
          return response;
        } else {
          this.log.warn('Widget resource not available (', response.status, '):', filename, '- NOT storing');
          return response;
        }
      } catch (error) {
        this.log.error('Failed to fetch widget resource:', filename, error);
        return new Response('Failed to fetch widget resource', {
          status: 502, statusText: 'Bad Gateway',
          headers: { 'Content-Type': 'text/plain' }
        });
      }
    })();

    this.pendingFetches.set(filename, fetchPromise);
    try {
      const response = await fetchPromise;
      return response.clone();
    } finally {
      this.pendingFetches.delete(filename);
    }
  }

  /**
   * Handle static resources (rewritten URLs from widget HTML)
   */
  async _handleStaticResource(url) {
    const filename = url.pathname.split('/').pop();
    this.log.info('Static resource request:', filename);

    // Check ContentStore via proxy
    try {
      const proxyResp = await fetch(`/store/static/${filename}`);
      if (proxyResp.ok) {
        this.log.info('Serving static resource from store:', filename);
        // Wrap response with explicit headers to prevent MIME mismatch from
        // stale browser cache entries (old 404s with text/html content type)
        return new Response(proxyResp.body, {
          headers: {
            'Content-Type': proxyResp.headers.get('Content-Type') || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000',
          }
        });
      }
      proxyResp.body?.cancel();
    } catch (_) {}

    this.log.warn('Static resource not stored:', filename);
    return new Response('Resource not stored', {
      status: 404,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }
    });
  }

  /**
   * Handle widget HTML requests — check ContentStore via proxy
   */
  async _handleWidgetHtml(url) {
    this.log.info('Widget HTML request:', url.pathname);

    // Route to proxy ContentStore
    const parts = url.pathname.replace(BASE + '/cache/', '').split('/');
    const proxyUrl = `/store/${parts.join('/')}`;
    try {
      const proxyResp = await fetch(proxyUrl);
      if (proxyResp.ok) {
        return new Response(proxyResp.body, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000'
          }
        });
      }
    } catch (_) {}

    return new Response('<!DOCTYPE html><html><body>Widget not found</body></html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }
    });
  }
}
