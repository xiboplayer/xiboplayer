/**
 * CMS API Client — OAuth2-authenticated REST client for Xibo CMS
 *
 * Full CRUD client for all Xibo CMS REST API entities: displays, layouts,
 * regions, widgets, media, campaigns, schedules, display groups, resolutions,
 * commands, dayparts, playlists, datasets, notifications, folders, and tags.
 * Implements OAuth2 client_credentials flow (machine-to-machine).
 *
 * Usage:
 *   const api = new CmsApiClient({ baseUrl: 'https://cms.example.com', clientId, clientSecret });
 *   await api.authenticate();
 *   const layout = await api.createLayout({ name: 'Test', resolutionId: 9 });
 *   const region = await api.addRegion(layout.layoutId, { width: 1920, height: 1080 });
 *   await api.addWidget('text', region.playlists[0].playlistId, { text: 'Hello' });
 *   await api.publishLayout(layout.layoutId);
 */

import { createLogger } from './logger.js';

const log = createLogger('CmsApi');

export class CmsApiClient {
  /**
   * @param {Object} options
   * @param {string} options.baseUrl - CMS base URL (e.g. https://cms.example.com)
   * @param {string} [options.clientId] - OAuth2 application client ID
   * @param {string} [options.clientSecret] - OAuth2 application client secret
   * @param {string} [options.apiToken] - Pre-configured bearer token (skips OAuth2 flow)
   */
  constructor({ baseUrl, clientId, clientSecret, apiToken } = {}) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.clientId = clientId || null;
    this.clientSecret = clientSecret || null;
    this.accessToken = apiToken || null;
    this.tokenExpiry = apiToken ? Infinity : 0;
  }

  // ── OAuth2 Token Management ─────────────────────────────────────

  /**
   * Authenticate using client_credentials grant
   * @returns {Promise<string>} Access token
   */
  async authenticate() {
    log.info('Authenticating with CMS API...');

    const response = await fetch(`${this.baseUrl}/api/authorize/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth2 authentication failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;

    log.info('Authenticated successfully, token expires in', data.expires_in, 's');
    return this.accessToken;
  }

  /**
   * Ensure we have a valid token (auto-refresh if expired)
   */
  async ensureToken() {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60000) return;
    if (!this.clientId || !this.clientSecret) {
      if (this.accessToken) return; // apiToken with no expiry
      throw new CmsApiError('AUTH', '/authorize', 0, 'No valid token and no OAuth2 credentials');
    }
    await this.authenticate();
  }

  /**
   * Make an authenticated API request
   * @param {string} method - HTTP method
   * @param {string} path - API path (e.g. /display)
   * @param {Object} [params] - Query params (GET) or body params (POST/PUT)
   * @returns {Promise<any>} Response data
   */
  async request(method, path, params = {}) {
    await this.ensureToken();

    const url = new URL(`${this.baseUrl}/api${path}`);
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    };

    if (method === 'GET') {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    } else {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.body = new URLSearchParams(params);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const text = await response.text();
      let errorMsg;
      try {
        const errorData = JSON.parse(text);
        errorMsg = errorData.error?.message || errorData.message || text;
      } catch (_) {
        errorMsg = text;
      }
      throw new CmsApiError(method, path, response.status, errorMsg);
    }

    // Some endpoints return empty body (204)
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return null;
  }

  // ── Convenience methods ────────────────────────────────────────

  /** GET request (path relative to /api/) */
  get(path, params) { return this.request('GET', path, params); }
  /** POST request (path relative to /api/) */
  post(path, body) { return this.request('POST', path, body); }
  /** PUT request (path relative to /api/) */
  put(path, body) { return this.request('PUT', path, body); }
  /** DELETE request (path relative to /api/) */
  del(path) { return this.request('DELETE', path); }

  // ── Display Management ──────────────────────────────────────────

  /**
   * Find a display by hardware key
   * @param {string} hardwareKey
   * @returns {Promise<Object|null>} Display object or null if not found
   */
  async findDisplay(hardwareKey) {
    log.info('Looking up display by hardwareKey:', hardwareKey);
    const data = await this.request('GET', '/display', { hardwareKey });

    // API returns array of matching displays
    const displays = Array.isArray(data) ? data : [];
    if (displays.length === 0) {
      log.info('No display found for hardwareKey:', hardwareKey);
      return null;
    }

    const display = displays[0];
    log.info(`Found display: ${display.display} (ID: ${display.displayId}, licensed: ${display.licensed})`);
    return display;
  }

  /**
   * Authorize (toggle licence) a display
   * @param {number} displayId
   * @returns {Promise<void>}
   */
  async authorizeDisplay(displayId) {
    log.info('Authorizing display:', displayId);
    await this.request('PUT', `/display/authorise/${displayId}`);
    log.info('Display authorized successfully');
  }

  /**
   * Edit display properties
   * @param {number} displayId
   * @param {Object} properties - Properties to update (display, description, defaultLayoutId, etc.)
   * @returns {Promise<Object>} Updated display
   */
  async editDisplay(displayId, properties) {
    log.info('Editing display:', displayId, properties);
    return this.request('PUT', `/display/${displayId}`, properties);
  }

  /**
   * List all displays (with optional filters)
   * @param {Object} [filters] - Optional filters (displayId, display, macAddress, hardwareKey, clientType)
   * @returns {Promise<Array>} Array of display objects
   */
  async listDisplays(filters = {}) {
    const data = await this.request('GET', '/display', filters);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Request screenshot from a display
   * @param {number} displayId
   * @returns {Promise<void>}
   */
  async requestScreenshot(displayId) {
    await this.request('PUT', `/display/requestscreenshot/${displayId}`);
  }

  /**
   * Get display status
   * @param {number} displayId
   * @returns {Promise<Object>}
   */
  async getDisplayStatus(displayId) {
    return this.request('GET', `/display/status/${displayId}`);
  }

  // ── Multipart Requests (File Uploads) ─────────────────────────────

  /**
   * Make an authenticated multipart/form-data request (for file uploads).
   * Do NOT set Content-Type — fetch adds the multipart boundary automatically.
   * @param {string} method - HTTP method (POST/PUT)
   * @param {string} path - API path
   * @param {FormData} formData - Form data with files
   * @returns {Promise<any>} Response data
   */
  async requestMultipart(method, path, formData) {
    await this.ensureToken();

    const url = `${this.baseUrl}/api${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
        // No Content-Type — fetch sets multipart boundary automatically
      },
      body: formData
    });

    if (!response.ok) {
      const text = await response.text();
      let errorMsg;
      try {
        const errorData = JSON.parse(text);
        errorMsg = errorData.error?.message || errorData.message || text;
      } catch (_) {
        errorMsg = text;
      }
      throw new Error(`CMS API ${method} ${path} failed (${response.status}): ${errorMsg}`);
    }

    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return null;
  }

  // ── Layout Management ─────────────────────────────────────────────

  /**
   * Create a new layout
   * @param {Object} params
   * @param {string} params.name - Layout name
   * @param {number} params.resolutionId - Resolution ID
   * @param {string} [params.description] - Description
   * @returns {Promise<Object>} Created layout
   */
  async createLayout({ name, resolutionId, description }) {
    const params = { name, resolutionId };
    if (description) params.description = description;
    return this.request('POST', '/layout', params);
  }

  /**
   * List layouts with optional filters
   * @param {Object} [filters] - Filters (layoutId, layout, userId, retired, etc.)
   * @returns {Promise<Array>}
   */
  async listLayouts(filters = {}) {
    const data = await this.request('GET', '/layout', filters);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Get a single layout by ID
   * @param {number} layoutId
   * @returns {Promise<Object>}
   */
  async getLayout(layoutId) {
    return this.request('GET', `/layout/${layoutId}`);
  }

  /**
   * Delete a layout
   * @param {number} layoutId
   * @returns {Promise<void>}
   */
  async deleteLayout(layoutId) {
    await this.request('DELETE', `/layout/${layoutId}`);
  }

  /**
   * Publish a draft layout (makes it available for scheduling)
   * @param {number} layoutId
   * @returns {Promise<void>}
   */
  async publishLayout(layoutId) {
    await this.request('PUT', `/layout/publish/${layoutId}`, { publishNow: 1 });
  }

  /**
   * Checkout a published layout (creates editable draft).
   * NOTE: Not needed for newly created layouts — they already have a draft.
   * Use getDraftLayout() to find the auto-created draft instead.
   * @param {number} layoutId
   * @returns {Promise<Object>} Draft layout
   */
  async checkoutLayout(layoutId) {
    return this.request('PUT', `/layout/checkout/${layoutId}`);
  }

  /**
   * Get the draft (editable) layout for a given parent layout.
   * In Xibo v4, POST /layout creates a parent + hidden draft automatically.
   * The draft is the one you edit (add regions, widgets) before publishing.
   * @param {number} parentId - The parent layout ID returned by createLayout()
   * @returns {Promise<Object|null>} Draft layout or null if not found
   */
  async getDraftLayout(parentId) {
    const drafts = await this.listLayouts({ parentId });
    return drafts.length > 0 ? drafts[0] : null;
  }

  /**
   * Edit layout background
   * @param {number} layoutId
   * @param {Object} params
   * @param {number} [params.backgroundImageId] - Media ID for background image
   * @param {string} [params.backgroundColor] - Hex color (e.g. '#FF0000')
   * @returns {Promise<Object>}
   */
  async editLayoutBackground(layoutId, params) {
    return this.request('PUT', `/layout/background/${layoutId}`, params);
  }

  // ── Region Management ─────────────────────────────────────────────

  /**
   * Add a region to a layout
   * @param {number} layoutId - Must be the DRAFT layout ID (not the parent)
   * @param {Object} params - { width, height, top, left }
   * @returns {Promise<Object>} Created region with regionPlaylist (singular object, not array)
   */
  async addRegion(layoutId, params) {
    return this.request('POST', `/region/${layoutId}`, params);
  }

  /**
   * Edit a region's properties
   * @param {number} regionId
   * @param {Object} params - { width, height, top, left, zIndex }
   * @returns {Promise<Object>}
   */
  async editRegion(regionId, params) {
    return this.request('PUT', `/region/${regionId}`, params);
  }

  /**
   * Delete a region
   * @param {number} regionId
   * @returns {Promise<void>}
   */
  async deleteRegion(regionId) {
    await this.request('DELETE', `/region/${regionId}`);
  }

  // ── Widget/Playlist Management ────────────────────────────────────

  /**
   * Add a widget to a playlist
   *
   * Xibo CMS v4 uses a two-step process:
   * 1. POST creates the widget shell (only templateId and displayOrder are processed)
   * 2. PUT sets all widget properties (uri, duration, mute, etc.)
   *
   * @param {string} type - Widget type (text, image, video, embedded, clock, etc.)
   * @param {number} playlistId - Target playlist ID (from region.playlists[0].playlistId)
   * @param {Object} [properties] - Widget-specific properties
   * @returns {Promise<Object>} Created widget with properties applied
   */
  async addWidget(type, playlistId, properties = {}) {
    // Step 1: Create the widget (only templateId/displayOrder handled by CMS addWidget)
    const { templateId, displayOrder, ...editProps } = properties;
    const createParams = {};
    if (templateId !== undefined) createParams.templateId = templateId;
    if (displayOrder !== undefined) createParams.displayOrder = displayOrder;

    const widget = await this.request('POST', `/playlist/widget/${type}/${playlistId}`, createParams);

    // Step 2: Set widget properties via editWidget (CMS processes all module properties here)
    if (Object.keys(editProps).length > 0) {
      // useDuration=1 tells CMS to use our custom duration instead of module default
      if (editProps.duration !== undefined && editProps.useDuration === undefined) {
        editProps.useDuration = 1;
      }
      return this.request('PUT', `/playlist/widget/${widget.widgetId}`, editProps);
    }

    return widget;
  }

  /**
   * Edit a widget's properties
   * @param {number} widgetId
   * @param {Object} properties - Widget-specific properties to update
   * @returns {Promise<Object>}
   */
  async editWidget(widgetId, properties) {
    return this.request('PUT', `/playlist/widget/${widgetId}`, properties);
  }

  /**
   * Delete a widget
   * @param {number} widgetId
   * @returns {Promise<void>}
   */
  async deleteWidget(widgetId) {
    await this.request('DELETE', `/playlist/widget/${widgetId}`);
  }

  // ── Media / Library ───────────────────────────────────────────────

  /**
   * Upload a media file to the library
   * @param {FormData} formData - Must include 'files' field with the file(s)
   * @returns {Promise<Object>} Upload result with media info
   */
  async uploadMedia(formData) {
    return this.requestMultipart('POST', '/library', formData);
  }

  /**
   * List media in the library
   * @param {Object} [filters] - Filters (mediaId, media, type, ownerId, etc.)
   * @returns {Promise<Array>}
   */
  async listMedia(filters = {}) {
    const data = await this.request('GET', '/library', filters);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Get a single media item by ID
   * @param {number} mediaId
   * @returns {Promise<Object>}
   */
  async getMedia(mediaId) {
    return this.request('GET', `/library/${mediaId}`);
  }

  /**
   * Delete a media item from the library
   * @param {number} mediaId
   * @returns {Promise<void>}
   */
  async deleteMedia(mediaId) {
    await this.request('DELETE', `/library/${mediaId}`);
  }

  // ── Campaign Management ───────────────────────────────────────────

  /**
   * Create a campaign
   * @param {string} name - Campaign name
   * @returns {Promise<Object>} Created campaign
   */
  async createCampaign(name) {
    return this.request('POST', '/campaign', { name });
  }

  /**
   * List campaigns
   * @param {Object} [filters] - Filters (campaignId, name, etc.)
   * @returns {Promise<Array>}
   */
  async listCampaigns(filters = {}) {
    const data = await this.request('GET', '/campaign', filters);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Delete a campaign
   * @param {number} campaignId
   * @returns {Promise<void>}
   */
  async deleteCampaign(campaignId) {
    await this.request('DELETE', `/campaign/${campaignId}`);
  }

  /**
   * Assign a layout to a campaign
   * @param {number} campaignId
   * @param {number} layoutId
   * @param {number} [displayOrder] - Position in campaign playlist
   * @returns {Promise<void>}
   */
  async assignLayoutToCampaign(campaignId, layoutId, displayOrder) {
    const params = { layoutId };
    if (displayOrder !== undefined) params.displayOrder = displayOrder;
    await this.request('POST', `/campaign/layout/assign/${campaignId}`, params);
  }

  // ── Schedule Management ───────────────────────────────────────────

  /**
   * Create a schedule event
   * @param {Object} params
   * @param {number} params.eventTypeId - 1=Campaign, 2=Command, 3=Overlay
   * @param {number} params.campaignId - Campaign to schedule
   * @param {Array<number>} params.displayGroupIds - Target display group IDs
   * @param {string} params.fromDt - Start date (ISO 8601)
   * @param {string} params.toDt - End date (ISO 8601)
   * @param {number} [params.isPriority] - 0 or 1
   * @param {number} [params.displayOrder] - Order within schedule
   * @returns {Promise<Object>} Created schedule event
   */
  async createSchedule(params) {
    // displayGroupIds needs to be sent as displayGroupIds[] for the API
    const body = { ...params };
    if (Array.isArray(body.displayGroupIds)) {
      // Xibo API expects repeated keys: displayGroupIds[]=1&displayGroupIds[]=2
      // URLSearchParams handles this when we pass entries manually
      delete body.displayGroupIds;
    }

    await this.ensureToken();

    const url = `${this.baseUrl}/api/schedule`;
    const urlParams = new URLSearchParams();

    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) {
        urlParams.set(key, String(value));
      }
    }

    // Append array values as repeated keys
    if (Array.isArray(params.displayGroupIds)) {
      for (const id of params.displayGroupIds) {
        urlParams.append('displayGroupIds[]', String(id));
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: urlParams
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CMS API POST /schedule failed (${response.status}): ${text}`);
    }

    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return null;
  }

  /**
   * Delete a schedule event
   * @param {number} eventId
   * @returns {Promise<void>}
   */
  async deleteSchedule(eventId) {
    await this.request('DELETE', `/schedule/${eventId}`);
  }

  /**
   * List schedule events
   * @param {Object} [filters] - Filters (displayGroupIds, fromDt, toDt)
   * @returns {Promise<Array>}
   */
  async listSchedules(filters = {}) {
    const data = await this.request('GET', '/schedule/data/events', filters);
    return Array.isArray(data) ? data : (data?.events || []);
  }

  // ── Display Group Management ──────────────────────────────────────

  /**
   * List display groups
   * @param {Object} [filters] - Filters (displayGroupId, displayGroup)
   * @returns {Promise<Array>}
   */
  async listDisplayGroups(filters = {}) {
    const data = await this.request('GET', '/displaygroup', filters);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Create a display group
   * @param {string} name - Display group name
   * @param {string} [description]
   * @returns {Promise<Object>} Created display group
   */
  async createDisplayGroup(name, description) {
    const params = { displayGroup: name };
    if (description) params.description = description;
    return this.request('POST', '/displaygroup', params);
  }

  /**
   * Delete a display group
   * @param {number} displayGroupId
   * @returns {Promise<void>}
   */
  async deleteDisplayGroup(displayGroupId) {
    await this.request('DELETE', `/displaygroup/${displayGroupId}`);
  }

  /**
   * Assign a display to a display group
   * @param {number} displayGroupId
   * @param {number} displayId
   * @returns {Promise<void>}
   */
  async assignDisplayToGroup(displayGroupId, displayId) {
    await this.ensureToken();

    const url = `${this.baseUrl}/api/displaygroup/${displayGroupId}/display/assign`;
    const urlParams = new URLSearchParams();
    urlParams.append('displayId[]', String(displayId));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: urlParams
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CMS API assign display to group failed (${response.status}): ${text}`);
    }
  }

  /**
   * Unassign a display from a display group
   * @param {number} displayGroupId
   * @param {number} displayId
   * @returns {Promise<void>}
   */
  async unassignDisplayFromGroup(displayGroupId, displayId) {
    await this.ensureToken();

    const url = `${this.baseUrl}/api/displaygroup/${displayGroupId}/display/unassign`;
    const urlParams = new URLSearchParams();
    urlParams.append('displayId[]', String(displayId));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: urlParams
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CMS API unassign display from group failed (${response.status}): ${text}`);
    }
  }

  // ── Resolution Management ─────────────────────────────────────────

  /**
   * List available resolutions
   * @returns {Promise<Array>}
   */
  async listResolutions() {
    const data = await this.request('GET', '/resolution');
    return Array.isArray(data) ? data : [];
  }

  // ── Template Management ──────────────────────────────────────────

  /**
   * List available layout templates
   * @param {Object} [filters] - Filters (layout, tags, etc.)
   * @returns {Promise<Array>}
   */
  async listTemplates(filters = {}) {
    const data = await this.request('GET', '/template', filters);
    return Array.isArray(data) ? data : [];
  }

  // ── Playlist Management ──────────────────────────────────────────

  /**
   * Assign media library items to a playlist (for file-based widgets: audio, PDF, video)
   * @param {number} playlistId
   * @param {number[]} mediaIds - Array of media IDs to assign
   * @returns {Promise<Object>}
   */
  async assignMediaToPlaylist(playlistId, mediaIds) {
    const ids = Array.isArray(mediaIds) ? mediaIds : [mediaIds];
    // Xibo API expects media[] repeated keys
    await this.ensureToken();
    const url = `${this.baseUrl}/api/playlist/library/assign/${playlistId}`;
    const urlParams = new URLSearchParams();
    for (const id of ids) {
      urlParams.append('media[]', String(id));
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: urlParams
    });
    if (!response.ok) {
      const text = await response.text();
      throw new CmsApiError('POST', `/playlist/library/assign/${playlistId}`, response.status, text);
    }
    const contentType = response.headers.get('Content-Type') || '';
    return contentType.includes('application/json') ? response.json() : null;
  }

  // ── Layout Edit ───────────────────────────────────────────────────

  /**
   * Edit layout properties
   * @param {number} layoutId
   * @param {Object} params - Properties to update
   * @returns {Promise<Object>}
   */
  async editLayout(layoutId, params) {
    return this.request('PUT', `/layout/${layoutId}`, params);
  }

  // ── Layout Copy / Discard (#25) ────────────────────────────────────

  /**
   * Copy a layout
   * @param {number} layoutId
   * @param {Object} [opts] - Options (name, description, copyMediaFiles)
   * @returns {Promise<Object>} Copied layout
   */
  async copyLayout(layoutId, opts = {}) {
    return this.post(`/layout/copy/${layoutId}`, opts);
  }

  /**
   * Discard a draft layout (revert to last published version)
   * @param {number} layoutId
   * @returns {Promise<void>}
   */
  async discardLayout(layoutId) {
    await this.put(`/layout/discard/${layoutId}`);
  }

  // ── Campaign Edit / Unassign (#26) ─────────────────────────────────

  /**
   * Edit campaign properties
   * @param {number} campaignId
   * @param {Object} params - Properties to update (name, etc.)
   * @returns {Promise<Object>} Updated campaign
   */
  async editCampaign(campaignId, params) {
    return this.put(`/campaign/${campaignId}`, params);
  }

  /**
   * Get a single campaign by ID
   * @param {number} campaignId
   * @returns {Promise<Object>}
   */
  async getCampaign(campaignId) {
    return this.get(`/campaign/${campaignId}`);
  }

  /**
   * Unassign a layout from a campaign
   * @param {number} campaignId
   * @param {number} layoutId
   * @returns {Promise<void>}
   */
  async unassignLayoutFromCampaign(campaignId, layoutId) {
    await this.post(`/campaign/layout/unassign/${campaignId}`, { layoutId });
  }

  // ── Schedule Edit (#27) ────────────────────────────────────────────

  /**
   * Edit a schedule event
   * @param {number} eventId
   * @param {Object} params - Properties to update (fromDt, toDt, isPriority, etc.)
   * @returns {Promise<Object>} Updated schedule event
   */
  async editSchedule(eventId, params) {
    return this.put(`/schedule/${eventId}`, params);
  }

  // ── Layout Retire / Status / Tag (#34) ─────────────────────────────

  /**
   * Retire a layout (hide from new scheduling but keep existing schedules)
   * @param {number} layoutId
   * @returns {Promise<void>}
   */
  async retireLayout(layoutId) {
    await this.put(`/layout/retire/${layoutId}`);
  }

  /**
   * Unretire a previously retired layout
   * @param {number} layoutId
   * @returns {Promise<void>}
   */
  async unretireLayout(layoutId) {
    await this.put(`/layout/unretire/${layoutId}`);
  }

  /**
   * Get layout status (build status, validity)
   * @param {number} layoutId
   * @returns {Promise<Object>}
   */
  async getLayoutStatus(layoutId) {
    return this.get(`/layout/status/${layoutId}`);
  }

  /**
   * Tag a layout
   * @param {number} layoutId
   * @param {string[]} tags - Tag names to add
   * @returns {Promise<void>}
   */
  async tagLayout(layoutId, tags) {
    await this.post(`/layout/${layoutId}/tag`, { tag: tags.join(',') });
  }

  /**
   * Remove tags from a layout
   * @param {number} layoutId
   * @param {string[]} tags - Tag names to remove
   * @returns {Promise<void>}
   */
  async untagLayout(layoutId, tags) {
    await this.post(`/layout/${layoutId}/untag`, { tag: tags.join(',') });
  }

  // ── Command CRUD (#36) ─────────────────────────────────────────────

  /**
   * List commands
   * @param {Object} [filters] - Filters (commandId, command)
   * @returns {Promise<Array>}
   */
  async listCommands(filters = {}) {
    const data = await this.get('/command', filters);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Create a command
   * @param {Object} params - { command, description, code }
   * @returns {Promise<Object>}
   */
  async createCommand(params) {
    return this.post('/command', params);
  }

  /**
   * Edit a command
   * @param {number} commandId
   * @param {Object} params - Properties to update
   * @returns {Promise<Object>}
   */
  async editCommand(commandId, params) {
    return this.put(`/command/${commandId}`, params);
  }

  /**
   * Delete a command
   * @param {number} commandId
   * @returns {Promise<void>}
   */
  async deleteCommand(commandId) {
    await this.del(`/command/${commandId}`);
  }

  // ── Display Extras (#41) ───────────────────────────────────────────

  /**
   * Delete a display
   * @param {number} displayId
   * @returns {Promise<void>}
   */
  async deleteDisplay(displayId) {
    await this.del(`/display/${displayId}`);
  }

  /**
   * Send Wake-on-LAN to a display
   * @param {number} displayId
   * @returns {Promise<void>}
   */
  async wolDisplay(displayId) {
    await this.post(`/display/wol/${displayId}`);
  }

  /**
   * Set the default layout for a display
   * @param {number} displayId
   * @param {number} layoutId - Layout to set as default
   * @returns {Promise<Object>}
   */
  async setDefaultLayout(displayId, layoutId) {
    return this.put(`/display/${displayId}`, { defaultLayoutId: layoutId });
  }

  /**
   * Purge all content from a display (force re-download)
   * @param {number} displayId
   * @returns {Promise<void>}
   */
  async purgeDisplay(displayId) {
    await this.post(`/display/purge/${displayId}`);
  }
}

/**
 * Structured error for CMS API failures
 */
export class CmsApiError extends Error {
  constructor(method, path, status, detail) {
    super(`CMS API ${method} ${path} → ${status}: ${detail}`);
    this.name = 'CmsApiError';
    this.method = method;
    this.path = path;
    this.status = status;
    this.detail = detail;
  }
}
