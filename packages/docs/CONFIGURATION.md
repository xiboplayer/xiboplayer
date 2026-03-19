# Xibo Player Configuration

Both the Electron and Chromium players are configured through a `config.json` file.
The file is sparse — only include keys you want to override; defaults apply for the rest.

## Config File Location

| Player   | Path                                          |
|----------|-----------------------------------------------|
| Electron | `~/.config/xiboplayer/electron/config.json`   |
| Chromium | `~/.config/xiboplayer/chromium/config.json`   |

On first run (RPM/DEB install), the system default from `/usr/share/xiboplayer-*/config.json` is copied to the user path if it doesn't exist. The PWA setup page handles CMS registration.

## Configuration Reference

### CMS Connection

| Key           | Type   | Default | Description                          |
|---------------|--------|---------|--------------------------------------|
| `cmsUrl`      | string | `""`    | CMS base URL (e.g. `https://cms.example.com`) |
| `cmsKey`      | string | `""`    | CMS server key for authentication    |
| `displayName` | string | `""`    | Display name registered with the CMS |

These are set automatically by the PWA setup page on first run.

### Per-CMS Storage

The player supports connecting to multiple CMS servers. Configuration and media caches are stored per-CMS so switching between servers doesn't lose data or require re-registration.

**Storage layout** (in `localStorage`):

| Key                    | Contents                                            |
|------------------------|-----------------------------------------------------|
| `xibo_global`          | Device identity: `hardwareKey`, `xmrPubKey`, `xmrPrivKey` |
| `xibo_cms:{cmsId}`     | CMS-scoped: `cmsUrl`, `cmsKey`, `displayName`, `xmrChannel` |
| `xibo_active_cms`      | String `cmsId` of the currently active CMS          |

The `cmsId` is a deterministic hash of the CMS URL origin (format: `{hostname}-{fnvHash12}`), e.g. `displays.superpantalles.com-a1b2c3d4e5f6`.

Global keys (`hardwareKey`, RSA keys) identify the physical display and never change — the same device presents the same identity to every CMS. CMS-scoped keys are preserved per server, so switching back restores previous registration.

See [PER_CMS_CACHE.md](PER_CMS_CACHE.md) for the full design rationale and cache directory layout.

### Server

| Key              | Type   | Default          | Description                          |
|------------------|--------|------------------|--------------------------------------|
| `serverPort`     | number | `8765` (Electron) / `8766` (Chromium) | Local proxy server port |
| `listenAddress`  | string | `"localhost"`    | Network interface to bind the proxy server. Set to `"0.0.0.0"` to allow LAN connections (required for cross-device video wall sync). |

### Window & Display

| Key               | Type    | Default | Description                                  |
|-------------------|---------|---------|----------------------------------------------|
| `kioskMode`       | boolean | `true`  | Lock window in kiosk mode (no title bar, Alt+F4 disabled) |
| `fullscreen`      | boolean | `true`  | Start in fullscreen (ignored when `kioskMode` is true) |
| `hideMouseCursor` | boolean | `true`  | Hide the mouse cursor (Chromium uses `unclutter`) |
| `preventSleep`    | boolean | `true`  | Disable screen blanking and DPMS             |
| `width`           | number  | `1920`  | Window width (when not fullscreen/kiosk)      |
| `height`          | number  | `1080`  | Window height (when not fullscreen/kiosk)     |

### Security

| Key              | Type    | Default | Description                                  |
|------------------|---------|---------|----------------------------------------------|
| `relaxSslCerts`  | boolean | `true`  | Disable SSL certificate verification for CMS connections. Useful for self-signed certificates. Shell-only — does not reach the PWA. |

### Logging

| Key        | Type   | Default | Description                                  |
|------------|--------|---------|----------------------------------------------|
| `logLevel` | string | `""`    | PWA log level: `DEBUG`, `INFO`, `WARNING`, `ERROR`, `NONE`. Empty string = default (`WARNING`). |

The log level is passed to the PWA as a URL parameter (`?logLevel=...`).
It controls the `@xiboplayer/utils` logger output in the browser console.

**Priority chain** (highest wins):
1. Electron `--dev` flag (forces `DEBUG`)
2. Chromium `--log-level=DEBUG` flag (forces the given level)
3. `config.json` `logLevel` key
4. URL parameter `?logLevel=...` (set by 1-3 above)
5. `localStorage` key `xibo_log_level`
6. CMS display setting
7. Default: `WARNING`

You can also set the log level at runtime in the browser DevTools console:
```js
localStorage.setItem('xibo_log_level', 'DEBUG');
location.reload();
```

#### Debug Object

| Key                       | Type    | Default | Description                                  |
|---------------------------|---------|---------|----------------------------------------------|
| `debug.consoleLogs`       | boolean | `false` | Forward browser console output to the proxy server's stdout. Useful for headless debugging. |
| `debug.consoleLogsInterval` | number | `10`  | Batch flush interval in seconds for forwarded console logs. |

When `debug.consoleLogs` is enabled, the PWA batches `console.*` calls and POSTs them to the proxy at the configured interval. The proxy prints them to stdout, making browser logs visible in shell/journal output.

### Player Controls & Overlays

| Key        | Type   | Default | Description                                  |
|------------|--------|---------|----------------------------------------------|
| `controls` | object | —       | Enable on-screen player controls and overlays |

The `controls` object has two sub-sections:

```json
"controls": {
  "keyboard": {
    "debugOverlays": false,
    "setupKey": false,
    "playbackControl": false,
    "videoControls": false
  },
  "mouse": {
    "statusBarOnHover": false
  }
}
```

| Key                          | Description                                         |
|------------------------------|-----------------------------------------------------|
| `keyboard.debugOverlays`     | Enable keyboard shortcuts to toggle debug overlays (timeline, cache, status) |
| `keyboard.setupKey`          | Enable keyboard shortcut to open the setup/config screen |
| `keyboard.playbackControl`   | Enable keyboard shortcuts for playback (skip layout, pause) |
| `keyboard.videoControls`     | Enable keyboard shortcuts for video control (play/pause, seek) |
| `mouse.statusBarOnHover`     | Show the status bar when hovering the mouse at the bottom of the screen |

### Transport

| Key              | Type   | Default             | Description                          |
|------------------|--------|---------------------|--------------------------------------|
| `transport`      | string | `"auto"`            | CMS transport: `auto`, `rest`, `soap` |
| `playerApiBase`  | string | `"/api/v2/player"`  | Base path for the REST Player API. Override if the CMS uses a custom route prefix. |

### Geolocation

| Key                | Type   | Default | Description                          |
|--------------------|--------|---------|--------------------------------------|
| `googleGeoApiKey`  | string | `""`    | Google Geolocation API key for weather widgets |

### Chromium-only

| Key                 | Type   | Default      | Description                          |
|---------------------|--------|--------------|--------------------------------------|
| `browser`           | string | `"chromium"` | Browser binary: `chromium`, `chrome`, or a custom path |
| `extraBrowserFlags` | string | `""`         | Additional Chromium command-line flags (space-separated) |

### Shell Commands

| Key                  | Type    | Default | Description                          |
|----------------------|---------|---------|--------------------------------------|
| `allowShellCommands` | boolean | `false` | Allow CMS to execute shell commands on this display. **Security-sensitive** — only enable on trusted networks. Commands are sent via XMR or embedded in layout widgets. 30-second timeout per command. Electron uses IPC; Chromium uses an HTTP endpoint on the proxy server. |

### Electron-only

| Key                  | Type    | Default | Description                          |
|----------------------|---------|---------|--------------------------------------|
| `autoLaunch`         | boolean | `false` | Auto-start on login (registers with OS autostart) |

## Platform Support Matrix

Not all keys apply to every platform. Shell-only keys are filtered out by `extractPwaConfig()` and never reach the PWA.

| Key                 | PWA | Electron | Chromium | Notes                    |
|---------------------|-----|----------|----------|--------------------------|
| `cmsUrl`            | yes | yes      | yes      |                          |
| `cmsKey`            | yes | yes      | yes      |                          |
| `displayName`       | yes | yes      | yes      |                          |
| `serverPort`        | —   | yes      | yes      | Shell-only               |
| `listenAddress`     | —   | yes      | yes      | Shell-only, default `localhost` |
| `kioskMode`         | —   | yes      | yes      | Shell-only               |
| `fullscreen`        | —   | yes      | yes      | Shell-only               |
| `hideMouseCursor`   | —   | yes      | yes      | Shell-only               |
| `preventSleep`      | —   | yes      | yes      | Shell-only               |
| `width` / `height`  | —   | yes      | yes      | Shell-only               |
| `relaxSslCerts`     | —   | yes      | yes      | Shell-only               |
| `logLevel`          | yes | yes      | yes      |                          |
| `debug`             | yes | yes      | yes      | Passes through to PWA    |
| `controls`          | yes | yes      | yes      |                          |
| `transport`         | yes | yes      | yes      |                          |
| `playerApiBase`     | yes | yes      | yes      |                          |
| `googleGeoApiKey`   | yes | yes      | yes      |                          |
| `autoLaunch`        | —   | yes      | —        | Electron-only            |
| `allowShellCommands`| —   | yes      | yes      | Shell-only, default OFF    |
| `browser`           | —   | —        | yes      | Chromium-only            |
| `extraBrowserFlags` | —   | —        | yes      | Chromium-only            |

A runtime warning is logged when a platform-specific key is set in the wrong shell's `config.json` (e.g. `browser` in Electron config). These warnings are informational only and do not prevent startup.

## Environment Variables

Environment variables are the highest-priority config source. They are used in Node.js contexts (tests, CI) and override all other sources.

| Env Variable       | Maps to           | Description                          |
|--------------------|-------------------|--------------------------------------|
| `CMS_URL`          | `cmsUrl`          | CMS base URL                         |
| `CMS_KEY`          | `cmsKey`          | CMS server key                       |
| `DISPLAY_NAME`     | `displayName`     | Display name                         |
| `HARDWARE_KEY`     | `hardwareKey`     | Hardware key (for test fixtures)     |
| `XMR_CHANNEL`      | `xmrChannel`      | XMR channel UUID                     |
| `GOOGLE_GEO_API_KEY` | `googleGeoApiKey` | Google Geolocation API key         |

In the browser (PWA), `localStorage` is the primary source; env vars are not available.

## Example: Debugging Config

```json
{
  "cmsUrl": "https://cms.example.com",
  "cmsKey": "yourKey",
  "displayName": "dev-display",

  "kioskMode": false,
  "fullscreen": false,
  "hideMouseCursor": false,
  "logLevel": "DEBUG",

  "debug": {
    "consoleLogs": true
  },

  "controls": {
    "keyboard": {
      "debugOverlays": true,
      "setupKey": true,
      "playbackControl": true,
      "videoControls": true
    },
    "mouse": {
      "statusBarOnHover": true
    }
  }
}
```

## Example: Production Kiosk

```json
{
  "cmsUrl": "https://cms.example.com",
  "cmsKey": "yourKey",
  "displayName": "lobby-screen-1",
  "preventSleep": true
}
```

All other defaults (kiosk mode, fullscreen, hidden cursor, WARNING log level) apply automatically.

## Example: Video Wall Lead (v0.7.1)

```json
{
  "cmsUrl": "https://cms.example.com",
  "cmsKey": "yourKey",
  "displayName": "videowall-lead",
  "preventSleep": true,
  "sync": {
    "isLead": true,
    "choreography": "diagonal-tl",
    "staggerMs": 200,
    "topology": { "x": 0, "y": 0, "orientation": 0 },
    "gridCols": 2,
    "gridRows": 2
  }
}
```

The lead automatically binds to `0.0.0.0` when `sync.isLead` is true. The CMS provides `syncGroup`, `syncGroupId`, `syncPublisherPort`, `syncSwitchDelay`, and `syncVideoPauseDelay` via the sync group settings. Local config only needs display-specific fields: `topology`, `choreography`, `staggerMs`, and grid dimensions.

## Example: Video Wall Follower (v0.7.1)

```json
{
  "cmsUrl": "https://cms.example.com",
  "cmsKey": "yourKey",
  "displayName": "videowall-follower-1",
  "preventSleep": true,
  "sync": {
    "topology": { "x": 1, "y": 0, "orientation": 0 },
    "choreography": "diagonal-tl",
    "staggerMs": 200,
    "gridCols": 2,
    "gridRows": 2
  }
}
```

Followers discover the lead's relay automatically via mDNS (v0.7.1+). The CMS-provided `syncGroup` IP is used as a fallback if mDNS discovery fails.

## Sync Configuration Reference (v0.7.1)

| Key | Type | Source | Description |
|-----|------|--------|-------------|
| `sync.isLead` | boolean | CMS | Whether this display is the sync group lead |
| `sync.syncGroup` | string | CMS | Lead's LAN IP (followers) or `"lead"` (lead) |
| `sync.syncGroupId` | number | CMS | Numeric group ID for relay isolation |
| `sync.syncPublisherPort` | number | CMS | WebSocket relay port (default: 8765) |
| `sync.syncSwitchDelay` | number | CMS | Milliseconds to wait before showing layout (default: 750) |
| `sync.syncVideoPauseDelay` | number | CMS | Milliseconds before unpausing video (default: 100) |
| `sync.relayUrl` | string | Auto | Built from syncGroup + port: `ws://<ip>:<port>/sync` |
| `sync.topology` | object | Local | Display position: `{ x, y, orientation }` |
| `sync.choreography` | string | Local | Transition effect (see below) |
| `sync.staggerMs` | number | Local | Delay between displays in choreography (default: 150) |
| `sync.gridCols` | number | Local | Grid width for 2D choreography |
| `sync.gridRows` | number | Local | Grid height for 2D choreography |
| `sync.layoutMap` | object | CMS | Wall mode: maps lead layout IDs to position-specific layouts |

## Choreography Effects (v0.7.1)

| Effect | Description | Stagger formula |
|--------|-------------|-----------------|
| `simultaneous` | All displays switch at once | 0ms for all |
| `wave-right` | Sweep left → right | x × staggerMs |
| `wave-left` | Sweep right → left | (maxX - x) × staggerMs |
| `wave-down` | Sweep top → bottom | y × staggerMs |
| `wave-up` | Sweep bottom → top | (maxY - y) × staggerMs |
| `diagonal-tl` | Cascade from top-left | (x + y) × staggerMs |
| `diagonal-tr` | Cascade from top-right | ((maxX - x) + y) × staggerMs |
| `diagonal-bl` | Cascade from bottom-left | (x + (maxY - y)) × staggerMs |
| `diagonal-br` | Cascade from bottom-right | ((maxX - x) + (maxY - y)) × staggerMs |
| `center-out` | Center first, edges last | distance_from_center × staggerMs |
| `outside-in` | Edges first, center last | (max_distance - distance) × staggerMs |
| `random` | Random delay per display | random(0, staggerMs × max_distance) |

## CLI Flags

Both players accept CLI flags that override config.json values.

### Electron

```
electron . [flags]
  --dev                  Open DevTools + force DEBUG logging
  --no-kiosk             Disable kiosk mode
  --port=XXXX            Override server port
  --pwa-path=/path       Use local PWA build instead of installed
  --cms-url=URL          Override CMS URL
  --cms-key=KEY          Override CMS key
  --display-name=NAME    Override display name
  --instance=NAME        Run a separate instance with its own config
```

### Chromium

```
launch-kiosk.sh [flags]
  --no-kiosk             Disable kiosk mode
  --port=XXXX            Override server port
  --pwa-path=/path       Use local PWA build
  --log-level=LEVEL      Set log level (DEBUG, INFO, WARNING, ERROR)
  --instance=NAME        Run a separate instance with its own config
  --server-dir=/path     Override server directory
```
