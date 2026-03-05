# @xiboplayer/cache

**Offline caching and download management with parallel chunk downloads, resume support, and storage health monitoring.**

## Overview

Manages the complete lifecycle of media files from CMS to local storage:

- **REST-based file store** -- StoreClient provides CRUD operations (has, get, put, remove, list) via proxy endpoints
- **Flat-queue download orchestration** -- DownloadManager with per-file and global concurrency limits
- **Intelligent chunking** -- files > 100MB split into 50MB chunks with prioritized headers and trailers for fast video start
- **Download resume** -- partial downloads resume automatically; expired URLs defer to next collection cycle
- **Stale media detection** -- CacheAnalyzer identifies orphaned files and evicts when storage exceeds threshold
- **Widget HTML preprocessing** -- base tag injection, dependency rewriting for iframe sandboxing

No Cache API is used. All content is stored on the filesystem via the proxy's ContentStore.

## Architecture

```
CMS (RequiredFiles: size, URL, MD5)
        |
        v
+-------------------------------------+
|      DownloadManager (Facade)       |
|  +- enqueue(fileInfo)               |
|  +- prioritizeLayoutFiles(mediaIds) |
|  +- urgentChunk(type, id, idx)      |
+-------------------------------------+
             |
             v
      DownloadQueue (Flat)
    +-----------------------------+
    | [Task, Task, BARRIER,       |
    |  Task, Task, Task]          |
    |                             |
    | Global concurrency: 6       |
    | Per-file chunks: 2-3        |
    +-----------------------------+
       |
       +-> DownloadTask (chunk-0, high priority)
       +-> DownloadTask (chunk-last, high priority)
       +-> BARRIER (gate: waits for above to finish)
       +-> DownloadTask (bulk chunks, normal priority)
               |
               v
         HTTP Range GET
               |
               v
       ContentStore (proxy)
         /store/media/{id}
         /store/layout/{id}
         /store/widget/{L}/{R}/{M}
```

## Installation

```bash
npm install @xiboplayer/cache
```

## Usage

### StoreClient -- direct REST access to ContentStore

```javascript
import { StoreClient } from '@xiboplayer/cache';

const store = new StoreClient();

// Check existence
const exists = await store.has('media', '123');

// Retrieve file
const blob = await store.get('media', '456');

// Store widget HTML
const html = new Blob(['<h1>Widget</h1>'], { type: 'text/html' });
await store.put('widget', 'layout/1/region/2/media/3', html, 'text/html');

// List all cached files
const files = await store.list();

// Delete orphaned files
await store.remove([
  { type: 'media', id: '999' },
  { type: 'media', id: '1000' },
]);
```

### DownloadManager -- orchestrated downloads

```javascript
import { DownloadManager } from '@xiboplayer/cache';

const dm = new DownloadManager({
  concurrency: 6,
  chunkSize: 50 * 1024 * 1024,
  chunksPerFile: 2,
});

// Enqueue a file
const media = dm.enqueue({
  id: '123',
  type: 'media',
  path: 'https://cdn.example.com/video.mp4',
  size: 250 * 1024 * 1024,
  md5: 'abc123def456',
});

// Wait for completion
const blob = await media.wait();

// Get progress
const progress = dm.getProgress();
// { 'media/123': { downloaded: 50M, total: 250M, percent: '20.0', state: 'downloading' } }
```

### Prioritization and emergency chunks

```javascript
// Boost files needed by current layout
dm.prioritizeLayoutFiles(['123', '456']);

// Emergency: chunk needed for video playback is stalled
// Moves to front of queue, reduces global concurrency to 2
dm.urgentChunk('media', '789', 3);
```

### CacheAnalyzer -- storage health

```javascript
import { CacheAnalyzer } from '@xiboplayer/cache';

const analyzer = new CacheAnalyzer(store, { threshold: 80 });

const report = await analyzer.analyze(requiredFiles);
console.log(`Storage: ${report.storage.percent}%`);
console.log(`Orphaned: ${report.files.orphaned} files`);
console.log(`Evicted: ${report.evicted.length} files`);
```

## Download Pipeline

Files flow through stages:

1. **Enqueueing** -- deduplication via `type/id` key, URL refresh if new URL has longer expiry
2. **Preparation** -- HEAD request determines chunking (> 100MB = chunked)
3. **Task creation** -- chunk-0 and chunk-last get high priority (video headers/trailers); BARRIER separates from bulk chunks
4. **Processing** -- concurrency-aware: 6 global connections, 2-3 per file
5. **Execution** -- HTTP Range GET with retries and exponential backoff
6. **Storage** -- proxy ContentStore saves chunks to filesystem
7. **Assembly** -- chunks concatenated; progressive callback enables playback before full download

### Chunk strategy

- **Default chunk size:** 50MB
- **Threshold:** files > 100MB get chunked
- **Header+trailer first:** MP4 moov atom in chunk-0 and chunk-last allows instant playback start
- **Barriers:** critical chunks download before bulk chunks begin
- **Resume:** cached chunks tracked in `skipChunks` Set; only missing chunks downloaded
- **Expired URLs:** deferred (not failed) -- next collection provides fresh URL

### Retry strategy by type

| Type | Max retries | Backoff | Notes |
|------|------------|---------|-------|
| media | 3 | 500ms | Large, cacheable files |
| layout | 3 | 500ms | Layout XML, stable URL |
| dataset | 4 | 15s, 30s, 60s, 120s | Re-enqueues 5x for "cache not ready" |
| static | 3 | 500ms | Widget dependencies (CSS, fonts) |

## API Reference

### StoreClient

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `has()` | `has(type, id)` | `Promise<boolean>` | Check if file exists |
| `get()` | `get(type, id)` | `Promise<Blob \| null>` | Retrieve file as Blob |
| `put()` | `put(type, id, body, contentType?)` | `Promise<boolean>` | Store file |
| `remove()` | `remove(files)` | `Promise<{deleted, total}>` | Delete files |
| `list()` | `list()` | `Promise<Array>` | List all cached files |

### DownloadManager

```javascript
new DownloadManager({ concurrency?, chunkSize?, chunksPerFile? })
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `enqueue()` | `enqueue(fileInfo)` | `FileDownload` | Add file to download queue |
| `getTask()` | `getTask(key)` | `FileDownload \| null` | Get task by "type/id" key |
| `getProgress()` | `getProgress()` | `Record<string, Progress>` | All in-progress downloads |
| `prioritizeLayoutFiles()` | `prioritizeLayoutFiles(mediaIds)` | `void` | Boost priority for layout files |
| `urgentChunk()` | `urgentChunk(type, id, chunkIndex)` | `boolean` | Move chunk to front, reduce concurrency |
| `clear()` | `clear()` | `void` | Cancel all, clear queue |

### CacheAnalyzer

```javascript
new CacheAnalyzer(storeClient, { threshold: 80 })
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `analyze()` | `analyze(requiredFiles)` | `Promise<Report>` | Compare cache vs required, evict if needed |

**Report:**
```javascript
{
  storage: { usage, quota, percent },
  files: { required, orphaned, total },
  orphaned: [{ id, type, size, cachedAt }],
  evicted: [{ id, type, size }],
  threshold: 80
}
```

### CacheManager

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `getCacheKey()` | `getCacheKey(type, id)` | `string` | Get cache key path |
| `addDependant()` | `addDependant(mediaId, layoutId)` | `void` | Track layout -> media reference |
| `removeLayoutDependants()` | `removeLayoutDependants(layoutId)` | `string[]` | Remove layout, return orphaned media IDs |
| `isMediaReferenced()` | `isMediaReferenced(mediaId)` | `boolean` | Check if media is still used |

## Dependencies

- `@xiboplayer/utils` -- logger
- `spark-md5` -- MD5 hashing for file verification

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)**
