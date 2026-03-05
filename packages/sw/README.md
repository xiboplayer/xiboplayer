# @xiboplayer/sw

**Service Worker toolkit for chunk streaming, media caching, and offline content serving.**

## Overview

Provides Service Worker building blocks for Xibo players:

- **Chunk streaming** -- progressive download with Range request support for large media files
- **BlobCache** -- in-memory cache for assembled chunks with LRU eviction
- **Widget HTML serving** -- intercepts GetResource requests and serves from ContentStore
- **Version-aware activation** -- prevents re-activation of same SW version to preserve in-flight streams
- **XLF-driven media resolution** -- parses layout XLF to determine exactly which media each layout needs
- **Adaptive chunk sizing** -- adjusts chunk size and concurrency based on device RAM (4GB/8GB+ tiers)
- **Unclaimed media** -- media files not claimed by any layout are enqueued for download

## Architecture

```
Browser fetch()                   Service Worker                    Proxy ContentStore
     |                                 |                                   |
     +-- GET /media/video.mp4 ------> RequestHandler.handleMedia()         |
     |                                 +- Check BlobCache (in-memory) ---> [hit: return blob]
     |                                 +- Miss: stream from chunks         |
     |                                 |  +- GET /store/media/video.mp4 ---+
     |                                 |  +- Assemble chunks, cache blob   |
     |                                 +- Return Response with Range support
     |
     +-- GET /widgets/1/2/3 --------> RequestHandler.handleWidget()        |
     |                                 +- GET /store/widget/1/2/3 ---------+
     |                                 +- Return HTML response             |
     |
     +-- postMessage(download) ------> MessageHandler.handleMessage()      |
                                       +- Parse XLF for media IDs          |
                                       +- Enqueue downloads                |
                                       +- Report progress                  |
```

## Installation

```bash
npm install @xiboplayer/sw
```

## Exports

| Export | Description |
|--------|-------------|
| `RequestHandler` | Fetch event handler: media streaming, widget serving, Range support |
| `MessageHandler` | PostMessage handler: download orchestration, progress reporting |
| `extractMediaIdsFromXlf` | Parse XLF XML to extract all required media file IDs |
| `calculateChunkConfig` | Adaptive chunk/concurrency config based on device RAM |

## Usage

```javascript
// In sw-pwa.js (Service Worker entry point)
import { RequestHandler, MessageHandler } from '@xiboplayer/sw';

const requestHandler = new RequestHandler();
const messageHandler = new MessageHandler();

self.addEventListener('fetch', (event) => {
  const response = requestHandler.handle(event.request);
  if (response) event.respondWith(response);
});

self.addEventListener('message', (event) => {
  messageHandler.handle(event);
});
```

### XLF media extraction

```javascript
import { extractMediaIdsFromXlf } from '@xiboplayer/sw';

const mediaIds = extractMediaIdsFromXlf(xlfXmlString);
// Returns: Set<string> of media file IDs needed by this layout
// Includes: fileId from media tags, data widget IDs (no fileId), background images
```

### Adaptive chunk config

```javascript
import { calculateChunkConfig } from '@xiboplayer/sw';

const config = calculateChunkConfig();
// 4GB RAM: { chunkSize: 25MB, concurrency: 4 }
// 8GB+ RAM: { chunkSize: 50MB, concurrency: 6 }
```

## Dependencies

- `@xiboplayer/utils` -- PLAYER_API constant
- `@xiboplayer/cache` -- StoreClient, DownloadManager

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)**
