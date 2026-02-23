/**
 * Widget HTML caching tests
 *
 * Tests the URL rewriting and base tag injection that cacheWidgetHtml performs.
 * These are critical for widget rendering — CMS provides HTML with absolute
 * signed URLs that must be rewritten to local cache paths.
 *
 * Real-world scenario (RSS ticker in layout 472, region 223, widget 193):
 *   1. CMS getResource returns HTML with signed URLs for bundle.min.js, fonts.css
 *   2. SW download manager may cache this raw HTML before the main thread processes it
 *   3. cacheWidgetHtml must rewrite CMS URLs → /cache/static/ and fetch the resources
 *   4. Widget iframe loads, SW serves bundle.min.js and fonts.css from static cache
 *   5. bundle.min.js runs getWidgetData → $.ajax("193.json") → SW serves from media cache
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cacheWidgetHtml } from './widget-html.js';

// --- Realistic CMS HTML templates (based on actual CMS output) ---

const CMS_BASE = 'https://displays.superpantalles.com';
const SIGNED_PARAMS = 'displayId=152&type=P&itemId=1&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260222T000000Z&X-Amz-Expires=1771803983&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123';

/**
 * Simulates actual CMS RSS ticker widget HTML (layout 472, region 223, widget 193).
 * The CMS generates this via getResource — it includes:
 * - Signed URLs for bundle.min.js and fonts.css (must be rewritten)
 * - Relative data URL "193.json" resolved via <base> tag
 * - Interactive Control (xiboIC) with hostAddress pointing at CMS
 */
function makeRssTickerHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>RSS Ticker</title>
<script src="${CMS_BASE}/pwa/file?file=bundle.min.js&fileType=bundle&${SIGNED_PARAMS}"></script>
<link rel="stylesheet" href="${CMS_BASE}/pwa/file?file=fonts.css&fileType=fontCss&${SIGNED_PARAMS}">
<style>.rss-item { padding: 10px; }</style>
</head>
<body>
<div id="content">
<script>
var currentWidget = { url: "193.json", duration: 5 };
var options = {hostAddress: "${CMS_BASE}"};
xiboIC.init(options);
function getWidgetData() {
  $.ajax({ url: currentWidget.url, dataType: "json" });
}
</script>
</div>
</body>
</html>`;
}

/** PDF widget (layout 472, region 221, widget 190) — simpler, no data URL */
function makePdfWidgetHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="${CMS_BASE}/pwa/file?file=bundle.min.js&fileType=bundle&${SIGNED_PARAMS}"></script>
<link rel="stylesheet" href="${CMS_BASE}/pwa/file?file=fonts.css&fileType=fontCss&${SIGNED_PARAMS}"></link>
</head>
<body>
<object data="11.pdf" type="application/pdf" width="100%" height="100%"></object>
</body>
</html>`;
}

/** Clock widget — uses xmds.php endpoint (older CMS versions) */
function makeClockWidgetHtml() {
  return `<html>
<head>
<script src="${CMS_BASE}/xmds.php?file=bundle.min.js&${SIGNED_PARAMS}"></script>
<link rel="stylesheet" href="${CMS_BASE}/xmds.php?file=fonts.css&${SIGNED_PARAMS}">
</head>
<body><div class="clock"></div></body>
</html>`;
}

// --- Mock Cache API ---

const cacheStore = new Map();
const mockCache = {
  put: vi.fn(async (url, response) => {
    const key = typeof url === 'string' ? url : url.toString();
    const text = await response.clone().text();
    cacheStore.set(key, text);
  }),
  match: vi.fn(async (key) => {
    const url = typeof key === 'string' ? key : (key.url || key.toString());
    const text = cacheStore.get(url);
    return text ? new Response(text) : undefined;
  }),
};

const fetchedUrls = [];
global.fetch = vi.fn(async (url) => {
  fetchedUrls.push(url);
  if (url.includes('bundle.min.js')) {
    return new Response('var xiboIC = { init: function(){} };', { status: 200 });
  }
  if (url.includes('fonts.css')) {
    return new Response(`@font-face { font-family: "Poppins"; src: url("${CMS_BASE}/pwa/file?file=Poppins-Regular.ttf&${SIGNED_PARAMS}"); }`, { status: 200 });
  }
  if (url.includes('.ttf') || url.includes('.woff')) {
    return new Response(new Blob([new Uint8Array(100)]), { status: 200 });
  }
  return new Response('', { status: 404 });
});

global.caches = {
  open: vi.fn(async () => mockCache),
};

// --- Tests ---

describe('cacheWidgetHtml', () => {
  beforeEach(() => {
    cacheStore.clear();
    vi.clearAllMocks();
    fetchedUrls.length = 0;
  });

  // --- Base tag injection ---

  describe('base tag injection', () => {
    it('injects <base> tag after <head>', async () => {
      const html = '<html><head><title>Widget</title></head><body>content</body></html>';
      await cacheWidgetHtml('472', '223', '193', html);

      const stored = cacheStore.values().next().value;
      expect(stored).toContain('<base href=');
      expect(stored).toContain('/cache/media/">');
    });

    it('injects <base> tag when no <head> tag exists', async () => {
      const html = '<div>no head tag</div>';
      await cacheWidgetHtml('472', '223', '193', html);

      const stored = cacheStore.values().next().value;
      expect(stored).toContain('<base href=');
    });
  });

  // --- RSS ticker: layout 472, region 223, widget 193 ---

  describe('RSS ticker (layout 472 / region 223 / widget 193)', () => {
    it('rewrites bundle.min.js and fonts.css signed URLs', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const stored = cacheStore.values().next().value;
      expect(stored).not.toContain(CMS_BASE);
      expect(stored).toContain('/cache/static/bundle.min.js');
      expect(stored).toContain('/cache/static/fonts.css');
    });

    it('preserves the data URL (193.json) for SW interception', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const stored = cacheStore.values().next().value;
      // 193.json is relative — resolved by <base> tag, not rewritten
      expect(stored).toContain('"193.json"');
    });

    it('rewrites xiboIC hostAddress from CMS to local path', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const stored = cacheStore.values().next().value;
      expect(stored).not.toContain(`hostAddress: "${CMS_BASE}"`);
      expect(stored).toContain('/ic"');
    });

    it('fetches bundle.min.js and fonts.css from CMS for local caching', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const bundleFetched = fetchedUrls.some(u => u.includes('bundle.min.js'));
      const fontsFetched = fetchedUrls.some(u => u.includes('fonts.css'));
      expect(bundleFetched).toBe(true);
      expect(fontsFetched).toBe(true);
    });

    it('stores processed HTML at correct cache key', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const keys = [...cacheStore.keys()];
      const widgetKey = keys.find(k => k.includes('/cache/widget/472/223/193'));
      expect(widgetKey).toBeTruthy();
    });

    it('caches font files referenced in fonts.css', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      // fonts.css contains url("...Poppins-Regular.ttf") which should be fetched
      const fontFetched = fetchedUrls.some(u => u.includes('Poppins-Regular.ttf'));
      expect(fontFetched).toBe(true);
    });
  });

  // --- PDF widget: layout 472, region 221, widget 190 ---

  describe('PDF widget (layout 472 / region 221 / widget 190)', () => {
    it('rewrites CMS URLs and preserves relative PDF path', async () => {
      await cacheWidgetHtml('472', '221', '190', makePdfWidgetHtml());

      const stored = cacheStore.values().next().value;
      expect(stored).not.toContain(CMS_BASE);
      expect(stored).toContain('/cache/static/bundle.min.js');
      // PDF data attribute "11.pdf" is relative — resolved by <base> tag
      expect(stored).toContain('"11.pdf"');
    });

    it('stores at correct widget cache key with layout/region/media IDs', async () => {
      await cacheWidgetHtml('472', '221', '190', makePdfWidgetHtml());

      const keys = [...cacheStore.keys()];
      expect(keys.some(k => k.includes('/cache/widget/472/221/190'))).toBe(true);
    });
  });

  // --- Clock widget: xmds.php endpoint (legacy) ---

  describe('clock widget with xmds.php URLs', () => {
    it('rewrites xmds.php signed URLs to local cache paths', async () => {
      await cacheWidgetHtml('1', '1', '1', makeClockWidgetHtml());

      const stored = cacheStore.values().next().value;
      expect(stored).not.toContain('xmds.php');
      expect(stored).toContain('/cache/static/bundle.min.js');
      expect(stored).toContain('/cache/static/fonts.css');
    });
  });

  // --- Idempotency (regression: duplicate base/style tags) ---

  describe('idempotency', () => {
    it('does not add duplicate <base> tags on re-processing', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());
      const firstPass = cacheStore.values().next().value;

      await cacheWidgetHtml('472', '223', '193', firstPass);
      const secondPass = cacheStore.values().next().value;

      expect(secondPass).toBe(firstPass);
    });

    it('does not add duplicate CSS fix tags on re-processing', async () => {
      const html = '<html><head></head><body></body></html>';
      await cacheWidgetHtml('472', '223', '193', html);
      const firstPass = cacheStore.values().next().value;

      await cacheWidgetHtml('472', '223', '193', firstPass);
      const secondPass = cacheStore.values().next().value;

      const baseCount = (secondPass.match(/<base /g) || []).length;
      const styleCount = (secondPass.match(/object-position:center center/g) || []).length;
      expect(baseCount).toBe(1);
      expect(styleCount).toBe(1);
    });
  });

  // --- SW pre-cache scenario (the bug we fixed) ---

  describe('SW pre-cached raw HTML (regression)', () => {
    it('processes raw HTML that SW cached without rewriting', async () => {
      // Simulate: SW downloads getResource HTML and caches it raw
      const rawCmsHtml = makeRssTickerHtml();

      // Main thread finds it in cache and re-processes
      await cacheWidgetHtml('472', '223', '193', rawCmsHtml);

      const stored = cacheStore.values().next().value;
      // CMS URLs must be rewritten even though HTML came from cache
      expect(stored).not.toContain(CMS_BASE);
      expect(stored).toContain('/cache/static/bundle.min.js');
      expect(stored).toContain('/cache/static/fonts.css');
      expect(stored).toContain('<base href=');
    });

    it('handles different widgets in different regions of same layout', async () => {
      // Layout 472 has region 221 (PDF) and region 223 (RSS ticker)
      await cacheWidgetHtml('472', '221', '190', makePdfWidgetHtml());
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const keys = [...cacheStore.keys()];
      const pdfKey = keys.find(k => k.includes('/cache/widget/472/221/190'));
      const rssKey = keys.find(k => k.includes('/cache/widget/472/223/193'));
      expect(pdfKey).toBeTruthy();
      expect(rssKey).toBeTruthy();

      // Both should have CMS URLs rewritten
      expect(cacheStore.get(pdfKey)).not.toContain(CMS_BASE);
      expect(cacheStore.get(rssKey)).not.toContain(CMS_BASE);
    });
  });
});
