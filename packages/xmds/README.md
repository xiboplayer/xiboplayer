# @xiboplayer/xmds

**XMDS/REST dual-transport CMS client for Xibo digital signage -- auto-detects REST or SOAP based on CMS capabilities.**

## Overview

Unified abstraction over Xibo's two communication protocols:

- **REST API v2** -- JSON-based, JWT auth, ETag caching, ~30% smaller payloads
- **XMDS SOAP** (v3-v7) -- XML-based, universal compatibility with all Xibo CMS versions

Both expose an identical public API. At startup, `ProtocolDetector` probes the CMS to select the optimal transport -- fallback to SOAP if REST is unavailable.

### Capabilities

- **Dual-transport abstraction** -- RestClient and XmdsClient implement the same interface
- **Auto-detection** -- quick health probe (3s timeout) to select REST or SOAP
- **HTTP caching** -- REST client uses ETags to avoid redundant GETs
- **Retry & backoff** -- exponential backoff with jitter (default: 2 retries, 2s base delay)
- **JWT auth** -- REST client auto-refreshes tokens 60s before expiry
- **CRC checksums** -- `checkRf` and `checkSchedule` allow skipping unchanged data
- **Delegated reporting** -- stats/logs can be submitted on behalf of other displays (follower -> lead delegation)

## Architecture

```
Player Core                        Transport Selection                CMS
-----------                       --------------------              -----

registerDisplay()                  Is REST available?
requiredFiles()     Same API       (GET /api/v2/player/health)
schedule()                 Yes --> RestClient (JWT, ETag)   --> /api/v2/player/*
getResource()              No  --> XmdsClient (SOAP XML)    --> /xmds.php
notify()
submitStats()
submitLog()
```

Both clients share the same return types. The scheduler, renderer, and sync modules consume only the CmsClient interface -- they're transport-agnostic.

## Installation

```bash
npm install @xiboplayer/xmds
```

## Usage

### Auto-detect and instantiate

```javascript
import { ProtocolDetector, RestClient, XmdsClient } from '@xiboplayer/xmds';

const detector = new ProtocolDetector(cmsUrl, RestClient, XmdsClient);
const { client, protocol } = await detector.detect({
  cmsUrl: 'https://cms.example.com',
  cmsKey: 'your-server-key',
  hardwareKey: 'display-123',
  displayName: 'Main Screen',
});

console.log(`Using ${protocol} transport`);

const display = await client.registerDisplay();
const files = await client.requiredFiles();
const schedule = await client.schedule();
```

### Force a specific transport

```javascript
const { client } = await detector.detect(config, 'xmds');  // Force SOAP
const { client } = await detector.detect(config, 'rest');   // Force REST
```

### Direct RestClient usage

```javascript
import { RestClient } from '@xiboplayer/xmds';

const client = new RestClient({
  cmsUrl: 'https://cms.example.com',
  cmsKey: 'server-key',
  hardwareKey: 'display-key',
  displayName: 'Display 1',
});

const { code, message, settings, syncConfig } = await client.registerDisplay();
const { files, purge } = await client.requiredFiles();
```

### Direct XmdsClient usage

```javascript
import { XmdsClient } from '@xiboplayer/xmds';

const client = new XmdsClient({
  cmsUrl: 'https://cms.example.com',
  cmsKey: 'server-key',
  hardwareKey: 'display-key',
  displayName: 'Display 1',
  xmrChannel: 'ch-123',
  xmrPubKey: '-----BEGIN PUBLIC KEY-----\n...',
});

const display = await client.registerDisplay();
```

### Parse schedule without network call

```javascript
import { parseScheduleResponse } from '@xiboplayer/xmds';

const parsed = parseScheduleResponse(scheduleXml);
// { default, layouts, campaigns, overlays, actions, commands, dataConnectors }
```

## Methods

All methods available on both `RestClient` and `XmdsClient` with identical signatures:

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `registerDisplay()` | -- | `RegisterDisplayResult` | Authenticate, get settings, tags, commands, sync config |
| `requiredFiles()` | -- | `RequiredFilesResult` | Get media, layouts, widgets, and files to purge |
| `schedule()` | -- | `ScheduleObject` | Get complete schedule |
| `getResource(layoutId, regionId, mediaId)` | number x 3 | `string` | Get rendered widget HTML |
| `notifyStatus(status)` | Object | JSON/XML | Report display status |
| `mediaInventory(inventoryXml)` | string/Array | JSON/XML | Report cached media |
| `submitStats(statsXml, hardwareKeyOverride?)` | string, string? | boolean | Submit proof-of-play (optional override for delegated reporting) |
| `submitLog(logXml, hardwareKeyOverride?)` | string, string? | boolean | Submit logs (optional override for delegated reporting) |
| `submitScreenShot(base64Image)` | string | boolean | Upload screenshot |
| `reportFaults(faultJson)` | string/Object | boolean | Report hardware/software faults |
| `blackList(mediaId, type, reason)` | string, string, string | boolean | Blacklist broken media |
| `getWeather()` | -- | JSON/XML | Get weather data for schedule criteria |

### Key Response Types

**RegisterDisplayResult:**
```typescript
{
  code: 'READY' | 'WRONG_SCHEDULE_KEY' | 'DISPLAY_NOT_LICENSED' | ...,
  message: string,
  settings: { [key: string]: any },
  tags: string[],
  commands: Array<{ commandCode, commandString }>,
  checkRf: string,         // CRC32 of RequiredFiles (skip if unchanged)
  checkSchedule: string,   // CRC32 of Schedule (skip if unchanged)
  syncConfig: {             // Multi-display sync (null if not enabled)
    syncGroup: string,
    syncPublisherPort: number,
    syncSwitchDelay: number,
    isLead: boolean
  } | null
}
```

## Transport Comparison

| Aspect | REST (v2) | XMDS (SOAP) |
|--------|-----------|-------------|
| **Protocol** | JSON over HTTP | XML-RPC over HTTP |
| **Auth** | JWT (Bearer token) | Per-request params (serverKey) |
| **Payload size** | ~30% smaller | Baseline |
| **Caching** | ETags + response cache | No caching |
| **Availability** | Custom CMS images (Xibo 3.0+) | All Xibo versions (v3-v7+) |
| **Fallback** | SOAP (automatic) | None |

## Error Handling

**Retry:** Both clients use `fetchWithRetry()` with exponential backoff (2 retries, 2s base delay).

**Token expiry (REST):** 401 response triggers automatic re-authentication and request retry.

**SOAP faults:** XmdsClient parses `<soap:Fault>` and throws with fault message.

**Custom retry strategy:**
```javascript
const client = new RestClient({
  ...config,
  retryOptions: { maxRetries: 5, baseDelayMs: 5000 }
});
```

## Constructor Options

```typescript
{
  cmsUrl: string,                // Base URL of Xibo CMS
  cmsKey: string,                // Server authentication key
  hardwareKey: string,           // Unique display identifier
  displayName?: string,          // Human-readable display name
  clientVersion?: string,        // Default: '0.1.0'
  clientType?: string,           // Default: 'linux'
  xmrChannel?: string,           // XMR channel ID
  xmrPubKey?: string,            // XMR public key (PEM)
  retryOptions?: {
    maxRetries?: number,         // Default: 2
    baseDelayMs?: number         // Default: 2000
  }
}
```

## Dependencies

- `@xiboplayer/utils` -- logger, fetchWithRetry

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)**
