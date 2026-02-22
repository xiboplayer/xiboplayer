# @xiboplayer/cache

**Offline caching and download management with parallel chunk downloads.**

## Overview

Manages media downloads and offline storage for Xibo players:

- **Parallel chunk downloads** — large files (100MB+) split into configurable chunks, downloaded concurrently
- **Header+trailer first** — MP4 moov atom fetched first for instant playback start before full download
- **MD5 verification** — integrity checking with CRC32-based skip optimization
- **Download queue** — flat queue with barriers for layout-ordered downloading
- **CacheProxy** — browser-side proxy that communicates with a Service Worker backend
- **Widget data via enriched RequiredFiles** — RSS/dataset widget data is fetched through server-side enriched RequiredFiles paths (CMS adds download URLs), not via client-side pre-fetching
- **Dynamic BASE path** — widget HTML `<base>` tag uses a dynamic path within the Service Worker scope for correct relative URL resolution

## Installation

```bash
npm install @xiboplayer/cache
```

## Usage

```javascript
import { CacheProxy } from '@xiboplayer/cache';

const cache = new CacheProxy();
await cache.init();

// Request downloads (delegated to Service Worker)
await cache.requestDownload({ layoutOrder, files });

// Check if a file is cached
const isCached = await cache.has(fileId);
```

## Exports

| Export | Description |
|--------|-------------|
| `CacheProxy` | Browser-side proxy communicating with SW backend |
| `DownloadManager` | Core download queue with barrier-based ordering |

## Dependencies

- `@xiboplayer/utils` — logger, events
- `spark-md5` — MD5 hashing for file verification

---

**Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)** | [MCP Server](https://github.com/xibo-players/xiboplayer/tree/main/mcp-server) for AI-assisted development
