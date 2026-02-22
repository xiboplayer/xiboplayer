# @xiboplayer/renderer

**XLF layout rendering engine for Xibo digital signage.**

## Overview

RendererLite parses Xibo Layout Format (XLF) files and builds a live DOM with:

- **Rich media** — video (MP4/HLS), images, PDF (via PDF.js), text/ticker, web pages, clock, calendar, weather
- **Transitions** — fade and fly (8-direction compass) via Web Animations API
- **Interactive actions** — touch/click and keyboard triggers for widget navigation, layout jumps, and commands
- **Layout preloading** — 2-layout pool pre-builds upcoming layouts at 75% of current duration for zero-gap transitions
- **Proportional scaling** — ResizeObserver-based scaling to fit any screen resolution
- **Overlay support** — multiple simultaneous overlay layouts with independent z-index (1000+)
- **Absolute widget positioning** — widget elements use `position: absolute` within regions to layer correctly in multi-widget regions
- **Animation cleanup** — `fill: forwards` animations cancelled between widgets to prevent stale visual state (e.g. video hidden after PDF)

## Installation

```bash
npm install @xiboplayer/renderer
```

## Usage

```javascript
import { RendererLite } from '@xiboplayer/renderer';

const renderer = new RendererLite({
  container: document.getElementById('player'),
});

// Render a layout from parsed XLF
await renderer.renderLayout(xlf, { mediaBaseUrl: '/cache/' });
```

## Widget Types

| Widget | Implementation |
|--------|---------------|
| Video | `<video>` with native HLS (Safari) + hls.js fallback, pause-on-last-frame |
| Image | `<img>` with CMS scaleType mapping (center->contain, stretch->fill, fit->cover), blob URL from cache |
| PDF | PDF.js canvas rendering (dynamically imported) |
| Text / Ticker | iframe with CMS-rendered HTML via GetResource |
| Web page | bare `<iframe src="...">` |
| Clock, Calendar, Weather | iframe via GetResource (server-rendered) |
| All other CMS widgets | Generic iframe via GetResource |

## Dependencies

- `@xiboplayer/utils` — logger, events
- `pdfjs-dist` — PDF rendering

---

**Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)** | [MCP Server](https://github.com/xibo-players/xiboplayer/tree/main/mcp-server) for AI-assisted development
