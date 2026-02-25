/**
 * MessageHandler - Handles postMessage from client
 *
 * Manages download orchestration, cache population, and progress reporting.
 * Uses XLF-driven media resolution to enqueue downloads in playback order.
 */

import { LayoutTaskBuilder, BARRIER, rewriteUrlForProxy } from '@xiboplayer/cache/download-manager';
import { formatBytes, BASE } from './sw-utils.js';
import { SWLogger } from './chunk-config.js';
import { extractMediaIdsFromXlf } from './xlf-parser.js';

/** Content-type map for static widget resources (JS, CSS, fonts, SVG) */
const STATIC_CONTENT_TYPES = {
  'js': 'application/javascript',
  'css': 'text/css',
  'otf': 'font/otf',
  'ttf': 'font/ttf',
  'woff': 'font/woff',
  'woff2': 'font/woff2',
  'eot': 'application/vnd.ms-fontobject',
  'svg': 'image/svg+xml'
};

export class MessageHandler {
  /**
   * @param {Object} downloadManager - DownloadManager instance
   * @param {import('./cache-manager.js').CacheManager} cacheManager
   * @param {import('./blob-cache.js').BlobCache} blobCache
   * @param {Object} config
   * @param {number} config.chunkSize - Chunk size in bytes
   * @param {number} config.chunkStorageThreshold - Files larger than this use chunked storage
   * @param {string} [config.cacheName='xibo-media-v1'] - Media cache name
   * @param {string} [config.staticCache='xibo-static-v1'] - Static cache name
   */
  constructor(downloadManager, cacheManager, blobCache, config) {
    this.downloadManager = downloadManager;
    this.cacheManager = cacheManager;
    this.blobCache = blobCache;
    this.config = {
      cacheName: 'xibo-media-v1',
      staticCache: 'xibo-static-v1',
      ...config
    };
    this.log = new SWLogger('SW Message');

    // Track in-progress chunk storage operations (cacheKey → Promise)
    // Prevents serving chunked files before chunks are fully written to cache
    this.pendingChunkStorage = new Map();
  }

  /**
   * Handle message from client
   */
  async handleMessage(event) {
    const { type, data } = event.data;

    // Log progress polls at debug (high-frequency), everything else at info
    if (type === 'GET_DOWNLOAD_PROGRESS') {
      this.log.debug('Received:', type);
    } else {
      this.log.info('Received:', type);
    }

    switch (type) {
      case 'PING':
        // Client is checking if SW is ready - broadcast SW_READY to caller
        this.log.info('PING received, broadcasting SW_READY');
        // Send SW_READY back to the client that sent PING
        const clients = await self.clients.matchAll();
        clients.forEach(client => {
          client.postMessage({ type: 'SW_READY' });
        });
        return { success: true };

      case 'DOWNLOAD_FILES':
        return await this.handleDownloadFiles(data);

      case 'PRIORITIZE_DOWNLOAD':
        return this.handlePrioritizeDownload(data.fileType, data.fileId);

      case 'CLEAR_CACHE':
        return await this.handleClearCache();

      case 'GET_DOWNLOAD_PROGRESS':
        return await this.handleGetProgress();

      case 'DELETE_FILES':
        return await this.handleDeleteFiles(data.files);

      case 'PREWARM_VIDEO_CHUNKS':
        return await this.handlePrewarmVideoChunks(data.mediaIds);

      case 'PRIORITIZE_LAYOUT_FILES':
        this.downloadManager.prioritizeLayoutFiles(data.mediaIds);
        return { success: true };

      case 'URGENT_CHUNK':
        return this.handleUrgentChunk(data.fileType, data.fileId, data.chunkIndex);

      case 'GET_ALL_FILES':
        return await this.handleGetAllFiles();

      default:
        this.log.warn('Unknown message type:', type);
        return { success: false, error: 'Unknown message type' };
    }
  }

  /**
   * Handle DELETE_FILES message - purge obsolete files from cache
   */
  async handleDeleteFiles(files) {
    if (!files || !Array.isArray(files)) {
      return { success: false, error: 'No files provided' };
    }

    let deleted = 0;
    for (const file of files) {
      const cacheKey = `${BASE}/cache/${file.type}/${file.id}`;
      const wasDeleted = await this.cacheManager.delete(cacheKey);
      if (wasDeleted) {
        this.log.info('Purged:', cacheKey);
        deleted++;
      } else {
        this.log.debug('Not cached (skip purge):', cacheKey);
      }
    }

    this.log.info(`Purge complete: ${deleted}/${files.length} files deleted`);
    return { success: true, deleted, total: files.length };
  }

  /**
   * Handle PREWARM_VIDEO_CHUNKS - pre-load first and last chunks into BlobCache
   * for faster video startup (avoids IndexedDB reads on initial Range requests)
   */
  async handlePrewarmVideoChunks(mediaIds) {
    if (!mediaIds || !Array.isArray(mediaIds) || mediaIds.length === 0) {
      return { success: false, error: 'No mediaIds provided' };
    }

    let warmed = 0;
    for (const mediaId of mediaIds) {
      const cacheKey = `${BASE}/cache/media/${mediaId}`;
      const metadata = await this.cacheManager.getMetadata(cacheKey);

      if (metadata?.chunked) {
        // Chunked file: pre-warm first chunk (ftyp/mdat) and last chunk (moov atom)
        const lastChunk = metadata.numChunks - 1;
        const chunksToWarm = [0];
        if (lastChunk > 0) chunksToWarm.push(lastChunk);

        for (const idx of chunksToWarm) {
          const chunkKey = `${cacheKey}/chunk-${idx}`;
          // Load into BlobCache (no-op if already cached)
          await this.blobCache.get(chunkKey, async () => {
            const resp = await this.cacheManager.getChunk(cacheKey, idx);
            if (!resp) return new Blob(); // shouldn't happen for cached media
            return await resp.blob();
          });
        }
        this.log.info(`Pre-warmed ${chunksToWarm.length} chunks for media ${mediaId} (${metadata.numChunks} total)`);
        warmed++;
      } else {
        // Whole file: pre-warm entire blob
        const cached = await this.cacheManager.get(cacheKey);
        if (cached) {
          await this.blobCache.get(cacheKey, async () => await cached.clone().blob());
          this.log.info(`Pre-warmed whole file for media ${mediaId}`);
          warmed++;
        }
      }
    }

    return { success: true, warmed, total: mediaIds.length };
  }

  /**
   * Handle PRIORITIZE_DOWNLOAD - move file to front of download queue
   */
  handlePrioritizeDownload(fileType, fileId) {
    this.log.info('Prioritize request:', `${fileType}/${fileId}`);
    const found = this.downloadManager.queue.prioritize(fileType, fileId);
    // Trigger queue processing in case there's capacity
    this.downloadManager.queue.processQueue();
    return { success: true, found };
  }

  /**
   * Handle URGENT_CHUNK — emergency priority for a stalled streaming chunk.
   * External path (main thread can signal via postMessage).
   */
  handleUrgentChunk(fileType, fileId, chunkIndex) {
    this.log.info('Urgent chunk request:', `${fileType}/${fileId}`, 'chunk', chunkIndex);
    const acted = this.downloadManager.queue.urgentChunk(fileType, fileId, chunkIndex);
    return { success: true, acted };
  }

  /**
   * Handle DOWNLOAD_FILES with XLF-driven media resolution.
   *
   * Accepts { layoutOrder: number[], files: Array, layoutDependants: Object } from PlayerCore.
   * Builds lookup maps from the flat CMS file list, fetches/parses XLFs to
   * discover which media each layout needs, then enqueues per-layout chunks
   * with barriers in playback order.
   *
   * layoutDependants maps layoutId → filenames (from CMS schedule dependants).
   * Used to claim sub-playlist media into the parent layout's download batch.
   *
   * @param {{ layoutOrder: number[], files: Array, layoutDependants?: Object }} payload
   */
  async handleDownloadFiles({ layoutOrder, files, layoutDependants }) {
    const dm = this.downloadManager;
    const queue = dm.queue;
    let enqueuedCount = 0;
    const enqueuedTasks = [];

    // Build lookup maps from flat CMS file list
    const xlfFiles = new Map();     // layoutId → file entry (for XLF download URL)
    const resources = [];            // fonts, bundle.min.js etc.
    const mediaFiles = new Map();    // mediaId (string) → file entry
    for (const f of files) {
      if (f.type === 'layout') {
        xlfFiles.set(parseInt(f.id), f);
      } else if (f.type === 'resource' || f.code === 'fonts.css'
          || (f.path && (f.path.includes('bundle.min') || f.path.includes('fonts')))) {
        resources.push(f);
      } else {
        // Flag widget data files (getData) for longer retry backoff.
        // CMS returns HTTP 500 "cache not ready" until the XTR task runs.
        if (f.path && f.path.includes('getData')) {
          f.isGetData = true;
        }
        mediaFiles.set(String(f.id), f);
      }
    }

    this.log.info(`Download: ${layoutOrder.length} layouts, ${mediaFiles.size} media, ${resources.length} resources`);

    // ── Step 1: Fetch + cache + parse all XLFs directly (parallel) ──
    const layoutMediaMap = new Map(); // layoutId → Set<mediaId>
    const xlfPromises = [];
    for (const layoutId of layoutOrder) {
      const xlfFile = xlfFiles.get(layoutId);
      if (!xlfFile?.path) continue;

      xlfPromises.push((async () => {
        const cacheKey = `${BASE}/cache/layout/${layoutId}`;
        const existing = await this.cacheManager.get(cacheKey);
        let xlfText;
        if (existing) {
          xlfText = await existing.clone().text();
        } else {
          const resp = await fetch(rewriteUrlForProxy(xlfFile.path));
          if (!resp.ok) { this.log.warn(`XLF fetch failed: ${layoutId} (${resp.status})`); return; }
          const blob = await resp.blob();
          await this.cacheManager.put(cacheKey, blob, 'text/xml');
          this.log.info(`Fetched + cached XLF ${layoutId} (${blob.size} bytes)`);
          // Notify clients so pending layouts can clear
          const clients = await self.clients.matchAll();
          clients.forEach(c => c.postMessage({ type: 'FILE_CACHED', fileId: String(layoutId), fileType: 'layout', size: blob.size }));
          xlfText = await blob.text();
        }
        layoutMediaMap.set(layoutId, extractMediaIdsFromXlf(xlfText, this.log));
      })());
    }
    // Also fetch XLFs NOT in layoutOrder (non-scheduled layouts, e.g. default)
    for (const [layoutId, xlfFile] of xlfFiles) {
      if (layoutOrder.includes(layoutId)) continue;
      xlfPromises.push((async () => {
        const cacheKey = `${BASE}/cache/layout/${layoutId}`;
        const existing = await this.cacheManager.get(cacheKey);
        if (!existing && xlfFile.path) {
          const resp = await fetch(rewriteUrlForProxy(xlfFile.path));
          if (resp.ok) {
            const blob = await resp.blob();
            await this.cacheManager.put(cacheKey, blob, 'text/xml');
            this.log.info(`Fetched + cached XLF ${layoutId} (non-scheduled, ${blob.size} bytes)`);
            const clients = await self.clients.matchAll();
            clients.forEach(c => c.postMessage({ type: 'FILE_CACHED', fileId: String(layoutId), fileType: 'layout', size: blob.size }));
            const xlfText = await blob.text();
            layoutMediaMap.set(layoutId, extractMediaIdsFromXlf(xlfText, this.log));
          }
        } else if (existing) {
          const xlfText = await existing.clone().text();
          layoutMediaMap.set(layoutId, extractMediaIdsFromXlf(xlfText, this.log));
        }
      })());
    }
    await Promise.allSettled(xlfPromises);
    this.log.info(`Parsed ${layoutMediaMap.size} XLFs`);

    // ── Step 2: Enqueue resources ──
    const resourceBuilder = new LayoutTaskBuilder(queue);
    for (const file of resources) {
      const enqueued = await this._enqueueFile(dm, resourceBuilder, file, enqueuedTasks);
      if (enqueued) enqueuedCount++;
    }
    const resourceTasks = await resourceBuilder.build();
    if (resourceTasks.length > 0) {
      resourceTasks.push(BARRIER);
      queue.enqueueOrderedTasks(resourceTasks);
    }

    // ── Step 3: For each layout in play order, merge XLF + non-scheduled + dependants ──
    const claimed = new Set(); // Track media IDs already claimed by a layout

    // Non-scheduled layouts (sub-playlists, overlays, default) — their media
    // should download alongside the scheduled layout that uses them.
    const nonScheduledIds = [...layoutMediaMap.keys()].filter(id => !layoutOrder.includes(id));

    // Build reverse lookup: filename → mediaId (for dependants matching).
    // Dependant filenames from the CMS schedule (e.g. "11.pdf") match the
    // saveAs field on RequiredFiles entries.
    const filenameToMediaId = new Map();
    for (const [id, file] of mediaFiles) {
      if (file.saveAs) {
        filenameToMediaId.set(file.saveAs, id);
      }
    }

    // Convert layoutDependants (plain object from postMessage) to a Map
    const depMap = new Map();
    if (layoutDependants) {
      for (const [id, filenames] of Object.entries(layoutDependants)) {
        depMap.set(parseInt(id, 10), filenames);
      }
    }

    for (const layoutId of layoutOrder) {
      const xlfMediaIds = layoutMediaMap.get(layoutId);
      if (!xlfMediaIds) continue;

      // Merge three sources of media for this layout:
      // 1. XLF-extracted media IDs (direct references in the layout's XLF)
      // 2. Non-scheduled layout media (sub-playlists, overlays whose XLFs
      //    are separate but whose media is needed when this layout plays)
      // 3. Dependant filenames (CMS-declared files needed before playback)
      const allMediaIds = new Set(xlfMediaIds);
      for (const nsId of nonScheduledIds) {
        const nsMediaIds = layoutMediaMap.get(nsId);
        if (nsMediaIds) {
          for (const id of nsMediaIds) allMediaIds.add(id);
        }
      }
      const deps = depMap.get(layoutId) || [];
      for (const filename of deps) {
        const mediaId = filenameToMediaId.get(filename);
        if (mediaId) allMediaIds.add(mediaId);
      }

      const matched = [];
      for (const id of allMediaIds) {
        if (claimed.has(id)) continue; // Already claimed by earlier layout
        const file = mediaFiles.get(id);
        if (file) {
          matched.push(file);
          claimed.add(id);
        }
      }
      if (matched.length === 0) continue;

      this.log.info(`Layout ${layoutId}: ${matched.length} media`);
      matched.sort((a, b) => (a.size || 0) - (b.size || 0));
      const builder = new LayoutTaskBuilder(queue);
      for (const file of matched) {
        const enqueued = await this._enqueueFile(dm, builder, file, enqueuedTasks);
        if (enqueued) enqueuedCount++;
      }
      const orderedTasks = await builder.build();
      if (orderedTasks.length > 0) {
        orderedTasks.push(BARRIER);
        queue.enqueueOrderedTasks(orderedTasks);
      }
    }

    // Enqueue unclaimed media (in CMS file list but not referenced by any XLF)
    // This includes widget data files (enriched from type=widget to type=media)
    // and any other files the CMS wants the player to have.
    const unclaimed = [...mediaFiles.keys()].filter(id => !claimed.has(id));
    if (unclaimed.length > 0) {
      this.log.info(`${unclaimed.length} media not in any XLF: ${unclaimed.join(', ')}`);
      const builder = new LayoutTaskBuilder(queue);
      for (const id of unclaimed) {
        const file = mediaFiles.get(id);
        if (file) {
          const enqueued = await this._enqueueFile(dm, builder, file, enqueuedTasks);
          if (enqueued) enqueuedCount++;
        }
      }
      const orderedTasks = await builder.build();
      if (orderedTasks.length > 0) {
        queue.enqueueOrderedTasks(orderedTasks);
      }
    }

    const activeCount = queue.running;
    const queuedCount = queue.queue.length;
    this.log.info('Downloads active:', activeCount, ', queued:', queuedCount);
    return { success: true, enqueuedCount, activeCount, queuedCount };
  }

  /**
   * Enqueue a single file for download (shared by phase 1 and phase 2).
   * Handles cache checks, dedup, and incomplete chunked resume.
   * @returns {boolean} true if file was enqueued (new download)
   */
  async _enqueueFile(dm, builder, file, enqueuedTasks) {
    // Skip files with no path
    if (!file.path || file.path === 'null' || file.path === 'undefined') {
      this.log.debug('Skipping file with no path:', file.id);
      return false;
    }

    const cacheKey = `${BASE}/cache/${file.type}/${file.id}`;

    // Check if already cached (supports both whole files and chunked storage)
    const fileInfo = await this.cacheManager.fileExists(cacheKey);
    if (fileInfo.exists) {
      // For chunked files, verify download actually completed
      if (fileInfo.chunked && fileInfo.metadata && !fileInfo.metadata.complete) {
        const { numChunks } = fileInfo.metadata;
        const skipChunks = new Set();
        for (let j = 0; j < numChunks; j++) {
          const chunk = await this.cacheManager.getChunk(cacheKey, j);
          if (chunk) skipChunks.add(j);
        }

        if (skipChunks.size === numChunks) {
          this.log.info('All chunks present but metadata incomplete, marking complete:', cacheKey);
          fileInfo.metadata.complete = true;
          await this.cacheManager.updateMetadata(cacheKey, fileInfo.metadata);
          return false;
        }

        this.log.info(`Incomplete chunked download: ${skipChunks.size}/${numChunks} chunks cached, resuming:`, cacheKey);
        file.skipChunks = skipChunks;
      } else {
        this.log.debug('File already cached:', cacheKey, fileInfo.chunked ? '(chunked)' : '(whole file)');
        await this.ensureStaticCacheEntry(file);
        return false;
      }
    }

    // Check if already downloading
    const stableKey = `${file.type}/${file.id}`;
    const activeTask = dm.getTask(stableKey);
    if (activeTask) {
      this.log.debug('File already downloading:', stableKey, '- skipping duplicate');
      return false;
    }

    const fileDownload = builder.addFile(file);
    // Only set up caching callback for NEW files (not deduped)
    if (fileDownload.state === 'pending') {
      const cachePromise = this.cacheFileAfterDownload(fileDownload, file);
      enqueuedTasks.push(cachePromise);
      return true;
    }
    return false;
  }

  /**
   * Cache file after download completes.
   * For large files (> chunkStorageThreshold): uses PROGRESSIVE caching —
   *   each chunk is stored to cache as soon as it downloads from the CMS,
   *   metadata is written after the HEAD request, and the client is notified
   *   after the first chunk so video playback can start immediately.
   * For small files: traditional whole-file caching.
   */
  async cacheFileAfterDownload(task, fileInfo) {
    try {
      const cacheKey = `${BASE}/cache/${fileInfo.type}/${fileInfo.id}`;
      const contentType = fileInfo.type === 'layout' ? 'text/xml' :
                          fileInfo.type === 'widget' ? 'text/html' :
                          'application/octet-stream';

      // Large files: progressive chunk caching (stream while downloading)
      const fileSize = parseInt(fileInfo.size) || 0;
      if (fileSize > this.config.chunkStorageThreshold) {
        return await this._progressiveCacheFile(task, fileInfo, cacheKey, contentType, fileSize);
      }

      // Small files: wait for full download, then cache whole file
      const blob = await task.wait();

      await this.cacheManager.put(cacheKey, blob, contentType);
      this.log.info('Cached after download:', cacheKey, `(${blob.size} bytes)`);

      // Cache widget resources (.js, .css, fonts) for static serving
      // Must complete before notifying clients — widgets load immediately after FILE_CACHED
      await this._cacheStaticResource(fileInfo, blob);

      // Notify all clients that file is cached
      const clients = await self.clients.matchAll();
      clients.forEach(client => {
        client.postMessage({
          type: 'FILE_CACHED',
          fileId: fileInfo.id,
          fileType: fileInfo.type,
          size: blob.size
        });
      });

      // Now safe to remove from active — file is in cache, won't be re-enqueued
      this.downloadManager.queue.removeCompleted(`${fileInfo.type}/${fileInfo.id}`);

      return blob;
    } catch (error) {
      this.log.error('Failed to cache after download:', fileInfo.id, error);
      this.downloadManager.queue.removeCompleted(`${fileInfo.type}/${fileInfo.id}`);
      throw error;
    }
  }

  /**
   * Progressive chunk caching: store each chunk to cache as it downloads.
   * Video can start playing after first chunk + metadata are stored.
   */
  async _progressiveCacheFile(task, fileInfo, cacheKey, contentType, fileSize) {
    const { chunkSize, cacheName } = this.config;
    const cache = await caches.open(cacheName);
    let chunksStored = 0;
    let clientNotified = false;

    // Compute expected chunk count from declared file size
    const expectedChunks = Math.ceil(fileSize / chunkSize);
    this.log.info(`Progressive download: ${cacheKey} (${formatBytes(fileSize)}, ~${expectedChunks} chunks)`);

    // Store metadata NOW based on declared file size so Range requests can
    // start working as soon as the first chunk lands in cache
    const metadata = {
      totalSize: fileSize,
      chunkSize,
      numChunks: expectedChunks,
      contentType,
      chunked: true,
      complete: false,
      createdAt: Date.now()
    };

    await cache.put(`${cacheKey}/metadata`, new Response(
      JSON.stringify(metadata),
      { headers: { 'Content-Type': 'application/json' } }
    ));
    // Also populate in-memory cache so Range requests skip Cache API lookup
    this.cacheManager.metadataCache.set(cacheKey, metadata);
    this.log.info('Metadata stored, ready for progressive streaming:', cacheKey);

    // Hook into DownloadTask's chunk-by-chunk download.
    // Each chunk gets stored to Cache API the moment it arrives from the CMS,
    // so handleChunkedRangeRequest() can serve it immediately.
    task.onChunkDownloaded = async (chunkIndex, chunkBlob, totalChunks) => {
      // Store chunk to cache immediately
      const chunkResponse = new Response(chunkBlob, {
        headers: {
          'Content-Type': contentType,
          'Content-Length': chunkBlob.size,
          'X-Chunk-Index': chunkIndex,
          'X-Total-Chunks': totalChunks
        }
      });
      await cache.put(`${cacheKey}/chunk-${chunkIndex}`, chunkResponse);
      chunksStored++;

      if (chunksStored % 2 === 0 || chunksStored === totalChunks) {
        this.log.info(`Progressive: chunk ${chunksStored}/${totalChunks} cached for ${fileInfo.id}`);
      }

      // Notify client when key chunks arrive for early playback:
      // - chunk 0: ftyp/mdat header (first bytes of file)
      // - last chunk: moov atom (MP4 structure, needed by browser before playback)
      // Download manager sends these two first (out-of-order priority).
      if (!clientNotified && (chunkIndex === 0 || chunkIndex === totalChunks - 1)) {
        // Only notify once both chunk 0 AND last chunk are stored
        const hasChunk0 = chunkIndex === 0 || await this.cacheManager.getChunk(cacheKey, 0);
        const hasLastChunk = chunkIndex === totalChunks - 1 || await this.cacheManager.getChunk(cacheKey, totalChunks - 1);

        if (hasChunk0 && hasLastChunk) {
          clientNotified = true;
          const clients = await self.clients.matchAll();
          clients.forEach(client => {
            client.postMessage({
              type: 'FILE_CACHED',
              fileId: fileInfo.id,
              fileType: fileInfo.type,
              size: fileSize,
              progressive: true,
              chunksReady: chunksStored,
              totalChunks
            });
          });
          this.log.info('Chunk 0 + last chunk cached — client notified, early playback ready:', cacheKey);
        }
      }

      // Update metadata with actual chunk count if it differs (edge case)
      if (totalChunks !== expectedChunks) {
        metadata.numChunks = totalChunks;
        await cache.put(`${cacheKey}/metadata`, new Response(
          JSON.stringify(metadata),
          { headers: { 'Content-Type': 'application/json' } }
        ));
      }
    };

    // Wait for DownloadTask to finish (all chunks downloaded + callbacks fired).
    // When onChunkDownloaded was used, task.wait() returns an empty Blob
    // (data is already stored to cache chunk by chunk).
    // When downloadFull was used instead (actual size < threshold), returns the full Blob.
    const downloadedBlob = await task.wait();

    // If the callback never fired (actual file smaller than DownloadTask's chunk
    // threshold), use the already-downloaded blob instead of re-fetching.
    if (chunksStored === 0) {
      this.log.warn('Progressive callback never fired, falling back to putChunked:', cacheKey);

      if (downloadedBlob.size > 0) {
        // Full blob available from downloadFull path — cache it
        await this.cacheManager.putChunked(cacheKey, downloadedBlob, contentType);
      } else {
        // Truly empty — should never happen, but cache whole file as safety net
        await this.cacheManager.put(cacheKey, downloadedBlob, contentType);
      }

      // Notify client
      const clients = await self.clients.matchAll();
      clients.forEach(client => {
        client.postMessage({
          type: 'FILE_CACHED',
          fileId: fileInfo.id,
          fileType: fileInfo.type,
          size: downloadedBlob.size || fileSize
        });
      });
      this.downloadManager.queue.removeCompleted(`${fileInfo.type}/${fileInfo.id}`);
      return downloadedBlob;
    }

    // URL expired mid-download: some chunks cached, but not all.
    // Don't mark complete — next collection cycle resumes with fresh URLs.
    if (task._urlExpired) {
      this.log.warn(`URL expired mid-download, partial cache: ${cacheKey} (${chunksStored}/${expectedChunks} chunks stored)`);
      this.downloadManager.queue.removeCompleted(`${fileInfo.type}/${fileInfo.id}`);
      return new Blob([], { type: contentType });
    }

    this.log.info(`Progressive download complete: ${cacheKey} (${chunksStored} chunks stored)`);

    // Mark metadata as complete — this is the commit point.
    // Until this flag is set, the file is considered incomplete and will be
    // resumed (not re-downloaded) on the next collection cycle.
    metadata.complete = true;
    await this.cacheManager.updateMetadata(cacheKey, metadata);

    // Notify client with final complete state
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({
        type: 'FILE_CACHED',
        fileId: fileInfo.id,
        fileType: fileInfo.type,
        size: fileSize,
        complete: true
      });
    });

    // Remove from pending storage tracker (all chunks are already stored)
    this.pendingChunkStorage.delete(cacheKey);

    // Now safe to remove from active — all chunks are in cache
    this.downloadManager.queue.removeCompleted(`${fileInfo.type}/${fileInfo.id}`);

    return new Blob([], { type: contentType }); // Data is in cache, not in memory
  }

  /**
   * Cache widget static resources (.js, .css, fonts) alongside the media cache
   */
  async _cacheStaticResource(fileInfo, blob) {
    const filename = fileInfo.path ? (() => {
      try { return new URL(fileInfo.path).searchParams.get('file'); } catch { return null; }
    })() : null;

    if (filename && (filename.endsWith('.js') || filename.endsWith('.css') ||
        /\.(otf|ttf|woff2?|eot|svg)$/i.test(filename))) {

      try {
        const staticCache = await caches.open(this.config.staticCache);
        const staticKey = `${BASE}/cache/static/${filename}`;

        const ext = filename.split('.').pop().toLowerCase();
        const staticContentType = STATIC_CONTENT_TYPES[ext] || 'application/octet-stream';

        await Promise.all([
          staticCache.put(staticKey, new Response(blob.slice(0, blob.size, blob.type), {
            headers: { 'Content-Type': staticContentType }
          })),
          this.cacheManager.put(staticKey, blob.slice(0, blob.size, blob.type), staticContentType)
        ]);

        this.log.info('Also cached as static resource:', filename, `(${staticContentType})`);
      } catch (e) {
        this.log.warn('Failed to cache static resource:', filename, e);
      }
    }
  }

  /**
   * Ensure widget resource files have static cache entries.
   *
   * NOTE: This no longer copies from the media/dependency cache because
   * dependency files can share the same id (e.g. bundle.min.js and fonts.css
   * are both dependency/1), causing content corruption. Static resources are
   * now cached correctly by widget-html.js on the main thread via the proxy.
   * This method only logs a debug message for traceability.
   */
  async ensureStaticCacheEntry(fileInfo) {
    // No-op: static caching is handled by widget-html.js (main thread)
  }

  /**
   * Handle GET_ALL_FILES message — enumerate all cached files
   */
  async handleGetAllFiles() {
    const files = await this.cacheManager.getAllFiles();
    return { success: true, files };
  }

  /**
   * Handle CLEAR_CACHE message
   */
  async handleClearCache() {
    this.log.info('Clearing cache');
    await this.cacheManager.clear();
    return { success: true };
  }

  /**
   * Handle GET_DOWNLOAD_PROGRESS message
   */
  async handleGetProgress() {
    const progress = this.downloadManager.getProgress();
    return { success: true, progress };
  }
}
