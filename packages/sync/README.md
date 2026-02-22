# @xiboplayer/sync

**Multi-display synchronization for Xibo video walls.**

## Overview

BroadcastChannel-based lead/follower synchronization:

- **Lead election** — automatic leader selection among browser tabs/windows
- **Synchronized playback** — video start coordinated across displays
- **Layout sync** — all displays transition to the same layout simultaneously
- **Stats/logs delegation** — follower tabs delegate proof-of-play stats and log submission to the sync lead via BroadcastChannel, avoiding duplicate CMS traffic in video wall setups

Designed for video wall setups where multiple screens show synchronized content.

## Installation

```bash
npm install @xiboplayer/sync
```

## Usage

```javascript
import { SyncManager } from '@xiboplayer/sync';

const sync = new SyncManager({ displayId: 'screen-1' });
sync.on('layout-sync', ({ layoutId }) => renderer.show(layoutId));
sync.init();
```

---

**Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)** | [MCP Server](https://github.com/xibo-players/xiboplayer/tree/main/mcp-server) for AI-assisted development
