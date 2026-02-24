# @xiboplayer/core Documentation

**Player core orchestration and lifecycle management.**

## 📖 Contents

- [ARCHITECTURE.md](ARCHITECTURE.md) - Core system architecture and design

## Overview

The `@xiboplayer/core` package provides the foundational player logic:

- **Player lifecycle** - Initialization, start, stop, restart
- **Module orchestration** - Coordinates renderer, cache, schedule, XMDS
- **Event system** - Pub/sub event bus for inter-module communication
- **Configuration** - Player configuration management
- **Error handling** - Centralized error management

## Installation

```bash
npm install @xiboplayer/core
```

## Basic Usage

```javascript
import { PlayerCore } from '@xiboplayer/core';

const player = new PlayerCore({
  cmsUrl: 'https://cms.example.com',
  displayId: 123,
  hardwareKey: 'abc123'
});

await player.initialize();
player.start();
```

## Architecture

See: [ARCHITECTURE.md](ARCHITECTURE.md) for detailed system design.

### Key Components

- **PlayerCore** - Main orchestrator
- **EventEmitter** - Event bus implementation
- **Config** - Configuration management
- **Logger** - Structured logging

## API Reference

### PlayerCore

```javascript
class PlayerCore {
  constructor(config)
  async initialize()
  start()
  stop()
  restart()
  on(event, callback)
  emit(event, data)
}
```

### Events

- `player:ready` - Player initialized and ready
- `player:error` - Player encountered error
- `layout:start` - Layout playback started
- `layout:end` - Layout playback ended
- `media:download` - Media file downloaded

## Dependencies

- `@xiboplayer/utils` - Shared utilities
- `@xiboplayer/xmds` - CMS communication (peer)
- `@xiboplayer/cache` - Offline storage (peer)
- `@xiboplayer/renderer` - Layout rendering (peer)
- `@xiboplayer/schedule` - Campaign scheduling (peer)

## Related Packages

- [@xiboplayer/renderer](../../renderer/docs/) - Rendering engine
- [@xiboplayer/cache](../../cache/docs/) - Cache management
- [@xiboplayer/schedule](../../schedule/docs/) - Scheduling logic

---
