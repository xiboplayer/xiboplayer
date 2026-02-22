# CacheProxy Architecture - Unified Cache Interface

## Overview

The CacheProxy provides a unified interface for file caching and downloading that works seamlessly with both Service Worker and direct cache implementations. This abstraction enables platform-independent code and automatic backend selection.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Client Code (PWA, XLR, Mobile, etc.)                │
│ - Uses CacheProxy for all file operations           │
│ - No knowledge of backend implementation             │
│ - Minimal integration code                           │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ CacheProxy Module (Shared Interface)                │
│ - Detects environment (Service Worker vs Direct)    │
│ - Provides unified API: get/download/cache files    │
│ - No client code changes needed                     │
└─────────────────────────────────────────────────────┘
                        ↓
        ┌───────────────┴───────────────┐
        ↓                               ↓
┌─────────────────┐           ┌─────────────────┐
│ Service Worker  │           │ Direct Cache    │
│ Backend         │           │ Backend         │
│                 │           │                 │
│ - Downloads in  │           │ - cache.js      │
│   background    │           │ - IndexedDB     │
│ - Caches files  │           │ - Blocking      │
│ - Serves via    │           │   downloads     │
│   fetch         │           │                 │
└─────────────────┘           └─────────────────┘
```

## Components

### 1. CacheProxy (Main Interface)

**Location**: `packages/core/src/cache-proxy.js`

**Purpose**: Auto-detects backend and provides unified API

**API**:
```javascript
class CacheProxy {
  async init()
  async getFile(type: string, id: string): Promise<Blob|null>
  async requestDownload(files: FileInfo[]): Promise<void>
  async isCached(type: string, id: string): Promise<boolean>
  getBackendType(): string // 'service-worker' | 'direct'
  isUsingServiceWorker(): boolean
}
```

**Usage**:
```javascript
import { CacheProxy } from '@core/cache-proxy.js';

// Initialize
const proxy = new CacheProxy(cacheManager);
await proxy.init();

// Get file (works with both backends)
const blob = await proxy.getFile('media', '123');

// Request downloads
await proxy.requestDownload([
  { id: '1', type: 'media', path: 'https://...', md5: '...' }
]);

// Check cache
const cached = await proxy.isCached('layout', '456');
```

### 2. ServiceWorkerBackend

**Purpose**: Routes requests to Service Worker

**Responsibilities**:
- Detects Service Worker availability
- Uses postMessage for downloads
- Uses fetch for file retrieval
- Non-blocking downloads (background)

**Implementation Details**:
```javascript
class ServiceWorkerBackend {
  async getFile(type, id) {
    // Fetch from /player/cache/{type}/{id}
    // Service Worker intercepts and serves from cache
  }

  async requestDownload(files) {
    // postMessage to Service Worker
    // Downloads happen in background
    // Returns immediately
  }
}
```

### 3. DirectCacheBackend

**Purpose**: Fallback when Service Worker unavailable

**Responsibilities**:
- Uses cache.js directly
- Blocking downloads
- IndexedDB metadata storage
- Browser Cache API for files

**Implementation Details**:
```javascript
class DirectCacheBackend {
  async getFile(type, id) {
    // Call cacheManager.getCachedFile()
    // Direct Cache API access
  }

  async requestDownload(files) {
    // Sequential downloads
    // Blocks until complete
    // Fallback for non-Service Worker environments
  }
}
```

## Backend Selection

CacheProxy automatically selects the best backend:

```javascript
async init() {
  // Try Service Worker first
  if (navigator.serviceWorker?.controller) {
    this.backend = new ServiceWorkerBackend();
    this.backendType = 'service-worker';
  } else {
    // Fallback to direct cache
    this.backend = new DirectCacheBackend(cacheManager);
    this.backendType = 'direct';
  }
}
```

### Selection Criteria

| Condition | Backend | Reason |
|-----------|---------|--------|
| Service Worker active | ServiceWorkerBackend | Better performance, non-blocking |
| Service Worker not active | DirectCacheBackend | Compatibility, works everywhere |
| Service Worker failed | DirectCacheBackend | Graceful degradation |

## Integration Example

### Before (Without CacheProxy)

```javascript
// Complex logic with manual fallback
const serviceWorkerActive = navigator.serviceWorker?.controller;

if (serviceWorkerActive) {
  try {
    await sendFilesToServiceWorker(files);
  } catch (error) {
    for (const file of files) {
      await cacheManager.downloadFile(file);
    }
  }
} else {
  for (const file of files) {
    await cacheManager.downloadFile(file);
  }
}

// Separate media retrieval
const response = await cacheManager.getCachedResponse('media', fileId);
const blob = await response.blob();
```

### After (With CacheProxy)

```javascript
// Simple, unified interface
await cacheProxy.requestDownload(files);

// Consistent file retrieval
const blob = await cacheProxy.getFile('media', fileId);
```

**Benefits**:
- 75% less code
- Automatic backend selection
- No error handling duplication
- Platform-independent

## Performance Characteristics

### Service Worker Backend

| Metric | Value | Notes |
|--------|-------|-------|
| Download latency | ~100ms | postMessage + enqueue |
| File retrieval | ~10ms | Fetch intercept |
| Blocking | No | Downloads in background |
| Concurrency | 4 files | Configurable |

### Direct Cache Backend

| Metric | Value | Notes |
|--------|-------|-------|
| Download latency | Varies | Depends on file size |
| File retrieval | ~5ms | Direct cache access |
| Blocking | Yes | Sequential downloads |
| Concurrency | 1 file | No parallelism |

## Service Worker Download Flow

```
Client                CacheProxy            Service Worker
  │                       │                       │
  │ requestDownload()     │                       │
  │─────────────────────> │                       │
  │                       │ postMessage           │
  │                       │ (DOWNLOAD_FILES)      │
  │                       │─────────────────────> │
  │                       │                       │
  │                       │                       │ enqueue files
  │                       │                       │ start downloads
  │                       │                       │
  │                       │ acknowledge           │
  │                       │ <─────────────────────│
  │ return (immediate)    │                       │
  │ <─────────────────────│                       │
  │                       │                       │
  │ ... continue work ... │                       │ ... downloading ...
  │                       │                       │
  │ getFile('media', '1') │                       │
  │─────────────────────> │                       │
  │                       │ fetch /cache/media/1  │
  │                       │─────────────────────> │
  │                       │                       │
  │                       │                       │ if cached: serve
  │                       │                       │ if downloading: wait
  │                       │                       │ if not found: 404
  │                       │                       │
  │                       │ <─────────────────────│
  │ <─────────────────────│                       │
  │ blob                  │                       │
```

## Direct Cache Download Flow

```
Client                CacheProxy            Cache.js
  │                       │                       │
  │ requestDownload()     │                       │
  │─────────────────────> │                       │
  │                       │ downloadFile() x N    │
  │                       │─────────────────────> │
  │                       │                       │ fetch file
  │                       │                       │ verify MD5
  │                       │                       │ cache in Cache API
  │                       │                       │ save metadata to IDB
  │                       │                       │
  │                       │ <─────────────────────│
  │ return (after all     │                       │
  │  downloads complete)  │                       │
  │ <─────────────────────│                       │
```

## Error Handling

CacheProxy handles errors gracefully:

```javascript
try {
  await cacheProxy.requestDownload(files);
} catch (error) {
  // Backend-specific error
  // Already logged by backend
  // Fallback handled automatically
}
```

### Error Scenarios

| Scenario | Service Worker | Direct Cache |
|----------|----------------|--------------|
| Network failure | Retry in SW | Throw error |
| File not found | 404 on fetch | null on get |
| MD5 mismatch | Log warning, continue | Log warning, continue |
| SW not available | Auto-switch to Direct | N/A |

## Testing

### Unit Tests

```javascript
// Test backend detection
it('should use Service Worker when available', async () => {
  const proxy = new CacheProxy(cacheManager);
  await proxy.init();
  expect(proxy.getBackendType()).toBe('service-worker');
});

// Test fallback
it('should fallback to direct cache', async () => {
  // Mock SW not available
  const proxy = new CacheProxy(cacheManager);
  await proxy.init();
  expect(proxy.getBackendType()).toBe('direct');
});
```

### Integration Tests

```javascript
// Test file download
it('should download and cache files', async () => {
  const files = [{ id: '1', type: 'media', path: 'https://...' }];
  await proxy.requestDownload(files);

  const blob = await proxy.getFile('media', '1');
  expect(blob).toBeTruthy();
  expect(blob.size).toBeGreaterThan(0);
});
```

## Migration Guide

### For Existing Platforms

1. **Import CacheProxy**:
   ```javascript
   import { CacheProxy } from '@core/cache-proxy.js';
   ```

2. **Initialize**:
   ```javascript
   const cacheProxy = new CacheProxy(cacheManager);
   await cacheProxy.init();
   ```

3. **Replace download code**:
   ```javascript
   // Old:
   await cacheManager.downloadFile(file);

   // New:
   await cacheProxy.requestDownload([file]);
   ```

4. **Replace file retrieval**:
   ```javascript
   // Old:
   const response = await cacheManager.getCachedResponse('media', id);
   const blob = await response.blob();

   // New:
   const blob = await cacheProxy.getFile('media', id);
   ```

## Widget Data Download Flow

Widget data for RSS feeds and dataset widgets is handled server-side. The CMS enriches
the RequiredFiles response with absolute download URLs for widget data files. These are
downloaded through the normal CacheProxy/Service Worker pipeline alongside regular media,
rather than being fetched client-side by the player. This ensures widget data is available
offline and benefits from the same parallel chunk download and caching infrastructure.

Widget HTML served from cache uses a dynamic `<base>` tag pointing to the Service Worker
scope path, ensuring relative URLs within widget HTML resolve correctly regardless of the
player's deployment path.

### For New Platforms

Simply use CacheProxy from the start:

```javascript
class MyPlayer {
  async init() {
    // Initialize CacheProxy
    this.cache = new CacheProxy(cacheManager);
    await this.cache.init();

    // Use unified API
    const files = await this.xmds.requiredFiles();
    await this.cache.requestDownload(files);

    const blob = await this.cache.getFile('media', '123');
  }
}
```

## Future Enhancements

### Planned Features

1. **Smart Backend Switching**:
   - Monitor Service Worker health
   - Auto-switch if SW becomes unresponsive
   - Fallback to direct cache on errors

2. **Progress Tracking**:
   ```javascript
   proxy.on('download-progress', (progress) => {
     console.log(`Downloaded ${progress.loaded}/${progress.total}`);
   });
   ```

3. **Cache Invalidation**:
   ```javascript
   await proxy.invalidate('media', '123');
   await proxy.invalidateAll();
   ```

4. **Prefetching**:
   ```javascript
   await proxy.prefetch(['media/1', 'layout/2']);
   ```

## Benefits

### For Developers

1. **Simpler Code**: 75% reduction in cache-related code
2. **Automatic Optimization**: Best backend selected automatically
3. **Platform Independence**: Same code works everywhere
4. **Better Testing**: Mock backends for unit tests

### For Users

1. **Better Performance**: Service Worker when available
2. **Better Compatibility**: Fallback when SW unavailable
3. **Transparent**: No difference in functionality
4. **Reliable**: Graceful degradation on errors

## Summary

CacheProxy provides a clean abstraction layer that:
- ✅ Automatically selects best backend
- ✅ Provides unified API across platforms
- ✅ Enables non-blocking downloads with Service Worker
- ✅ Gracefully falls back to direct cache
- ✅ Simplifies platform-specific code
- ✅ Makes testing easier

**Result**: Platform-independent cache code that just works.
