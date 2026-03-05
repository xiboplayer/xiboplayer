# @xiboplayer/renderer

**Fast, memory-efficient XLF layout rendering engine for digital signage.**

## Overview

Parses Xibo Layout Format (XLF) files and builds a live DOM with element reuse, instant transitions, and a 2-layout preload pool:

- **Rich media** -- video (MP4/HLS), images (scaleType, align/valign), audio (with visualization), PDF (PDF.js), text/ticker, web pages, clock, calendar, weather, and all CMS widget types
- **Instant layout transitions** -- 2-layout preload pool keeps the next layout DOM-ready for zero-gap swap
- **Element reuse** -- pre-creates all widget elements upfront; cycling reuses them instead of destroying/rebuilding
- **Transitions** -- fade and fly animations with 8 compass directions via Web Animations API
- **Canvas regions** -- simultaneous multi-widget rendering (stacked layers)
- **Drawer regions** -- hidden action-triggered areas for interactive controls
- **Overlays** -- multiple floating layouts with priority z-indexing
- **Interactive actions** -- touch/click and keyboard triggers for widget navigation, layout jumps, and command execution
- **Shell commands** -- native command execution via Electron IPC and Chromium HTTP endpoint
- **Sub-playlist cycling** -- round-robin or random selection from widget groups
- **Dynamic duration** -- video/audio metadata overrides for accurate timing
- **Scale-to-fit** -- responsive scaling for any screen size via ResizeObserver

## Architecture

```
XLF XML -> RendererLite
            +- parseXlf() -> Layout object {width, height, regions: []}
            +- renderLayout()
                +- createRegion() for each region
                |   +- createWidgetElement() for each widget
                |       +- renderImage()        [<img>]
                |       +- renderVideo()        [<video>] (HLS/DASH)
                |       +- renderAudio()        [<audio> + visual]
                |       +- renderTextWidget()   [<iframe>] (GetResource)
                |       +- renderPdf()          [<canvas>] (multi-page)
                |       +- renderWebpage()      [<iframe>]
                |       +- renderVideoIn()      [<video>] (webcam)
                |       +- renderGenericWidget() [<iframe>] (clock, etc.)
                |
                +- attachActionListeners() for touch/click/keyboard
                +- startRegion() -> _startRegionCycle()
                |   +- renderWidget() / stopWidget() cycling
                |
                +- startLayoutTimerWhenReady()
                    +- Waits for all initial widgets to load
                    +- Starts layout duration timer

Layout Pool (2 entries max):
  +- Hot entry    (visible, currently playing)
  +- Warm entry   (preloaded, hidden, ready for instant swap)
```

## Installation

```bash
npm install @xiboplayer/renderer
```

## Usage

### Basic rendering

```javascript
import { RendererLite } from '@xiboplayer/renderer';

const renderer = new RendererLite(
  { cmsUrl: 'https://cms.example.com', hardwareKey: 'DISPLAY-001' },
  document.getElementById('player')
);

renderer.on('layoutStart', (layoutId, layout) => {
  console.log(`Layout ${layoutId} started (${layout.duration}s)`);
});

renderer.on('layoutEnd', (layoutId) => {
  console.log(`Layout ${layoutId} ended`);
});

await renderer.renderLayout(xlfXmlContent, 42);
```

### Preloading for instant transitions

```javascript
// At 75% of current layout duration, renderer emits:
renderer.on('request-next-layout-preload', async () => {
  const nextLayout = await getNextLayoutFromSchedule();
  if (nextLayout && !renderer.hasPreloadedLayout(nextLayout.id)) {
    await renderer.preloadLayout(nextLayout.xlf, nextLayout.id);
  }
});

// When it's time to show next layout, swap is INSTANT if preloaded
await renderer.renderLayout(nextXlfXml, nextLayoutId);
```

### Overlays

```javascript
// Render an overlay on top of the main layout
await renderer.renderOverlay(alertXlfXml, 101, 10);

renderer.on('overlayEnd', (overlayId) => console.log('Overlay done'));

// Stop overlay
renderer.stopOverlay(101);
```

## Widget Types

| Type | Element | Source | Notes |
|------|---------|--------|-------|
| **image** | `<img>` | Media file | Object-fit: center/stretch/fit. objectPosition: top/middle/bottom, left/center/right |
| **video** | `<video>` | Media file | HLS via native (Safari) + hls.js fallback. Pause-on-last-frame. Duration detection |
| **audio** | `<audio>` + visual | Media file | Gradient visualization + music note icon. Volume control. Loop option |
| **videoin** | `<video>` | getUserMedia() | Webcam/mic capture with mirror mode |
| **text** | `<iframe>` | GetResource | CMS-rendered HTML. Parses NUMITEMS/DURATION comments |
| **ticker** | `<iframe>` | GetResource | Data feeds with dynamic cycling |
| **pdf** | `<canvas>` | Media file | PDF.js multi-page cycling. Page indicator. Time-per-page = duration / pages |
| **webpage** | `<iframe>` | Direct URL | modeId=1 (URL), modeId=0 (GetResource) |
| **clock** | `<iframe>` | GetResource | Digital/analogue variants |
| **calendar** | `<iframe>` | GetResource | Calendar widget HTML |
| **weather** | `<iframe>` | GetResource | Weather service HTML |
| **global** | Stacked iframes | GetResource | Canvas region auto-detect for multi-layer content |
| **all others** | `<iframe>` | GetResource | Generic CMS widget HTML |

## Layout Lifecycle

```
XLF XML
  |
  +- parseXlf() -> {width, height, regions: [{widgets: [...]}]}
  |
  +- calculateScale() -> fit layout to screen
  |
  +- createRegion() for each region
  |   +- Filter widgets (fromDt/toDt time-gating)
  |   +- Apply sub-playlist cycling
  |
  +- createWidgetElement() for each widget (pre-creation)
  |   +- Create DOM element, position absolute, hidden
  |   +- Track blob URLs for cleanup
  |
  +- startRegion() for each region
  |   +- Canvas: show ALL widgets at once, timer = max duration
  |   +- Normal: cycle widgets with transitions
  |
  +- startLayoutTimerWhenReady()
  |   +- Wait for video.playing / img.load (or 10s timeout)
  |   +- Start layout duration timer
  |
  +- At 75%: emit 'request-next-layout-preload'
  |
  +- Layout duration expires
      +- emit('layoutEnd', layoutId)
```

### Element reuse flow

1. All widget elements pre-created during `renderLayout()` -- hidden, opacity 0
2. Cycling: `renderWidget()` shows current, `stopWidget()` hides (same elements)
3. No DOM destruction/recreation -- smooth transitions, instant replay
4. When layout evicted from pool: blob URLs revoked, elements removed

### Ready-wait gating

Layout timer starts only when all initial widgets are loaded:
- Video: waits for `playing` event
- Image: waits for `load` event
- Text/embedded: ready immediately
- Timeout: 10s per widget (don't block on broken media)

## Transitions

Defined per-widget in XLF options:

**Fade:** `fade`, `fadein`, `fadeout` -- opacity animation

**Fly:** `fly`, `flyin`, `flyout` -- translate animation with compass direction:
- `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`

```xml
<media duration="5">
  <options>
    <transIn>fly</transIn>
    <transInDuration>1000</transInDuration>
    <transInDirection>NE</transInDirection>
    <transOut>fade</transOut>
    <transOutDuration>500</transOutDuration>
  </options>
</media>
```

## Interactive Actions

Actions defined in XLF at layout, region, or widget level:

**Trigger types:** `touch` (click), `keyboard:KEY` (e.g., `keyboard:n`, `keyboard:Enter`)

**Action types:** `navWidget` (jump to widget), `nextWidget`, `previousWidget`, `shellCommand`

```javascript
renderer.on('action-trigger', (actionData) => {
  console.log(`Action: ${actionData.actionType}`, actionData);
});

// Programmatic navigation
renderer.navigateToWidget('target-widget-id');
renderer.nextWidget('region-id');
renderer.previousWidget('region-id');
```

## Events

| Event | Args | Description |
|-------|------|-------------|
| `layoutStart` | `(layoutId, layout)` | Layout DOM built and playback started |
| `layoutEnd` | `(layoutId)` | Layout duration expired |
| `layoutDurationUpdated` | `(layoutId, newDuration)` | Video metadata revealed actual duration |
| `widgetStart` | `({ widgetId, regionId, layoutId, type, duration, enableStat })` | Widget now visible |
| `widgetEnd` | `({ widgetId, regionId, layoutId, type, enableStat })` | Widget hidden/cycled |
| `widgetCommand` | `({ commandCode, commandString, widgetId, regionId, layoutId })` | Shell command triggered |
| `widgetAction` | `({ type, widgetId, layoutId, regionId, url })` | Widget webhook URL |
| `videoError` | `({ storedAs, fileId, errorCode, errorMessage })` | Video playback error |
| `overlayStart` | `(overlayId, layout)` | Overlay rendered |
| `overlayEnd` | `(overlayId)` | Overlay finished |
| `action-trigger` | `({ actionType, triggerType, targetId, commandCode })` | Touch/keyboard action fired |
| `request-next-layout-preload` | `()` | 75% through layout -- preload next |
| `error` | `({ type, error, layoutId, widgetId })` | Generic error |

## API Reference

### Constructor

```javascript
new RendererLite(config, container, options?)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | Object | `{ cmsUrl, hardwareKey }` |
| `container` | HTMLElement | DOM element to render into |
| `options.getWidgetHtml` | Function? | `(widget) => htmlString` -- fetch widget HTML from cache |
| `options.fileIdToSaveAs` | Map? | Map of fileId to storedAs filename |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `renderLayout(xlfXml, layoutId)` | Promise | Parse, build, and start layout. Instant swap if preloaded. |
| `preloadLayout(xlfXml, layoutId)` | Promise<bool> | Pre-build layout as hidden warm entry |
| `hasPreloadedLayout(layoutId)` | boolean | Check if layout is in preload pool |
| `renderOverlay(xlfXml, layoutId, priority)` | Promise | Render overlay on top |
| `stopCurrentLayout()` | void | Stop main layout |
| `stopOverlay(layoutId)` | void | Stop and remove overlay |
| `stopAllOverlays()` | void | Stop all active overlays |
| `navigateToWidget(widgetId)` | void | Jump to specific widget |
| `nextWidget(regionId?)` | void | Advance to next widget |
| `previousWidget(regionId?)` | void | Go back to previous widget |
| `pause()` | void | Pause media and widget cycling |
| `resume()` | void | Resume playback |
| `cleanup()` | void | Stop all, clear pool, revoke blob URLs |

## Dependencies

- `@xiboplayer/utils` -- logger, events
- `pdfjs-dist` -- PDF rendering (dynamic import)
- `hls.js` -- HLS streaming (dynamic import)

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)**
