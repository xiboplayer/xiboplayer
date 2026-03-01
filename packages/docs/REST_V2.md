# REST API v2 Transport

## Overview

XiboPlayer v0.6.0 introduces full support for the Xibo CMS REST API v2, replacing SOAP/XML as the primary transport for CMS communication. This is the first Xibo player to implement the complete v2 API.

## Why REST v2?

The Xibo CMS REST API v2 (`/api/v2/player/*`) is a ground-up rewrite of the legacy SOAP/XML protocol. It addresses fundamental limitations that have plagued Xibo deployments for years:

### For Server Operators

| Problem (SOAP/XML) | Solution (REST v2) |
|---|---|
| **SOAP requires PHP ext-soap** — many hosting providers disable it, and it's the #1 deployment blocker for Xibo CMS | REST uses standard HTTP/JSON — works on any web server, any hosting provider, any CDN |
| **XML payloads are 30-50% larger** than equivalent JSON, consuming more bandwidth for every collection cycle | JSON payloads are compact, with ETag 304 caching eliminating unchanged responses entirely |
| **No HTTP caching** — every RequiredFiles, Schedule, and GetResource call transfers the full response even if nothing changed | ETag/If-None-Match support returns 304 Not Modified, saving bandwidth and reducing server load |
| **WSDL parsing is fragile** — SOAP client libraries frequently break on CMS upgrades, PHP version changes, or proxy misconfiguration | Standard REST endpoints with versioned paths (`/api/v2/`) — no WSDL, no XML namespaces, no SOAP envelopes |
| **No CDN/reverse proxy support** — SOAP POST requests with XML bodies cannot be cached by Varnish, Cloudflare, or nginx | GET requests with proper cache headers work with any CDN or reverse proxy out of the box |
| **Debugging is painful** — SOAP XML is verbose and hard to read in logs, network inspectors, and monitoring tools | JSON is human-readable, grep-friendly, and natively supported by every monitoring tool |

### For Players

| Problem (SOAP/XML) | Solution (REST v2) |
|---|---|
| **Large XML responses** for RequiredFiles and Schedule consume memory and CPU to parse | JSON parsing is native and 5-10x faster than XML DOM parsing |
| **No partial updates** — the entire file list and schedule are retransmitted every collection cycle | ETag caching skips unchanged responses; future: delta updates |
| **GetFile chunked downloads** require SOAP envelope wrapping for each chunk, adding overhead | Direct HTTP file downloads with Range headers — standard, efficient, CDN-compatible |
| **Widget HTML via GetResource** requires a SOAP call per widget | Direct GET `/widgets/{id}/resource` — cacheable, parallelizable |
| **No JWT authentication** — serverKey+hardwareKey must be sent with every request | JWT Bearer tokens with automatic refresh — authenticate once, reuse token for all requests |

### For the Xibo Ecosystem

- **REST v2 is extensible** — all new CMS features can be easily designed RESTfully
- **Interoperability** — REST/JSON is the universal API format; any language, any platform can implement a v2 player
- **Security** — JWT tokens expire and can be revoked; serverKey/hardwareKey are permanent credentials

## Architecture

### Transport Auto-Detection

The player automatically detects the best available transport:

```
1. Try POST /api/v2/player/auth → if 200, use REST v2
2. Fallback to SOAP/XML via xmds.php
```

No configuration required. The player adapts to the CMS version.

### Authentication Flow

```
POST /api/v2/player/auth
  Body: { serverKey, hardwareKey }
  Response: { token, displayId }

All subsequent requests:
  Authorization: Bearer <token>
```

Tokens are refreshed automatically on 401 responses.

### Endpoint Mapping

| SOAP Method | REST v2 Endpoint | Method |
|---|---|---|
| RegisterDisplay | POST /displays | POST |
| RequiredFiles | GET /displays/{id}/media | GET |
| Schedule | GET /displays/{id}/schedule | GET |
| GetResource | GET /widgets/{id}/resource | GET |
| MediaInventory | PUT /displays/{id}/inventory | PUT |
| NotifyStatus | PUT /displays/{id}/status | PUT |
| SubmitLog | POST /displays/{id}/logs | POST |
| SubmitStats | POST /displays/{id}/stats | POST |
| SubmitScreenShot | POST /displays/{id}/screenshot | POST |
| GetFile | GET /displays/{id}/media/{fileId} | GET |
| ReportFaults | POST /displays/{id}/faults | POST |
| GetWeather | GET /displays/{id}/weather | GET |
| BlackList | POST /displays/{id}/blacklist | POST |

### Dependency Downloads

v2 introduces a dedicated dependency endpoint for widget resources:

```
GET /api/v2/player/dependencies/{filename}?fileType=bundle|fontCss|font|asset
```

The download pipeline:
1. Classifies `type=dependency` files as static resources
2. Extracts filenames from the URL path (not query params like v1)
3. Stores them as `static/{filename}` in the ContentStore
4. Rewrites widget HTML URLs from CMS absolute paths to local store paths
5. Skips numeric-ID media references (e.g. `1.png`) — those are media items

### JWT Token Propagation

The JWT token flows from the REST client through the download pipeline to the proxy, which injects it as an `Authorization: Bearer` header on CMS requests. Currently the token is passed as a query parameter through the Service Worker due to Electron stripping `Authorization` headers from SW fetch requests — this workaround may be revisited in future versions.

## Implementation

### Files Changed

| Package | File | Purpose |
|---|---|---|
| `@xiboplayer/xmds` | `rest-client-v2.js` | REST v2 client with JWT auth, ETag caching |
| `@xiboplayer/cache` | `download-manager.js` | Auth token storage and propagation |
| `@xiboplayer/cache` | `download-client.js` | Token passing to Service Worker |
| `@xiboplayer/cache` | `widget-html.js` | v2 dependency URL rewriting |
| `@xiboplayer/sw` | `message-handler.js` | v2 dependency classification, auth token |
| `@xiboplayer/sw` | `request-handler.js` | Static resource retry for cold start |
| `@xiboplayer/proxy` | `proxy.js` | Bearer token injection, token redaction |
| `@xiboplayer/pwa` | `main.ts` | Token extraction and forwarding |

### Test Results

All 1295 tests pass. Live CMS integration verified:
- 0 xiboIC errors, 0 dependency errors
- All 12 widget types rendering (clock-digital, countdown-clock, global, embedded, webpage, rss-ticker, pdf, clock-analogue, clock-flip, video, image×3)
- 14 static resources cached (JS bundles, CSS, fonts, widget assets)
- ETag 304 caching working for schedule and media list

## Configuration

No configuration required. REST v2 is auto-detected when the CMS supports it.

To force a specific transport:

```json
// config.json
{
  "transport": "rest-v2"  // or "soap" to force legacy
}
```

## Compatibility

| CMS Version | Transport |
|---|---|
| Xibo CMS v3.x | SOAP only |
| Xibo CMS v4.x | REST v2 (auto-detected), SOAP fallback |
