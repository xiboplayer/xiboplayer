# REST API Transport

## Overview

XiboPlayer supports the Xibo CMS Player REST API, replacing SOAP/XML as the primary transport for CMS communication. This is the first Xibo player to implement the complete REST Player API.

## Why REST?

The Xibo CMS Player REST API (`/api/v2/player/*`) is a ground-up rewrite of the legacy SOAP/XML protocol. It addresses fundamental limitations that have plagued Xibo deployments for years:

### For Server Operators

| Problem (SOAP/XML) | Solution (REST) |
|---|---|
| **SOAP requires PHP ext-soap** — many hosting providers disable it, and it's the #1 deployment blocker for Xibo CMS | REST uses standard HTTP/JSON — works on any web server, any hosting provider, any CDN |
| **XML payloads are 30-50% larger** than equivalent JSON, consuming more bandwidth for every collection cycle | JSON payloads are compact, with ETag 304 caching eliminating unchanged responses entirely |
| **No HTTP caching** — every RequiredFiles, Schedule, and GetResource call transfers the full response even if nothing changed | ETag/If-None-Match support returns 304 Not Modified, saving bandwidth and reducing server load |
| **WSDL parsing is fragile** — SOAP client libraries frequently break on CMS upgrades, PHP version changes, or proxy misconfiguration | Standard REST endpoints with versioned paths (`/api/v2/`) — no WSDL, no XML namespaces, no SOAP envelopes |
| **No CDN/reverse proxy support** — SOAP POST requests with XML bodies cannot be cached by Varnish, Cloudflare, or nginx | GET requests with proper cache headers work with any CDN or reverse proxy out of the box |
| **Debugging is painful** — SOAP XML is verbose and hard to read in logs, network inspectors, and monitoring tools | JSON is human-readable, grep-friendly, and natively supported by every monitoring tool |

### For Players

| Problem (SOAP/XML) | Solution (REST) |
|---|---|
| **Large XML responses** for RequiredFiles and Schedule consume memory and CPU to parse | JSON parsing is native and 5-10x faster than XML DOM parsing |
| **No partial updates** — the entire file list and schedule are retransmitted every collection cycle | ETag caching skips unchanged responses; future: delta updates |
| **GetFile chunked downloads** require SOAP envelope wrapping for each chunk, adding overhead | Direct HTTP file downloads with Range headers — standard, efficient, CDN-compatible |
| **Widget HTML via GetResource** requires a SOAP call per widget | Direct GET `/widgets/{L}/{R}/{M}` — cacheable, parallelizable |
| **No JWT authentication** — serverKey+hardwareKey must be sent with every request | JWT Bearer tokens with automatic refresh — authenticate once, reuse token for all requests |

### For the Xibo Ecosystem

- **REST is extensible** — all new CMS features can be easily designed RESTfully
- **Interoperability** — REST/JSON is the universal API format; any language, any platform can implement a REST player
- **Security** — JWT tokens expire and can be revoked; serverKey/hardwareKey are permanent credentials

## Architecture

### Transport Auto-Detection

The player automatically detects the best available transport:

```
1. Try POST /api/v2/player/auth → if 200, use REST
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
The JWT token is stored server-side in the Express proxy via `POST /auth-token`.
The proxy automatically injects the Bearer header on all CMS requests.

### Endpoint Mapping

| SOAP Method | REST Endpoint | Method |
|---|---|---|
| RegisterDisplay | POST /displays | POST |
| RequiredFiles | GET /displays/{id}/media | GET |
| Schedule | GET /displays/{id}/schedule | GET |
| GetResource | GET /widgets/{L}/{R}/{M} | GET |
| MediaInventory | PUT /displays/{id}/inventory | PUT |
| NotifyStatus | PUT /displays/{id}/status | PUT |
| SubmitLog | POST /displays/{id}/logs | POST |
| SubmitStats | POST /displays/{id}/stats | POST |
| SubmitScreenShot | POST /displays/{id}/screenshot | POST |
| GetFile | GET /displays/{id}/media/{fileId} | GET |
| ReportFaults | POST /displays/{id}/faults | POST |
| GetWeather | GET /displays/{id}/weather | GET |
| BlackList | POST /displays/{id}/blacklist | POST |

### Content Mirror Paths

All content is stored using CMS URL paths as storage keys:

```
{storeDir}/api/v2/player/
  media/42.bin                    — images, audio, XLF layouts
  dependencies/fonts.css.bin      — CSS, fonts, JS bundles
  widgets/{L}/{R}/{M}.bin         — rendered widget HTML
```

The Express proxy serves content at the same paths the CMS uses.
No URL translation needed — iframes load from `/api/v2/player/widgets/{L}/{R}/{M}`.

### Dependency Downloads

Dedicated dependency endpoint for widget resources:

```
GET /api/v2/player/dependencies/{filename}?fileType=bundle|fontCss|font|asset
```

The download pipeline:
1. Classifies `type=static` files as dependencies
2. Extracts filenames from the URL path
3. Stores them as `api/v2/player/dependencies/{filename}` in the ContentStore
4. Rewrites widget HTML URLs from CMS absolute paths to local store paths

## Implementation

### Files

| Package | File | Purpose |
|---|---|---|
| `@xiboplayer/xmds` | `rest-client.js` | REST client with JWT auth, ETag caching |
| `@xiboplayer/cache` | `download-manager.js` | Download orchestration |
| `@xiboplayer/cache` | `download-client.js` | Service Worker postMessage interface |
| `@xiboplayer/cache` | `widget-html.js` | Dependency URL rewriting |
| `@xiboplayer/sw` | `message-handler.js` | Dependency classification |
| `@xiboplayer/sw` | `request-handler.js` | Static resource retry for cold start |
| `@xiboplayer/proxy` | `proxy.js` | JWT token storage, Bearer header injection |
| `@xiboplayer/pwa` | `main.ts` | Token push to proxy before downloads |

## Configuration

No configuration required. REST is auto-detected when the CMS supports it.

To force a specific transport:

```json
// config.json
{
  "transport": "rest"  // or "xmds" to force SOAP
}
```

The API base path defaults to `/api/v2/player` but can be overridden:

```json
{
  "playerApiBase": "/api/v2/player"
}
```

## Compatibility

| CMS Version | Transport |
|---|---|
| Xibo CMS v3.x | SOAP only |
| Xibo CMS v4.x + Player API module | REST (auto-detected), SOAP fallback |
