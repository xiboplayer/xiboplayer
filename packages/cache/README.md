# @xiboplayer/cache

**Offline caching and download management with durable filesystem storage.**

## Overview

Manages media downloads and offline storage for Xibo players:

- **StoreClient** — pure REST client for reading/writing content in the ContentStore (filesystem via proxy)
- **DownloadClient** — Service Worker postMessage client for managing background downloads
- **Parallel chunk downloads** — large files (100MB+) split into configurable chunks, downloaded concurrently
- **Header+trailer first** — MP4 moov atom fetched first for instant playback start before full download
- **MD5 verification** — integrity checking with CRC32-based skip optimization
- **Download queue** — flat queue with barriers for layout-ordered downloading
- **CacheAnalyzer** — stale media detection and storage-pressure eviction
- **Widget data via enriched RequiredFiles** — RSS/dataset widget data is fetched through server-side enriched RequiredFiles paths (CMS adds download URLs), not via client-side pre-fetching
- **Dynamic BASE path** — widget HTML `<base>` tag uses a dynamic path within the Service Worker scope for correct relative URL resolution

No Cache API is used anywhere. All content is stored on the filesystem via the proxy's ContentStore.

## Installation

```bash
npm install @xiboplayer/cache
```

## Usage

```javascript
import { StoreClient, DownloadClient } from '@xiboplayer/cache';

// Storage operations (pure REST, no SW needed)
const store = new StoreClient();
const { exists, size } = await store.has('media', '123');
const blob = await store.get('media', '123');
await store.put('widget', '472/221/190', htmlBlob, 'text/html');

// Download management (SW postMessage)
const downloads = new DownloadClient();
await downloads.init();
await downloads.download(files);
const progress = await downloads.getProgress();
```

## Exports

| Export | Description |
|--------|-------------|
| `StoreClient` | Pure REST client for ContentStore — has/get/put/remove/list |
| `DownloadClient` | SW postMessage client for background downloads |
| `DownloadManager` | Core download queue with barrier-based ordering |
| `CacheAnalyzer` | Stale media detection and eviction |

## Dependencies

- `@xiboplayer/utils` — logger, events
- `spark-md5` — MD5 hashing for file verification

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)**
