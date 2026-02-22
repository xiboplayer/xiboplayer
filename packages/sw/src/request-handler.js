/**
 * RequestHandler - Handles fetch events for cached media
 *
 * Routes requests to appropriate handlers based on:
 * - Storage format (whole file vs chunked)
 * - Request type (GET, HEAD, Range)
 */

import {
  formatBytes,
  parseRangeHeader,
  getChunksForRange,
  extractRangeFromChunks,
  BASE
} from './sw-utils.js';
import { SWLogger } from './chunk-config.js';

export class RequestHandler {
  /**
   * @param {Object} downloadManager - DownloadManager instance
   * @param {import('./cache-manager.js').CacheManager} cacheManager
   * @param {import('./blob-cache.js').BlobCache} blobCache
   * @param {Object} [options]
   * @param {string} [options.staticCache='xibo-static-v1'] - Static cache name
   */
  constructor(downloadManager, cacheManager, blobCache, { staticCache = 'xibo-static-v1' } = {}) {
    this.downloadManager = downloadManager;
    this.cacheManager = cacheManager;
    this.blobCache = blobCache;
    this.staticCache = staticCache;
    this.pendingFetches = new Map(); // filename → Promise<Response> for deduplication
    this.log = new SWLogger('SW');

    // Pending chunk blob loads: chunkKey → Promise<Blob>
    // Coalesces concurrent reads for the same chunk into a single Cache API operation
    this.pendingChunkLoads = new Map();
  }

  /**
   * Route file request to appropriate handler based on storage format
   * Single source of truth for format detection and handler selection
   *
   * @param {string} cacheKey - Cache key (e.g., /player/pwa/cache/media/6)
   * @param {string} method - HTTP method ('GET' or 'HEAD')
   * @param {string|null} rangeHeader - Range header value or null
   * @returns {Promise<{found: boolean, handler: string, data: Object}>}
   */
  async routeFileRequest(cacheKey, method, rangeHeader) {
    // Check file existence and format (centralized API)
    const fileInfo = await this.cacheManager.fileExists(cacheKey);

    if (!fileInfo.exists) {
      return { found: false, handler: null, data: null };
    }

    // Route based on storage format and request type
    if (fileInfo.chunked) {
      // Chunked storage routing
      const data = { metadata: fileInfo.metadata, cacheKey };

      if (method === 'HEAD') {
        return { found: true, handler: 'head-chunked', data };
      }
      if (rangeHeader) {
        return { found: true, handler: 'range-chunked', data: { ...data, rangeHeader } };
      }
      // GET without Range - serve full file from chunks
      return { found: true, handler: 'full-chunked', data };

    } else {
      // Whole file storage routing
      const cached = await this.cacheManager.get(cacheKey);
      const data = { cached, cacheKey };

      if (method === 'HEAD') {
        return { found: true, handler: 'head-whole', data };
      }
      if (rangeHeader) {
        return { found: true, handler: 'range-whole', data: { ...data, rangeHeader } };
      }
      // GET without Range - serve whole file
      return { found: true, handler: 'full-whole', data };
    }
  }

  /**
   * Handle fetch request
   * - Serve from cache if available
   * - Wait for download if in progress
   * - Return 404 if not cached and not downloading
   */
  async handleRequest(event) {
    const url = new URL(event.request.url);
    this.log.info('handleRequest called for:', url.href);
    this.log.info('pathname:', url.pathname);

    // Handle static files (player pages)
    if (url.pathname === BASE + '/' ||
        url.pathname === BASE + '/index.html' ||
        url.pathname === BASE + '/setup.html') {
      const cache = await caches.open(this.staticCache);
      const cached = await cache.match(event.request);
      if (cached) {
        this.log.info('Serving static file from cache:', url.pathname);
        return cached;
      }
      // Fallback to network
      this.log.info('Fetching static file from network:', url.pathname);
      return fetch(event.request);
    }

    // Handle widget resources (bundle.min.js, fonts)
    // Uses pendingFetches for deduplication — concurrent requests share one fetch
    if ((url.pathname.includes('xmds.php') || url.pathname.includes('pwa/file')) &&
        (url.searchParams.get('fileType') === 'bundle' ||
         url.searchParams.get('fileType') === 'fontCss' ||
         url.searchParams.get('fileType') === 'font')) {
      const filename = url.searchParams.get('file');
      const cacheKey = `${BASE}/cache/static/${filename}`;
      const cache = await caches.open(this.staticCache);

      const cached = await cache.match(cacheKey);
      if (cached) {
        this.log.info('Serving widget resource from cache:', filename);
        return cached.clone();
      }

      // Check if another request is already fetching this resource
      if (this.pendingFetches.has(filename)) {
        this.log.info('Deduplicating widget resource fetch:', filename);
        const pending = await this.pendingFetches.get(filename);
        return pending.clone();
      }

      // Fetch from CMS with deduplication
      this.log.info('Fetching widget resource from CMS:', filename);
      const fetchPromise = (async () => {
        try {
          const response = await fetch(event.request);

          if (response.ok) {
            this.log.info('Caching widget resource:', filename, `(${response.headers.get('Content-Type')})`);
            const responseClone = response.clone();
            // AWAIT cache.put to prevent race condition
            await cache.put(cacheKey, responseClone);
            return response;
          } else {
            this.log.warn('Widget resource not available (', response.status, '):', filename, '- NOT caching');
            return response;
          }
        } catch (error) {
          this.log.error('Failed to fetch widget resource:', filename, error);
          return new Response('Failed to fetch widget resource', {
            status: 502,
            statusText: 'Bad Gateway',
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

    // Handle XMDS media requests (XLR compatibility + PWA file downloads)
    if ((url.pathname.includes('xmds.php') || url.pathname.includes('pwa/file')) && url.searchParams.has('file')) {
      const filename = url.searchParams.get('file');
      const fileId = filename.split('.')[0];
      const fileType = url.searchParams.get('type');
      const cacheType = fileType === 'L' ? 'layout' : 'media';

      this.log.info('XMDS request:', filename, 'type:', fileType, '→', BASE + '/cache/' + cacheType + '/' + fileId);

      const cacheKey = `${BASE}/cache/${cacheType}/${fileId}`;
      const cached = await this.cacheManager.get(cacheKey);
      if (cached) {
        // Clone the response to avoid consuming the body
        return new Response(cached.clone().body, {
          headers: {
            'Content-Type': cached.headers.get('Content-Type') || 'video/mp4',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000',
            'Accept-Ranges': 'bytes'
          }
        });
      }

      // Not cached - pass through to CMS
      this.log.info('XMDS file not cached, passing through:', filename);
      return fetch(event.request);
    }

    // Handle static widget resources (rewritten URLs from widget HTML)
    // These are absolute CMS URLs rewritten to /player/pwa/cache/static/<filename>
    if (url.pathname.startsWith(BASE + '/cache/static/')) {
      const filename = url.pathname.split('/').pop();
      this.log.info('Static resource request:', filename);

      // Try xibo-static-v1 first
      const staticCache = await caches.open(this.staticCache);
      const staticCached = await staticCache.match(`${BASE}/cache/static/${filename}`);
      if (staticCached) {
        this.log.info('Serving static resource from static cache:', filename);
        return staticCached.clone();
      }

      // Try xibo-media-v1 at the static path (dual-cached from download manager)
      const mediaCached = await this.cacheManager.get(url.pathname);
      if (mediaCached) {
        this.log.info('Serving static resource from media cache:', filename);
        return new Response(mediaCached.clone().body, {
          headers: {
            'Content-Type': mediaCached.headers.get('Content-Type') || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000'
          }
        });
      }

      // Not cached yet — return 404 (SW widget-resource fetch will cache it on first CMS hit)
      this.log.warn('Static resource not cached:', filename);
      return new Response('Resource not cached', { status: 404 });
    }

    // Only handle /player/pwa/cache/* requests below
    if (!url.pathname.startsWith(BASE + '/cache/')) {
      this.log.info('NOT a cache request, returning null:', url.pathname);
      return null; // Let browser handle
    }

    this.log.info('IS a cache request, proceeding...', url.pathname);

    // Handle widget data requests (pre-fetched JSON for RSS, dataset, etc.)
    if (url.pathname.startsWith(BASE + '/cache/data/')) {
      this.log.info('Widget data request:', url.pathname);
      const cached = await this.cacheManager.get(url.pathname);
      if (cached) {
        return new Response(cached.clone().body, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300'
          }
        });
      }
      return new Response('{"data":[],"meta":{}}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Handle widget HTML requests
    if (url.pathname.startsWith(BASE + '/cache/widget/')) {
      this.log.info('Widget HTML request:', url.pathname);
      const cached = await this.cacheManager.get(url.pathname);
      if (cached) {
        return new Response(cached.clone().body, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000'
          }
        });
      }
      return new Response('<!DOCTYPE html><html><body>Widget not found</body></html>', {
        status: 404,
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // Extract cache key: already in correct format /player/pwa/cache/media/123
    const cacheKey = url.pathname;
    const method = event.request.method;
    const rangeHeader = event.request.headers.get('Range');

    this.log.debug('Request URL:', url.pathname);
    this.log.debug('Cache key:', cacheKey);
    if (rangeHeader) {
      this.log.info(method, cacheKey, `Range: ${rangeHeader}`);
    } else {
      this.log.info(method, cacheKey);
    }

    // Use routing helper to determine how to serve this file
    const route = await this.routeFileRequest(cacheKey, method, rangeHeader);

    // If file exists, dispatch to appropriate handler
    if (route.found) {
      switch (route.handler) {
        case 'head-whole':
          return this.handleHeadWhole(route.data.cached?.headers.get('Content-Length'));

        case 'head-chunked':
          return this.handleHeadChunked(route.data.metadata, route.data.cacheKey);

        case 'range-whole':
          return this.handleRangeRequest(route.data.cached, route.data.rangeHeader, route.data.cacheKey);

        case 'range-chunked':
          return this.handleChunkedRangeRequest(route.data.cacheKey, route.data.rangeHeader, route.data.metadata);

        case 'full-whole':
          return this.handleFullWhole(route.data.cached, route.data.cacheKey);

        case 'full-chunked':
          return this.handleFullChunked(route.data.cacheKey, route.data.metadata);

        default:
          this.log.error('Unknown handler:', route.handler);
          return new Response('Internal error: unknown handler', { status: 500 });
      }
    }

    // File not found - check if download in progress
    const parts = cacheKey.split('/');
    const type = parts[2]; // 'media' or 'layout'
    const id = parts[3];

    let task = null;
    for (const [downloadUrl, activeTask] of this.downloadManager.queue.active.entries()) {
      if (activeTask.fileInfo.type === type && activeTask.fileInfo.id === id) {
        task = activeTask;
        break;
      }
    }

    if (task) {
      this.log.info('Download in progress, waiting:', cacheKey);

      try {
        await task.wait();

        // After download, re-route to serve the file
        const retryRoute = await this.routeFileRequest(cacheKey, method, rangeHeader);
        if (retryRoute.found) {
          this.log.info('Download complete, serving via', retryRoute.handler);

          switch (retryRoute.handler) {
            case 'full-whole':
              return this.handleFullWhole(retryRoute.data.cached, retryRoute.data.cacheKey);
            case 'full-chunked':
              return this.handleFullChunked(retryRoute.data.cacheKey, retryRoute.data.metadata);
            default:
              // For Range/HEAD after download, fall through to normal routing
              return this.handleRequest(event);  // Recursive call with fresh state
          }
        }
      } catch (error) {
        this.log.error('Download failed:', cacheKey, error);
        return new Response('Download failed: ' + error.message, { status: 500 });
      }
    }

    // Not cached and not downloading - return 404
    this.log.info('Not found:', cacheKey);
    return new Response('Not found', { status: 404 });
  }

  /**
   * Handle HEAD request for whole file
   */
  handleHeadWhole(size) {
    this.log.info('HEAD response: File exists (whole file)');
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Length': size ? size.toString() : '',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  /**
   * Handle HEAD request for chunked file.
   * Only reports 200 if chunk 0 is actually in cache (not just metadata).
   * Metadata-only means the progressive download has started but no data
   * is servable yet — the client should treat this as "not ready".
   */
  async handleHeadChunked(metadata, cacheKey) {
    const chunk0 = await this.cacheManager.getChunk(cacheKey, 0);
    if (!chunk0) {
      this.log.info('HEAD response: Chunked file not yet playable (chunk 0 missing):', cacheKey);
      return new Response(null, { status: 404 });
    }
    this.log.info('HEAD response: File exists (chunked)');
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Length': metadata.totalSize.toString(),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  /**
   * Handle full GET request for whole file (no Range)
   */
  handleFullWhole(cached, cacheKey) {
    const contentLength = cached.headers.get('Content-Length');
    const fileSize = contentLength ? formatBytes(parseInt(contentLength)) : 'unknown size';
    this.log.info('Serving from cache:', cacheKey, `(${fileSize})`);

    return new Response(cached.body, {
      headers: {
        'Content-Type': cached.headers.get('Content-Type') || 'application/octet-stream',
        'Content-Length': contentLength || '',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000'
      }
    });
  }

  /**
   * Handle full GET request for chunked file (no Range) - serve entire file as chunks
   */
  async handleFullChunked(cacheKey, metadata) {
    this.log.info('Chunked file GET without Range:', cacheKey, `- serving full file from ${metadata.numChunks} chunks`);

    // Serve entire file using synthetic range
    const syntheticRange = `bytes=0-${metadata.totalSize - 1}`;
    return this.handleChunkedRangeRequest(cacheKey, syntheticRange, metadata);
  }

  /**
   * Handle Range request for video seeking with blob caching
   * @param {Response} cachedResponse - Cached response from Cache API
   * @param {string} rangeHeader - Range header value (e.g., "bytes=0-1000")
   * @param {string} cacheKey - Cache key for blob cache lookup
   */
  async handleRangeRequest(cachedResponse, rangeHeader, cacheKey) {
    // Use blob cache to avoid re-materializing on every seek
    const blob = await this.blobCache.get(cacheKey, async () => {
      const cachedClone = cachedResponse.clone();
      return await cachedClone.blob();
    });

    const fileSize = blob.size;

    // Parse Range header using utility
    const { start, end } = parseRangeHeader(rangeHeader, fileSize);

    // Extract requested range (blob.slice is lazy - no copy!)
    const rangeBlob = blob.slice(start, end + 1);

    this.log.debug(`Range: bytes ${start}-${end}/${fileSize} (${formatBytes(rangeBlob.size)} of ${formatBytes(fileSize)})`);

    return new Response(rangeBlob, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': cachedResponse.headers.get('Content-Type') || 'video/mp4',
        'Content-Length': rangeBlob.size.toString(),
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  /**
   * Handle Range request for chunked files (load only required chunks)
   * @param {string} cacheKey - Base cache key
   * @param {string} rangeHeader - Range header
   * @param {Object} metadata - Chunk metadata
   */
  async handleChunkedRangeRequest(cacheKey, rangeHeader, metadata) {
    const { totalSize, chunkSize, numChunks, contentType } = metadata;

    // Parse Range header using utility
    const { start, end: parsedEnd } = parseRangeHeader(rangeHeader, totalSize);

    // Cap open-ended ranges (e.g., "bytes=0-") to a single chunk for progressive streaming,
    // but ONLY if some chunks are still missing. When all chunks from the start position
    // to the end of file are already cached, serve the full range to avoid sequential
    // chunk-by-chunk round-trips that can cause video stalls.
    let end = parsedEnd;
    const rangeStr = rangeHeader.replace(/bytes=/, '');
    const isOpenEnded = rangeStr.indexOf('-') === rangeStr.length - 1;
    if (isOpenEnded) {
      const startChunkIdx = Math.floor(start / chunkSize);
      const lastChunkIdx = numChunks - 1;

      // Check if all remaining chunks are cached (quick BlobCache check first, then Cache API)
      let allCached = true;
      for (let i = startChunkIdx; i <= lastChunkIdx; i++) {
        const chunkKey = `${cacheKey}/chunk-${i}`;
        if (this.blobCache.has(chunkKey)) continue;
        // Not in BlobCache — check Cache API
        const resp = await this.cacheManager.getChunk(cacheKey, i);
        if (!resp) {
          allCached = false;
          break;
        }
      }

      if (!allCached) {
        const cappedEnd = Math.min((startChunkIdx + 1) * chunkSize - 1, totalSize - 1);
        if (cappedEnd < end) {
          end = cappedEnd;
          this.log.info(`Progressive streaming: capping bytes=${start}- to chunk ${startChunkIdx} (bytes ${start}-${end}/${totalSize})`);
        }
      } else {
        this.log.info(`All chunks cached from ${startChunkIdx} to ${lastChunkIdx}, serving full range (bytes ${start}-${end}/${totalSize})`);
      }
    }

    // Calculate which chunks contain the requested range using utility
    const { startChunk, endChunk, count: chunksNeeded } = getChunksForRange(start, end, chunkSize);

    this.log.debug(`Chunked range: bytes ${start}-${end}/${totalSize} (chunks ${startChunk}-${endChunk}, ${chunksNeeded} chunks)`);

    // Load a single chunk, with coalescing + blob caching.
    // Returns the blob immediately if cached, or polls until available.
    const loadChunk = (i) => {
      const chunkKey = `${cacheKey}/chunk-${i}`;

      return this.blobCache.get(chunkKey, () => {
        // Coalesce: reuse in-flight Cache API read if another request is
        // already loading this exact chunk
        if (this.pendingChunkLoads.has(chunkKey)) {
          return this.pendingChunkLoads.get(chunkKey);
        }

        const loadPromise = (async () => {
          let chunkResponse = await this.cacheManager.getChunk(cacheKey, i);
          if (chunkResponse) return await chunkResponse.blob();

          // Chunk not yet stored — progressive download still running.
          // Signal emergency priority: video is stalled waiting for this chunk.
          // Moves it to front of queue with exclusive bandwidth.
          this.log.info(`Chunk ${i}/${numChunks} not yet available for ${cacheKey}, signalling urgent...`);
          {
            const keyParts = cacheKey.split('/');
            const urgentFileId = keyParts[keyParts.length - 1];
            const urgentFileType = keyParts[keyParts.length - 2];
            this.downloadManager.queue.urgentChunk(urgentFileType, urgentFileId, i);
          }

          // Poll with increasing backoff: 60 × 1s = 60s max wait.
          for (let retry = 0; retry < 60; retry++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            chunkResponse = await this.cacheManager.getChunk(cacheKey, i);
            if (chunkResponse) {
              this.log.info(`Chunk ${i}/${numChunks} arrived for ${cacheKey} after ${retry + 1}s`);
              return await chunkResponse.blob();
            }
          }
          throw new Error(`Chunk ${i} not available for ${cacheKey} after 60s`);
        })();

        this.pendingChunkLoads.set(chunkKey, loadPromise);
        loadPromise.finally(() => this.pendingChunkLoads.delete(chunkKey));
        return loadPromise;
      });
    };

    // Fast path: try to load all chunks immediately (no waiting).
    // If all are cached, serve the blob response synchronously.
    const immediateBlobs = [];
    let allImmediate = true;
    for (let i = startChunk; i <= endChunk; i++) {
      const chunkResponse = await this.cacheManager.getChunk(cacheKey, i);
      if (chunkResponse) {
        const chunkKey = `${cacheKey}/chunk-${i}`;
        const blob = await this.blobCache.get(chunkKey, async () => await chunkResponse.blob());
        immediateBlobs.push(blob);
      } else {
        allImmediate = false;
        break;
      }
    }

    if (allImmediate && immediateBlobs.length === chunksNeeded) {
      // All chunks available — serve immediately (common path for completed downloads)
      const rangeData = extractRangeFromChunks(immediateBlobs, start, end, chunkSize);
      this.log.debug(`Serving chunked range: ${formatBytes(rangeData.size)} from ${chunksNeeded} chunk(s)`);

      return new Response(rangeData, {
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'Content-Type': contentType,
          'Content-Length': rangeData.size.toString(),
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Slow path: some chunks still downloading. Return a 206 with a
    // ReadableStream body so Chrome sees a "slow" response (buffering
    // spinner) instead of an error. The stream pushes data as chunks arrive.
    this.log.info(`Streaming response for ${cacheKey} bytes ${start}-${end} (waiting for chunks)`);
    const rangeSize = end - start + 1;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Load all required chunks (with waiting for missing ones)
          const chunkBlobs = [];
          for (let i = startChunk; i <= endChunk; i++) {
            const blob = await loadChunk(i);
            chunkBlobs.push(blob);
          }

          // Extract the exact byte range and push to stream
          const rangeData = extractRangeFromChunks(chunkBlobs, start, end, chunkSize);
          const buffer = await rangeData.arrayBuffer();
          controller.enqueue(new Uint8Array(buffer));
          controller.close();
        } catch (err) {
          this.log.error(`Stream error for ${cacheKey}: ${err.message}`);
          controller.error(err);
        }
      }
    });

    return new Response(stream, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': contentType,
        'Content-Length': rangeSize.toString(),
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
