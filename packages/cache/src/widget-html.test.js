// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Widget HTML caching tests
 *
 * Tests the base tag injection and IC hostAddress rewriting.
 * URL rewriting has been removed — the CMS now serves relative paths,
 * and the proxy mirror routes serve content at CMS URL paths directly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cacheWidgetHtml } from './widget-html.js';
import { PLAYER_API } from '@xiboplayer/utils';

const CMS_BASE = 'https://displays.superpantalles.com';

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
<script src="${PLAYER_API}/dependencies/bundle.min.js"></script>
<link rel="stylesheet" href="${PLAYER_API}/dependencies/fonts.css">
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
<script src="${PLAYER_API}/dependencies/bundle.min.js"></script>
<link rel="stylesheet" href="${PLAYER_API}/dependencies/fonts.css"></link>
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

  const storePrefix = `/store${PLAYER_API}/widgets/`;

  function getStoredWidget() {
    for (const [key, value] of storeContents) {
      if (key.startsWith(storePrefix)) return value;
    }
    return undefined;
  }

  // --- Base tag injection ---

  describe('base tag injection', () => {
    it('injects <base> tag pointing to CMS media mirror path', async () => {
      const html = '<html><head><title>Widget</title></head><body>content</body></html>';
      await cacheWidgetHtml('472', '223', '193', html);

      const stored = getStoredWidget();
      expect(stored).toContain(`<base href="${PLAYER_API}/media/file/">`);
    });

    it('injects <base> tag when no <head> tag exists', async () => {
      const html = '<div>no head tag</div>';
      await cacheWidgetHtml('472', '223', '193', html);

      const stored = getStoredWidget();
      expect(stored).toContain(`<base href="${PLAYER_API}/media/file/">`);
    });
  });

  // --- RSS ticker ---

  describe('RSS ticker (layout 472 / region 223 / widget 193)', () => {
    it('preserves dependency URLs as-is (no rewriting needed)', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const stored = getStoredWidget();
      expect(stored).toContain(`${PLAYER_API}/dependencies/bundle.min.js`);
      expect(stored).toContain(`${PLAYER_API}/dependencies/fonts.css`);
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
      const putCalls = fetchedUrls.filter(u => u.startsWith(storePrefix));
      expect(putCalls.length).toBe(1);
    });

    it('stores processed HTML at correct store key', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const keys = [...storeContents.keys()];
      expect(keys.some(k => k.includes(`${storePrefix}472/223/193`))).toBe(true);
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
      expect(keys.some(k => k.includes(`${storePrefix}472/221/190`))).toBe(true);
    });
  });

  // --- xiboICTargetId injection ---

  describe('xiboICTargetId injection', () => {
    it('injects xiboICTargetId script with the media ID', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const stored = getStoredWidget();
      expect(stored).toContain("var xiboICTargetId = '193'");
    });

    it('injects before XIC library script', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());

      const stored = getStoredWidget();
      const targetIdPos = stored.indexOf('xiboICTargetId');
      const xicInitPos = stored.indexOf('xiboIC.init');
      expect(targetIdPos).toBeLessThan(xicInitPos);
    });

    it('is idempotent (no double injection)', async () => {
      await cacheWidgetHtml('472', '223', '193', makeRssTickerHtml());
      const firstPass = getStoredWidget();

      storeContents.clear();
      await cacheWidgetHtml('472', '223', '193', firstPass);
      const secondPass = getStoredWidget();

      const count = (secondPass.match(/xiboICTargetId/g) || []).length;
      // 1 in the injected script + 1 in the original xiboIC.init options (if any)
      // But the original HTML doesn't have xiboICTargetId, so count should be exactly 1
      expect(count).toBe(1);
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
      expect(keys.some(k => k.includes(`${storePrefix}472/221/190`))).toBe(true);
      expect(keys.some(k => k.includes(`${storePrefix}472/223/193`))).toBe(true);
    });
  });
});
