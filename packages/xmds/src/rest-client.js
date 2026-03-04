/**
 * REST transport client for Xibo CMS Player API.
 *
 * Uses the Player API REST endpoints with JWT auth, resource-oriented URLs,
 * and native JSON responses (no XML parsing required).
 *
 *   - JWT bearer token auth (single POST /auth → token for all requests)
 *   - Resource-oriented URLs (/displays/{id}/schedule vs /schedule)
 *   - Native JSON schedule (no client-side XML parsing)
 *   - Categorized required files (media/layouts/widgets)
 *   - CDN/reverse proxy compatible (GET with cache headers)
 *
 * Same public API as XmdsClient — drop-in replacement.
 */
import { createLogger, fetchWithRetry, PLAYER_API } from '@xiboplayer/utils';

const log = createLogger('REST');

export class RestClient {
  constructor(config) {
    this.config = config;
    this.schemaVersion = 7;
    this.retryOptions = config.retryOptions || { maxRetries: 2, baseDelayMs: 2000 };

    // JWT auth state
    this._token = null;
    this._tokenExpiresAt = 0;
    this._displayId = null;

    // ETag-based HTTP caching
    this._etags = new Map();
    this._responseCache = new Map();

    log.info('Using REST transport');
  }

  // ─── Transport helpers ──────────────────────────────────────────

  /**
   * Get the REST API base URL.
   * In proxy mode (Electron/Chromium), returns the local relative path so
   * requests go through the Express proxy's mirror routes.
   * In direct mode (standalone PWA), returns the full CMS URL.
   */
  getRestBaseUrl() {
    if (this._isProxyMode()) {
      return `${window.location.origin}${PLAYER_API}`;
    }
    const base = this.config.restApiUrl || `${this.config.cmsUrl}${PLAYER_API}`;
    return base.replace(/\/+$/, '');
  }

  /**
   * Check if running behind the local proxy (Electron or Chromium kiosk).
   */
  _isProxyMode() {
    return typeof window !== 'undefined' &&
      (window.electronAPI?.isElectron ||
       window.location.hostname === 'localhost');
  }

  // ─── JWT auth ─────────────────────────────────────────────────

  /**
   * Authenticate with the CMS and obtain a JWT token.
   * Called automatically before the first authenticated request.
   */
  async _authenticate() {
    const url = `${this.getRestBaseUrl()}/auth`;

    log.debug('Authenticating...');

    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverKey: this.config.cmsKey,
        hardwareKey: this.config.hardwareKey,
      }),
    }, this.retryOptions);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Auth failed: ${response.status} ${response.statusText} ${errorBody}`);
    }

    const data = await response.json();
    this._token = data.token;
    this._displayId = data.displayId;
    // Refresh 60s before expiry to avoid edge-case rejections
    this._tokenExpiresAt = Date.now() + (data.expiresIn - 60) * 1000;

    log.info(`Authenticated as display ${this._displayId}`);
  }

  /**
   * Get a valid JWT token, refreshing if expired or missing.
   */
  async _getToken() {
    if (!this._token || Date.now() >= this._tokenExpiresAt) {
      await this._authenticate();
    }
    return this._token;
  }

  /**
   * Make an authenticated GET request with ETag caching.
   */
  async restGet(path, queryParams = {}) {
    const token = await this._getToken();
    const url = new URL(`${this.getRestBaseUrl()}${path}`);
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, String(value));
    }

    const cacheKey = path;
    const headers = { 'Authorization': `Bearer ${token}` };
    const cachedEtag = this._etags.get(cacheKey);
    if (cachedEtag) {
      headers['If-None-Match'] = cachedEtag;
    }

    log.debug(`GET ${path}`, queryParams);

    const response = await fetchWithRetry(url.toString(), {
      method: 'GET',
      headers,
    }, this.retryOptions);

    // Token expired mid-flight — re-auth and retry once
    if (response.status === 401) {
      this._token = null;
      return this.restGet(path, queryParams);
    }

    if (response.status === 304) {
      const cached = this._responseCache.get(cacheKey);
      if (cached) {
        log.debug(`${path} → 304 (using cache)`);
        return cached;
      }
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`REST GET ${path} failed: ${response.status} ${response.statusText} ${errorBody}`);
    }

    const etag = response.headers.get('ETag');
    if (etag) {
      this._etags.set(cacheKey, etag);
    }

    const contentType = response.headers.get('Content-Type') || '';
    let data;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    this._responseCache.set(cacheKey, data);
    return data;
  }

  /**
   * Make an authenticated POST/PUT request with JSON body.
   */
  async restSend(method, path, body = {}) {
    const token = await this._getToken();
    const url = new URL(`${this.getRestBaseUrl()}${path}`);

    log.debug(`${method} ${path}`);

    const response = await fetchWithRetry(url.toString(), {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }, this.retryOptions);

    // Token expired mid-flight — re-auth and retry once
    if (response.status === 401) {
      this._token = null;
      return this.restSend(method, path, body);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`REST ${method} ${path} failed: ${response.status} ${response.statusText} ${errorBody}`);
    }

    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      return await response.json();
    }
    return await response.text();
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * RegisterDisplay - authenticate and get settings.
   * POST /displays → JSON with display settings
   */
  async registerDisplay() {
    // Auth first to get displayId
    await this._getToken();

    const os = typeof navigator !== 'undefined'
      ? `${navigator.platform} ${navigator.userAgent}`
      : 'unknown';

    const json = await this.restSend('POST', '/displays', {
      displayName: this.config.displayName,
      clientType: this.config.clientType || 'linux',
      clientVersion: this.config.clientVersion || '0.1.0',
      clientCode: this.config.clientCode || 1,
      operatingSystem: os,
      macAddress: this.config.macAddress || 'n/a',
      xmrChannel: this.config.xmrChannel,
      xmrPubKey: this.config.xmrPubKey || '',
    });

    return this._parseRegisterDisplayJson(json);
  }

  /**
   * Parse register display JSON response.
   * Same output format as XmdsClient.
   */
  _parseRegisterDisplayJson(json) {
    const display = json.display || json;
    const attrs = display['@attributes'] || {};
    const code = attrs.code || display.code;
    const message = attrs.message || display.message || '';

    if (code !== 'READY') {
      return { code, message, settings: null };
    }

    const settings = {};
    let tags = [];
    let commands = [];
    for (const [key, value] of Object.entries(display)) {
      if (key === '@attributes' || key === 'file') continue;
      if (key === 'commands') {
        if (Array.isArray(value)) {
          commands = value.map(c => ({
            commandCode: c.code || c.commandCode || '',
            commandString: c.commandString || ''
          }));
        }
        continue;
      }
      if (key === 'tags') {
        const extractTag = (t) => typeof t === 'object' ? (t.tag || t.value || '') : String(t);
        if (Array.isArray(value)) {
          tags = value.map(extractTag).filter(Boolean);
        } else if (value && typeof value === 'object') {
          const t = extractTag(value);
          if (t) tags = [t];
        } else if (typeof value === 'string' && value) {
          tags = [value];
        }
        continue;
      }
      settings[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }

    const checkRf = attrs.checkRf || '';
    const checkSchedule = attrs.checkSchedule || '';

    const displayAttrs = {
      date: attrs.date || display.date || null,
      timezone: attrs.timezone || display.timezone || null,
      status: attrs.status || display.status || null,
      localDate: attrs.localDate || display.localDate || null,
      version_instructions: attrs.version_instructions || display.version_instructions || null,
    };

    const syncConfig = display.syncGroup ? {
      syncGroup: String(display.syncGroup),
      syncPublisherPort: parseInt(display.syncPublisherPort || '9590', 10),
      syncSwitchDelay: parseInt(display.syncSwitchDelay || '750', 10),
      syncVideoPauseDelay: parseInt(display.syncVideoPauseDelay || '100', 10),
      isLead: String(display.syncGroup) === 'lead',
    } : null;

    return { code, message, settings, tags, commands, displayAttrs, checkRf, checkSchedule, syncConfig };
  }

  /**
   * RequiredFiles - get list of files to download.
   * GET /displays/{id}/media → categorized JSON (no XML parsing)
   */
  async requiredFiles() {
    const json = await this.restGet(`/displays/${this._displayId}/media`);
    return this._parseRequiredFilesV2(json);
  }

  /**
   * Parse v2 categorized required files into the same flat format
   * that the download pipeline expects.
   *
   * v2 server returns: { media: [...], layouts: [...], widgets: [...] }
   * We flatten back to: { files: [...], purge: [] }
   */
  _parseRequiredFilesV2(json) {
    const files = [];

    // Media files (images, videos)
    for (const m of json.media || []) {
      files.push({
        type: m.type || 'media',
        id: m.id != null ? String(m.id) : null,
        size: m.fileSize || 0,
        md5: m.md5 || null,
        download: 'http',
        path: m.url || null,
        saveAs: m.saveAs || null,
        fileType: null,
        code: null,
        layoutid: null,
        regionid: null,
        mediaid: null,
      });
    }

    // Layout files
    for (const l of json.layouts || []) {
      files.push({
        type: 'layout',
        id: l.id != null ? String(l.id) : null,
        size: l.fileSize || 0,
        md5: l.md5 || null,
        download: 'http',
        path: l.url || null,
        saveAs: null,
        fileType: null,
        code: null,
        layoutid: null,
        regionid: null,
        mediaid: null,
      });
    }

    // Widget data files (datasets — dynamic API, not static media)
    for (const w of json.widgets || []) {
      files.push({
        type: 'dataset',
        id: w.id != null ? String(w.id) : null,
        size: 0,
        md5: w.md5 || null,
        download: 'http',
        path: w.url || null,
        saveAs: null,
        fileType: null,
        code: null,
        layoutid: null,
        regionid: null,
        mediaid: null,
        updateInterval: w.updateInterval || 0,
      });
    }

    // Dependencies (fonts, CSS, JS bundles) — pre-classified as 'static'
    for (const d of json.dependencies || []) {
      files.push({
        type: 'static',
        id: d.id != null ? String(d.id) : null,
        size: d.fileSize || 0,
        md5: d.md5 || null,
        download: 'http',
        path: d.url || null,
        saveAs: null,
        fileType: d.type || null,
        code: null,
        layoutid: null,
        regionid: null,
        mediaid: null,
      });
    }

    return { files, purge: [] };
  }

  /**
   * Schedule - get layout schedule.
   * GET /displays/{id}/schedule → native JSON (no XML parsing needed!)
   *
   * The v2 server returns the same structure as parseScheduleResponse(),
   * so we return it directly.
   */
  async schedule() {
    return this.restGet(`/displays/${this._displayId}/schedule`);
  }

  /**
   * GetResource - get rendered widget HTML.
   * GET /widgets/{layoutId}/{regionId}/{mediaId} → HTML string
   */
  async getResource(layoutId, regionId, mediaId) {
    return this.restGet(`/widgets/${layoutId}/${regionId}/${mediaId}`);
  }

  /**
   * NotifyStatus - report current status.
   * PUT /displays/{id}/status → JSON acknowledgement
   */
  async notifyStatus(status) {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        status.availableSpace = estimate.quota - estimate.usage;
        status.totalSpace = estimate.quota;
      } catch (_) { /* storage estimate not supported */ }
    }

    if (!status.timeZone && typeof Intl !== 'undefined') {
      status.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }

    if (!status.statusDialog) {
      status.statusDialog = `Current Layout: ${status.currentLayoutId || 'None'}`;
    }

    return this.restSend('PUT', `/displays/${this._displayId}/status`, {
      statusData: status,
    });
  }

  /**
   * MediaInventory - report downloaded files.
   * PUT /displays/{id}/inventory → JSON acknowledgement
   */
  async mediaInventory(inventoryXml) {
    const body = Array.isArray(inventoryXml)
      ? { inventoryItems: inventoryXml }
      : { inventory: inventoryXml };
    return this.restSend('PUT', `/displays/${this._displayId}/inventory`, body);
  }

  /**
   * BlackList - report broken media to CMS.
   * Not in v2 API — falls back to v1 behavior (no-op with warning).
   */
  async blackList(mediaId, type, reason) {
    log.warn(`BlackList not available in v2 API (${type}/${mediaId}: ${reason})`);
    return false;
  }

  /**
   * SubmitLog - submit player logs to CMS.
   * POST /displays/{id}/logs → JSON acknowledgement
   */
  async submitLog(logXml, hardwareKeyOverride = null) {
    const body = Array.isArray(logXml) ? { logs: logXml } : { logXml };
    const result = await this.restSend('POST', `/displays/${this._displayId}/logs`, body);
    return result?.success === true;
  }

  /**
   * SubmitScreenShot - submit screenshot to CMS.
   * POST /displays/{id}/screenshot → JSON acknowledgement
   */
  async submitScreenShot(base64Image) {
    const result = await this.restSend('POST', `/displays/${this._displayId}/screenshot`, {
      screenshot: base64Image,
    });
    return result?.success === true;
  }

  /**
   * SubmitStats - submit proof of play statistics.
   * POST /displays/{id}/stats → JSON acknowledgement
   */
  async submitStats(statsXml, hardwareKeyOverride = null) {
    try {
      const body = Array.isArray(statsXml) ? { stats: statsXml } : { statXml: statsXml };
      const result = await this.restSend('POST', `/displays/${this._displayId}/stats`, body);
      const success = result?.success === true;
      log.info(`SubmitStats result: ${success}`);
      return success;
    } catch (error) {
      log.error('SubmitStats failed:', error);
      throw error;
    }
  }

  /**
   * ReportFaults - submit fault data to CMS for dashboard alerts.
   * POST /displays/{id}/faults → JSON acknowledgement
   */
  async reportFaults(faultJson) {
    const result = await this.restSend('POST', `/displays/${this._displayId}/faults`, {
      fault: faultJson,
    });
    return result?.success === true;
  }

  /**
   * GetWeather - get current weather data for schedule criteria.
   * GET /displays/{id}/weather → JSON weather data
   */
  async getWeather() {
    return this.restGet(`/displays/${this._displayId}/weather`);
  }

  // ─── Static helpers ───────────────────────────────────────────

  /**
   * Probe whether the CMS supports API v2.
   * GET /api/v2/player/health → { version: 2, status: "ok" }
   *
   * @param {string} cmsUrl - CMS base URL
   * @param {Object} [retryOptions] - Retry options for fetch
   * @returns {Promise<boolean>} true if v2 is available
   */
  static async isAvailable(cmsUrl, retryOptions) {
    try {
      // In proxy mode, probe the local proxy's forward route instead of the CMS directly (avoids CORS)
      const isProxy = typeof window !== 'undefined' &&
        (window.electronAPI?.isElectron || window.location.hostname === 'localhost');
      const base = isProxy ? '' : cmsUrl.replace(/\/+$/, '');
      const url = `${base}${PLAYER_API}/health`;
      const timeoutMs = retryOptions?.timeoutMs || 3000;
      const fetchOptions = { method: 'GET' };
      // Apply timeout via AbortSignal (short timeout avoids delaying startup)
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        fetchOptions.signal = AbortSignal.timeout(timeoutMs);
      }
      const response = await fetchWithRetry(url, fetchOptions, retryOptions || { maxRetries: 0 });
      if (!response.ok) return false;
      const data = await response.json();
      return data.version === 2 && data.status === 'ok';
    } catch {
      return false;
    }
  }
}
