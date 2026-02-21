/**
 * REST transport client for Xibo CMS.
 *
 * Uses the /pwa REST API endpoints with JSON payloads and ETag caching.
 * Lighter than SOAP — ~30% smaller payloads, standard HTTP semantics.
 *
 * Protocol: https://github.com/linuxnow/xibo_players_docs
 */
import { createLogger, fetchWithRetry } from '@xiboplayer/utils';
import { parseScheduleResponse } from './schedule-parser.js';

const log = createLogger('REST');

export class RestClient {
  constructor(config) {
    this.config = config;
    this.schemaVersion = 7;
    this.retryOptions = config.retryOptions || { maxRetries: 2, baseDelayMs: 2000 };

    // ETag-based HTTP caching
    this._etags = new Map();         // endpoint → ETag string
    this._responseCache = new Map(); // endpoint → cached parsed response

    log.info('Using REST transport');
  }

  // ─── Transport helpers ──────────────────────────────────────────

  /**
   * Get the REST API base URL.
   * Falls back to /pwa path relative to the CMS address.
   */
  getRestBaseUrl() {
    const base = this.config.restApiUrl || `${this.config.cmsAddress}/pwa`;
    return base.replace(/\/+$/, '');
  }

  /**
   * Make a REST GET request with optional ETag caching.
   * Returns the parsed JSON body, or cached data on 304.
   */
  async restGet(path, queryParams = {}) {
    const url = new URL(`${this.getRestBaseUrl()}${path}`);
    url.searchParams.set('serverKey', this.config.cmsKey);
    url.searchParams.set('hardwareKey', this.config.hardwareKey);
    url.searchParams.set('v', String(this.schemaVersion));
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, String(value));
    }

    const cacheKey = path;
    const headers = {};
    const cachedEtag = this._etags.get(cacheKey);
    if (cachedEtag) {
      headers['If-None-Match'] = cachedEtag;
    }

    log.debug(`GET ${path}`, queryParams);

    const response = await fetchWithRetry(url.toString(), {
      method: 'GET',
      headers,
    }, this.retryOptions);

    // 304 Not Modified — return cached response
    if (response.status === 304) {
      const cached = this._responseCache.get(cacheKey);
      if (cached) {
        log.debug(`${path} → 304 (using cache)`);
        return cached;
      }
      // Cache miss despite 304 — fall through to fetch fresh
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`REST GET ${path} failed: ${response.status} ${response.statusText} ${errorBody}`);
    }

    // Store ETag for future requests
    const etag = response.headers.get('ETag');
    if (etag) {
      this._etags.set(cacheKey, etag);
    }

    const contentType = response.headers.get('Content-Type') || '';
    let data;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      // XML or HTML — return raw text
      data = await response.text();
    }

    // Cache parsed response for 304 reuse
    this._responseCache.set(cacheKey, data);
    return data;
  }

  /**
   * Make a REST POST/PUT request with JSON body.
   * Returns the parsed JSON response.
   */
  async restSend(method, path, body = {}) {
    const url = new URL(`${this.getRestBaseUrl()}${path}`);
    url.searchParams.set('v', String(this.schemaVersion));

    log.debug(`${method} ${path}`);

    const response = await fetchWithRetry(url.toString(), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverKey: this.config.cmsKey,
        hardwareKey: this.config.hardwareKey,
        ...body,
      }),
    }, this.retryOptions);

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
   * RegisterDisplay - authenticate and get settings
   * POST /register → JSON with display settings
   */
  async registerDisplay() {
    const os = typeof navigator !== 'undefined'
      ? `${navigator.platform} ${navigator.userAgent}`
      : 'unknown';

    const json = await this.restSend('POST', '/register', {
      displayName: this.config.displayName,
      clientType: this.config.clientType || 'chromeOS',
      clientVersion: this.config.clientVersion || '0.1.0',
      clientCode: this.config.clientCode || 1,
      operatingSystem: os,
      macAddress: this.config.macAddress || 'n/a',
      xmrChannel: this.config.xmrChannel,
      xmrPubKey: this.config.xmrPubKey || '',
      licenceResult: 'licensed',
    });

    return this._parseRegisterDisplayJson(json);
  }

  /**
   * Parse REST JSON RegisterDisplay response into the same format as SOAP.
   */
  _parseRegisterDisplayJson(json) {
    // Handle both direct object and wrapped {display: ...} forms
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
        // Parse commands: array of {code/commandCode, commandString} objects
        if (Array.isArray(value)) {
          commands = value.map(c => ({
            commandCode: c.code || c.commandCode || '',
            commandString: c.commandString || ''
          }));
        }
        continue;
      }
      if (key === 'tags') {
        // Parse tags: array of strings, or array of {tag: "value"} objects
        if (Array.isArray(value)) {
          tags = value.map(t => typeof t === 'object' ? (t.tag || t.value || '') : String(t)).filter(Boolean);
        }
        continue;
      }
      settings[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }

    const checkRf = attrs.checkRf || '';
    const checkSchedule = attrs.checkSchedule || '';

    // Extract display-level attributes from CMS (server time, status, version info)
    const displayAttrs = {
      date: attrs.date || display.date || null,
      timezone: attrs.timezone || display.timezone || null,
      status: attrs.status || display.status || null,
      localDate: attrs.localDate || display.localDate || null,
      version_instructions: attrs.version_instructions || display.version_instructions || null,
    };

    // Extract sync group config if present (multi-display sync coordination)
    // syncGroup: "lead" if this display is leader, or leader's LAN IP if follower
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
   * RequiredFiles - get list of files to download
   * GET /requiredFiles → JSON file manifest (with ETag caching)
   */
  async requiredFiles() {
    const json = await this.restGet('/requiredFiles');
    return this._parseRequiredFilesJson(json);
  }

  /**
   * Parse REST JSON RequiredFiles into the same array format as SOAP.
   */
  _parseRequiredFilesJson(json) {
    const files = [];
    let fileList = json.file || [];

    // Normalize single item to array
    if (!Array.isArray(fileList)) {
      fileList = [fileList];
    }

    for (const f of fileList) {
      const attrs = f['@attributes'] || f;
      const path = attrs.path || null;
      files.push({
        type: attrs.type || null,
        id: attrs.id || null,
        size: parseInt(attrs.size || '0'),
        md5: attrs.md5 || null,
        download: attrs.download || null,
        path,
        saveAs: attrs.saveAs || null,
        fileType: attrs.fileType || null,
        code: attrs.code || null,
        layoutid: attrs.layoutid || null,
        regionid: attrs.regionid || null,
        mediaid: attrs.mediaid || null,
      });
    }

    // Parse purge items — files CMS wants the player to delete
    const purgeItems = [];
    let purgeList = json.purge?.item || [];
    if (!Array.isArray(purgeList)) purgeList = [purgeList];
    for (const p of purgeList) {
      const pAttrs = p['@attributes'] || p;
      purgeItems.push({
        id: pAttrs.id || null,
        storedAs: pAttrs.storedAs || null,
      });
    }

    return { files, purge: purgeItems };
  }

  /**
   * Schedule - get layout schedule
   * GET /schedule → XML (preserved for layout parser compatibility, with ETag caching)
   */
  async schedule() {
    const xml = await this.restGet('/schedule');
    return parseScheduleResponse(xml);
  }

  /**
   * GetResource - get rendered widget HTML
   * GET /getResource → HTML string
   */
  async getResource(layoutId, regionId, mediaId) {
    return this.restGet('/getResource', {
      layoutId: String(layoutId),
      regionId: String(regionId),
      mediaId: String(mediaId),
    });
  }

  /**
   * NotifyStatus - report current status
   * PUT /status → JSON acknowledgement
   * @param {Object} status - Status object with currentLayoutId, deviceName, etc.
   */
  async notifyStatus(status) {
    // Enrich with storage estimate if available
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        status.availableSpace = estimate.quota - estimate.usage;
        status.totalSpace = estimate.quota;
      } catch (_) { /* storage estimate not supported */ }
    }

    // Add timezone if not already provided
    if (!status.timeZone && typeof Intl !== 'undefined') {
      status.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }

    return this.restSend('PUT', '/status', {
      statusData: status,
    });
  }

  /**
   * MediaInventory - report downloaded files
   * POST /mediaInventory → JSON acknowledgement
   */
  async mediaInventory(inventoryXml) {
    // Accept array (JSON-native) or string (XML) — send under the right key
    const body = Array.isArray(inventoryXml)
      ? { inventoryItems: inventoryXml }
      : { inventory: inventoryXml };
    return this.restSend('POST', '/mediaInventory', body);
  }

  /**
   * BlackList - report broken media to CMS
   *
   * BlackList has no REST equivalent endpoint.
   * Log a warning and return false.
   */
  async blackList(mediaId, type, reason) {
    log.warn(`BlackList not available via REST (${type}/${mediaId}: ${reason})`);
    return false;
  }

  /**
   * SubmitLog - submit player logs to CMS
   * POST /log → JSON acknowledgement
   */
  async submitLog(logXml) {
    // Accept array (JSON-native) or string (XML) — send under the right key
    const body = Array.isArray(logXml) ? { logs: logXml } : { logXml };
    const result = await this.restSend('POST', '/log', body);
    return result?.success === true;
  }

  /**
   * SubmitScreenShot - submit screenshot to CMS
   * POST /screenshot → JSON acknowledgement
   */
  async submitScreenShot(base64Image) {
    const result = await this.restSend('POST', '/screenshot', {
      screenshot: base64Image,
    });
    return result?.success === true;
  }

  /**
   * SubmitStats - submit proof of play statistics
   * POST /stats → JSON acknowledgement
   */
  /**
   * ReportFaults - submit fault data to CMS for dashboard alerts
   * POST /fault → JSON acknowledgement
   * @param {string} faultJson - JSON-encoded fault data
   * @returns {Promise<boolean>}
   */
  async reportFaults(faultJson) {
    const result = await this.restSend('POST', '/fault', { fault: faultJson });
    return result?.success === true;
  }

  /**
   * GetWeather - get current weather data for schedule criteria
   * GET /weather → JSON weather data
   * @returns {Promise<Object>} Weather data from CMS
   */
  async getWeather() {
    return this.restGet('/weather');
  }

  async submitStats(statsXml) {
    try {
      // Accept array (JSON-native) or string (XML) — send under the right key
      const body = Array.isArray(statsXml) ? { stats: statsXml } : { statXml: statsXml };
      const result = await this.restSend('POST', '/stats', body);
      const success = result?.success === true;
      log.info(`SubmitStats result: ${success}`);
      return success;
    } catch (error) {
      log.error('SubmitStats failed:', error);
      throw error;
    }
  }
}
