/**
 * Unit tests for CmsApiClient
 *
 * Tests OAuth2 authentication, token management, generic request handling,
 * and all CRUD methods (layout, region, widget, media, campaign, schedule,
 * display group, resolution). Uses mocked fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CmsApiClient } from './cms-api.js';

// Suppress logger output during tests
vi.mock('./logger.js', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  })
}));

describe('CmsApiClient', () => {
  let api;
  let mockFetch;

  const CMS_URL = 'https://cms.example.com';
  const CLIENT_ID = 'test-client';
  const CLIENT_SECRET = 'test-secret';

  /** Helper: create a mock JSON response */
  function jsonResponse(data, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data))
    };
  }

  /** Helper: create a mock empty response (204) */
  function emptyResponse(status = 204) {
    return {
      ok: true,
      status,
      headers: new Headers({}),
      text: () => Promise.resolve('')
    };
  }

  /** Helper: create a mock error response */
  function errorResponse(status, message) {
    return {
      ok: false,
      status,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () => Promise.resolve({ message }),
      text: () => Promise.resolve(JSON.stringify({ message }))
    };
  }

  /** Helper: stub authentication so request() doesn't re-auth */
  function stubAuth() {
    api.accessToken = 'test-token';
    api.tokenExpiry = Date.now() + 3600000; // 1 hour from now
  }

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    api = new CmsApiClient({
      baseUrl: CMS_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constructor ──

  describe('constructor', () => {
    it('should strip trailing slashes from baseUrl', () => {
      const a = new CmsApiClient({ baseUrl: 'https://cms.test.com///', clientId: 'x', clientSecret: 'y' });
      expect(a.baseUrl).toBe('https://cms.test.com');
    });

    it('should initialize with null token', () => {
      expect(api.accessToken).toBeNull();
      expect(api.tokenExpiry).toBe(0);
    });
  });

  // ── OAuth2 Authentication ──

  describe('authenticate()', () => {
    it('should POST client_credentials and store token', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        access_token: 'abc123',
        expires_in: 3600,
        token_type: 'Bearer'
      }));

      const token = await api.authenticate();

      expect(token).toBe('abc123');
      expect(api.accessToken).toBe('abc123');
      expect(api.tokenExpiry).toBeGreaterThan(Date.now());

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${CMS_URL}/api/authorize/access_token`);
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(opts.body.get('grant_type')).toBe('client_credentials');
      expect(opts.body.get('client_id')).toBe(CLIENT_ID);
      expect(opts.body.get('client_secret')).toBe(CLIENT_SECRET);
    });

    it('should throw on auth failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Invalid credentials')
      });

      await expect(api.authenticate()).rejects.toThrow('OAuth2 authentication failed (401)');
    });

    it('should default to 3600s expiry if not provided', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ access_token: 'tok' }));

      await api.authenticate();

      // Token should expire roughly 3600s from now
      const expectedExpiry = Date.now() + 3600 * 1000;
      expect(api.tokenExpiry).toBeGreaterThan(expectedExpiry - 5000);
      expect(api.tokenExpiry).toBeLessThan(expectedExpiry + 5000);
    });
  });

  // ── Token Management ──

  describe('ensureToken()', () => {
    it('should authenticate if no token exists', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ access_token: 'new-token', expires_in: 3600 }));

      await api.ensureToken();

      expect(api.accessToken).toBe('new-token');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should skip authentication if token is still valid', async () => {
      stubAuth();

      await api.ensureToken();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should re-authenticate if token expires within 60 seconds', async () => {
      api.accessToken = 'old-token';
      api.tokenExpiry = Date.now() + 30000; // 30s left (< 60s threshold)

      mockFetch.mockResolvedValue(jsonResponse({ access_token: 'refreshed', expires_in: 3600 }));

      await api.ensureToken();

      expect(api.accessToken).toBe('refreshed');
    });
  });

  // ── Generic Request ──

  describe('request()', () => {
    beforeEach(() => stubAuth());

    it('should make GET with query params', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ id: 1 }]));

      const result = await api.request('GET', '/display', { hardwareKey: 'abc', limit: 10 });

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/api/display');
      expect(url.searchParams.get('hardwareKey')).toBe('abc');
      expect(url.searchParams.get('limit')).toBe('10');
      expect(result).toEqual([{ id: 1 }]);
    });

    it('should skip null/undefined query params', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));

      await api.request('GET', '/display', { name: 'test', extra: null, undef: undefined });

      const [url] = mockFetch.mock.calls[0];
      expect(url.searchParams.has('name')).toBe(true);
      expect(url.searchParams.has('extra')).toBe(false);
      expect(url.searchParams.has('undef')).toBe(false);
    });

    it('should make POST with form-urlencoded body', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ layoutId: 42 }));

      await api.request('POST', '/layout', { name: 'Test', resolutionId: 9 });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(opts.body.get('name')).toBe('Test');
      expect(opts.body.get('resolutionId')).toBe('9');
    });

    it('should make PUT with form-urlencoded body', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.request('PUT', '/display/1', { display: 'Updated' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('PUT');
      expect(opts.body.get('display')).toBe('Updated');
    });

    it('should make DELETE request', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.request('DELETE', '/layout/42');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/api/layout/42');
      expect(opts.method).toBe('DELETE');
    });

    it('should return null for non-JSON responses', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      const result = await api.request('PUT', '/display/authorise/1');

      expect(result).toBeNull();
    });

    it('should throw with parsed error message on failure', async () => {
      mockFetch.mockResolvedValue(errorResponse(422, 'Validation failed'));

      await expect(api.request('POST', '/layout', {})).rejects.toThrow('Validation failed');
    });

    it('should throw with raw text if error is not JSON', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers({}),
        text: () => Promise.resolve('Internal Server Error')
      });

      await expect(api.request('GET', '/fail')).rejects.toThrow('Internal Server Error');
    });

    it('should include Authorization header', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));

      await api.request('GET', '/display');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer test-token');
    });
  });

  // ── Multipart Request ──

  describe('requestMultipart()', () => {
    beforeEach(() => stubAuth());

    it('should send FormData without Content-Type header', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ mediaId: 99 }));

      const formData = new FormData();
      formData.append('name', 'test.jpg');

      await api.requestMultipart('POST', '/library', formData);

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body).toBe(formData);
      // Should NOT have Content-Type — browser adds multipart boundary
      expect(opts.headers['Content-Type']).toBeUndefined();
      expect(opts.headers.Authorization).toBe('Bearer test-token');
    });

    it('should throw on error', async () => {
      mockFetch.mockResolvedValue(errorResponse(413, 'File too large'));

      await expect(api.requestMultipart('POST', '/library', new FormData()))
        .rejects.toThrow('File too large');
    });
  });

  // ── Display Management ──

  describe('Display Management', () => {
    beforeEach(() => stubAuth());

    it('findDisplay() should return display object', async () => {
      mockFetch.mockResolvedValue(jsonResponse([
        { displayId: 1, display: 'Test Display', licensed: 1 }
      ]));

      const display = await api.findDisplay('pwa-abc123');

      expect(display.displayId).toBe(1);
      expect(display.display).toBe('Test Display');
    });

    it('findDisplay() should return null when not found', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));

      const display = await api.findDisplay('nonexistent');

      expect(display).toBeNull();
    });

    it('authorizeDisplay() should PUT to correct path', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.authorizeDisplay(42);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/display/authorise/42');
      expect(opts.method).toBe('PUT');
    });

    it('editDisplay() should PUT properties', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ displayId: 1, display: 'Updated' }));

      const result = await api.editDisplay(1, { display: 'Updated', defaultLayoutId: 5 });

      expect(result.display).toBe('Updated');
    });

    it('listDisplays() should return array', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ displayId: 1 }, { displayId: 2 }]));

      const displays = await api.listDisplays();

      expect(displays).toHaveLength(2);
    });

    it('requestScreenshot() should PUT', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.requestScreenshot(5);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/display/requestscreenshot/5');
      expect(opts.method).toBe('PUT');
    });

    it('getDisplayStatus() should GET', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 1 }));

      const status = await api.getDisplayStatus(5);

      expect(status.status).toBe(1);
    });
  });

  // ── Layout Management ──

  describe('Layout Management', () => {
    beforeEach(() => stubAuth());

    it('createLayout() should POST with name and resolutionId', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ layoutId: 10 }));

      const layout = await api.createLayout({ name: 'Test Layout', resolutionId: 9 });

      expect(layout.layoutId).toBe(10);
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body.get('name')).toBe('Test Layout');
      expect(opts.body.get('resolutionId')).toBe('9');
    });

    it('createLayout() should include description if provided', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ layoutId: 11 }));

      await api.createLayout({ name: 'Test', resolutionId: 9, description: 'A test layout' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body.get('description')).toBe('A test layout');
    });

    it('listLayouts() should GET with filters', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ layoutId: 1 }]));

      const layouts = await api.listLayouts({ layout: 'Test' });

      const [url] = mockFetch.mock.calls[0];
      expect(url.searchParams.get('layout')).toBe('Test');
      expect(layouts).toHaveLength(1);
    });

    it('getLayout() should GET single layout', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ layoutId: 10, layout: 'My Layout' }));

      const layout = await api.getLayout(10);

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/layout/10');
      expect(layout.layout).toBe('My Layout');
    });

    it('deleteLayout() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteLayout(10);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/layout/10');
      expect(opts.method).toBe('DELETE');
    });

    it('publishLayout() should PUT to /layout/publish/{id}', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.publishLayout(10);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/layout/publish/10');
      expect(opts.method).toBe('PUT');
    });

    it('checkoutLayout() should PUT to /layout/checkout/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ layoutId: 20 }));

      const draft = await api.checkoutLayout(10);

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/layout/checkout/10');
      expect(draft.layoutId).toBe(20);
    });

    it('editLayoutBackground() should PUT background params', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ layoutId: 10 }));

      await api.editLayoutBackground(10, { backgroundColor: '#FF0000', backgroundImageId: 5 });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/layout/background/10');
      expect(opts.body.get('backgroundColor')).toBe('#FF0000');
    });
  });

  // ── Region Management ──

  describe('Region Management', () => {
    beforeEach(() => stubAuth());

    it('addRegion() should POST to /region/{layoutId}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        regionId: 5,
        playlists: [{ playlistId: 100 }]
      }));

      const region = await api.addRegion(10, { width: 1920, height: 1080, top: 0, left: 0 });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/region/10');
      expect(opts.method).toBe('POST');
      expect(opts.body.get('width')).toBe('1920');
      expect(region.playlists[0].playlistId).toBe(100);
    });

    it('editRegion() should PUT', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ regionId: 5 }));

      await api.editRegion(5, { width: 960, height: 540 });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/region/5');
      expect(opts.method).toBe('PUT');
    });

    it('deleteRegion() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteRegion(5);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/region/5');
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── Widget Management ──

  describe('Widget Management', () => {
    beforeEach(() => stubAuth());

    it('addWidget() should POST to /playlist/widget/{type}/{playlistId}', async () => {
      // addWidget() is a two-step process:
      // Step 1: POST creates the widget shell (only templateId/displayOrder)
      // Step 2: PUT sets all widget properties (text, duration, etc.)
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ widgetId: 77 }))   // POST create
        .mockResolvedValueOnce(jsonResponse({ widgetId: 77 }));   // PUT edit

      const widget = await api.addWidget('text', 100, { text: 'Hello', duration: 10 });

      // First call: POST to create the widget
      const [url1, opts1] = mockFetch.mock.calls[0];
      expect(url1.toString()).toContain('/playlist/widget/text/100');
      expect(opts1.method).toBe('POST');

      // Second call: PUT to set properties (text, duration, useDuration)
      const [url2, opts2] = mockFetch.mock.calls[1];
      expect(url2.toString()).toContain('/playlist/widget/77');
      expect(opts2.method).toBe('PUT');
      expect(opts2.body.get('text')).toBe('Hello');
      expect(opts2.body.get('duration')).toBe('10');
      expect(widget.widgetId).toBe(77);
    });

    it('editWidget() should PUT to /playlist/widget/{widgetId}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ widgetId: 77 }));

      await api.editWidget(77, { text: 'Updated' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/playlist/widget/77');
      expect(opts.method).toBe('PUT');
    });

    it('deleteWidget() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteWidget(77);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/playlist/widget/77');
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── Media / Library ──

  describe('Media / Library', () => {
    beforeEach(() => stubAuth());

    it('uploadMedia() should use requestMultipart', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ mediaId: 50 }));

      const formData = new FormData();
      formData.append('files', new Blob(['test']), 'test.jpg');

      const result = await api.uploadMedia(formData);

      expect(result.mediaId).toBe(50);
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body).toBe(formData);
    });

    it('listMedia() should GET with filters', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ mediaId: 1 }, { mediaId: 2 }]));

      const media = await api.listMedia({ type: 'image' });

      const [url] = mockFetch.mock.calls[0];
      expect(url.searchParams.get('type')).toBe('image');
      expect(media).toHaveLength(2);
    });

    it('getMedia() should GET single media', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ mediaId: 50, name: 'test.jpg' }));

      const media = await api.getMedia(50);

      expect(media.name).toBe('test.jpg');
    });

    it('deleteMedia() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteMedia(50);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/library/50');
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── Campaign Management ──

  describe('Campaign Management', () => {
    beforeEach(() => stubAuth());

    it('createCampaign() should POST with name', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ campaignId: 20 }));

      const campaign = await api.createCampaign('Test Campaign');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body.get('name')).toBe('Test Campaign');
      expect(campaign.campaignId).toBe(20);
    });

    it('listCampaigns() should GET', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ campaignId: 1 }]));

      const campaigns = await api.listCampaigns();

      expect(campaigns).toHaveLength(1);
    });

    it('deleteCampaign() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteCampaign(20);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/campaign/20');
      expect(opts.method).toBe('DELETE');
    });

    it('assignLayoutToCampaign() should POST with layoutId', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.assignLayoutToCampaign(20, 10);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/campaign/layout/assign/20');
      expect(opts.body.get('layoutId')).toBe('10');
    });

    it('assignLayoutToCampaign() should include displayOrder if provided', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.assignLayoutToCampaign(20, 10, 3);

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body.get('displayOrder')).toBe('3');
    });
  });

  // ── Schedule Management ──

  describe('Schedule Management', () => {
    beforeEach(() => stubAuth());

    it('createSchedule() should POST with displayGroupIds as array params', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ eventId: 99 }));

      await api.createSchedule({
        eventTypeId: 1,
        campaignId: 20,
        displayGroupIds: [1, 2],
        fromDt: '2026-01-01 00:00:00',
        toDt: '2026-12-31 23:59:59',
        isPriority: 0
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${CMS_URL}/api/schedule`);
      expect(opts.method).toBe('POST');

      // Verify array params are sent as displayGroupIds[]
      const body = opts.body;
      expect(body.getAll('displayGroupIds[]')).toEqual(['1', '2']);
      expect(body.get('eventTypeId')).toBe('1');
      expect(body.get('campaignId')).toBe('20');
    });

    it('deleteSchedule() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteSchedule(99);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/schedule/99');
      expect(opts.method).toBe('DELETE');
    });

    it('listSchedules() should GET events', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ events: [{ eventId: 1 }] }));

      const schedules = await api.listSchedules();

      expect(schedules).toEqual([{ eventId: 1 }]);
    });

    it('listSchedules() should handle direct array response', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ eventId: 1 }]));

      const schedules = await api.listSchedules();

      expect(schedules).toEqual([{ eventId: 1 }]);
    });
  });

  // ── Display Group Management ──

  describe('Display Group Management', () => {
    beforeEach(() => stubAuth());

    it('listDisplayGroups() should GET', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ displayGroupId: 1, displayGroup: 'Group 1' }]));

      const groups = await api.listDisplayGroups();

      expect(groups).toHaveLength(1);
      expect(groups[0].displayGroup).toBe('Group 1');
    });

    it('createDisplayGroup() should POST with displayGroup param', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ displayGroupId: 5 }));

      const group = await api.createDisplayGroup('Test Group', 'A test group');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body.get('displayGroup')).toBe('Test Group');
      expect(opts.body.get('description')).toBe('A test group');
      expect(group.displayGroupId).toBe(5);
    });

    it('deleteDisplayGroup() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteDisplayGroup(5);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/displaygroup/5');
      expect(opts.method).toBe('DELETE');
    });

    it('assignDisplayToGroup() should POST displayId[] param', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, headers: new Headers({}) });

      await api.assignDisplayToGroup(5, 42);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${CMS_URL}/api/displaygroup/5/display/assign`);
      expect(opts.method).toBe('POST');
      expect(opts.body.getAll('displayId[]')).toEqual(['42']);
    });

    it('assignDisplayToGroup() should throw on error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers({}),
        text: () => Promise.resolve('Not found')
      });

      await expect(api.assignDisplayToGroup(5, 42))
        .rejects.toThrow('assign display to group failed (404)');
    });

    it('unassignDisplayFromGroup() should POST displayId[] param to unassign path', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, headers: new Headers({}) });

      await api.unassignDisplayFromGroup(5, 42);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${CMS_URL}/api/displaygroup/5/display/unassign`);
      expect(opts.body.getAll('displayId[]')).toEqual(['42']);
    });
  });

  // ── Resolution Management ──

  describe('Resolution Management', () => {
    beforeEach(() => stubAuth());

    it('listResolutions() should GET', async () => {
      mockFetch.mockResolvedValue(jsonResponse([
        { resolutionId: 9, resolution: '1080p HD', width: 1920, height: 1080 }
      ]));

      const resolutions = await api.listResolutions();

      expect(resolutions).toHaveLength(1);
      expect(resolutions[0].width).toBe(1920);
    });
  });

  // ── Layout Copy / Discard (#25) ──

  describe('Layout Copy / Discard', () => {
    beforeEach(() => stubAuth());

    it('copyLayout() should POST to /layout/copy/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ layoutId: 99 }));

      const result = await api.copyLayout(10, { name: 'Copy of Layout' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/layout/copy/10');
      expect(opts.method).toBe('POST');
      expect(opts.body.get('name')).toBe('Copy of Layout');
      expect(result.layoutId).toBe(99);
    });

    it('discardLayout() should PUT to /layout/discard/{id}', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.discardLayout(10);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/layout/discard/10');
      expect(opts.method).toBe('PUT');
    });
  });

  // ── Campaign Edit / Unassign (#26) ──

  describe('Campaign Edit / Unassign', () => {
    beforeEach(() => stubAuth());

    it('editCampaign() should PUT to /campaign/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ campaignId: 20 }));

      const result = await api.editCampaign(20, { name: 'Updated Campaign' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/campaign/20');
      expect(opts.method).toBe('PUT');
      expect(opts.body.get('name')).toBe('Updated Campaign');
      expect(result.campaignId).toBe(20);
    });

    it('getCampaign() should GET /campaign/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ campaignId: 20, name: 'My Campaign' }));

      const result = await api.getCampaign(20);

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/campaign/20');
      expect(result.name).toBe('My Campaign');
    });

    it('unassignLayoutFromCampaign() should POST with layoutId', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.unassignLayoutFromCampaign(20, 10);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/campaign/layout/unassign/20');
      expect(opts.method).toBe('POST');
      expect(opts.body.get('layoutId')).toBe('10');
    });
  });

  // ── Schedule Edit (#27) ──

  describe('Schedule Edit', () => {
    beforeEach(() => stubAuth());

    it('editSchedule() should PUT to /schedule/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ eventId: 99 }));

      const result = await api.editSchedule(99, { isPriority: 1 });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/schedule/99');
      expect(opts.method).toBe('PUT');
      expect(opts.body.get('isPriority')).toBe('1');
      expect(result.eventId).toBe(99);
    });
  });

  // ── Layout Retire / Status / Tag (#34) ──

  describe('Layout Retire / Status / Tag', () => {
    beforeEach(() => stubAuth());

    it('retireLayout() should PUT to /layout/retire/{id}', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.retireLayout(10);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/layout/retire/10');
      expect(opts.method).toBe('PUT');
    });

    it('unretireLayout() should PUT to /layout/unretire/{id}', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.unretireLayout(10);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/layout/unretire/10');
      expect(opts.method).toBe('PUT');
    });

    it('getLayoutStatus() should GET /layout/status/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: 3, description: 'Valid' }));

      const result = await api.getLayoutStatus(10);

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/layout/status/10');
      expect(result.status).toBe(3);
    });

    it('tagLayout() should POST comma-separated tags', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.tagLayout(10, ['lobby', 'hd']);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/layout/10/tag');
      expect(opts.method).toBe('POST');
      expect(opts.body.get('tag')).toBe('lobby,hd');
    });

    it('untagLayout() should POST comma-separated tags to untag', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.untagLayout(10, ['old']);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/layout/10/untag');
      expect(opts.body.get('tag')).toBe('old');
    });
  });

  // ── Command CRUD (#36) ──

  describe('Command CRUD', () => {
    beforeEach(() => stubAuth());

    it('listCommands() should GET and return array', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ commandId: 1, command: 'reboot' }]));

      const cmds = await api.listCommands();

      expect(cmds).toHaveLength(1);
      expect(cmds[0].command).toBe('reboot');
    });

    it('createCommand() should POST', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ commandId: 2 }));

      const result = await api.createCommand({ command: 'reboot', code: 'sudo reboot' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body.get('command')).toBe('reboot');
      expect(result.commandId).toBe(2);
    });

    it('editCommand() should PUT to /command/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ commandId: 2 }));

      await api.editCommand(2, { description: 'Updated' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/command/2');
      expect(opts.method).toBe('PUT');
    });

    it('deleteCommand() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteCommand(2);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/command/2');
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── Display Extras (#41) ──

  describe('Display Extras', () => {
    beforeEach(() => stubAuth());

    it('deleteDisplay() should DELETE /display/{id}', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteDisplay(42);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/display/42');
      expect(opts.method).toBe('DELETE');
    });

    it('wolDisplay() should POST to /display/wol/{id}', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.wolDisplay(42);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/display/wol/42');
      expect(opts.method).toBe('POST');
    });

    it('setDefaultLayout() should PUT defaultLayoutId', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ displayId: 42 }));

      await api.setDefaultLayout(42, 10);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/display/42');
      expect(opts.method).toBe('PUT');
      expect(opts.body.get('defaultLayoutId')).toBe('10');
    });

    it('purgeDisplay() should POST to /display/purge/{id}', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.purgeDisplay(42);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/display/purge/42');
      expect(opts.method).toBe('POST');
    });
  });

  // ── Token Auto-Refresh Integration ──

  describe('Token auto-refresh', () => {
    it('should auto-authenticate on first request', async () => {
      // First call = authenticate, second call = actual request
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ access_token: 'auto-token', expires_in: 3600 }))
        .mockResolvedValueOnce(jsonResponse([]));

      await api.listDisplays();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // First call should be auth
      expect(mockFetch.mock.calls[0][0]).toContain('/authorize/access_token');
      // Second call should be the actual API request
      expect(mockFetch.mock.calls[1][0].toString()).toContain('/display');
    });
  });
});
