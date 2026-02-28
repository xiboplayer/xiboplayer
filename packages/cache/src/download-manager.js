/**
 * DownloadManager - Flat queue download orchestration
 *
 * Works in both browser and Service Worker contexts.
 * Handles download queue, concurrency control, parallel chunks, and MD5 verification.
 *
 * Architecture (flat queue):
 * - DownloadTask: Single HTTP fetch unit (one GET request — full file or one chunk)
 * - FileDownload: Orchestrator that creates DownloadTasks for a file (HEAD + chunks)
 * - DownloadQueue: Flat queue where every download unit competes equally for connection slots
 * - DownloadManager: Public facade
 *
 * BEFORE:  Queue[File, File, File] → each File internally spawns N chunk fetches
 * AFTER:   Queue[chunk, chunk, file, chunk, chunk, file, chunk] → flat, 1 fetch per slot
 *
 * This eliminates the two-layer concurrency problem where N files × M chunks per file
 * could exceed Chromium's 6-per-host connection limit, causing head-of-line blocking.
 *
 * Per-file chunk limit (maxChunksPerFile) prevents one large file from hogging all
 * connection slots, ensuring bandwidth is shared fairly and chunk 0 arrives fast.
 *
 * Usage:
 *   const dm = new DownloadManager({ concurrency: 6, chunkSize: 50MB, chunksPerFile: 2 });
 *   const file = dm.enqueue({ id, type, path, md5 });
 *   const blob = await file.wait();
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('Download');
const DEFAULT_CONCURRENCY = 6; // Max concurrent HTTP connections (matches Chromium per-host limit)
const DEFAULT_CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks
const DEFAULT_MAX_CHUNKS_PER_FILE = 3; // Max parallel chunk downloads per file
const CHUNK_THRESHOLD = 100 * 1024 * 1024; // Files > 100MB get chunked
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500; // Fast: 500ms, 1s, 1.5s → total ~3s

// getData (widget data) retry config — CMS "cache not ready" (HTTP 500) resolves
// when the XTR task runs (30-120s). Use longer backoff to ride it out.
const GETDATA_MAX_RETRIES = 4;
const GETDATA_RETRY_DELAYS = [15_000, 30_000, 60_000, 120_000]; // 15s, 30s, 60s, 120s
const GETDATA_REENQUEUE_DELAY_MS = 60_000; // Re-add to queue after 60s if all retries fail
const GETDATA_MAX_REENQUEUES = 5; // Max times a getData can be re-enqueued before permanent failure
const URGENT_CONCURRENCY = 2; // Slots when urgent chunk is active (bandwidth focus)
const FETCH_TIMEOUT_MS = 600_000; // 10 minutes — 100MB chunk at ~2 Mbps
const HEAD_TIMEOUT_MS = 15_000; // 15 seconds for HEAD requests

// CMS origin for proxy filtering — set via setCmsOrigin() at init
let _cmsOrigin = null;

/**
 * Set the CMS origin so toProxyUrl() only proxies CMS URLs.
 * External URLs (CDNs, Google Fonts, geolocation APIs) pass through unchanged.
 * @param {string} origin - e.g. 'https://cms.example.com'
 */
export function setCmsOrigin(origin) {
  _cmsOrigin = origin;
}

/**
 * Infer Content-Type from file path extension.
 * Used when we skip HEAD (size already known from RequiredFiles).
 */
function inferContentType(fileInfo) {
  const path = fileInfo.path || fileInfo.code || '';
  const ext = path.split('.').pop()?.split('?')[0]?.toLowerCase();
  const types = {
    mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
    css: 'text/css', js: 'application/javascript',
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
    xml: 'application/xml', xlf: 'application/xml',
  };
  return types[ext] || 'application/octet-stream';
}

// Priority levels — higher number = starts first
export const PRIORITY = { normal: 0, layout: 1, high: 2, urgent: 3 };

/**
 * BARRIER sentinel — hard gate in the download queue.
 *
 * When processQueue() encounters a BARRIER:
 * - If tasks are still in-flight above it → STOP (slots stay empty)
 * - If running === 0 → remove barrier, continue with tasks below
 *
 * Used by LayoutQueueBuilder to separate critical chunks (chunk-0, chunk-last)
 * from remaining bulk chunks. Ensures video playback can start before all
 * chunks finish downloading.
 */
export const BARRIER = Symbol('BARRIER');

/**
 * Parse the X-Amz-Expires absolute timestamp from a signed URL.
 * Returns the expiry as a Unix timestamp (seconds), or Infinity if not found.
 */
function getUrlExpiry(url) {
  try {
    const match = url.match(/X-Amz-Expires=(\d+)/);
    return match ? parseInt(match[1], 10) : Infinity;
  } catch {
    return Infinity;
  }
}

/**
 * Check if a signed URL has expired (or will expire within a grace period).
 * @param {string} url - Signed URL with X-Amz-Expires parameter
 * @param {number} graceSeconds - Seconds before actual expiry to consider it expired (default: 30)
 * @returns {boolean}
 */
export function isUrlExpired(url, graceSeconds = 30) {
  const expiry = getUrlExpiry(url);
  if (expiry === Infinity) return false;
  return (Date.now() / 1000) >= (expiry - graceSeconds);
}

/**
 * Rewrite an absolute CMS URL through the local proxy when running behind
 * the proxy server (Chromium kiosk or Electron).
 * Detection: SW/window on localhost (any port) = proxy mode.
 */
export function toProxyUrl(url) {
  if (!url.startsWith('http')) return url;
  const loc = typeof self !== 'undefined' ? self.location : undefined;
  if (!loc || loc.hostname !== 'localhost') return url;
  const parsed = new URL(url);
  // Only proxy URLs belonging to the CMS server; external URLs pass through
  if (_cmsOrigin && parsed.origin !== _cmsOrigin) return url;
  return `/file-proxy?cms=${encodeURIComponent(parsed.origin)}&url=${encodeURIComponent(parsed.pathname + parsed.search)}`;
}

/**
 * DownloadTask - Single HTTP fetch unit
 *
 * Handles exactly one HTTP request: either a full small file GET or a single Range GET
 * for one chunk of a larger file. Includes retry logic with exponential backoff.
 */
export class DownloadTask {
  constructor(fileInfo, options = {}) {
    this.fileInfo = fileInfo;
    this.chunkIndex = options.chunkIndex ?? null;
    this.rangeStart = options.rangeStart ?? null;
    this.rangeEnd = options.rangeEnd ?? null;
    this.state = 'pending';
    this.blob = null;
    this._parentFile = null;
    this._priority = PRIORITY.normal;
    // Widget data (getData) uses longer retry backoff — CMS "cache not ready" is transient
    this.isGetData = fileInfo.isGetData || false;
  }

  getUrl() {
    const url = this.fileInfo.path;
    if (isUrlExpired(url)) {
      throw new Error(`URL expired for ${this.fileInfo.type}/${this.fileInfo.id} — waiting for fresh URL from next collection cycle`);
    }
    let proxyUrl = toProxyUrl(url);

    // Append store key params so the proxy can save to ContentStore
    if (proxyUrl.startsWith('/file-proxy')) {
      const storeKey = `${this.fileInfo.type || 'media'}/${this.fileInfo.id}`;
      proxyUrl += `&storeKey=${encodeURIComponent(storeKey)}`;
      if (this.chunkIndex != null) {
        proxyUrl += `&chunkIndex=${this.chunkIndex}`;
        if (this._parentFile) {
          proxyUrl += `&numChunks=${this._parentFile.totalChunks}`;
          proxyUrl += `&chunkSize=${this._parentFile.options.chunkSize || 104857600}`;
        }
      }
      if (this.fileInfo.md5) {
        proxyUrl += `&md5=${encodeURIComponent(this.fileInfo.md5)}`;
      }
    }
    return proxyUrl;
  }

  async start() {
    this.state = 'downloading';
    const headers = {};
    if (this.rangeStart != null) {
      headers['Range'] = `bytes=${this.rangeStart}-${this.rangeEnd}`;
    }

    const maxRetries = this.isGetData ? GETDATA_MAX_RETRIES : MAX_RETRIES;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        const url = this.getUrl();
        const fetchOpts = { signal: ac.signal };
        if (Object.keys(headers).length > 0) fetchOpts.headers = headers;
        const response = await fetch(url, fetchOpts);

        if (!response.ok && response.status !== 206) {
          throw new Error(`Fetch failed: ${response.status}`);
        }

        this.blob = await response.blob();
        this.state = 'complete';
        return this.blob;

      } catch (error) {
        const msg = ac.signal.aborted ? `Timeout after ${FETCH_TIMEOUT_MS / 1000}s` : error.message;
        if (attempt < maxRetries) {
          const delay = this.isGetData
            ? GETDATA_RETRY_DELAYS[attempt - 1]
            : RETRY_DELAY_MS * attempt;
          const chunkLabel = this.chunkIndex != null ? ` chunk ${this.chunkIndex}` : '';
          log.warn(`[DownloadTask] ${this.fileInfo.type}/${this.fileInfo.id}${chunkLabel} attempt ${attempt}/${maxRetries} failed: ${msg}. Retrying in ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          this.state = 'failed';
          throw ac.signal.aborted ? new Error(msg) : error;
        }
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/**
 * FileDownload - Orchestrates downloading a single file
 *
 * Does the HEAD request to determine file size, then:
 * - Small file (≤ 100MB): creates 1 DownloadTask for the full file
 * - Large file (> 100MB): creates N DownloadTasks, one per chunk
 *
 * All tasks are enqueued into the flat DownloadQueue where they compete
 * equally for HTTP connection slots with tasks from other files.
 *
 * Provides wait() that resolves when ALL tasks for this file complete.
 * Supports progressive caching via onChunkDownloaded callback.
 */
export class FileDownload {
  constructor(fileInfo, options = {}) {
    this.fileInfo = fileInfo;
    this.options = options;
    this.state = 'pending';
    this.tasks = [];
    this.completedChunks = 0;
    this.totalChunks = 0;
    this.totalBytes = 0;
    this.downloadedBytes = 0;
    this.onChunkDownloaded = null;
    this.skipChunks = fileInfo.skipChunks || new Set();
    this._contentType = 'application/octet-stream';
    this._chunkBlobs = new Map();
    this._runningCount = 0; // Currently running tasks for this file
    this._resolve = null;
    this._reject = null;
    this._promise = new Promise((res, rej) => {
      this._resolve = res;
      this._reject = rej;
    });
    this._promise.catch(() => {});
  }

  getUrl() {
    const url = this.fileInfo.path;
    if (isUrlExpired(url)) {
      throw new Error(`URL expired for ${this.fileInfo.type}/${this.fileInfo.id} — waiting for fresh URL from next collection cycle`);
    }
    let proxyUrl = toProxyUrl(url);

    // Append store key for ContentStore (same as DownloadTask)
    if (proxyUrl.startsWith('/file-proxy')) {
      const storeKey = `${this.fileInfo.type || 'media'}/${this.fileInfo.id}`;
      proxyUrl += `&storeKey=${encodeURIComponent(storeKey)}`;
      if (this.fileInfo.md5) {
        proxyUrl += `&md5=${encodeURIComponent(this.fileInfo.md5)}`;
      }
    }
    return proxyUrl;
  }

  wait() {
    return this._promise;
  }

  /**
   * Determine file size and create DownloadTasks.
   * Uses RequiredFiles size when available (instant, no network).
   * Falls back to HEAD request only when size is unknown.
   */
  async prepare(queue) {
    try {
      this.state = 'preparing';
      const { id, type, size } = this.fileInfo;
      log.info('[FileDownload] Starting:', `${type}/${id}`);

      // Use declared size from RequiredFiles — no HEAD needed for queue building
      this.totalBytes = (size && size > 0) ? parseInt(size) : 0;
      this._contentType = inferContentType(this.fileInfo);

      if (this.totalBytes === 0) {
        // No size declared — HEAD fallback (rare: only for files without CMS size)
        const url = this.getUrl();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), HEAD_TIMEOUT_MS);
        try {
          const head = await fetch(url, { method: 'HEAD', signal: ac.signal });
          if (head.ok) {
            this.totalBytes = parseInt(head.headers.get('Content-Length') || '0');
            this._contentType = head.headers.get('Content-Type') || this._contentType;
          }
        } finally {
          clearTimeout(timer);
        }
      }

      log.info('[FileDownload] File size:', (this.totalBytes / 1024 / 1024).toFixed(1), 'MB');

      const chunkSize = this.options.chunkSize || DEFAULT_CHUNK_SIZE;

      if (this.totalBytes > CHUNK_THRESHOLD) {
        const ranges = [];
        for (let start = 0; start < this.totalBytes; start += chunkSize) {
          ranges.push({
            start,
            end: Math.min(start + chunkSize - 1, this.totalBytes - 1),
            index: ranges.length
          });
        }
        this.totalChunks = ranges.length;

        const needed = ranges.filter(r => !this.skipChunks.has(r.index));
        const skippedCount = ranges.length - needed.length;

        for (const r of ranges) {
          if (this.skipChunks.has(r.index)) {
            this.downloadedBytes += (r.end - r.start + 1);
          }
        }

        if (needed.length === 0) {
          log.info('[FileDownload] All chunks already cached, nothing to download');
          this.state = 'complete';
          this._resolve(new Blob([], { type: this._contentType }));
          return;
        }

        if (skippedCount > 0) {
          log.info(`[FileDownload] Resuming: ${skippedCount} chunks cached, ${needed.length} to download`);
        }

        const isResume = skippedCount > 0;

        if (isResume) {
          const sorted = needed.sort((a, b) => a.index - b.index);
          for (const r of sorted) {
            const task = new DownloadTask(this.fileInfo, {
              chunkIndex: r.index, rangeStart: r.start, rangeEnd: r.end
            });
            task._parentFile = this;
            task._priority = PRIORITY.normal;
            this.tasks.push(task);
          }
        } else {
          for (const r of needed) {
            const task = new DownloadTask(this.fileInfo, {
              chunkIndex: r.index, rangeStart: r.start, rangeEnd: r.end
            });
            task._parentFile = this;
            task._priority = (r.index === 0 || r.index === ranges.length - 1) ? PRIORITY.high : PRIORITY.normal;
            this.tasks.push(task);
          }
        }

        const highCount = this.tasks.filter(t => t._priority >= PRIORITY.high).length;
        log.info(`[FileDownload] ${type}/${id}: ${this.tasks.length} chunks` +
          (highCount > 0 ? ` (${highCount} priority)` : '') +
          (isResume ? ' (resume)' : ''));

      } else {
        this.totalChunks = 1;
        const task = new DownloadTask(this.fileInfo, {});
        task._parentFile = this;
        this.tasks.push(task);
      }

      queue.enqueueChunkTasks(this.tasks);
      this.state = 'downloading';

    } catch (error) {
      log.error('[FileDownload] Prepare failed:', `${this.fileInfo.type}/${this.fileInfo.id}`, error);
      this.state = 'failed';
      this._reject(error);
    }
  }

  async onTaskComplete(task) {
    this.completedChunks++;
    this.downloadedBytes += task.blob.size;

    if (task.chunkIndex != null) {
      this._chunkBlobs.set(task.chunkIndex, task.blob);
    }

    if (this.options.onProgress) {
      this.options.onProgress(this.downloadedBytes, this.totalBytes);
    }

    // Fire progressive chunk callback
    if (this.onChunkDownloaded && task.chunkIndex != null) {
      try {
        await this.onChunkDownloaded(task.chunkIndex, task.blob, this.totalChunks);
      } catch (e) {
        log.warn('[FileDownload] onChunkDownloaded callback error:', e);
      }
    }

    if (this.completedChunks === this.tasks.length && this.state !== 'complete') {
      this.state = 'complete';
      const { type, id } = this.fileInfo;

      if (task.chunkIndex == null) {
        log.info('[FileDownload] Complete:', `${type}/${id}`, `(${task.blob.size} bytes)`);
        this._resolve(task.blob);
      } else if (this.onChunkDownloaded) {
        log.info('[FileDownload] Complete:', `${type}/${id}`, `(progressive, ${this.totalChunks} chunks)`);
        this._resolve(new Blob([], { type: this._contentType }));
      } else {
        const ordered = [];
        for (let i = 0; i < this.totalChunks; i++) {
          const blob = this._chunkBlobs.get(i);
          if (blob) ordered.push(blob);
        }
        const assembled = new Blob(ordered, { type: this._contentType });
        log.info('[FileDownload] Complete:', `${type}/${id}`, `(${assembled.size} bytes, reassembled)`);
        this._resolve(assembled);
      }

      this._chunkBlobs.clear();
    }
  }

  onTaskFailed(task, error) {
    if (this.state === 'complete' || this.state === 'failed') return;

    // URL expiration is transient — drop this task, don't fail the file.
    // Already-downloaded chunks are safe in cache. Next collection cycle
    // provides fresh URLs and the resume logic (skipChunks) fills the gaps.
    if (error.message?.includes('URL expired')) {
      const chunkLabel = task.chunkIndex != null ? ` chunk ${task.chunkIndex}` : '';
      log.warn(`[FileDownload] URL expired, dropping${chunkLabel}:`, `${this.fileInfo.type}/${this.fileInfo.id}`);
      this.tasks = this.tasks.filter(t => t !== task);
      // If all remaining tasks completed, resolve as partial
      if (this.tasks.length === 0 || this.completedChunks >= this.tasks.length) {
        this.state = 'complete';
        this._urlExpired = true;
        this._resolve(new Blob([], { type: this._contentType }));
      }
      return;
    }

    log.error('[FileDownload] Failed:', `${this.fileInfo.type}/${this.fileInfo.id}`, error);
    this.state = 'failed';
    this._reject(error);
  }
}

/**
 * LayoutTaskBuilder — Smart builder that produces a sorted, barrier-embedded
 * task list for a single layout.
 *
 * Usage:
 *   const builder = new LayoutTaskBuilder(queue);
 *   builder.addFile(fileInfo);
 *   const orderedTasks = await builder.build();
 *   queue.enqueueOrderedTasks(orderedTasks);
 *
 * The builder runs HEAD requests (throttled), collects the resulting
 * DownloadTasks, sorts them optimally, and embeds BARRIERs between
 * critical chunks (chunk-0, chunk-last) and bulk chunks.
 *
 * Duck-typing: implements enqueueChunkTasks() so FileDownload.prepare()
 * works unchanged — it just collects tasks instead of processing them.
 */
export class LayoutTaskBuilder {
  constructor(queue) {
    this.queue = queue;           // Main DownloadQueue (for dedup via active map)
    this._filesToPrepare = [];    // FileDownloads needing HEAD requests
    this._tasks = [];             // Collected DownloadTasks (from prepare callbacks)
    this._maxPreparing = 2;       // HEAD request throttle
  }

  /**
   * Register a file. Uses queue.active for dedup/URL refresh.
   * Does NOT trigger prepare — that happens in build().
   */
  addFile(fileInfo) {
    const key = DownloadQueue.stableKey(fileInfo);

    if (this.queue.active.has(key)) {
      const existing = this.queue.active.get(key);
      // URL refresh (same logic as queue.enqueue)
      if (fileInfo.path && fileInfo.path !== existing.fileInfo.path) {
        const oldExpiry = getUrlExpiry(existing.fileInfo.path);
        const newExpiry = getUrlExpiry(fileInfo.path);
        if (newExpiry > oldExpiry) {
          existing.fileInfo.path = fileInfo.path;
        }
      }
      return existing;
    }

    const file = new FileDownload(fileInfo, {
      chunkSize: this.queue.chunkSize,
      calculateMD5: this.queue.calculateMD5,
      onProgress: this.queue.onProgress
    });

    this.queue.active.set(key, file);
    this._filesToPrepare.push(file);
    return file;
  }

  /**
   * Duck-type interface for FileDownload.prepare().
   * Collects tasks instead of processing them.
   */
  enqueueChunkTasks(tasks) {
    this._tasks.push(...tasks);
  }

  /**
   * Run all HEAD requests (throttled) and return sorted tasks with barriers.
   */
  async build() {
    await this._prepareAll();
    return this._sortWithBarriers();
  }

  async _prepareAll() {
    await new Promise((resolve) => {
      let running = 0;
      let idx = 0;
      const next = () => {
        while (running < this._maxPreparing && idx < this._filesToPrepare.length) {
          const file = this._filesToPrepare[idx++];
          running++;
          file.prepare(this).finally(() => {
            running--;
            if (idx >= this._filesToPrepare.length && running === 0) {
              resolve();
            } else {
              next();
            }
          });
        }
      };
      if (this._filesToPrepare.length === 0) resolve();
      else next();
    });
  }

  _sortWithBarriers() {
    const nonChunked = [];
    const chunk0s = [];
    const chunkLasts = [];
    const remaining = [];

    for (const t of this._tasks) {
      if (t.chunkIndex == null) {
        nonChunked.push(t);
      } else if (t.chunkIndex === 0) {
        chunk0s.push(t);
      } else {
        const total = t._parentFile?.totalChunks || 0;
        if (total > 1 && t.chunkIndex === total - 1) {
          chunkLasts.push(t);
        } else {
          remaining.push(t);
        }
      }
    }

    nonChunked.sort((a, b) => (a._parentFile?.totalBytes || 0) - (b._parentFile?.totalBytes || 0));
    remaining.sort((a, b) => a.chunkIndex - b.chunkIndex);

    // Build: small files + critical chunks → BARRIER → bulk chunks
    const result = [...nonChunked, ...chunk0s, ...chunkLasts];
    if (remaining.length > 0) {
      result.push(BARRIER, ...remaining);
    }
    return result;
  }
}

/**
 * DownloadQueue - Flat queue with per-file and global concurrency limits
 *
 * Global concurrency limit (e.g., 6) controls total HTTP connections.
 * Per-file chunk limit (e.g., 2) prevents one large file from hogging all
 * connections, ensuring bandwidth per chunk is high and chunk 0 arrives fast.
 * HEAD requests are throttled to avoid flooding browser connection pool.
 */
export class DownloadQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency || DEFAULT_CONCURRENCY;
    this.chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    this.maxChunksPerFile = options.chunksPerFile || DEFAULT_MAX_CHUNKS_PER_FILE;
    this.calculateMD5 = options.calculateMD5;
    this.onProgress = options.onProgress;

    this.queue = [];          // DownloadTask[] — flat queue of chunk/file tasks
    this.active = new Map();  // stableKey → FileDownload
    this._activeTasks = [];   // DownloadTask[] — currently in-flight tasks
    this.running = 0;

    // HEAD request throttling: prevents prepare() from flooding browser connections
    this._prepareQueue = [];
    this._preparingCount = 0;
    this._maxPreparing = 2; // Max concurrent HEAD requests

    // When paused, processQueue() is a no-op (used during barrier setup)
    this.paused = false;

    // Track getData re-enqueue timers so clear() can cancel them
    this._reenqueueTimers = new Set();
  }

  static stableKey(fileInfo) {
    return `${fileInfo.type}/${fileInfo.id}`;
  }

  enqueue(fileInfo) {
    const key = DownloadQueue.stableKey(fileInfo);

    if (this.active.has(key)) {
      const existing = this.active.get(key);
      if (fileInfo.path && fileInfo.path !== existing.fileInfo.path) {
        const oldExpiry = getUrlExpiry(existing.fileInfo.path);
        const newExpiry = getUrlExpiry(fileInfo.path);
        if (newExpiry > oldExpiry) {
          log.info('[DownloadQueue] Refreshing URL for', key);
          existing.fileInfo.path = fileInfo.path;
        }
      }
      return existing;
    }

    const file = new FileDownload(fileInfo, {
      chunkSize: this.chunkSize,
      calculateMD5: this.calculateMD5,
      onProgress: this.onProgress
    });

    this.active.set(key, file);
    log.info('[DownloadQueue] Enqueued:', key);

    // Throttled prepare: HEAD requests are limited to avoid flooding connections
    this._schedulePrepare(file);

    return file;
  }

  /**
   * Schedule a FileDownload's prepare() with throttling.
   * Only N HEAD requests run concurrently to preserve connections for data transfers.
   */
  _schedulePrepare(file) {
    this._prepareQueue.push(file);
    this._processPrepareQueue();
  }

  _processPrepareQueue() {
    while (this._preparingCount < this._maxPreparing && this._prepareQueue.length > 0) {
      const file = this._prepareQueue.shift();
      this._preparingCount++;
      file.prepare(this).finally(() => {
        this._preparingCount--;
        this._processPrepareQueue();
      });
    }
  }

  enqueueChunkTasks(tasks) {
    for (const task of tasks) {
      this.queue.push(task);
    }
    this._sortQueue();

    log.info(`[DownloadQueue] ${tasks.length} tasks added (${this.queue.length} pending, ${this.running} active)`);
    this.processQueue();
  }

  /**
   * Enqueue a pre-ordered list of tasks (with optional BARRIER sentinels).
   * Preserves insertion order — no sorting. Position = priority.
   *
   * Used by LayoutQueueBuilder to push the entire download queue in layout
   * playback order with barriers separating critical chunks from bulk.
   *
   * @param {Array<DownloadTask|Symbol>} items - Tasks and BARRIERs in order
   */
  enqueueOrderedTasks(items) {
    let taskCount = 0;
    let barrierCount = 0;
    for (const item of items) {
      if (item === BARRIER) {
        this.queue.push(BARRIER);
        barrierCount++;
      } else {
        this.queue.push(item);
        taskCount++;
      }
    }

    log.info(`[DownloadQueue] Ordered queue: ${taskCount} tasks, ${barrierCount} barriers (${this.queue.length} pending, ${this.running} active)`);
    this.processQueue();
  }

  /** Sort queue by priority (highest first), stable within same priority. */
  _sortQueue() {
    this.queue.sort((a, b) => b._priority - a._priority);
  }

  prioritize(fileType, fileId) {
    const key = `${fileType}/${fileId}`;
    const file = this.active.get(key);

    if (!file) {
      log.info('[DownloadQueue] Not found:', key);
      return false;
    }

    let boosted = 0;
    for (const t of this.queue) {
      if (t._parentFile === file && t._priority < PRIORITY.high) {
        t._priority = PRIORITY.high;
        boosted++;
      }
    }
    this._sortQueue();

    log.info('[DownloadQueue] Prioritized:', key, `(${boosted} tasks boosted)`);
    return true;
  }

  /**
   * Boost priority for files needed by the current/next layout.
   * @param {Array} fileIds - Media IDs needed by the layout
   * @param {number} priority - Priority level (default: PRIORITY.high)
   */
  prioritizeLayoutFiles(fileIds, priority = PRIORITY.high) {
    const idSet = new Set(fileIds.map(String));

    let boosted = 0;
    for (const t of this.queue) {
      if (idSet.has(String(t._parentFile?.fileInfo.id)) && t._priority < priority) {
        t._priority = priority;
        boosted++;
      }
    }
    for (const t of this._activeTasks) {
      if (idSet.has(String(t._parentFile?.fileInfo.id)) && t._priority < priority) {
        t._priority = priority;
      }
    }
    this._sortQueue();

    log.info('[DownloadQueue] Layout files prioritized:', idSet.size, 'files,', boosted, 'tasks boosted to', priority);
  }

  /**
   * Emergency priority for a specific streaming chunk.
   * Called by the Service Worker when a video is stalled waiting for chunk N.
   * Sets urgent priority → queue re-sorts → processQueue() limits concurrency.
   */
  urgentChunk(fileType, fileId, chunkIndex) {
    const key = `${fileType}/${fileId}`;
    const file = this.active.get(key);

    if (!file) {
      log.info('[DownloadQueue] urgentChunk: file not active:', key, 'chunk', chunkIndex);
      return false;
    }

    // Already in-flight — nothing to do
    const isActive = this._activeTasks.some(
      t => t._parentFile === file && t.chunkIndex === chunkIndex && t.state === 'downloading'
    );
    if (isActive) {
      // Mark the in-flight task as urgent so processQueue() limits concurrency
      const activeTask = this._activeTasks.find(
        t => t._parentFile === file && t.chunkIndex === chunkIndex
      );
      if (activeTask && activeTask._priority < PRIORITY.urgent) {
        activeTask._priority = PRIORITY.urgent;
        log.info(`[DownloadQueue] URGENT: ${key} chunk ${chunkIndex} (already in-flight, limiting slots)`);
        // Don't call processQueue() — can't stop in-flight tasks, but next
        // processQueue() call (when any task completes) will see hasUrgent
        // and limit new starts to URGENT_CONCURRENCY.
        return true;
      }
      log.info('[DownloadQueue] urgentChunk: already urgent:', key, 'chunk', chunkIndex);
      return false;
    }

    // Find task in queue (may be past a barrier)
    const idx = this.queue.findIndex(
      t => t !== BARRIER && t._parentFile === file && t.chunkIndex === chunkIndex
    );

    if (idx === -1) {
      log.info('[DownloadQueue] urgentChunk: chunk not in queue:', key, 'chunk', chunkIndex);
      return false;
    }

    const task = this.queue.splice(idx, 1)[0];
    task._priority = PRIORITY.urgent;
    // Move to front of queue (past any barriers)
    this.queue.unshift(task);

    log.info(`[DownloadQueue] URGENT: ${key} chunk ${chunkIndex} (moved to front)`);
    this.processQueue();
    return true;
  }

  /**
   * Process queue — barrier-aware loop.
   *
   * Supports two modes:
   * 1. Priority-sorted (legacy): queue sorted by priority, urgent reduces concurrency
   * 2. Barrier-ordered: queue contains BARRIER sentinels that act as hard gates
   *
   * BARRIER behavior:
   * - When processQueue() hits a BARRIER and running > 0 → STOP (slots stay empty)
   * - When running === 0 → remove barrier, continue with tasks below
   * - Tasks are never reordered past a BARRIER (except urgentChunk which bypasses)
   *
   * Urgent mode: when any task has PRIORITY.urgent, concurrency drops to
   * URGENT_CONCURRENCY so the stalled chunk gets maximum bandwidth.
   */
  processQueue() {
    if (this.paused) return;

    // Determine effective concurrency and minimum priority to start
    const hasUrgent = this.queue.some(t => t !== BARRIER && t._priority >= PRIORITY.urgent) ||
      this._activeTasks?.some(t => t._priority >= PRIORITY.urgent && t.state === 'downloading');
    const maxSlots = hasUrgent ? URGENT_CONCURRENCY : this.concurrency;
    const minPriority = hasUrgent ? PRIORITY.urgent : 0; // Urgent = only urgent tasks run

    // Fill slots from front of queue
    while (this.running < maxSlots && this.queue.length > 0) {
      const next = this.queue[0];

      // Hit a BARRIER — hard gate
      if (next === BARRIER) {
        if (this.running > 0) {
          break; // In-flight tasks still running — slots stay empty
        }
        // All above-barrier tasks done → raise barrier, continue
        this.queue.shift();
        continue;
      }

      // Per-file limit: skip to next eligible task (but don't cross barrier)
      if (next._priority < minPriority || !this._canStartTask(next)) {
        let found = false;
        for (let i = 1; i < this.queue.length; i++) {
          if (this.queue[i] === BARRIER) break; // Don't look past barrier
          const task = this.queue[i];
          if (task._priority >= minPriority && this._canStartTask(task)) {
            this.queue.splice(i, 1);
            this._startTask(task);
            found = true;
            break;
          }
        }
        if (!found) break;
        continue;
      }

      this.queue.shift();
      this._startTask(next);
    }

    if (this.queue.length === 0 && this.running === 0) {
      log.info('[DownloadQueue] All downloads complete');
    }
  }

  /**
   * Per-file concurrency check. Priority sorting decides order,
   * this just prevents one file from hogging all connections.
   */
  _canStartTask(task) {
    return task._parentFile._runningCount < this.maxChunksPerFile;
  }

  _startTask(task) {
    this.running++;
    task._parentFile._runningCount++;
    this._activeTasks.push(task);
    const key = `${task.fileInfo.type}/${task.fileInfo.id}`;
    const chunkLabel = task.chunkIndex != null ? ` chunk ${task.chunkIndex}` : '';
    log.info(`[DownloadQueue] Starting: ${key}${chunkLabel} (${this.running}/${this.concurrency} active)`);

    task.start()
      .then(() => {
        this.running--;
        task._parentFile._runningCount--;
        this._activeTasks = this._activeTasks.filter(t => t !== task);
        log.info(`[DownloadQueue] Fetched: ${key}${chunkLabel} (${this.running} active, ${this.queue.length} pending)`);
        this.processQueue();
        return task._parentFile.onTaskComplete(task);
      })
      .catch(err => {
        this.running--;
        task._parentFile._runningCount--;
        this._activeTasks = this._activeTasks.filter(t => t !== task);

        // getData (widget data): defer re-enqueue instead of permanent failure.
        // CMS "cache not ready" resolves when the XTR task runs (30-120s).
        if (task.isGetData) {
          task._reenqueueCount = (task._reenqueueCount || 0) + 1;
          if (task._reenqueueCount > GETDATA_MAX_REENQUEUES) {
            log.error(`[DownloadQueue] getData ${key} exceeded ${GETDATA_MAX_REENQUEUES} re-enqueues, failing permanently`);
            this.processQueue();
            task._parentFile.onTaskFailed(task, err);
            return;
          }
          log.warn(`[DownloadQueue] getData ${key} failed all retries (attempt ${task._reenqueueCount}/${GETDATA_MAX_REENQUEUES}), scheduling re-enqueue in ${GETDATA_REENQUEUE_DELAY_MS / 1000}s`);
          const timerId = setTimeout(() => {
            this._reenqueueTimers.delete(timerId);
            task.state = 'pending';
            task._parentFile.state = 'downloading';
            this.queue.push(task);
            log.info(`[DownloadQueue] getData ${key} re-enqueued for retry`);
            this.processQueue();
          }, GETDATA_REENQUEUE_DELAY_MS);
          this._reenqueueTimers.add(timerId);
          this.processQueue();
          return;
        }

        this.processQueue();
        task._parentFile.onTaskFailed(task, err);
      });
  }

  /**
   * Wait for all queued prepare (HEAD) operations to finish.
   * Returns when the prepare queue is drained and all FileDownloads have
   * either created their tasks or failed.
   */
  awaitAllPrepared() {
    return new Promise((resolve) => {
      const check = () => {
        if (this._preparingCount === 0 && this._prepareQueue.length === 0) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  removeCompleted(key) {
    const file = this.active.get(key);
    if (file && (file.state === 'complete' || file.state === 'failed')) {
      this.queue = this.queue.filter(t => t === BARRIER || t._parentFile !== file);
      this.active.delete(key);
    }
  }

  getTask(key) {
    return this.active.get(key) || null;
  }

  getProgress() {
    const progress = {};
    for (const [key, file] of this.active.entries()) {
      progress[key] = {
        downloaded: file.downloadedBytes,
        total: file.totalBytes,
        percent: file.totalBytes > 0 ? (file.downloadedBytes / file.totalBytes * 100).toFixed(1) : 0,
        state: file.state
      };
    }
    return progress;
  }

  clear() {
    this.queue = [];
    this.active.clear();
    this.running = 0;
    this._prepareQueue = [];
    this._preparingCount = 0;
    // Cancel any pending getData re-enqueue timers
    for (const id of this._reenqueueTimers) clearTimeout(id);
    this._reenqueueTimers.clear();
  }
}

/**
 * DownloadManager - Main API
 */
export class DownloadManager {
  constructor(options = {}) {
    this.queue = new DownloadQueue(options);
  }

  enqueue(fileInfo) {
    return this.queue.enqueue(fileInfo);
  }

  /**
   * Enqueue a file for layout-grouped downloading.
   * Layout grouping is now handled externally by LayoutTaskBuilder.
   * @param {Object} fileInfo - File info
   * @returns {FileDownload}
   */
  enqueueForLayout(fileInfo) {
    return this.queue.enqueue(fileInfo);
  }

  getTask(key) {
    return this.queue.getTask(key);
  }

  getProgress() {
    return this.queue.getProgress();
  }

  prioritizeLayoutFiles(fileIds, priority) {
    this.queue.prioritizeLayoutFiles(fileIds, priority);
    this.queue.processQueue();
  }

  urgentChunk(fileType, fileId, chunkIndex) {
    return this.queue.urgentChunk(fileType, fileId, chunkIndex);
  }

  clear() {
    this.queue.clear();
  }
}
