# @xiboplayer/xmr

**XMR WebSocket client for real-time Xibo CMS push commands.**

## Overview

Listens for push commands from the CMS over WebSocket with automatic reconnection:

- **13 command handlers** -- collectNow, screenshot, changeLayout, overlayLayout, revertToSchedule, purgeAll, commandAction, triggerWebhook, dataUpdate, rekeyAction, criteriaUpdate, currentGeoLocation, licenceCheck
- **Auto-reconnect** -- exponential backoff (5s base, up to 10 attempts), resumes on next collection cycle
- **Intentional shutdown** -- clean disconnect without triggering reconnection
- **Dual-path geo-location** -- CMS can push coordinates or request the player to report its position

## Architecture

```
CMS (Push)                     XmrWrapper                    PlayerCore
    |                              |                              |
    +--- WebSocket message ------> xmr.on('collectNow') -------> player.collect()
    +--- WebSocket message ------> xmr.on('changeLayout') -----> player.changeLayout()
    +--- WebSocket message ------> xmr.on('screenshot') -------> player.captureScreenshot()
    +--- WebSocket message ------> xmr.on('purgeAll') ---------> player.purgeAll()
    |                              |                              |
    +--- disconnect -------------> scheduleReconnect() ---------> [5s, 10s, 15s, ...]
    +--- reconnect --------------> xmr.on('connected') --------> updateStatus('XMR connected')
```

## Installation

```bash
npm install @xiboplayer/xmr
```

## Usage

```javascript
import { XmrWrapper } from '@xiboplayer/xmr';

const xmr = new XmrWrapper(config, player);

// Start connection (from RegisterDisplay result)
const success = await xmr.start(xmrWebSocketAddress, xmrCmsKey);

if (success) {
  console.log('XMR connected - real-time commands active');
} else {
  console.log('XMR failed - falling back to polling mode');
}

// Check status
xmr.isConnected(); // true/false

// Stop cleanly
await xmr.stop();
```

## Commands

| Command | Payload | Action |
|---------|---------|--------|
| `collectNow` | -- | Trigger immediate XMDS collection cycle |
| `screenShot` / `screenshot` | -- | Capture and upload display screenshot |
| `changeLayout` | `{ layoutId, duration?, downloadRequired?, changeMode? }` | Switch to specific layout |
| `overlayLayout` | `{ layoutId, duration?, downloadRequired? }` | Push overlay on top |
| `revertToSchedule` | -- | Return to normal scheduled content |
| `purgeAll` | -- | Clear all cached files and re-download |
| `commandAction` | `{ commandCode, commands? }` | Execute player command (HTTP only in browser) |
| `triggerWebhook` | `{ triggerCode }` | Fire a webhook trigger action |
| `dataUpdate` | -- | Force refresh data connectors |
| `rekeyAction` | -- | Rotate RSA key pair and re-register |
| `criteriaUpdate` | `data` | Update display criteria, trigger collection |
| `currentGeoLocation` | `{ latitude?, longitude? }` | Push coordinates or request location report |
| `licenceCheck` | -- | No-op for Linux clients |

## Reconnection

- **Base delay:** 5 seconds, linear increase (5s, 10s, 15s, ...)
- **Max attempts:** 10 per disconnect event
- **After max:** stops trying until next collection cycle calls `start()` again
- **Intentional stop:** `stop()` sets a flag that prevents reconnection on disconnect

## API Reference

### Constructor

```javascript
new XmrWrapper(config, player)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | Object | Player config with `hardwareKey`, `xmrChannel` |
| `player` | Object | PlayerCore instance with command methods |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `start(xmrUrl, cmsKey)` | `Promise<boolean>` | Connect to XMR WebSocket |
| `stop()` | `Promise<void>` | Disconnect cleanly (no reconnect) |
| `isConnected()` | `boolean` | Check connection status |
| `send(action, data)` | `Promise<boolean>` | Send message to CMS |

## Dependencies

- `@xiboplayer/utils` -- logger

No external XMR dependencies. The native `XmrClient` (`xmr-client.js`) replaces the
upstream `@xibosignage/xibo-communication-framework`, providing a complete implementation
with generic action dispatch and zero third-party dependencies (no luxon, no nanoevents).

### Upstream comparison

| Feature | upstream `xibo-communication-framework@0.0.6` | native `XmrClient` |
|---------|------------------------------------------------|---------------------|
| `collectNow` | hardcoded | generic dispatch |
| `screenShot` | hardcoded | generic dispatch |
| `licenceCheck` | hardcoded | generic dispatch |
| `criteriaUpdate` | hardcoded | generic dispatch |
| `commandAction` (showStatusWindow) | hardcoded, splits commandCode | generic dispatch (full message) |
| `commandAction` (forceUpdateChromeOS) | hardcoded, splits commandCode | generic dispatch (full message) |
| `commandAction` (currentGeoLocation) | hardcoded, splits commandCode | generic dispatch (full message) |
| `commandAction` (other) | **missing** -- `console.error('unknown action')` | generic dispatch (full message) |
| `changeLayout` | **missing** -- `console.error('unknown action')` | generic dispatch |
| `overlayLayout` | **missing** -- `console.error('unknown action')` | generic dispatch |
| `revertToSchedule` | **missing** -- `console.error('unknown action')` | generic dispatch |
| `purgeAll` | **missing** -- `console.error('unknown action')` | generic dispatch |
| `triggerWebhook` | **missing** -- `console.error('unknown action')` | generic dispatch |
| `dataUpdate` | **missing** -- `console.error('unknown action')` | generic dispatch |
| `rekeyAction` | **missing** -- `console.error('unknown action')` | generic dispatch |
| Any future CMS action | requires library update | works automatically |
| TTL check | luxon `DateTime.fromISO().plus()` (68KB) | native `Date.parse()` (0KB) |
| Event emitter | nanoevents (external) | built-in `Map<Set>` (0KB) |
| Bundle size impact | ~70KB (luxon + nanoevents + framework) | ~2KB |
| Reconnect interval | 60s `setInterval` | 60s `setInterval` (same) |
| `isActive()` check | 15min silence threshold | 15min silence threshold (same) |
| Init handshake | `{type:'init', key, channel}` | `{type:'init', key, channel}` (same) |
| Heartbeat handling | `"H"` → update lastMessageAt | `"H"` → update lastMessageAt (same) |

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xiboplayer/xiboplayer)**
