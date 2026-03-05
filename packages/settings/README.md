# @xiboplayer/settings

**CMS display settings management for Xibo players.**

## Overview

Parses and applies display configuration received from the CMS RegisterDisplay response:

- **Collection interval** -- how often to poll the CMS (60s-86400s, default 300s)
- **Display info** -- name, resolution (sizeX/sizeY)
- **Stats config** -- enable/disable, aggregation mode (Individual/Aggregate)
- **Log level** -- remote log verbosity (error, audit, info, debug)
- **XMR config** -- WebSocket address and CMS key for real-time commands
- **Download windows** -- time-of-day restrictions with overnight crossing support
- **Screenshot config** -- interval and quality settings
- **Event-driven** -- emits `interval-changed` and `settings-applied` on updates

## Architecture

```
CMS RegisterDisplay response
        |
        v
DisplaySettings.applySettings(raw)
  +- Parse all settings (handles both camelCase and PascalCase)
  +- Validate and normalize values
  +- Detect changes (collectInterval)
  +- Emit events
        |
        v
Platform Layer listens to events
  +- 'interval-changed' -> update collection timer
  +- 'settings-applied' -> update UI, screenshot config, etc.
```

## Installation

```bash
npm install @xiboplayer/settings
```

## Usage

```javascript
import { DisplaySettings } from '@xiboplayer/settings';

const settings = new DisplaySettings();

// Apply settings from CMS (RegisterDisplay response)
const { changed, settings: applied } = settings.applySettings(regResult.settings);
console.log('Changed:', changed); // e.g., ['collectInterval']

// Read settings
const interval = settings.getCollectInterval(); // 300 (seconds)
const displayName = settings.getDisplayName();   // 'Lobby Display'
const { width, height } = settings.getDisplaySize(); // { width: 1920, height: 1080 }
const statsOn = settings.isStatsEnabled();        // true/false

// Check download window
if (settings.isInDownloadWindow()) {
  startDownloads();
} else {
  const next = settings.getNextDownloadWindow();
  console.log(`Downloads paused, next window at ${next}`);
}

// Check screenshot timing
if (settings.shouldTakeScreenshot(lastScreenshotDate)) {
  captureScreenshot();
}

// Listen for changes
settings.on('interval-changed', (newInterval) => {
  updateCollectionTimer(newInterval);
});

settings.on('settings-applied', (allSettings, changedKeys) => {
  console.log('Settings updated:', changedKeys);
});
```

## Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `collectInterval` | number | 300 | CMS polling interval (seconds, min 60, max 86400) |
| `displayName` | string | 'Unknown Display' | Human-readable display name |
| `sizeX` / `sizeY` | number | 1920 / 1080 | Display resolution |
| `statsEnabled` | boolean | false | Enable proof-of-play tracking |
| `aggregationLevel` | string | 'Individual' | Stats mode: 'Individual' or 'Aggregate' |
| `logLevel` | string | 'error' | Remote log level |
| `xmrNetworkAddress` | string | null | XMR network address |
| `xmrWebSocketAddress` | string | null | XMR WebSocket URL |
| `xmrCmsKey` | string | null | XMR authentication key |
| `preventSleep` | boolean | true | Keep screen awake |
| `screenshotInterval` | number | 120 | Seconds between screenshots |
| `downloadStartWindow` | string | null | Download window start (HH:MM) |
| `downloadEndWindow` | string | null | Download window end (HH:MM) |

## API Reference

### Constructor

```javascript
new DisplaySettings()
```

Extends EventEmitter -- supports `on()`, `off()`, `emit()`.

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `applySettings(raw)` | `{ changed, settings }` | Parse and apply CMS settings |
| `getCollectInterval()` | `number` | Collection interval in seconds |
| `getDisplayName()` | `string` | Display name |
| `getDisplaySize()` | `{ width, height }` | Display resolution |
| `isStatsEnabled()` | `boolean` | Stats enabled flag |
| `getAllSettings()` | `Object` | All settings (copy) |
| `getSetting(key, default?)` | `any` | Get specific setting |
| `isInDownloadWindow()` | `boolean` | Check if downloads are allowed now |
| `getNextDownloadWindow()` | `Date \| null` | Next download window start |
| `shouldTakeScreenshot(last)` | `boolean` | Check if screenshot interval elapsed |

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `interval-changed` | `(seconds)` | Collection interval changed |
| `settings-applied` | `(settings, changedKeys)` | Settings applied from CMS |

## Dependencies

- `@xiboplayer/utils` -- EventEmitter, logger

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)**
