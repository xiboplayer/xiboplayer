# @xiboplayer/core

**Player orchestration, collection cycle, and lifecycle management for Xibo digital signage.**

## Overview

The core package is the central coordinator of a Xibo player. It manages:

- **Collection cycle** — periodic CMS polling for schedule, required files, and display settings
- **Layout state machine** — controls which layout is playing, handles transitions and interrupts
- **Offline mode** — falls back to cached schedule and media when the CMS is unreachable
- **Event bus** — emits lifecycle events (`schedule-updated`, `download-request`, `layout-changed`, etc.)

## Installation

```bash
npm install @xiboplayer/core
```

## Usage

```javascript
import { PlayerCore } from '@xiboplayer/core';

const player = new PlayerCore({
  transport,   // XMDS or REST transport from @xiboplayer/xmds
  schedule,    // Schedule instance from @xiboplayer/schedule
  renderer,    // Renderer instance from @xiboplayer/renderer
  cache,       // StoreClient + DownloadClient from @xiboplayer/cache
});

player.on('download-request', ({ layoutOrder, files }) => {
  // Handle media downloads in layout priority order
});

await player.init();
```

## Key Events

| Event | Payload | Description |
|-------|---------|-------------|
| `schedule-updated` | `{ schedule }` | New schedule received from CMS |
| `download-request` | `{ layoutOrder, files }` | Media files needed, ordered by layout priority |
| `layout-changed` | `{ layoutId }` | Currently playing layout changed |
| `collection-error` | `{ error }` | CMS communication failed |
| `status` | `{ message }` | Human-readable status update |

## Dependencies

- `@xiboplayer/utils` — logger, events, config

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)**
