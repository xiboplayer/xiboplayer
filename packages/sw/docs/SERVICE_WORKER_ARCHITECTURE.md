# Service Worker Architecture

## Overview

The Xibo PWA player uses a standalone Service Worker that handles all file download and caching logic independently. This architecture eliminates HTTP 202 deadlocks and provides a clean separation between the player client and download management.

**Version**: 2026-02-06-standalone

## Architecture

### Core Components

The Service Worker consists of 4 main classes (CacheManager was removed — all storage goes through the proxy's ContentStore):

```
┌─────────────────────────────────────────────────────────┐
│                    Service Worker                        │
│  ┌──────────────┐  ┌──────────────┐                     │
│  │DownloadQueue │  │MessageHandler│                     │
│  │- concurrency │  │- postMessage │                     │
│  │- queue mgmt  │  │- commands    │                     │
│  └──────────────┘  └──────────────┘                     │
│         │                   │                            │
│         ▼                   ▼                            │
│  ┌──────────────┐  ┌──────────────────────────────────┐ │
│  │DownloadTask  │  │      RequestHandler              │ │
│  │- chunks      │  │      - fetch events              │ │
│  │- MD5 verify  │  │      - route to /store/*         │ │
│  │- PUT /store  │  │      - wait for downloads        │ │
│  └──────────────┘  └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
         │                           │
         ▼                           ▼
    ┌────────┐                ┌──────────┐
    │  CMS   │                │  Proxy   │
    │Network │                │/store/*  │
    └────────┘                └──────────┘
```

### Class 1: DownloadQueue

Manages the download queue with concurrency control.

**Purpose**: Ensures only N files download simultaneously to avoid overwhelming the network.

**Key Features**:
- Concurrent download limit (default: 4)
- Queue management (FIFO)
- Task tracking (active downloads)
- Automatic queue processing

**Methods**:
- `enqueue(fileInfo)` - Add file to queue, returns existing task if already downloading
- `processQueue()` - Start downloads up to concurrency limit
- `getTask(url)` - Get active download task by URL
- `getProgress()` - Get progress for all active downloads

### Class 2: DownloadTask

Handles individual file download with parallel chunk downloads.

**Purpose**: Downloads a single file efficiently using parallel chunks for large files.

**Key Features**:
- Parallel chunk downloads (4 chunks at a time)
- MD5 verification (optional)
- Progress tracking
- Waiter pattern (promises wait for completion)

**Waiter Pattern**:
```javascript
// Client requests file while downloading
const task = downloadQueue.getTask(url);
const blob = await task.wait();  // Resolves when download completes
```

**Methods**:
- `start()` - Start download
- `wait()` - Wait for download to complete (returns blob)
- `downloadFull(url)` - Download small file in one request
- `downloadChunks(url, contentType)` - Download large file in parallel chunks
- `calculateMD5(blob)` - Verify file integrity

**Download Strategy**:
- Files < 100MB: Single request
- Files > 100MB: 50MB chunks, 4 concurrent

### ContentStore (Proxy)

All storage goes through the proxy's ContentStore via REST endpoints. No Cache API is used.

**Store Key Format**:
```
/store/{type}/{id}

Examples:
- /store/media/123     (media file ID 123)
- /store/layout/456    (layout file ID 456)
- /store/widget/1/2/3  (widget HTML for layout 1, region 2, media 3)
- /store/static/bundle.min.js  (widget resource)
```

**REST Endpoints**:
- `GET /store/:type/:id` — serve file (Range support)
- `HEAD /store/:type/:id` — existence + size check
- `PUT /store/:type/:id` — store file
- `POST /store/delete` — delete files
- `GET /store/list` — list all cached files

### Class 3: RequestHandler

Handles fetch events from the browser.

**Purpose**: Intercepts fetch requests and serves files from cache or waits for downloads.

**Request Flow**:
```
fetch('/player/cache/media/123')
         │
         ▼
  ┌──────────────────────┐
  │ Fetch from /store/*  │
  └──────────────────────┘
         │
   200   │  404
    ┌────┴────┐
    ▼         ▼
┌────────┐  ┌─────────────────────┐
│ Serve  │  │ Is it downloading?  │
│  file  │  └─────────────────────┘
└────────┘         │
             Yes   │   No
            ┌──────┴────────┐
            ▼               ▼
    ┌──────────────┐   ┌────────┐
    │ Wait & serve │   │ 404    │
    └──────────────┘   └────────┘
```

**No HTTP 202**: The Service Worker waits internally and returns actual files, never HTTP 202.

**Methods**:
- `handleRequest(event)` - Main fetch handler
- `handleRangeRequest(response, rangeHeader)` - Handle video seeking

**Special Handling**:
- Static files (index.html, manifest.json)
- Widget resources (bundle.min.js, fonts)
- XMDS media requests (XLR compatibility)
- Widget HTML (/player/cache/widget/*)
- Media files (/player/cache/media/*)
- Layout files (/player/cache/layout/*)

### Class 4: MessageHandler

Handles postMessage communication from client.

**Purpose**: Receives commands from the player client to manage downloads.

**Message Types**:

#### DOWNLOAD_FILES
Enqueue files for download.

```javascript
// Client sends
navigator.serviceWorker.controller.postMessage({
  type: 'DOWNLOAD_FILES',
  data: { files: [
    { id: '123', type: 'media', path: 'https://cms/xmds.php?file=123.mp4', md5: 'abc...' },
    { id: '456', type: 'layout', path: 'https://cms/xmds.php?file=456.xlf', md5: 'def...' }
  ]}
}, [messageChannel.port2]);

// Service Worker responds
{ success: true, enqueuedCount: 2 }
```

#### CLEAR_CACHE
Clear all cached files.

```javascript
// Client sends
navigator.serviceWorker.controller.postMessage({
  type: 'CLEAR_CACHE'
}, [messageChannel.port2]);

// Service Worker responds
{ success: true }
```

#### GET_DOWNLOAD_PROGRESS
Get progress for all active downloads.

```javascript
// Client sends
navigator.serviceWorker.controller.postMessage({
  type: 'GET_DOWNLOAD_PROGRESS'
}, [messageChannel.port2]);

// Service Worker responds
{
  success: true,
  progress: {
    'https://cms/xmds.php?file=123.mp4': {
      downloaded: 50000000,
      total: 100000000,
      percent: '50.0'
    }
  }
}
```

## Client Integration

### main.ts Changes

The player client detects if Service Worker is active and sends file list for download:

```typescript
// Check if Service Worker is active
const serviceWorkerActive = navigator.serviceWorker?.controller;

if (serviceWorkerActive) {
  // Use Service Worker for downloads (non-blocking)
  await this.sendFilesToServiceWorker(files);
} else {
  // Fallback: Download directly using cache.js
  for (const file of files) {
    await cacheManager.downloadFile(file);
  }
}
```

**Key Points**:
- Service Worker downloads happen in background
- Client doesn't wait for downloads to complete
- Layout switching works as normal (Service Worker serves files when ready)

### cache.js Changes

The cache manager detects Service Worker and skips direct downloads:

```javascript
async downloadFile(fileInfo) {
  // Check if Service Worker is handling downloads
  if (navigator.serviceWorker?.controller) {
    console.log('[Cache] Service Worker active - skipping direct download');
    return { isServiceWorkerDownload: true, ... };
  }

  // Fallback: Download directly
  // ... existing download logic ...
}
```

**Backward Compatibility**: If Service Worker is not active (e.g., HTTP without HTTPS, or Service Worker disabled), cache.js handles downloads as before.

## File Flow

### First Boot (No Cache)

```
1. Player starts
   └─> main.ts calls xmds.requiredFiles()
       └─> Gets list of 50 files (layouts + media)

2. Send to Service Worker
   └─> main.ts.sendFilesToServiceWorker(files)
       └─> Service Worker enqueues all files

3. Service Worker downloads in background
   ├─> 4 concurrent downloads
   ├─> Large files: 50MB chunks, 4 concurrent
   └─> Files cached as they complete

4. Player renders layout
   ├─> Requests /player/cache/media/123
   ├─> Service Worker checks cache
   ├─> If downloading: wait for completion
   └─> Returns file when ready
```

### Subsequent Boots (Cache Exists)

```
1. Player starts
   └─> main.ts calls xmds.requiredFiles()

2. Send to Service Worker
   └─> Service Worker checks cache for each file
       ├─> Already cached: skip
       └─> Not cached: enqueue

3. Player renders layout
   └─> Requests /player/cache/media/123
       └─> Service Worker serves from cache immediately
```

## Performance

### Parallel Downloads

- **4 concurrent file downloads** (not sequential)
- **4 concurrent chunks per large file** (50MB chunks)
- **Effective speedup**: 4-10x faster than sequential

### Example: 1GB video

**Sequential (old)**:
- 1 download: ~5 minutes

**Parallel chunks (new)**:
- 20 chunks × 50MB each
- 4 chunks at a time = 5 batches
- ~1-2 minutes

### Memory Efficiency

- Chunks streamed to ContentStore via PUT (not kept in memory)
- Filesystem handles storage (no RAM bloat)
- Blob URLs created on-demand (not upfront)

## Testing

### Manual Testing

1. **Clear cache**:
   ```bash
   # Clear ContentStore (Electron)
   rm -rf ~/.config/xiboplayer/electron/content-store/
   # Clear ContentStore (Chromium)
   rm -rf ~/.config/xiboplayer/chromium/content-store/
   ```

2. **Reload player**:
   - Check console for `[SW] Loading standalone Service Worker`
   - Check console for `[PWA] Sending file list to Service Worker`
   - Check console for `[Queue] Enqueued` messages

3. **Watch downloads**:
   - Chrome DevTools → Network tab
   - Should see 4 concurrent requests
   - Should see Range requests for large files

4. **Test video seeking**:
   - Video should support scrubbing
   - Should see 206 Partial Content responses

### Automated Testing

```bash
# Build (from xiboplayer-pwa repo)
pnpm run build

# Test in browser
# Navigate to https://your-cms.example.com/player/pwa/
```

## Troubleshooting

### Service Worker not loading

**Symptoms**: Console shows `[PWA] Service Worker not active, using cache.js`

**Causes**:
- HTTP instead of HTTPS (Service Workers require HTTPS)
- Service Worker failed to install
- Browser cache issues

**Fix**:
1. Check HTTPS is enabled
2. Check browser console for Service Worker errors
3. Try hard refresh (Ctrl+Shift+R)
4. Unregister old Service Worker:
   ```javascript
   navigator.serviceWorker.getRegistrations().then(registrations => {
     for (let registration of registrations) {
       registration.unregister();
     }
   });
   location.reload();
   ```

### Downloads not starting

**Symptoms**: Console shows files enqueued but no network activity

**Causes**:
- Invalid file URLs
- CORS issues
- CMS not responding

**Fix**:
1. Check console for `[Download] Starting` messages
2. Check Network tab for failed requests
3. Verify file URLs in `xmds.requiredFiles()` response
4. Check CMS logs

### Video not seeking

**Symptoms**: Video plays but can't scrub/seek

**Causes**:
- Service Worker not handling Range requests
- Cache missing Accept-Ranges header

**Fix**:
1. Check Network tab for 206 responses (should be 206, not 200)
2. Check Response headers for `Accept-Ranges: bytes`
3. Check Service Worker console logs for `[Request] Serving from cache`

### Memory issues

**Symptoms**: Browser becomes slow, tab crashes

**Causes**:
- Too many concurrent downloads
- Large files not chunked
- Blob URLs not released

**Fix**:
1. Reduce `CONCURRENT_DOWNLOADS` in sw.js
2. Reduce `CONCURRENT_CHUNKS` in sw.js
3. Check for blob URL leaks (see `docs/PERFORMANCE_OPTIMIZATIONS.md`)

## Configuration

### sw.js Constants

```javascript
const CONCURRENT_DOWNLOADS = 4;  // Max concurrent file downloads
const CHUNK_SIZE = 50 * 1024 * 1024;  // 50MB chunks
const CONCURRENT_CHUNKS = 4;  // Parallel chunks per file
```

**Tuning**:
- **Slower network**: Reduce `CONCURRENT_DOWNLOADS` to 2
- **Faster network**: Increase to 6-8
- **Large files**: Increase `CHUNK_SIZE` to 100MB
- **Small files**: Decrease `CHUNK_SIZE` to 25MB

## Future Enhancements

### Planned Features

1. **Streaming video playback** - Start playback before download completes
2. **Progressive Web App** - Full offline support
3. **Background sync** - Download files when network available
4. **Smart caching** - Only cache files that will be used soon
5. **Compression** - Use gzip/brotli for text files

### Not Implemented

- **MD5 verification** - Currently skipped (calculateMD5 returns null)
- **Retry logic** - Downloads fail permanently on error
- **Bandwidth throttling** - No rate limiting
- **Cache expiration** - Files never expire

## Related Documentation

- `../../renderer/docs/PERFORMANCE_OPTIMIZATIONS.md` - Performance details
- `../../cache/docs/CACHE_PROXY_ARCHITECTURE.md` - StoreClient + DownloadClient architecture

## Version History

- **2026-02-06-standalone**: Initial standalone implementation
  - 5 core classes
  - No HTTP 202 responses
  - Parallel chunk downloads
  - Waiter pattern
  - Full XLR compatibility

## Summary

The standalone Service Worker architecture provides:

- **No HTTP 202 deadlocks** — Service Worker waits internally, returns actual files
- **Parallel downloads** — configurable concurrent files (6 on high-RAM devices)
- **Clean separation** — StoreClient (REST) for storage, DownloadClient (postMessage) for downloads
- **Durable storage** — ContentStore on filesystem, survives browser cache eviction
- **XLR compatible** — Handles XMDS media requests
- **Video seeking** — Supports Range requests via proxy

**Result**: Single storage backend (filesystem), no Cache API, no deadlocks.
