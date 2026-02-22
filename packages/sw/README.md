# @xiboplayer/sw

**Service Worker toolkit for chunk streaming and offline caching.**

## Overview

Provides Service Worker building blocks for Xibo players:

- **Chunk streaming** — progressive download with Range request support for large media files
- **BlobCache** — in-memory cache for assembled chunks with LRU eviction
- **Widget HTML serving** — intercepts GetResource requests and serves from cache
- **Version-aware activation** — prevents re-activation of same SW version to preserve in-flight streams
- **XLF-driven media resolution** — parses layout XLF to determine exactly which media each layout needs, including data widget IDs extracted from media tags without a fileId
- **Unclaimed media downloads** — media files not claimed by any layout (widget data, non-XLF assets) are enqueued for download instead of being skipped

## Installation

```bash
npm install @xiboplayer/sw
```

## Features

This package provides the core logic used by the PWA Service Worker (`sw-pwa.js`). The SW handles:

1. **Static caching** — PWA shell files cached on install
2. **Media caching** — layout media downloaded via parallel chunks
3. **Range requests** — video seeking served from cached chunks
4. **Download queue** — flat queue with barriers for layout-ordered downloads

---

**Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)** | [MCP Server](https://github.com/xibo-players/xiboplayer/tree/main/mcp-server) for AI-assisted development
