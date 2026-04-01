// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Unit tests for PwaPlayer internals.
 *
 * Tests the pure-logic methods by exposing them through a minimal test harness.
 * The full init() flow requires a live DOM + SW and is covered by Playwright e2e.
 */

import { describe, it, expect } from 'vitest';

// Since PwaPlayer methods are private, we test the logic by reimplementing
// the pure functions here. This is a practical approach for a class with
// no public API beyond init() — avoids exposing internals just for tests.

// ── parseBody ──────────────────────────────────────────────

function parseBody(body: string | null): any {
  try { return body ? JSON.parse(body) : {}; } catch (_) { return {}; }
}

describe('parseBody', () => {
  it('parses valid JSON', () => {
    expect(parseBody('{"key":"value"}')).toEqual({ key: 'value' });
  });

  it('returns empty object for null', () => {
    expect(parseBody(null)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parseBody('')).toEqual({});
  });

  it('returns empty object for invalid JSON', () => {
    expect(parseBody('not json')).toEqual({});
  });

  it('parses arrays', () => {
    expect(parseBody('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('handles nested objects', () => {
    expect(parseBody('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
  });
});

// ── containedRect ──────────────────────────────────────────

function containedRect(
  srcW: number, srcH: number, rect: { left: number; top: number; width: number; height: number }
): { x: number; y: number; w: number; h: number } {
  const srcAspect = srcW / srcH;
  const dstAspect = rect.width / rect.height;
  let w: number, h: number;
  if (srcAspect > dstAspect) {
    w = rect.width;
    h = rect.width / srcAspect;
  } else {
    h = rect.height;
    w = rect.height * srcAspect;
  }
  return {
    x: rect.left + (rect.width - w) / 2,
    y: rect.top + (rect.height - h) / 2,
    w, h,
  };
}

describe('containedRect', () => {
  it('fits wider source (letterbox)', () => {
    // 1920x1080 source into 800x600 container
    const result = containedRect(1920, 1080, { left: 0, top: 0, width: 800, height: 600 });
    expect(result.w).toBe(800);
    expect(result.h).toBeCloseTo(450, 0);
    expect(result.x).toBe(0);
    expect(result.y).toBeCloseTo(75, 0); // (600-450)/2
  });

  it('fits taller source (pillarbox)', () => {
    // 1080x1920 source into 800x600 container
    const result = containedRect(1080, 1920, { left: 0, top: 0, width: 800, height: 600 });
    expect(result.h).toBe(600);
    expect(result.w).toBeCloseTo(337.5, 0);
    expect(result.y).toBe(0);
    expect(result.x).toBeCloseTo(231.25, 0);
  });

  it('perfect fit returns same dimensions', () => {
    const result = containedRect(800, 600, { left: 0, top: 0, width: 800, height: 600 });
    expect(result.w).toBe(800);
    expect(result.h).toBe(600);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it('respects container offset', () => {
    const result = containedRect(800, 600, { left: 100, top: 50, width: 800, height: 600 });
    expect(result.x).toBe(100);
    expect(result.y).toBe(50);
  });

  it('handles square source in landscape container', () => {
    const result = containedRect(500, 500, { left: 0, top: 0, width: 800, height: 400 });
    expect(result.w).toBe(400);
    expect(result.h).toBe(400);
    expect(result.x).toBe(200); // pillarboxed
    expect(result.y).toBe(0);
  });
});

// ── getMediaIds ────────────────────────────────────────────

function getMediaIds(
  xlfXml: string,
  fileIdToSaveAs: Map<string, string> = new Map()
): { allMedia: string[]; videoMedia: string[] } {
  const doc = new DOMParser().parseFromString(xlfXml, 'text/xml');
  const allMedia: string[] = [];
  const videoMedia: string[] = [];

  doc.querySelectorAll('media[fileId]').forEach(el => {
    const fileId = el.getAttribute('fileId');
    if (fileId) {
      const saveAs = fileIdToSaveAs.get(fileId) || fileId;
      if (saveAs.endsWith('.xlf')) return;
      allMedia.push(saveAs);
      if (el.getAttribute('type') === 'video') {
        videoMedia.push(saveAs);
      }
    }
  });

  const bgFileId = doc.querySelector('layout')?.getAttribute('background');
  if (bgFileId) {
    const saveAs = fileIdToSaveAs.get(bgFileId) || bgFileId;
    if (!allMedia.includes(saveAs)) {
      allMedia.push(saveAs);
    }
  }

  return { allMedia, videoMedia };
}

describe('getMediaIds', () => {
  it('extracts image media IDs', () => {
    const xlf = `<layout><region><media fileId="123" type="image"/></region></layout>`;
    const result = getMediaIds(xlf);
    expect(result.allMedia).toEqual(['123']);
    expect(result.videoMedia).toEqual([]);
  });

  it('extracts video media IDs', () => {
    const xlf = `<layout><region><media fileId="456" type="video"/></region></layout>`;
    const result = getMediaIds(xlf);
    expect(result.allMedia).toEqual(['456']);
    expect(result.videoMedia).toEqual(['456']);
  });

  it('uses saveAs mapping', () => {
    const xlf = `<layout><region><media fileId="789" type="image"/></region></layout>`;
    const mapping = new Map([['789', 'background.jpg']]);
    const result = getMediaIds(xlf, mapping);
    expect(result.allMedia).toEqual(['background.jpg']);
  });

  it('skips XLF references', () => {
    const xlf = `<layout><region><media fileId="100" type="layout"/></region></layout>`;
    const mapping = new Map([['100', 'layout_42.xlf']]);
    const result = getMediaIds(xlf, mapping);
    expect(result.allMedia).toEqual([]);
  });

  it('includes background image', () => {
    const xlf = `<layout background="bg1"><region><media fileId="123" type="image"/></region></layout>`;
    const result = getMediaIds(xlf);
    expect(result.allMedia).toEqual(['123', 'bg1']);
  });

  it('does not duplicate background if already in media list', () => {
    const xlf = `<layout background="123"><region><media fileId="123" type="image"/></region></layout>`;
    const result = getMediaIds(xlf);
    expect(result.allMedia).toEqual(['123']);
  });

  it('handles multiple media elements', () => {
    const xlf = `
      <layout>
        <region>
          <media fileId="1" type="image"/>
          <media fileId="2" type="video"/>
          <media fileId="3" type="image"/>
        </region>
      </layout>`;
    const result = getMediaIds(xlf);
    expect(result.allMedia).toEqual(['1', '2', '3']);
    expect(result.videoMedia).toEqual(['2']);
  });

  it('handles empty layout', () => {
    const xlf = `<layout></layout>`;
    const result = getMediaIds(xlf);
    expect(result.allMedia).toEqual([]);
    expect(result.videoMedia).toEqual([]);
  });
});

// ── handleInteractiveControl routing ───────────────────────

describe('IC routing', () => {
  // Minimal mock of the IC router logic
  function routeIC(path: string, search: string, _body: string | null): { status: number; body: string } {
    switch (path) {
      case '/info':
        return { status: 200, body: JSON.stringify({ playerType: 'pwa' }) };
      case '/trigger':
        return { status: 200, body: 'OK' };
      case '/duration/expire':
        return { status: 200, body: 'OK' };
      case '/duration/extend':
        return { status: 200, body: 'OK' };
      case '/duration/set':
        return { status: 200, body: 'OK' };
      case '/fault':
        return { status: 200, body: 'OK' };
      case '/realtime': {
        const params = new URLSearchParams(search);
        if (!params.get('dataKey')) return { status: 400, body: JSON.stringify({ error: 'Missing dataKey parameter' }) };
        return { status: 200, body: '{}' };
      }
      case '/criteria':
        return { status: 200, body: JSON.stringify({ playerType: 'pwa' }) };
      default:
        return { status: 404, body: JSON.stringify({ error: 'Unknown IC route' }) };
    }
  }

  it('returns 200 for /info', () => {
    expect(routeIC('/info', '', null).status).toBe(200);
  });

  it('returns 200 for /trigger', () => {
    expect(routeIC('/trigger', '', '{"id":"w1","trigger":"next"}').status).toBe(200);
  });

  it('returns 400 for /realtime without dataKey', () => {
    expect(routeIC('/realtime', '', null).status).toBe(400);
  });

  it('returns 200 for /realtime with dataKey', () => {
    expect(routeIC('/realtime', 'dataKey=weather', null).status).toBe(200);
  });

  it('returns 404 for unknown route', () => {
    expect(routeIC('/unknown', '', null).status).toBe(404);
  });

  it('returns 200 for /duration/expire', () => {
    expect(routeIC('/duration/expire', '', '{"id":"w1"}').status).toBe(200);
  });

  it('returns 200 for /duration/extend', () => {
    expect(routeIC('/duration/extend', '', '{"id":"w1","duration":"30"}').status).toBe(200);
  });

  it('returns 200 for /criteria', () => {
    const res = routeIC('/criteria', '', null);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).playerType).toBe('pwa');
  });
});
