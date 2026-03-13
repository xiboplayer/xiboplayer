# StoreClient + DownloadClient Architecture

## Overview

The cache package provides two client classes that separate storage concerns from download concerns:

- **StoreClient** — pure REST client for reading/writing content in the ContentStore (filesystem)
- **DownloadClient** — Service Worker postMessage client for managing background downloads

No Cache API is used anywhere. All content is stored on the filesystem via the proxy's ContentStore.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Client Code (PWA, Electron, Chromium)               │
│ - StoreClient for storage operations                │
│ - DownloadClient for download management            │
└─────────────────────────────────────────────────────┘
        │                               │
        ▼                               ▼
┌─────────────────┐           ┌─────────────────┐
│ StoreClient     │           │ DownloadClient  │
│ (REST)          │           │ (SW postMessage)│
│                 │           │                 │
│ has(type, id)   │           │ download(files) │
│ get(type, id)   │           │ prioritize()    │
│ put(type, id)   │           │ getProgress()   │
│ remove(files)   │           │                 │
│ list()          │           │                 │
└────────┬────────┘           └────────┬────────┘
         │                             │
         ▼                             ▼
┌─────────────────┐           ┌─────────────────┐
│ Proxy REST API  │           │ Service Worker  │
│ /store/:type/*  │           │ DownloadManager │
│                 │           │ RequestHandler  │
│ GET, HEAD, PUT  │           │ MessageHandler  │
│ POST /delete    │           │                 │
│ GET /list       │           │                 │
└────────┬────────┘           └─────────────────┘
         │
         ▼
┌─────────────────┐
│ ContentStore    │
│ (filesystem)    │
│                 │
│ media/*.bin     │
│ layout/*.bin    │
│ widget/*.bin    │
│ static/*.bin    │
└─────────────────┘
```

## Components

### 1. StoreClient (REST)

**Location**: `packages/cache/src/store-client.js`

**Purpose**: Pure REST client for content storage operations. No Service Worker dependency — works immediately with just `fetch()`.

**API**:
```javascript
class StoreClient {
  async has(type, id)                    // HEAD /store/:type/:id → { exists, size }
  async get(type, id)                    // GET /store/:type/:id → Blob | null
  async put(type, id, body, contentType) // PUT /store/:type/:id
  async remove(files)                    // POST /store/delete
  async list()                           // GET /store/list → Array<FileInfo>
}
```

**Usage**:
```javascript
import { StoreClient } from '@xiboplayer/cache';

const store = new StoreClient();

// Check if file exists
const { exists, size } = await store.has('media', '123');

// Store widget HTML
await store.put('widget', '472/221/190', htmlBlob, 'text/html');

// Get file
const blob = await store.get('media', '123');

// List all cached files
const files = await store.list();
```

### 2. DownloadClient (SW postMessage)

**Location**: `packages/cache/src/download-client.js`

**Purpose**: Communicates with the Service Worker's DownloadManager via postMessage to manage background downloads.

**API**:
```javascript
class DownloadClient {
  async init()                           // Wait for SW ready
  async download(files)                  // SW DOWNLOAD_FILES
  async prioritize(type, id)             // SW PRIORITIZE_DOWNLOAD
  async prioritizeLayout(mediaIds)       // SW PRIORITIZE_LAYOUT_FILES
  async getProgress()                    // SW GET_DOWNLOAD_PROGRESS
}
```

**Usage**:
```javascript
import { DownloadClient } from '@xiboplayer/cache';

const downloads = new DownloadClient();
await downloads.init();

// Request background downloads
await downloads.download(files);

// Prioritize a file needed for the current layout
await downloads.prioritize('media', '12');

// Check download progress
const progress = await downloads.getProgress();
```

## REST API Routes (Proxy)

The proxy server (`packages/proxy/src/proxy.js`) exposes these endpoints backed by ContentStore:

| Method | Route | Purpose |
|--------|-------|---------|
| `HEAD` | `/store/:type/*` | Existence + size check (returns 404 for incomplete chunked files) |
| `GET` | `/store/:type/*` | Serve file (Range support) |
| `PUT` | `/store/:type/*` | Store file |
| `POST` | `/store/delete` | Delete files |
| `POST` | `/store/mark-complete` | Mark chunked download complete |
| `POST` | `/store/unmark-complete` | Unmark chunked file (keeps chunks, allows partial re-download) |
| `GET` | `/store/missing-chunks/:type/*` | Return missing chunk indices for a chunked file |
| `GET` | `/store/list` | List all cached files |

**Note:** HEAD must be registered before GET in Express 5 because `app.get()` also matches HEAD requests.

### ContentStore (Filesystem)

**Location**: `packages/proxy/src/content-store.js`

The ContentStore manages files on disk with metadata:

```
~/.config/xiboplayer/{electron,chromium}/content-store/
├── media/
│   ├── 12.bin          # Video file
│   ├── 12.meta.json    # { contentType, size, cachedAt, md5 }
│   ├── 34.bin          # Image file
│   └── 34.meta.json
├── layout/
│   ├── 472.bin         # XLF layout XML
│   └── 472.meta.json
├── widget/
│   ├── 472/221/190.bin # Widget HTML
│   └── 472/221/190.meta.json
└── static/
    ├── bundle.min.js.bin
    ├── fonts.css.bin
    ├── Aileron-Heavy.otf.bin
    └── ...
```

## Download Flow

### Cache-Through with XMDS Support (v0.6.12)

The proxy's `cacheThrough()` function serves files from the ContentStore or fetches them from the CMS on cache miss. It supports both REST and XMDS transports:

```
Request for /player/api/v2/media/file/42.mp4
    │
    ├── Check ContentStore → HIT → serve from disk
    │
    └── MISS → build CMS fetch URL:
        ├── Has X-Cms-Download-Url header? → use it (XMDS signed URL)
        └── No header? → build REST URL: ${cmsUrl}/player/api/v2/media/file/42.mp4
            │
            └── Fetch from CMS → store in ContentStore → serve
```

The `X-Cms-Download-Url` header carries the original XMDS signed URL (e.g., `xmds.php?file=42.mp4&X-Amz-Signature=...`). This is set by:
- `DownloadTask` in `download-manager.js` (when `fileInfo.cmsDownloadUrl` is present)
- `RequestHandler._handleXmdsFile()` in the Service Worker (for intercepted XMDS URLs)

### Service Worker Download

```
Client                DownloadClient       Service Worker
  │                       │                       │
  │ download(files)       │                       │
  │──────────────────────>│                       │
  │                       │ postMessage           │
  │                       │ (DOWNLOAD_FILES)      │
  │                       │──────────────────────>│
  │                       │                       │
  │                       │                       │ enqueue files
  │                       │                       │ download from CMS
  │                       │                       │ PUT /store/:type/:id
  │                       │                       │
  │                       │ acknowledge           │
  │                       │<──────────────────────│
  │ return (immediate)    │                       │
  │<──────────────────────│                       │
  │                       │                       │
  │ ... continue work ... │                       │
  │                       │                       │
  │ store.has('media','1')│                       │
  │──────────────────────>│                       │
  │                       │ HEAD /store/media/1   │
  │                       │──────────────────────>│
  │                       │<──────────────────────│
  │<──────────────────────│                       │
  │ { exists: true }      │                       │
```

### Widget HTML Storage

Widget HTML is processed on the main thread by `cacheWidgetHtml()`:

1. Fetch widget HTML from CMS (`getResource`)
2. Inject `<base>` tag for relative path resolution
3. Rewrite CMS signed URLs → local `/player/cache/static/*` paths
4. Fetch and store static dependencies (bundle.min.js, fonts.css, fonts)
5. Store widget HTML via `PUT /store/widget/{layoutId}/{regionId}/{mediaId}`

Static resources are stored before widget HTML to prevent race conditions when the iframe loads.

## Chunked Download Resume

Large media files are downloaded in chunks (configurable size, default ~100MB per chunk). If a download is interrupted (crash, network failure, process restart), the player resumes by only downloading missing chunks:

### How it works

1. **On startup/collection**: `enqueueFile()` calls `GET /store/missing-chunks/{storeKey}` before enqueueing
2. If chunks exist on disk, it populates `file.skipChunks` with the indices of cached chunks
3. The download pipeline skips those chunks, downloading only the missing ones
4. After all chunks arrive, the file is marked complete

### On video playback error

1. The renderer emits a `videoError` event when a `<video>` element fails
2. The PWA calls `GET /store/missing-chunks/{storeKey}` to check for missing chunks
3. If chunks are missing, it calls `POST /store/unmark-complete` (keeps all existing chunks on disk)
4. Triggers `collectNow()` — the normal enqueue path populates `skipChunks` and re-downloads only the missing chunks

### Incomplete file detection

- `HEAD /store/:type/*` returns **404** for chunked files with missing chunks (so the download pipeline picks them up)
- `cacheThrough()` falls through to the CMS for incomplete chunked files instead of serving broken data from the store

### Example

A 2GB video (21 chunks) where chunks 0 and 9 are cached:
```
GET /store/missing-chunks/api/v2/player/media/15
→ { "missing": [1,2,3,4,5,6,7,8,10,11,12,13,14,15,16,17,18,19,20], "numChunks": 21 }

# enqueueFile sets skipChunks = {0, 9}
# Download pipeline fetches only 19 chunks instead of 21
# Saves ~200MB of bandwidth
```

## Error Handling

| Scenario | StoreClient | DownloadClient |
|----------|-------------|----------------|
| Network failure | `fetch()` throws | SW retries internally |
| File not found | `has()` → `{ exists: false }` | N/A |
| Proxy down | `fetch()` throws | SW queues for retry |
| SW not ready | N/A | `init()` waits for activation |

## Performance

### StoreClient

| Operation | Latency | Notes |
|-----------|---------|-------|
| `has()` | ~2ms | HEAD request to local proxy |
| `get()` | ~5ms | GET from filesystem |
| `put()` | ~10ms | Write to filesystem |
| `list()` | ~20ms | Scan all type directories |

### DownloadClient

| Operation | Latency | Notes |
|-----------|---------|-------|
| `download()` | ~100ms | postMessage + enqueue |
| `prioritize()` | ~50ms | Reorder queue |
| `getProgress()` | ~50ms | Query active downloads |

Downloads run with configurable concurrency (default 6 on high-RAM devices).

## Summary

- **StoreClient**: Pure REST, no SW dependency, works immediately
- **DownloadClient**: SW postMessage, non-blocking background downloads
- **ContentStore**: Filesystem storage, no Cache API anywhere
- **Types**: media/, layout/, widget/, static/

**Result**: Single storage backend (filesystem), two clean client interfaces, zero Cache API usage.
