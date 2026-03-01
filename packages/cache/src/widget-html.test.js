/**
 * Widget HTML caching tests
 *
 * Tests the base tag injection and IC hostAddress rewriting.
 * URL rewriting has been removed — the CMS now serves relative paths,
 * and the proxy mirror routes serve content at CMS URL paths directly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cacheWidgetHtml } from './widget-html.js';

const CMS_BASE = 'https://displays.superpantalles.com';
const SIGNED_PARAMS = 'displayId=152&type=P&itemId=1&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260222T000000Z&X-Amz-Expires=1771803983&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123';

/**
 * RSS ticker widget HTML (layout 472, region 223, widget 193).
 * In v2, CMS serves relative dependency URLs — but legacy tests use absolute.
 */
function makeRssTickerHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>RSS Ticker</title>
<script src="/api/v2/player/dependencies/bundle.min.js"></script>
<link rel="stylesheet" href="/api/v2/player/dependencies/fonts.css">
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

/** PDF widget — relative paths, no data URL rewriting needed */
function makePdfWidgetHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="/api/v2/player/dependencies/bundle.min.js"></script>
<link rel="stylesheet" href="/api/v2/player/dependencies/fonts.css"></link>
</head>
<body>
<object data="11.pdf" type="application/pdf" width="100%" height="100%"></object>
</body>
</html>`;
}

// --- Mock: track PUT /store/... calls via fetch() ---

const storeContents = new Map();
const fetchedUrls = [];

function createFetchMock() {
  return vi.fn(async (url, opts) => {
    fetchedUrls.push(url);

    // PUT /store/... — store content
    if (opts?.method === 'PUT' && url.startsWith('/store/')) {
      const body = typeof opts.body === 'string' ? opts.body : await opts.body?.text?.() || '';
      storeContents.set(url, body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response('', { status: 404 });
  });
}

// --- Tests ---

describe('cacheWidgetHtml', () => {
  beforeEach(() => {
    storeContents.clear();
    fetchedUrls.length = 0;
    vi.clearAllMocks();
    global.fetch = createFetchMock();
  });

  function getStoredWidget() {
    for (const [key, value] of storeContents) {
      if (key.startsWith('/store/api/v2/player/widgets/')) return value;
    }
    return undefined;
  }

  // --- Base tag injection ---

  describe('base tag injection', () => {
    it('injects <base> tag pointing to CMS media mirror path', async () => {
      const html = '<html><head><title>Widget</title></head><body>content</body></html>';
      await cacheWidgetHtml('472', '223', '193', html);

      const stored = getStoredWidget();
      expect(stored).toContain('<base href="/api/v2/player/media/">');
    });

    it('injects <base> tag when no <head> tag exists', async () => {
      const html = '<div>no head tag</div>';
      await cacheWidgetHtml('472', '223', '193', html);

      const stored = getStoredWidget();
      expect(stored).toContain('<base href="/api/v2/player/media/">');
    });
  });

  // --- RSS ticker ---

  describe('RSS ticker (layout 472 / region 223 / widget 193)', () => {
    it('preserves dependency URLs as-is (no rewriting needed)', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const stored = getStoredWidget();
      expect(stored).toContain('/api/v2/player/dependencies/bundle.min.js');
      expect(stored).toContain('/api/v2/player/dependencies/fonts.css');
    });

    it('preserves the data URL (193.json) for resolution via base tag', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const stored = getStoredWidget();
      expect(stored).toContain('"193.json"');
    });

    it('rewrites xiboIC hostAddress from CMS to local path', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const stored = getStoredWidget();
      expect(stored).not.toContain(`hostAddress: "${CMS_BASE}"`);
      expect(stored).toContain('/ic"');
    });

    it('does NOT fetch any static resources (pipeline handles deps)', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      // Only the widget HTML PUT should be fetched — no proactive resource fetches
      const putCalls = fetchedUrls.filter(u => u.startsWith('/store/api/v2/player/widgets/'));
      expect(putCalls.length).toBe(1);
    });

    it('stores processed HTML at correct store key', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const keys = [...storeContents.keys()];
      expect(keys.some(k => k.includes('/store/api/v2/player/widgets/472/223/193'))).toBe(true);
    });
  });

  // --- PDF widget ---

  describe('PDF widget (layout 472 / region 221 / widget 190)', () => {
    it('preserves relative PDF path for resolution via base tag', async () => {
      await cacheWidgetHtml('472', '221', '190', makePdfWidgetHtml());

      const stored = getStoredWidget();
      expect(stored).toContain('"11.pdf"');
    });

    it('stores at correct widget store key', async () => {
      await cacheWidgetHtml('472', '221', '190', makePdfWidgetHtml());

      const keys = [...storeContents.keys()];
      expect(keys.some(k => k.includes('/store/api/v2/player/widgets/472/221/190'))).toBe(true);
    });
  });

  // --- CSS object-position fix ---

  describe('CSS object-position fix', () => {
    it('injects object-position CSS fix', async () => {
      const html = '<html><head></head><body></body></html>';
      await cacheWidgetHtml('472', '223', '193', html);

      const stored = getStoredWidget();
      expect(stored).toContain('object-position:center center');
    });
  });

  // --- Idempotency ---

  describe('idempotency', () => {
    it('does not add duplicate <base> tags on re-processing', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());
      const firstPass = getStoredWidget();

      storeContents.clear();
      await cacheWidgetHtml('472', '223', '193', firstPass);
      const secondPass = getStoredWidget();

      expect(secondPass).toBe(firstPass);
    });

    it('does not add duplicate CSS fix tags on re-processing', async () => {
      const html = '<html><head></head><body></body></html>';
      await cacheWidgetHtml('472', '223', '193', html);
      const firstPass = getStoredWidget();

      storeContents.clear();
      await cacheWidgetHtml('472', '223', '193', firstPass);
      const secondPass = getStoredWidget();

      const baseCount = (secondPass.match(/<base /g) || []).length;
      const styleCount = (secondPass.match(/object-position:center center/g) || []).length;
      expect(baseCount).toBe(1);
      expect(styleCount).toBe(1);
    });
  });

  // --- Multi-region ---

  describe('multi-region layout', () => {
    it('handles different widgets in different regions', async () => {
      await cacheWidgetHtml('472', '221', '190', makePdfWidgetHtml());
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const keys = [...storeContents.keys()];
      expect(keys.some(k => k.includes('/store/api/v2/player/widgets/472/221/190'))).toBe(true);
      expect(keys.some(k => k.includes('/store/api/v2/player/widgets/472/223/193'))).toBe(true);
    });
  });
});
