# @xiboplayer/xmds

**XMDS SOAP + REST client for Xibo CMS communication.**

## Overview

Dual-transport client supporting both Xibo communication protocols:

- **XMDS SOAP** (v3-v7) — standard Xibo player protocol with XML encoding
- **REST API** — lighter JSON transport (~30% smaller payloads) with ETag caching

Both transports expose the same API. The REST client is preferred when available.

## Installation

```bash
npm install @xiboplayer/xmds
```

## Usage

```javascript
import { RestClient } from '@xiboplayer/xmds';

const client = new RestClient({
  cmsUrl: 'https://your-cms.example.com',
  serverKey: 'your-key',
  hardwareKey: 'display-id',
});

const result = await client.registerDisplay();
const files = await client.requiredFiles();
const schedule = await client.schedule();
```

## Methods

| Method | Description |
|--------|-------------|
| `registerDisplay()` | Register/authorize the display with the CMS |
| `requiredFiles()` | Get list of required media files and layouts |
| `schedule()` | Get the current schedule XML |
| `getResource(regionId, mediaId)` | Get rendered widget HTML |
| `notifyStatus(status)` | Report display status to CMS |
| `mediaInventory(inventory)` | Report cached media inventory |
| `submitStats(stats, hardwareKeyOverride?)` | Submit proof of play statistics (optional `hardwareKeyOverride` for delegated submissions on behalf of another display) |
| `submitScreenShot(base64)` | Upload a screenshot to the CMS |
| `submitLog(logs, hardwareKeyOverride?)` | Submit display logs (optional `hardwareKeyOverride` for delegated submissions on behalf of another display) |

## Dependencies

- `@xiboplayer/utils` — logger, events, fetchWithRetry

---

**Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)** | [MCP Server](https://github.com/xibo-players/xiboplayer/tree/main/mcp-server) for AI-assisted development
