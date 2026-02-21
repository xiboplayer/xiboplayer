/**
 * XMDS Client Tests - REST Transport
 *
 * Tests the REST transport layer (useRestApi: true).
 * Verifies that REST methods produce identical data structures to SOAP.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RestClient } from './rest-client.js';
import { XmdsClient } from './xmds-client.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function createRestClient(overrides = {}) {
  return new RestClient({
    cmsAddress: 'https://cms.example.com',
    cmsKey: 'test-server-key',
    hardwareKey: 'test-hw-key',
    displayName: 'Test Display',
    xmrChannel: 'test-xmr-channel',
    retryOptions: { maxRetries: 0 },
    ...overrides,
  });
}

function jsonResponse(data, { status = 200, etag = null } = {}) {
  const headers = new Map([['Content-Type', 'application/json']]);
  if (etag) headers.set('ETag', etag);
  return {
    ok: status >= 200 && status < 400,
    status,
    statusText: status === 200 ? 'OK' : status === 304 ? 'Not Modified' : 'Error',
    headers: { get: (k) => headers.get(k) || null },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function xmlResponse(xml, { status = 200, etag = null } = {}) {
  const headers = new Map([['Content-Type', 'application/xml']]);
  if (etag) headers.set('ETag', etag);
  return {
    ok: status >= 200 && status < 400,
    status,
    statusText: status === 200 ? 'OK' : status === 304 ? 'Not Modified' : 'Error',
    headers: { get: (k) => headers.get(k) || null },
    text: async () => xml,
    json: async () => { throw new Error('Not JSON'); },
  };
}

function htmlResponse(html) {
  const headers = new Map([['Content-Type', 'text/html']]);
  return {
    ok: true, status: 200, statusText: 'OK',
    headers: { get: (k) => headers.get(k) || null },
    text: async () => html,
  };
}

function notModifiedResponse() {
  return {
    ok: true, status: 304, statusText: 'Not Modified',
    headers: { get: () => null },
    text: async () => '',
  };
}

function errorResponse(status, message) {
  return {
    ok: false, status, statusText: message,
    headers: { get: () => null },
    text: async () => message,
  };
}

// ─── Constructor & Config ─────────────────────────────────────────────

describe('RestClient - Config', () => {
  it('should derive REST base URL from cmsAddress', () => {
    const client = createRestClient();
    expect(client.getRestBaseUrl()).toBe('https://cms.example.com/pwa');
  });

  it('should use custom restApiUrl when provided', () => {
    const client = createRestClient({ restApiUrl: 'https://api.example.com/v1/pwa' });
    expect(client.getRestBaseUrl()).toBe('https://api.example.com/v1/pwa');
  });

  it('should strip trailing slashes from REST base URL', () => {
    const client = createRestClient({ restApiUrl: 'https://api.example.com/pwa/' });
    expect(client.getRestBaseUrl()).toBe('https://api.example.com/pwa');
  });

  it('should initialize empty ETag and response caches', () => {
    const client = createRestClient();
    expect(client._etags.size).toBe(0);
    expect(client._responseCache.size).toBe(0);
  });
});

// ─── REST GET with ETag Caching ───────────────────────────────────────

describe('RestClient - GET & Caching', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = createRestClient();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should make GET request with serverKey and hardwareKey as query params', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ test: true }));

    await client.restGet('/requiredFiles');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toContain('/pwa/requiredFiles');
    expect(url.searchParams.get('serverKey')).toBe('test-server-key');
    expect(url.searchParams.get('hardwareKey')).toBe('test-hw-key');
    expect(url.searchParams.get('v')).toBe('7');
  });

  it('should include additional query params', async () => {
    mockFetch.mockResolvedValue(htmlResponse('<div>test</div>'));

    await client.restGet('/resource', { layoutId: '10', regionId: '20', mediaId: '30' });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('layoutId')).toBe('10');
    expect(url.searchParams.get('regionId')).toBe('20');
    expect(url.searchParams.get('mediaId')).toBe('30');
  });

  it('should store ETag from response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ files: [] }, { etag: '"abc123"' }));

    await client.restGet('/requiredFiles');

    expect(client._etags.get('/requiredFiles')).toBe('"abc123"');
  });

  it('should send If-None-Match on subsequent requests', async () => {
    // First request — stores ETag
    mockFetch.mockResolvedValue(jsonResponse({ files: [] }, { etag: '"abc123"' }));
    await client.restGet('/requiredFiles');

    // Second request — should include If-None-Match
    mockFetch.mockResolvedValue(jsonResponse({ files: [] }, { etag: '"abc123"' }));
    await client.restGet('/requiredFiles');

    const secondCall = mockFetch.mock.calls[1][1];
    expect(secondCall.headers['If-None-Match']).toBe('"abc123"');
  });

  it('should return cached response on 304 Not Modified', async () => {
    const data = { file: [{ '@attributes': { type: 'media', id: '42' } }] };

    // First request — caches response
    mockFetch.mockResolvedValue(jsonResponse(data, { etag: '"etag1"' }));
    const first = await client.restGet('/requiredFiles');

    // Second request — 304
    mockFetch.mockResolvedValue(notModifiedResponse());
    const second = await client.restGet('/requiredFiles');

    expect(second).toEqual(first);
  });

  it('should throw on HTTP error', async () => {
    mockFetch.mockResolvedValue(errorResponse(500, 'Internal Server Error'));

    await expect(client.restGet('/requiredFiles')).rejects.toThrow('REST GET /requiredFiles failed: 500');
  });

  it('should throw on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    await expect(client.restGet('/requiredFiles')).rejects.toThrow('Connection refused');
  });
});

// ─── REST POST/PUT ──────────────────────────────────────────────────

describe('RestClient - POST/PUT', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = createRestClient();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should send POST with JSON body including serverKey and hardwareKey', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));

    await client.restSend('POST', '/log', { logXml: '<logs/>' });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.serverKey).toBe('test-server-key');
    expect(body.hardwareKey).toBe('test-hw-key');
    expect(body.logXml).toBe('<logs/>');
  });

  it('should send PUT for status updates', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));

    await client.restSend('PUT', '/status', { statusData: { currentLayoutId: '5' } });

    const opts = mockFetch.mock.calls[0][1];
    expect(opts.method).toBe('PUT');
  });

  it('should throw on HTTP error', async () => {
    mockFetch.mockResolvedValue(errorResponse(403, 'Forbidden'));

    await expect(client.restSend('POST', '/log', {})).rejects.toThrow('REST POST /log failed: 403');
  });
});

// ─── RegisterDisplay ─────────────────────────────────────────────────

describe('RestClient - RegisterDisplay', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = createRestClient();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should include xmrPubKey from config in POST body', async () => {
    const clientWithKey = createRestClient({
      xmrPubKey: '-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----',
    });
    const mockFetchLocal = vi.fn();
    global.fetch = mockFetchLocal;

    mockFetchLocal.mockResolvedValue(jsonResponse({
      display: {
        '@attributes': { code: 'READY', message: 'OK' },
        collectInterval: '60',
      }
    }));

    await clientWithKey.registerDisplay();

    const body = JSON.parse(mockFetchLocal.mock.calls[0][1].body);
    expect(body.xmrPubKey).toBe('-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----');
  });

  it('should send empty xmrPubKey when config has no key', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      display: {
        '@attributes': { code: 'READY', message: 'OK' },
        collectInterval: '60',
      }
    }));

    await client.registerDisplay();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.xmrPubKey).toBe('');
  });

  it('should POST to /register and parse READY response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      display: {
        '@attributes': { code: 'READY', message: 'Display is active', checkRf: 'rf123', checkSchedule: 'sc456' },
        collectInterval: '60',
        downloadStartWindow: '00:00',
        downloadEndWindow: '00:00',
        statsEnabled: '1',
        screenShotRequestInterval: '300',
      }
    }));

    const result = await client.registerDisplay();

    expect(result.code).toBe('READY');
    expect(result.message).toBe('Display is active');
    expect(result.settings.collectInterval).toBe('60');
    expect(result.settings.statsEnabled).toBe('1');
    expect(result.checkRf).toBe('rf123');
    expect(result.checkSchedule).toBe('sc456');

    // Verify POST method and body
    const opts = mockFetch.mock.calls[0][1];
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.displayName).toBe('Test Display');
    expect(body.clientType).toBe('chromeOS');
  });

  it('should handle WAITING response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      display: {
        '@attributes': { code: 'WAITING', message: 'Display is awaiting authorisation' },
      }
    }));

    const result = await client.registerDisplay();

    expect(result.code).toBe('WAITING');
    expect(result.settings).toBeNull();
  });

  it('should handle flat JSON (no @attributes wrapper)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      code: 'READY',
      message: 'OK',
      collectInterval: '30',
    }));

    const result = await client.registerDisplay();
    expect(result.code).toBe('READY');
    expect(result.settings.collectInterval).toBe('30');
  });

  it('should throw on HTTP error', async () => {
    mockFetch.mockResolvedValue(errorResponse(500, 'Server Error'));

    await expect(client.registerDisplay()).rejects.toThrow('REST POST /register failed: 500');
  });
});

// ─── RequiredFiles ───────────────────────────────────────────────────

describe('RestClient - RequiredFiles', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = createRestClient();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should GET /requiredFiles and parse file manifest', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      file: [
        { '@attributes': { type: 'media', id: '42', size: '1024', md5: 'abc', download: 'http', path: '/media/42.jpg' } },
        { '@attributes': { type: 'layout', id: '10', size: '500', md5: 'def', download: 'xmds', path: null } },
        { '@attributes': { type: 'resource', id: '99', size: '200', md5: 'ghi', download: 'xmds', layoutid: '10', regionid: '5', mediaid: '99' } },
      ]
    }, { etag: '"files-v1"' }));

    const result = await client.requiredFiles();

    expect(result.files).toHaveLength(3);
    expect(result.files[0]).toEqual(expect.objectContaining({
      type: 'media', id: '42', size: 1024, md5: 'abc', download: 'http',
      path: '/media/42.jpg', code: null, layoutid: null, regionid: null, mediaid: null,
    }));
    expect(result.files[1].type).toBe('layout');
    expect(result.files[2].layoutid).toBe('10');
    expect(result.files[2].regionid).toBe('5');
    expect(result.files[2].mediaid).toBe('99');
    expect(result.purge).toEqual([]);
  });

  it('should handle single file (not array)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      file: { '@attributes': { type: 'media', id: '1', size: '100', md5: 'x' } }
    }));

    const result = await client.requiredFiles();
    expect(result.files).toHaveLength(1);
    expect(result.files[0].id).toBe('1');
  });

  it('should handle empty file list', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));

    const result = await client.requiredFiles();
    expect(result.files).toHaveLength(0);
  });

  it('should use ETag caching', async () => {
    const data = { file: [{ '@attributes': { type: 'media', id: '1', size: '100', md5: 'x' } }] };

    // First call — stores ETag
    mockFetch.mockResolvedValue(jsonResponse(data, { etag: '"rf-v1"' }));
    const first = await client.requiredFiles();

    // Second call — 304
    mockFetch.mockResolvedValue(notModifiedResponse());
    const second = await client.requiredFiles();

    // Should get same cached JSON (not yet parsed)
    expect(second).toEqual(first);
  });

  it('should parse required files JSON into standard structure', () => {
    const json = {
      file: [
        { '@attributes': { type: 'media', id: '42', size: '1024', md5: 'abc', download: 'http', path: '/media/42.jpg' } },
      ]
    };

    const result = client._parseRequiredFilesJson(json);

    expect(result.files[0].type).toBe('media');
    expect(result.files[0].id).toBe('42');
    expect(result.files[0].size).toBe(1024);
    expect(result.files[0].md5).toBe('abc');
    expect(result.files[0].download).toBe('http');
    expect(result.files[0].path).toBe('/media/42.jpg');
  });
});

// ─── Schedule ────────────────────────────────────────────────────────

describe('RestClient - Schedule', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = createRestClient();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should GET /schedule and parse XML response', async () => {
    const scheduleXml = `<?xml version="1.0" encoding="UTF-8"?>
<schedule>
  <default file="100" />
  <layout file="200" fromdt="2026-01-01" todt="2026-12-31" scheduleid="1" priority="5" />
  <campaign id="c1" priority="10" fromdt="2026-01-01" todt="2026-12-31" scheduleid="2">
    <layout file="300" />
    <layout file="301" />
  </campaign>
</schedule>`;

    mockFetch.mockResolvedValue(xmlResponse(scheduleXml, { etag: '"sched-v1"' }));

    const schedule = await client.schedule();

    expect(schedule.default).toBe('100');
    expect(schedule.layouts).toHaveLength(1);
    expect(schedule.layouts[0].file).toBe('200');
    expect(schedule.layouts[0].priority).toBe(5);
    expect(schedule.campaigns).toHaveLength(1);
    expect(schedule.campaigns[0].layouts).toHaveLength(2);
    expect(schedule.campaigns[0].layouts[0].file).toBe('300');
  });

  it('should use ETag caching for schedule', async () => {
    const xml = '<schedule><default file="1" /></schedule>';

    mockFetch.mockResolvedValue(xmlResponse(xml, { etag: '"s1"' }));
    const first = await client.schedule();

    // 304 — return cached
    mockFetch.mockResolvedValue(notModifiedResponse());
    const second = await client.schedule();

    expect(second.default).toBe(first.default);
  });

  it('should parse overlays', async () => {
    const xml = `<schedule>
      <default file="1"/>
      <overlays>
        <overlay file="50" duration="30" fromdt="2026-01-01" todt="2026-12-31" priority="10" scheduleid="5" />
      </overlays>
    </schedule>`;

    mockFetch.mockResolvedValue(xmlResponse(xml));

    const schedule = await client.schedule();
    expect(schedule.overlays).toHaveLength(1);
    expect(schedule.overlays[0].file).toBe('50');
    expect(schedule.overlays[0].duration).toBe(30);
    expect(schedule.overlays[0].priority).toBe(10);
  });
});

// ─── GetResource ─────────────────────────────────────────────────────

describe('RestClient - GetResource', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = createRestClient();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should GET /resource with layout/region/media params', async () => {
    mockFetch.mockResolvedValue(htmlResponse('<html><body>Widget HTML</body></html>'));

    const html = await client.getResource(10, 20, 30);

    expect(html).toContain('Widget HTML');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('layoutId')).toBe('10');
    expect(url.searchParams.get('regionId')).toBe('20');
    expect(url.searchParams.get('mediaId')).toBe('30');
  });

  it('should return raw HTML string', async () => {
    const widgetHtml = '<div style="color:red">Hello World</div>';
    mockFetch.mockResolvedValue(htmlResponse(widgetHtml));

    const result = await client.getResource(1, 2, 3);
    expect(result).toBe(widgetHtml);
  });
});

// ─── NotifyStatus ────────────────────────────────────────────────────

describe('RestClient - NotifyStatus', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = createRestClient();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should PUT to /status with JSON statusData', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));

    const status = { currentLayoutId: '5', timeZone: 'Europe/Madrid' };
    await client.notifyStatus(status);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe('PUT');
    expect(new URL(url).pathname).toContain('/pwa/status');

    const body = JSON.parse(opts.body);
    expect(body.statusData.currentLayoutId).toBe('5');
  });

  it('should return success response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));

    const result = await client.notifyStatus({ currentLayoutId: '1', timeZone: 'UTC' });
    expect(result.success).toBe(true);
  });
});

// ─── SubmitLog ───────────────────────────────────────────────────────

describe('RestClient - SubmitLog', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = createRestClient();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should POST to /log with logXml', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));

    const result = await client.submitLog('<logs><log date="2026-01-01" /></logs>');

    expect(result).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.logXml).toContain('<logs>');
  });

  it('should return false when server responds with success: false', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: false }));

    const result = await client.submitLog('<logs/>');
    expect(result).toBe(false);
  });

  it('should throw on HTTP error', async () => {
    mockFetch.mockResolvedValue(errorResponse(500, 'Server Error'));

    await expect(client.submitLog('<logs/>')).rejects.toThrow('REST POST /log failed: 500');
  });
});

// ─── SubmitStats ─────────────────────────────────────────────────────

describe('RestClient - SubmitStats', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = createRestClient();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should POST to /stats with statXml', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));

    const result = await client.submitStats('<stats><stat type="layout" /></stats>');

    expect(result).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.statXml).toContain('<stats>');
  });

  it('should return false on failure', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: false }));

    const result = await client.submitStats('<stats/>');
    expect(result).toBe(false);
  });

  it('should throw on HTTP error', async () => {
    mockFetch.mockResolvedValue(errorResponse(500, 'Error'));

    await expect(client.submitStats('<stats/>')).rejects.toThrow('REST POST /stats failed: 500');
  });
});

// ─── SubmitScreenShot ────────────────────────────────────────────────

describe('RestClient - SubmitScreenShot', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = createRestClient();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should POST to /screenshot with base64 image', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));

    const result = await client.submitScreenShot('iVBORw0KGgo...');

    expect(result).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.screenshot).toBe('iVBORw0KGgo...');
  });

  it('should return false on failure', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: false }));

    const result = await client.submitScreenShot('data');
    expect(result).toBe(false);
  });
});

// ─── MediaInventory ──────────────────────────────────────────────────

describe('RestClient - MediaInventory', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    client = createRestClient();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should POST to /mediaInventory with inventory XML', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));

    await client.mediaInventory('<files><file type="media" id="1" complete="1"/></files>');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.inventory).toContain('<files>');
  });
});

// ─── BlackList (always SOAP) ─────────────────────────────────────────

describe('RestClient - BlackList', () => {
  it('should return false since REST has no BlackList endpoint', async () => {
    const client = createRestClient();
    const result = await client.blackList('42', 'media', 'Broken');
    expect(result).toBe(false);
  });
});

// ─── Transport Parity ────────────────────────────────────────────────

describe('Transport Parity', () => {
  it('SOAP and REST clients should expose identical public methods', () => {
    const soap = new XmdsClient({
      cmsAddress: 'https://cms.example.com',
      cmsKey: 'k', hardwareKey: 'h',
    });
    const rest = createRestClient();

    const publicMethods = [
      'registerDisplay', 'requiredFiles', 'schedule', 'getResource',
      'notifyStatus', 'mediaInventory', 'blackList', 'submitLog',
      'submitScreenShot', 'submitStats',
    ];

    for (const method of publicMethods) {
      expect(typeof soap[method]).toBe('function');
      expect(typeof rest[method]).toBe('function');
    }
  });
});
