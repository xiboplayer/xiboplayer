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

  // ── DayPart CRUD (#24) ──

  describe('DayPart CRUD', () => {
    beforeEach(() => stubAuth());

    it('listDayParts() should GET and return array', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ dayPartId: 1, name: 'Business Hours' }]));

      const parts = await api.listDayParts();

      expect(parts).toHaveLength(1);
      expect(parts[0].name).toBe('Business Hours');
    });

    it('createDayPart() should POST', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ dayPartId: 2 }));

      const result = await api.createDayPart({ name: 'Evening', startTime: '18:00', endTime: '22:00' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body.get('name')).toBe('Evening');
      expect(result.dayPartId).toBe(2);
    });

    it('editDayPart() should PUT to /daypart/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ dayPartId: 2 }));

      await api.editDayPart(2, { name: 'Updated Evening' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/daypart/2');
      expect(opts.method).toBe('PUT');
    });

    it('deleteDayPart() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteDayPart(2);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/daypart/2');
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── Library Extensions (#33) ──

  describe('Library Extensions', () => {
    beforeEach(() => stubAuth());

    it('uploadMediaUrl() should POST with url and name', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ mediaId: 60 }));

      const result = await api.uploadMediaUrl('https://example.com/image.jpg', 'Test Image');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body.get('url')).toBe('https://example.com/image.jpg');
      expect(opts.body.get('name')).toBe('Test Image');
      expect(result.mediaId).toBe(60);
    });

    it('copyMedia() should POST to /library/copy/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ mediaId: 61 }));

      const result = await api.copyMedia(50);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/library/copy/50');
      expect(opts.method).toBe('POST');
      expect(result.mediaId).toBe(61);
    });

    it('downloadMedia() should GET raw response', async () => {
      const mockResponse = { ok: true, status: 200, text: () => Promise.resolve('binary data') };
      mockFetch.mockResolvedValue(mockResponse);

      const response = await api.downloadMedia(50);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/library/download/50');
      expect(response).toBe(mockResponse);
    });

    it('downloadMedia() should throw on error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found')
      });

      await expect(api.downloadMedia(999)).rejects.toThrow('404');
    });

    it('editMedia() should PUT to /library/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ mediaId: 50 }));

      await api.editMedia(50, { name: 'Renamed' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/library/50');
      expect(opts.method).toBe('PUT');
      expect(opts.body.get('name')).toBe('Renamed');
    });

    it('getMediaUsage() should GET /library/usage/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ layouts: [1, 2] }));

      const result = await api.getMediaUsage(50);

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/library/usage/50');
      expect(result.layouts).toEqual([1, 2]);
    });

    it('tidyLibrary() should POST to /library/tidy', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.tidyLibrary();

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/library/tidy');
      expect(opts.method).toBe('POST');
    });
  });

  // ── Playlist CRUD (#35) ──

  describe('Playlist CRUD', () => {
    beforeEach(() => stubAuth());

    it('listPlaylists() should GET and return array', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ playlistId: 1, name: 'Default' }]));

      const playlists = await api.listPlaylists();

      expect(playlists).toHaveLength(1);
    });

    it('createPlaylist() should POST with name', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ playlistId: 10 }));

      const result = await api.createPlaylist('My Playlist');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body.get('name')).toBe('My Playlist');
      expect(result.playlistId).toBe(10);
    });

    it('getPlaylist() should GET /playlist/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ playlistId: 10, name: 'My Playlist' }));

      const result = await api.getPlaylist(10);

      expect(result.name).toBe('My Playlist');
    });

    it('editPlaylist() should PUT', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ playlistId: 10 }));

      await api.editPlaylist(10, { name: 'Renamed' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/playlist/10');
      expect(opts.method).toBe('PUT');
    });

    it('deletePlaylist() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deletePlaylist(10);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/playlist/10');
      expect(opts.method).toBe('DELETE');
    });

    it('reorderPlaylist() should POST widgets[] array params', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, headers: new Headers({}) });

      await api.reorderPlaylist(10, [3, 1, 2]);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/playlist/order/10');
      expect(opts.method).toBe('POST');
      expect(opts.body.getAll('widgets[]')).toEqual(['3', '1', '2']);
    });

    it('reorderPlaylist() should throw on error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        text: () => Promise.resolve('Invalid order')
      });

      await expect(api.reorderPlaylist(10, [1])).rejects.toThrow('422');
    });

    it('copyPlaylist() should POST to /playlist/copy/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ playlistId: 11 }));

      const result = await api.copyPlaylist(10);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/playlist/copy/10');
      expect(opts.method).toBe('POST');
      expect(result.playlistId).toBe(11);
    });
  });

  // ── Widget Extras (#37) ──

  describe('Widget Extras', () => {
    beforeEach(() => stubAuth());

    it('setWidgetTransition() should PUT type and config', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ widgetId: 77 }));

      await api.setWidgetTransition(77, 'fade', { duration: 1000 });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/playlist/widget/transition/77');
      expect(opts.method).toBe('PUT');
      expect(opts.body.get('type')).toBe('fade');
      expect(opts.body.get('duration')).toBe('1000');
    });

    it('setWidgetAudio() should PUT to /playlist/widget/{id}/audio', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ widgetId: 77 }));

      await api.setWidgetAudio(77, { mediaId: 50, volume: 80 });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/playlist/widget/77/audio');
      expect(opts.method).toBe('PUT');
      expect(opts.body.get('mediaId')).toBe('50');
    });

    it('removeWidgetAudio() should DELETE /playlist/widget/{id}/audio', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.removeWidgetAudio(77);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/playlist/widget/77/audio');
      expect(opts.method).toBe('DELETE');
    });

    it('setWidgetExpiry() should PUT to /playlist/widget/{id}/expiry', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ widgetId: 77 }));

      await api.setWidgetExpiry(77, { fromDt: '2026-01-01', toDt: '2026-12-31' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/playlist/widget/77/expiry');
      expect(opts.method).toBe('PUT');
      expect(opts.body.get('fromDt')).toBe('2026-01-01');
    });
  });

  // ── Template Save / Manage (#39) ──

  describe('Template Save / Manage', () => {
    beforeEach(() => stubAuth());

    it('saveAsTemplate() should POST to /template/{layoutId}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ templateId: 5 }));

      const result = await api.saveAsTemplate(10, { name: 'My Template', includeWidgets: 1 });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/template/10');
      expect(opts.method).toBe('POST');
      expect(opts.body.get('name')).toBe('My Template');
      expect(result.templateId).toBe(5);
    });

    it('getTemplate() should GET /template/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ templateId: 5, layout: 'My Template' }));

      const result = await api.getTemplate(5);

      expect(result.layout).toBe('My Template');
    });

    it('deleteTemplate() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteTemplate(5);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/template/5');
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── Dataset CRUD (#28) ──

  describe('Dataset CRUD', () => {
    beforeEach(() => stubAuth());

    it('listDatasets() should GET and return array', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ dataSetId: 1, dataSet: 'Sales' }]));

      const datasets = await api.listDatasets();

      expect(datasets).toHaveLength(1);
      expect(datasets[0].dataSet).toBe('Sales');
    });

    it('createDataset() should POST', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ dataSetId: 2 }));

      const result = await api.createDataset({ dataSet: 'Inventory', description: 'Stock levels' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body.get('dataSet')).toBe('Inventory');
      expect(result.dataSetId).toBe(2);
    });

    it('editDataset() should PUT to /dataset/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ dataSetId: 2 }));

      await api.editDataset(2, { description: 'Updated' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/dataset/2');
      expect(opts.method).toBe('PUT');
    });

    it('deleteDataset() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteDataset(2);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/dataset/2');
      expect(opts.method).toBe('DELETE');
    });

    it('listDatasetColumns() should GET /dataset/{id}/column', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ dataSetColumnId: 1, heading: 'Name' }]));

      const cols = await api.listDatasetColumns(2);

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/dataset/2/column');
      expect(cols).toHaveLength(1);
    });

    it('createDatasetColumn() should POST', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ dataSetColumnId: 3 }));

      const result = await api.createDatasetColumn(2, { heading: 'Price', dataTypeId: 2 });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/dataset/2/column');
      expect(opts.method).toBe('POST');
      expect(opts.body.get('heading')).toBe('Price');
      expect(result.dataSetColumnId).toBe(3);
    });

    it('editDatasetColumn() should PUT to /dataset/{id}/column/{colId}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ dataSetColumnId: 3 }));

      await api.editDatasetColumn(2, 3, { heading: 'Unit Price' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/dataset/2/column/3');
      expect(opts.method).toBe('PUT');
    });

    it('deleteDatasetColumn() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteDatasetColumn(2, 3);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/dataset/2/column/3');
      expect(opts.method).toBe('DELETE');
    });

    it('listDatasetData() should GET /dataset/data/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ id: 1, Name: 'Widget A' }]));

      const rows = await api.listDatasetData(2);

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/dataset/data/2');
      expect(rows).toHaveLength(1);
    });

    it('addDatasetRow() should POST to /dataset/data/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 5 }));

      const result = await api.addDatasetRow(2, { Name: 'Widget B', Price: '9.99' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/dataset/data/2');
      expect(opts.method).toBe('POST');
      expect(opts.body.get('Name')).toBe('Widget B');
      expect(result.id).toBe(5);
    });

    it('editDatasetRow() should PUT to /dataset/data/{id}/{rowId}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 5 }));

      await api.editDatasetRow(2, 5, { Price: '12.99' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/dataset/data/2/5');
      expect(opts.method).toBe('PUT');
    });

    it('deleteDatasetRow() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteDatasetRow(2, 5);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/dataset/data/2/5');
      expect(opts.method).toBe('DELETE');
    });

    it('importDatasetCsv() should use requestMultipart', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ imported: 10 }));

      const formData = new FormData();
      formData.append('file', new Blob(['a,b\n1,2']), 'data.csv');

      const result = await api.importDatasetCsv(2, formData);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/dataset/import/2');
      expect(opts.body).toBe(formData);
      expect(result.imported).toBe(10);
    });

    it('clearDataset() should DELETE /dataset/data/{id}', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.clearDataset(2);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/dataset/data/2');
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── Notification CRUD (#29) ──

  describe('Notification CRUD', () => {
    beforeEach(() => stubAuth());

    it('listNotifications() should GET and return array', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ notificationId: 1, subject: 'Alert' }]));

      const notifs = await api.listNotifications();

      expect(notifs).toHaveLength(1);
      expect(notifs[0].subject).toBe('Alert');
    });

    it('createNotification() should POST', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ notificationId: 2 }));

      const result = await api.createNotification({ subject: 'Emergency', body: 'Evacuate' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body.get('subject')).toBe('Emergency');
      expect(result.notificationId).toBe(2);
    });

    it('editNotification() should PUT', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ notificationId: 2 }));

      await api.editNotification(2, { body: 'Updated' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/notification/2');
      expect(opts.method).toBe('PUT');
    });

    it('deleteNotification() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteNotification(2);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/notification/2');
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── Folder CRUD (#30) ──

  describe('Folder CRUD', () => {
    beforeEach(() => stubAuth());

    it('listFolders() should GET and return array', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ folderId: 1, text: 'Root' }]));

      const folders = await api.listFolders();

      expect(folders).toHaveLength(1);
      expect(folders[0].text).toBe('Root');
    });

    it('createFolder() should POST', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ folderId: 2 }));

      const result = await api.createFolder({ text: 'Marketing', parentId: 1 });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body.get('text')).toBe('Marketing');
      expect(result.folderId).toBe(2);
    });

    it('editFolder() should PUT', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ folderId: 2 }));

      await api.editFolder(2, { text: 'Rebranded' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/folder/2');
      expect(opts.method).toBe('PUT');
    });

    it('deleteFolder() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteFolder(2);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/folder/2');
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── Tag CRUD + Entity Tagging (#31) ──

  describe('Tag CRUD + Entity Tagging', () => {
    beforeEach(() => stubAuth());

    it('listTags() should GET and return array', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ tagId: 1, tag: 'lobby' }]));

      const tags = await api.listTags();

      expect(tags).toHaveLength(1);
      expect(tags[0].tag).toBe('lobby');
    });

    it('createTag() should POST', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ tagId: 2 }));

      const result = await api.createTag({ tag: 'outdoor' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body.get('tag')).toBe('outdoor');
      expect(result.tagId).toBe(2);
    });

    it('editTag() should PUT', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ tagId: 2 }));

      await api.editTag(2, { tag: 'indoor' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/tag/2');
      expect(opts.method).toBe('PUT');
    });

    it('deleteTag() should DELETE', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.deleteTag(2);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/tag/2');
      expect(opts.method).toBe('DELETE');
    });

    it('tagEntity() should POST comma-separated tags to /{entity}/{id}/tag', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.tagEntity('media', 50, ['outdoor', 'hd']);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/media/50/tag');
      expect(opts.method).toBe('POST');
      expect(opts.body.get('tag')).toBe('outdoor,hd');
    });

    it('untagEntity() should POST to /{entity}/{id}/untag', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.untagEntity('campaign', 20, ['old']);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/campaign/20/untag');
      expect(opts.body.get('tag')).toBe('old');
    });
  });

  // ── DisplayGroup Actions (#32) ──

  describe('DisplayGroup Actions', () => {
    beforeEach(() => stubAuth());

    it('dgChangeLayout() should POST layoutId to action/changeLayout', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.dgChangeLayout(5, 10);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/displaygroup/5/action/changeLayout');
      expect(opts.method).toBe('POST');
      expect(opts.body.get('layoutId')).toBe('10');
    });

    it('dgOverlayLayout() should POST to action/overlayLayout', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.dgOverlayLayout(5, 10);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/displaygroup/5/action/overlayLayout');
      expect(opts.body.get('layoutId')).toBe('10');
    });

    it('dgRevertToSchedule() should POST to action/revertToSchedule', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.dgRevertToSchedule(5);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/displaygroup/5/action/revertToSchedule');
      expect(opts.method).toBe('POST');
    });

    it('dgCollectNow() should POST to action/collectNow', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.dgCollectNow(5);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/displaygroup/5/action/collectNow');
      expect(opts.method).toBe('POST');
    });

    it('dgSendCommand() should POST commandId to action/command', async () => {
      mockFetch.mockResolvedValue(emptyResponse());

      await api.dgSendCommand(5, 2);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/displaygroup/5/action/command');
      expect(opts.body.get('commandId')).toBe('2');
    });

    it('editDisplayGroup() should PUT to /displaygroup/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ displayGroupId: 5 }));

      const result = await api.editDisplayGroup(5, { displayGroup: 'Renamed', description: 'New desc' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain('/displaygroup/5');
      expect(opts.method).toBe('PUT');
      expect(opts.body.get('displayGroup')).toBe('Renamed');
      expect(result.displayGroupId).toBe(5);
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
