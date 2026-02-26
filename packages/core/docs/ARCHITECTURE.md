# Architecture Documentation

Technical architecture and design decisions for the Xibo Player multi-platform implementation.

## Table of Contents

- [Overview](#overview)
- [Core Architecture](#core-architecture)
- [Platform Wrappers](#platform-wrappers)
- [Communication Protocols](#communication-protocols)
- [Data Flow](#data-flow)
- [Security Considerations](#security-considerations)

## Overview

The Xibo Player is a free, open-source implementation of a Xibo-compatible digital signage player with full compatibility with Xibo CMS.

###Key Design Principles

1. **Multi-Platform**: Single PWA core wrapped for all platforms
3. **Offline-First**: Service Worker caching for reliability
4. **Real-Time Capable**: XMR WebSocket support for instant updates
5. **Lightweight**: Minimal dependencies, small bundle size

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         Xibo CMS                            │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────┐     │
│  │    XMDS     │  │     XMR     │  │ Media Library  │     │
│  │(SOAP/HTTP)  │  │ (WebSocket) │  │     (HTTP)     │     │
│  └──────┬──────┘  └──────┬──────┘  └────────┬───────┘     │
└─────────┼─────────────────┼──────────────────┼─────────────┘
          │                 │                  │
          │ SOAP XML        │ WS JSON          │ HTTP
          ▼                 ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    PWA Core (packages/core/)                 │
│  ┌───────────┐  ┌──────────┐  ┌────────┐  ┌──────────┐    │
│  │ xmds.js   │  │xmr-wrap  │  │ cache  │  │ layout   │    │
│  │           │  │per.js    │  │ .js    │  │ .js      │    │
│  │clientType │  │          │  │        │  │          │    │
│  │='linux'   │  │XCF lib   │  │SW+IDB  │  │XLF→HTML  │    │
│  └───────────┘  └──────────┘  └────────┘  └──────────┘    │
│  ┌───────────────────────────────────────────────────┐     │
│  │           PDF.js (pdfjs-dist)                     │     │
│  └───────────────────────────────────────────────────┘     │
└─────────────────┬───────────────────────────────────────────┘
                  │
        ┌─────────┼─────────┬──────────┬─────────────┐
        ▼         ▼         ▼          ▼             ▼
    ┌───────┐ ┌───────┐ ┌────────┐ ┌────────┐  ┌────────┐
    │Browser│ │Chrome │ │Electron│ │Android │  │ webOS  │
    │  PWA  │ │  Ext  │ │Desktop │ │WebView │  │Cordova │
    └───────┘ └───────┘ └────────┘ └────────┘  └────────┘
```

## Core Architecture

The PWA core is built with vanilla JavaScript (ES modules) and minimal dependencies.

### Package Structure

The SDK is split into independently published npm packages under `@xiboplayer/*`:

```
packages/
├── core/          # Player orchestration and lifecycle
├── renderer/      # XLF layout rendering (RendererLite)
├── cache/         # Cache manager and download manager
├── schedule/      # Campaign scheduling, dayparting, interrupts
├── xmds/          # XMDS SOAP + REST clients
├── xmr/           # XMR WebSocket real-time messaging
├── stats/         # Proof of play and log reporting
├── settings/      # CMS display settings management
├── sw/            # Service Worker toolkit
└── utils/         # Shared utilities (logger, config, events)
```

### Dependencies

**Production dependencies:**
```json
{
  "@xibosignage/xibo-communication-framework": "^0.0.6",  // XMR
  "pdfjs-dist": "^4.10.38",  // PDF rendering
  "spark-md5": "^3.0.2"      // File checksums
}
```

**Dev dependencies:**
```json
{
  "vite": "^7.3.1"  // Build tool
}
```

### Component Breakdown

#### main.js - Player Orchestrator

**Responsibilities:**
- Initialize all subsystems
- Run collection cycles (XMDS sync)
- Check and apply schedule
- Display layouts
- Handle XMR commands

**Key methods:**
```javascript
class Player {
  async init()              // Initialize player
  async collect()           // XMDS collection cycle
  async checkSchedule()     // Apply current schedule
  async showLayout()        // Display layout
  async initializeXmr()     // Setup XMR
  async captureScreenshot() // Screenshot (XMR command)
  async changeLayout()      // Change layout (XMR command)
}
```

#### xmds.js - SOAP Client

**Responsibilities:**
- Communicate with Xibo CMS via SOAP
- Register display with CMS
- Get required files list
- Get schedule
- Report status

**Key methods:**
```javascript
class XmdsClient {
  async call(method, params)      // Generic SOAP call
  async registerDisplay()         // Register (clientType='linux')
  async requiredFiles()           // Get files to download
  async schedule()                // Get schedule
  async notifyStatus(status)      // Report player status
  async submitScreenshot(blob)    // Upload screenshot
}
```

**SOAP Envelope Structure:**
```xml
<soap:Envelope xmlns:xsi="..." xmlns:xsd="..." xmlns:soap="...">
  <soap:Body>
    <RegisterDisplay xmlns="...">
      <serverKey>isiSdUCy</serverKey>
      <hardwareKey>abc123</hardwareKey>
      <displayName>test-display</displayName>
      <clientType>linux</clientType>      <clientVersion>0.1.0</clientVersion>
      <clientCode>1</clientCode>
      <operatingSystem>Linux</operatingSystem>
      <macAddress>n/a</macAddress>
    </RegisterDisplay>
  </soap:Body>
</soap:Envelope>
```

#### xmr-wrapper.js - Real-Time Messaging

**Responsibilities:**
- WebSocket connection to CMS
- Handle real-time commands
- Graceful fallback if unavailable

**Supported commands:**
- `collectNow`: Trigger immediate collection
- `screenShot`: Capture and upload screenshot
- `changeLayout`: Switch to specific layout
- `licenceCheck`: Acknowledges license check request

**Connection flow:**
```javascript
1. Player calls initializeXmr() after RegisterDisplay
2. XMR connects via WebSocket: wss://cms/xmr
3. Subscribes to channel: player-{hardwareKey}
4. Listens for commands from CMS
5. Executes commands on player
```

#### Cache Package — StoreClient + DownloadClient

**Responsibilities:**
- Download media files from CMS (via DownloadClient → Service Worker)
- Verify checksums (MD5)
- Store in ContentStore (filesystem via proxy REST API)
- Stale media detection and eviction (CacheAnalyzer)

**ContentStore structure:**
```
~/.config/xiboplayer/{electron,chromium}/content-store/
├── media/12.bin             (images, videos)
├── layout/472.bin           (XLF layout XML)
├── widget/472/221/190.bin   (widget HTML)
└── static/bundle.min.js.bin (widget resources)
```

#### schedule.js - Schedule Interpreter

**Responsibilities:**
- Parse schedule XML from CMS
- Determine which layout(s) to show
- Handle default layout
- Check schedule every minute

**Schedule XML:**
```xml
<schedule>
  <default file="1.xlf"/>
  <layout file="42.xlf" fromdt="2026-01-29 08:00:00" todt="2026-01-29 18:00:00"/>
  <layout file="99.xlf" fromdt="2026-01-29 18:00:00" todt="2026-01-29 23:59:59"/>
</schedule>
```

#### layout.js - XLF Translator

**Responsibilities:**
- Parse XLF (Xibo Layout Format) XML
- Translate to HTML/CSS/JavaScript
- Generate media playback code
- Handle PDF rendering

**XLF → HTML translation:**
```
XLF:
<layout width="1920" height="1080" bgcolor="#000">
  <region id="1" width="1920" height="540" top="0" left="0">
    <media type="image" duration="10" id="123">
      <options><uri>image.jpg</uri></options>
    </media>
  </region>
</layout>

↓ translates to ↓

HTML:
<div id="layout_42" style="width:1920px; height:1080px; background:#000">
  <div id="region_1" style="width:1920px; height:540px; top:0; left:0">
    <!-- JavaScript-driven media playback -->
  </div>
</div>

<script>
  // Media sequencer
  // startFn() → shows media
  // wait duration
  // stopFn() → hides media
  // repeat for next media
</script>
```

**Supported media types:**
- `image`: JPG, PNG, GIF
- `video`: MP4, WebM (HTML5 video)
- `pdf`: PDF documents (PDF.js)
- `webpage`: Embedded iframe
- `text`: HTML text blocks
- Widgets: clock, calendar, weather, etc.

#### config.js - Configuration

**Stored in localStorage:**
```javascript
{
  cmsUrl: "https://your-cms.example.com",
  cmsKey: "your-cms-key",
  hardwareKey: "abc123-def456",
  displayName: "Lobby Display",
  xmrChannel: "player-abc123-def456"
}
```

### Service Worker (sw-main.js)

**Responsibilities:**
- Intercept fetch requests and route to proxy's ContentStore
- Manage background downloads via DownloadManager
- Handle widget HTML and static resource serving
- Enable offline operation

**Request routing:**
```
fetch('/player/pwa/cache/media/123')
  → Service Worker intercepts
  → Routes to proxy: GET /store/media/123
  → Proxy serves from ContentStore (filesystem)
  → Response returned to client
```

Static pages (index.html, setup.html) pass through to Express.

## Platform Wrappers

Each platform wraps the PWA core with platform-specific functionality.

### Platform Repositories

Each platform is a separate repository that depends on the SDK packages via npm:

| Platform | Repository | Description |
|----------|-----------|-------------|
| PWA | [xiboplayer-pwa](https://github.com/xibo-players/xiboplayer-pwa) | Browser-based, installable PWA |
| Electron | [xiboplayer-electron](https://github.com/xibo-players/xiboplayer-electron) | Desktop kiosk wrapper with CORS handling |
| Chromium | [xiboplayer-chromium](https://github.com/xibo-players/xiboplayer-chromium) | Chromium kiosk RPM for Linux |
| Chrome | [xiboplayer-chrome](https://github.com/xibo-players/xiboplayer-chrome) | Chrome extension |
| Android | [xiboplayer-android](https://github.com/xibo-players/xiboplayer-android) | TWA wrapper for Android |
| webOS | [xiboplayer-webos](https://github.com/xibo-players/xiboplayer-webos) | LG webOS signage |

## Communication Protocols

### XMDS (SOAP)

**Transport:** HTTP POST
**Format:** XML (SOAP 1.1)
**Endpoint:** `https://cms/xmds.php?v=7`

**Methods:**
- `RegisterDisplay`: Authenticate and get settings
- `RequiredFiles`: Get list of files to download
- `GetFile`: Download file (chunked, for large files)
- `Schedule`: Get schedule
- `NotifyStatus`: Report player status
- `SubmitLog`: Upload log messages
- `SubmitStats`: Upload playback statistics
- `SubmitScreenShot`: Upload screenshot

**Example request:**
```xml
POST /xmds.php?v=7 HTTP/1.1
Content-Type: text/xml

<?xml version="1.0"?>
<soap:Envelope>
  <soap:Body>
    <RegisterDisplay>
      <serverKey>isiSdUCy</serverKey>
      <hardwareKey>abc123</hardwareKey>
      <clientType>linux</clientType>    </RegisterDisplay>
  </soap:Body>
</soap:Envelope>
```

### XMR (WebSocket)

**Transport:** WebSocket
**Format:** JSON
**Endpoint:** `wss://cms/xmr`

**Message format:**
```json
{
  "channel": "player-abc123",
  "action": "collectNow",
  "payload": {}
}
```

**Actions:**
- `collectNow`: Trigger collection
- `screenShot`: Capture screenshot
- `changeLayout`: Switch layout
- `commandUpdate`: Update command status

**Connection:**
```
Client                          Server
  |                               |
  |--- WS Connect (wss://cms/xmr) -->|
  |<-- WS Upgrade ----------------|
  |                               |
  |--- Subscribe {channel} ------>|
  |<-- Subscribed ----------------|
  |                               |
  |<-- collectNow command --------|
  |--- Execute ---------------->  |
  |--- Status update ------------>|
```

### Media Download

**Transport:** HTTP GET
**Format:** Binary
**Endpoint:** `https://cms/{path}`

**Files downloaded:**
- Layout XLF files
- Media files (images, videos, PDFs)
- Widget HTML files

**Verification:**
- MD5 checksum from RequiredFiles
- Calculated on downloaded file
- Re-download if mismatch

## Data Flow

### Initial Setup Flow

```
User opens player
  ↓
Check localStorage for config
  ↓
[No config] → Redirect to setup.html
  ↓
User enters CMS details
  ↓
Save to localStorage
  ↓
Redirect to index.html
  ↓
Player initializes
```

### Collection Cycle Flow

```
Player.collect() triggered
  ↓
1. RegisterDisplay (XMDS)
   clientType='linux' → CMS returns READY ✓
  ↓
2. RequiredFiles (XMDS)
   CMS returns list of files needed
  ↓
3. Download files (HTTP)
   For each file: fetch → verify MD5 → cache
  ↓
4. Translate layouts (XLF → HTML)
   Parse XLF → generate HTML/JS → cache
  ↓
5. Get Schedule (XMDS)
   CMS returns schedule XML
  ↓
6. NotifyStatus (XMDS)
   Report current status to CMS
  ↓
Schedule next collection (default: 15 minutes)
```

### XMR Real-Time Flow

```
Player connects XMR WebSocket
  ↓
CMS sends collectNow command
  ↓
Player.collect() triggered immediately
  ↓
(Same as collection cycle above)
  ↓
Player reports completion to CMS
```

### Layout Playback Flow

```
Schedule check (every minute)
  ↓
Determine current layout(s) from schedule
  ↓
Load layout HTML from cache
  ↓
Insert into DOM (replace previous layout)
  ↓
Execute layout JavaScript
  ↓
JavaScript sequencer:
  for each media item:
    startFn() → show media
    wait duration
    stopFn() → hide media
    next media
  loop forever
```

## Security Considerations

### Authentication

**CMS Key:**
- Shared secret between player and CMS
- Sent in every XMDS request
- Not encrypted in SOAP (relies on HTTPS)

**Hardware Key:**
- Unique identifier per display
- Generated on first setup
- Used for display identification

### Transport Security

**HTTPS Required:**
- All XMDS calls over HTTPS
- XMR WebSocket over WSS
- Media downloads over HTTPS

**Certificate Validation:**
- Browser/platform validates SSL certificates
- Self-signed certificates require user approval

### Content Security

**XSS Prevention:**
- All media loads from cache (controlled origin)
- Layouts are user-generated (trusted)
- No user input fields (no injection risk)

**CORS:**
- Media served from same origin (or CORS-enabled)
- Widgets may need CORS headers

### Storage Security

**localStorage:**
- Plain text storage (browser API)
- Accessible to same-origin JavaScript
- Not encrypted (CMS key exposed to anyone with file system access)

**ContentStore:**
- Stores downloaded media on filesystem
- Local to the device
- Not encrypted

**Recommendations for production:**
1. Use HTTPS always (enforced)
2. Secure server file system (limit access)
3. Use VPN for signage network (optional)
4. Firewall CMS to known IPs (optional)

## Performance Considerations

### Bundle Size Optimization

**Code splitting:**
```javascript
// PDF.js loaded on-demand
if (media.type === 'pdf') {
  const pdfjsLib = await import('pdfjs-dist');
}
```

**Lazy loading:**
- PDF worker (1.4 MB) only loads when needed
- XMR only initializes if CMS supports it

### Caching Strategy

**Static assets:**
- Cache-first (immutable)
- Long cache headers (1 year)

**HTML pages:**
- Network-first (updates)
- Cache fallback (offline)

**Media files:**
- Pre-fetch on collection cycle
- Persist in ContentStore (filesystem)
- No network requests during playback

### Memory Management

**Layout cleanup:**
```javascript
// Remove previous layout before loading new one
container.innerHTML = '';  // Frees memory

// Stop media playback
stopFn();  // Releases media resources
```

**Cache limits:**
- Browser may evict old cache entries
- Implement LRU cache strategy (future)

## Future Enhancements

### Planned Features

1. **Multi-page PDF support**
   - Rotate through pages automatically
   - Duration per page

2. **Advanced scheduling**
   - Priority levels
   - Day-parting
   - Recurring events

3. **Analytics**
   - Proof of play logging
   - Audience measurement (camera)

4. **Synchronized playback**
   - Multiple displays in sync
   - Video walls

5. **Embedded browser improvements**
   - Better iframe sandboxing
   - Enhanced widget API

### Technical Debt

1. **TypeScript migration**
   - Convert core JavaScript to TypeScript
   - Better type safety

2. **Unit tests**
   - Jest/Vitest for unit testing
   - Higher code coverage

3. **E2E tests**
   - Playwright for browser testing
   - Automated UI testing

4. **Offline-first improvements**
   - Better cache invalidation
   - Background sync API

## Contributing

When contributing, remember:

1. **Never change `clientType: 'linux'`**
2. Always run `npm test` before committing
3. Document breaking changes
4. Test on multiple platforms
5. Update this document for architectural changes

## References

- [Xibo CMS API Documentation](https://xibo.org.uk/manual/en/)
- [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [PDF.js Documentation](https://mozilla.github.io/pdf.js/)
- [Electron Documentation](https://www.electronjs.org/docs)
