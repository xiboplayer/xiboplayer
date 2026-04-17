/**
 * Service Worker for Xibo PWA Player
 *
 * Supports two modes:
 * - Proxy mode (Electron/Chromium on localhost): passes through to Node.js proxy
 * - Browser mode (PWA on CMS): cache-through via ContentStoreBrowser
 *
 * Mode is auto-detected from the origin hostname.
 */

import { DownloadManager } from '@xiboplayer/cache/download-manager';
import { VERSION as CACHE_VERSION } from '@xiboplayer/cache';
import {
  RequestHandler,
  RequestHandlerBrowser,
  MessageHandler,
  calculateChunkConfig
} from '@xiboplayer/sw';
import { ContentStoreBrowser } from '@xiboplayer/sw/content-store-browser';
import { createLogger } from '@xiboplayer/utils';
import { BASE } from '@xiboplayer/sw/utils';

// ── Configuration ──────────────────────────────────────────────────────────
const SW_VERSION = __BUILD_DATE__;
const log = createLogger('SW');

// Auto-detect mode: proxy (localhost) vs browser (CMS server)
const isProxyMode = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';
log.info(`Mode: ${isProxyMode ? 'proxy' : 'browser'} (${self.location.hostname})`);

// ── Device-adaptive chunk config ───────────────────────────────────────────
const CHUNK_CONFIG = calculateChunkConfig(log);

log.info('Loading Service Worker:', SW_VERSION);

// ── Initialize shared instances ────────────────────────────────────────────
const downloadManager = new DownloadManager({
  concurrency: CHUNK_CONFIG.concurrency,
  chunkSize: CHUNK_CONFIG.chunkSize,
  chunksPerFile: 2
});

let requestHandler;
let contentStore = null;

if (isProxyMode) {
  // Proxy mode — pass through to Node.js Express server
  requestHandler = new RequestHandler(downloadManager);
} else {
  // Browser mode — use CacheStorage backend
  contentStore = new ContentStoreBrowser();
  requestHandler = new RequestHandlerBrowser(contentStore);
}

const messageHandler = new MessageHandler(downloadManager, {
  chunkSize: CHUNK_CONFIG.chunkSize,
  chunkStorageThreshold: CHUNK_CONFIG.threshold
});

// ── Interactive Control handler ──────────────────────────────────────────

async function handleInteractiveControl(event) {
  const url = new URL(event.request.url);
  const icPath = url.pathname.replace(BASE + '/ic', '');
  const method = event.request.method;

  log.info('Interactive Control request:', method, icPath);

  let body = null;
  if (method === 'POST' || method === 'PUT') {
    try { body = await event.request.text(); } catch (_) {}
  }

  const clients = await self.clients.matchAll({ type: 'window' });
  if (clients.length === 0) {
    return new Response(JSON.stringify({ error: 'No active player' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const response = await new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => reject(new Error('IC timeout')), 5000);
      channel.port1.onmessage = (msg) => { clearTimeout(timer); resolve(msg.data); };
      clients[0].postMessage({
        type: 'INTERACTIVE_CONTROL', method, path: icPath, search: url.search, body
      }, [channel.port2]);
    });

    return new Response(response.body || '', {
      status: response.status || 200,
      headers: { 'Content-Type': response.contentType || 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    log.error('IC handler error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// ── Lifecycle: Install ─────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  log.info('Installing... Version:', SW_VERSION);
  event.waitUntil(
    (async () => {
      if (self.registration.active) {
        try {
          const versionCache = await caches.open('xibo-sw-version');
          const stored = await versionCache.match('version');
          if (stored) {
            const activeVersion = await stored.text();
            if (activeVersion === SW_VERSION) {
              log.info('Same version already active, skipping activation');
              return;
            }
            log.info('Version changed:', activeVersion, '→', SW_VERSION);
          }
        } catch (_) {}
      }
      log.info('New version, activating immediately');
      return self.skipWaiting();
    })()
  );
});

// ── Lifecycle: Activate ────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  log.info('Activating... Version:', SW_VERSION, '| cache:', CACHE_VERSION);
  event.waitUntil(
    (async () => {
      // Initialize browser ContentStore if in browser mode
      if (contentStore) {
        await contentStore.init();
        log.info('Browser ContentStore initialized');
      }

      // Store version
      const versionCache = await caches.open('xibo-sw-version');
      await versionCache.put('version', new Response(SW_VERSION));

      // Take control
      log.info('Taking control of all clients');
      await self.clients.claim();

      // Notify clients
      const clients = await self.clients.matchAll();
      clients.forEach(client => client.postMessage({ type: 'SW_READY' }));
    })()
  );
});

// ── Fetch handler ──────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Interactive Control
  if (url.pathname.startsWith(BASE + '/ic/')) {
    event.respondWith(handleInteractiveControl(event));
    return;
  }

  if (isProxyMode) {
    // Proxy mode — only intercept XMDS and HTML
    const shouldIntercept =
      (url.pathname.startsWith('/player/') && (url.pathname.endsWith('.html') || url.pathname === '/player/')) ||
      (url.pathname.includes('xmds.php') && url.searchParams.has('file') && event.request.method === 'GET');

    if (shouldIntercept) {
      event.respondWith(requestHandler.handleRequest(event));
    }
  } else {
    // Browser mode — intercept API requests for cache-through
    const shouldIntercept =
      url.pathname.startsWith('/player/api/v2/') ||
      url.pathname.startsWith('/player/') && (url.pathname.endsWith('.html') || url.pathname === '/player/') ||
      (url.pathname.includes('xmds.php') && url.searchParams.has('file'));

    if (shouldIntercept) {
      event.respondWith(requestHandler.handleRequest(event));
    }
  }
});

// ── Message handler ────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  // SW ↔ main-thread AUTH_TOKEN protocol. See the top-of-file JSDoc
  // on RequestHandlerBrowser (packages/sw/src/request-handler-browser.js)
  // for the full contract — shape, token lifecycle, proxy-mode gating,
  // and acknowledgement semantics.
  //
  // `!isProxyMode` is the important guard: in proxy mode the legacy
  // RequestHandler is assigned to `requestHandler` and it does NOT
  // implement setAuthToken(). Dispatching would throw.
  if (event.data?.type === 'AUTH_TOKEN' && !isProxyMode) {
    requestHandler.setAuthToken(event.data.token);
    log.info('Auth token updated from main thread');
    event.ports[0]?.postMessage({ ok: true });
    return;
  }

  event.waitUntil(
    messageHandler.handleMessage(event).then((result) => {
      event.ports[0]?.postMessage(result);
    })
  );
});

log.info('Service Worker ready');
