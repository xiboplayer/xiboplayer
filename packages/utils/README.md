# @xiboplayer/utils

**Shared utilities for all XiboPlayer SDK packages.**

## Overview

Foundation utilities used across the SDK:

- **Logger** -- structured logging with configurable levels (DEBUG, INFO, WARNING, ERROR, NONE) and per-module tags
- **Log sinks** -- pluggable log destinations (console, LogReporter for CMS submission)
- **EventEmitter** -- lightweight pub/sub event system
- **fetchWithRetry** -- HTTP fetch with exponential backoff, jitter, and configurable retries
- **Config** -- hardware key management, IndexedDB-backed configuration, CMS ID computation
- **CMS REST API client** -- 77-method JSON API client with ETag caching and JWT auth
- **PLAYER_API** -- configurable base path for media/widget/dependency URLs

## Installation

```bash
npm install @xiboplayer/utils
```

## Usage

### Logger

```javascript
import { createLogger, setLogLevel, applyCmsLogLevel, registerLogSink } from '@xiboplayer/utils';

const log = createLogger('my-module');
log.info('Starting...');
log.debug('Detailed info', { key: 'value' });
log.warn('Something unexpected');
log.error('Critical failure', error);

// Set global log level
setLogLevel('DEBUG');  // DEBUG, INFO, WARNING, ERROR, NONE

// Apply CMS log level (maps CMS values to SDK levels)
applyCmsLogLevel('audit'); // maps to DEBUG

// Register a custom log sink (e.g., CMS log reporter)
registerLogSink({
  log(level, tag, ...args) {
    cmsReporter.log(level, args.join(' '), tag);
  }
});
```

### EventEmitter

```javascript
import { EventEmitter } from '@xiboplayer/utils';

class MyClass extends EventEmitter {
  doSomething() {
    this.emit('done', { result: 42 });
  }
}

const obj = new MyClass();
obj.on('done', (data) => console.log(data));
obj.once('done', (data) => console.log('First time only'));
obj.off('done', handler);
```

### fetchWithRetry

```javascript
import { fetchWithRetry } from '@xiboplayer/utils';

const response = await fetchWithRetry(url, {
  retries: 3,        // Max retry attempts (default: 2)
  baseDelay: 2000,   // Base delay in ms (default: 2000)
  // Backoff: baseDelay * 2^attempt + random jitter
  headers: { 'Content-Type': 'application/json' },
  method: 'POST',
  body: JSON.stringify(data),
});
```

### Config

```javascript
import { config, computeCmsId } from '@xiboplayer/utils';

// Read config values (from localStorage / IndexedDB)
const cmsUrl = config.data.cmsUrl;
const hardwareKey = config.data.hardwareKey;

// Compute CMS ID for namespacing databases
const cmsId = computeCmsId('https://cms.example.com', 'display-key');
// Returns FNV hash string for unique IndexedDB names per CMS+display pair
```

### CMS REST API client

```javascript
import { CmsApiClient } from '@xiboplayer/utils';

const api = new CmsApiClient({
  baseUrl: 'https://cms.example.com',
  clientId: 'oauth-client-id',
  clientSecret: 'oauth-client-secret',
});

// 77 methods covering all CMS entities
const displays = await api.getDisplays();
const layouts = await api.getLayouts();
await api.authorizeDisplay(displayId);
```

### PLAYER_API

```javascript
import { PLAYER_API, setPlayerApi } from '@xiboplayer/utils';

// Default: '/api/v2/player'
console.log(PLAYER_API); // '/api/v2/player'

// Override before route registration (e.g., in proxy setup)
setPlayerApi('/custom/player/path');
```

## Exports

| Export | Description |
|--------|-------------|
| `createLogger(tag)` | Create a tagged logger instance |
| `setLogLevel(level)` | Set global log level |
| `getLogLevel()` | Get current log level |
| `isDebug()` | Check if DEBUG level is active |
| `applyCmsLogLevel(cmsLevel)` | Map CMS log level to SDK level |
| `registerLogSink(sink)` | Add custom log destination |
| `unregisterLogSink(sink)` | Remove log destination |
| `LOG_LEVELS` | Level constants: DEBUG, INFO, WARNING, ERROR, NONE |
| `EventEmitter` | Pub/sub event emitter class |
| `fetchWithRetry(url, opts)` | Fetch with exponential backoff |
| `config` | Global config instance (localStorage/IndexedDB) |
| `extractPwaConfig(config)` | Extract PWA-relevant keys from shell config |
| `computeCmsId(url, key)` | FNV hash for CMS+display namespacing |
| `SHELL_ONLY_KEYS` | Config keys not forwarded to PWA |
| `CmsApiClient` | CMS REST API client (77 methods) |
| `CmsApiError` | API error class with status code |
| `PLAYER_API` | Media/widget base path (configurable) |
| `setPlayerApi(base)` | Override PLAYER_API at runtime |
| `VERSION` | Package version from package.json |

## Dependencies

No external runtime dependencies.

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)**
