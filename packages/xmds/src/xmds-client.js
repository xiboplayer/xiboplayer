/**
 * XMDS SOAP transport client for Xibo CMS.
 *
 * Uses the traditional SOAP/XML endpoint (xmds.php) for full protocol
 * compatibility with all Xibo CMS versions.
 *
 * Protocol: https://github.com/linuxnow/xibo_players_docs
 */
import { createLogger, fetchWithRetry } from '@xiboplayer/utils';
import { parseScheduleResponse } from './schedule-parser.js';

const log = createLogger('XMDS');

export class XmdsClient {
  constructor(config) {
    this.config = config;
    this.schemaVersion = 5;
    this.retryOptions = config.retryOptions || { maxRetries: 2, baseDelayMs: 2000 };
  }

  // ─── SOAP transport helpers ─────────────────────────────────────

  /**
   * Build SOAP envelope for a given method and parameters
   */
  buildEnvelope(method, params) {
    const paramElements = Object.entries(params)
      .map(([key, value]) => {
        const escaped = String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
        return `<${key} xsi:type="xsd:string">${escaped}</${key}>`;
      })
      .join('\n      ');

    return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope
    xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/"
    xmlns:tns="urn:xmds"
    xmlns:types="urn:xmds/encodedTypes"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
    <tns:${method}>
      ${paramElements}
    </tns:${method}>
  </soap:Body>
</soap:Envelope>`;
  }

  /**
   * Rewrite XMDS URL for Electron proxy.
   * If running inside the Electron shell, use the local proxy to avoid CORS.
   * Detection: preload.js exposes window.electronAPI.isElectron = true,
   * or fallback to checking localhost:8765 (default Electron server port).
   */
  rewriteXmdsUrl(cmsUrl) {
    if (typeof window !== 'undefined' &&
        (window.electronAPI?.isElectron ||
         (window.location.hostname === 'localhost' && window.location.port === '8765'))) {
      const encodedCmsUrl = encodeURIComponent(cmsUrl);
      return `/xmds-proxy?cms=${encodedCmsUrl}`;
    }

    return `${cmsUrl}/xmds.php`;
  }

  /**
   * Call XMDS SOAP method
   */
  async call(method, params = {}) {
    const xmdsUrl = this.rewriteXmdsUrl(this.config.cmsAddress);
    const url = `${xmdsUrl}${xmdsUrl.includes('?') ? '&' : '?'}v=${this.schemaVersion}&method=${method}`;
    const body = this.buildEnvelope(method, params);

    log.debug(`${method}`, params);
    log.debug(`URL: ${url}`);

    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8'
      },
      body
    }, this.retryOptions);

    if (!response.ok) {
      throw new Error(`XMDS ${method} failed: ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();
    return this.parseResponse(xml, method);
  }

  /**
   * Parse SOAP response
   */
  parseResponse(xml, method) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    // Check for SOAP fault (handle namespace prefix like soap:Fault)
    let fault = doc.querySelector('Fault');
    if (!fault) {
      fault = Array.from(doc.querySelectorAll('*')).find(
        el => el.localName === 'Fault' || el.tagName.endsWith(':Fault')
      );
    }
    if (fault) {
      const faultString = fault.querySelector('faultstring')?.textContent
        || Array.from(fault.querySelectorAll('*')).find(el => el.localName === 'faultstring')?.textContent
        || 'Unknown SOAP fault';
      throw new Error(`SOAP Fault: ${faultString}`);
    }

    // Extract response element (handle namespace prefixes like ns1:MethodResponse)
    const responseTag = `${method}Response`;
    let responseEl = doc.querySelector(responseTag);
    if (!responseEl) {
      responseEl = Array.from(doc.querySelectorAll('*')).find(
        el => el.localName === responseTag || el.tagName.endsWith(':' + responseTag)
      );
    }

    if (!responseEl) {
      throw new Error(`No ${responseTag} element in SOAP response`);
    }

    const returnEl = responseEl.firstElementChild;
    if (!returnEl) {
      return null;
    }

    return returnEl.textContent;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * RegisterDisplay - authenticate and get settings
   */
  async registerDisplay() {
    const os = `${navigator.platform} ${navigator.userAgent}`;

    const xml = await this.call('RegisterDisplay', {
      serverKey: this.config.cmsKey,
      hardwareKey: this.config.hardwareKey,
      displayName: this.config.displayName,
      clientType: this.config.clientType || 'chromeOS',
      clientVersion: this.config.clientVersion || '0.1.0',
      clientCode: this.config.clientCode || '1',
      operatingSystem: os,
      macAddress: this.config.macAddress || 'n/a',
      xmrChannel: this.config.xmrChannel,
      xmrPubKey: this.config.xmrPubKey || '',
      licenceResult: 'licensed'
    });

    return this.parseRegisterDisplayResponse(xml);
  }

  /**
   * Parse RegisterDisplay XML response
   */
  parseRegisterDisplayResponse(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    const display = doc.querySelector('display');
    if (!display) {
      throw new Error('Invalid RegisterDisplay response: no <display> element');
    }

    const code = display.getAttribute('code');
    const message = display.getAttribute('message');

    if (code !== 'READY') {
      return { code, message, settings: null };
    }

    const settings = {};
    const tags = [];
    for (const child of display.children) {
      const name = child.tagName.toLowerCase();
      if (name === 'commands' || name === 'file') continue;
      if (name === 'tags') {
        // Parse <tags><tag>value</tag>...</tags> into array
        for (const tagEl of child.querySelectorAll('tag')) {
          if (tagEl.textContent) tags.push(tagEl.textContent);
        }
        continue;
      }
      settings[child.tagName] = child.textContent;
    }

    const checkRf = display.getAttribute('checkRf') || '';
    const checkSchedule = display.getAttribute('checkSchedule') || '';

    // Extract sync group config if present (multi-display sync coordination)
    const syncGroupVal = settings.syncGroup || null;
    const syncConfig = syncGroupVal ? {
      syncGroup: syncGroupVal,
      syncPublisherPort: parseInt(settings.syncPublisherPort || '9590', 10),
      syncSwitchDelay: parseInt(settings.syncSwitchDelay || '750', 10),
      syncVideoPauseDelay: parseInt(settings.syncVideoPauseDelay || '100', 10),
      isLead: syncGroupVal === 'lead',
    } : null;

    return { code, message, settings, tags, checkRf, checkSchedule, syncConfig };
  }

  /**
   * RequiredFiles - get list of files to download
   */
  async requiredFiles() {
    const xml = await this.call('RequiredFiles', {
      serverKey: this.config.cmsKey,
      hardwareKey: this.config.hardwareKey
    });

    return this.parseRequiredFilesResponse(xml);
  }

  /**
   * Parse RequiredFiles XML response
   */
  parseRequiredFilesResponse(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    const files = [];
    for (const fileEl of doc.querySelectorAll('file')) {
      files.push({
        type: fileEl.getAttribute('type'),
        id: fileEl.getAttribute('id'),
        size: parseInt(fileEl.getAttribute('size') || '0'),
        md5: fileEl.getAttribute('md5'),
        download: fileEl.getAttribute('download'),
        path: fileEl.getAttribute('path'),
        code: fileEl.getAttribute('code'),
        layoutid: fileEl.getAttribute('layoutid'),
        regionid: fileEl.getAttribute('regionid'),
        mediaid: fileEl.getAttribute('mediaid')
      });
    }

    return files;
  }

  /**
   * Schedule - get layout schedule
   */
  async schedule() {
    const xml = await this.call('Schedule', {
      serverKey: this.config.cmsKey,
      hardwareKey: this.config.hardwareKey
    });

    return parseScheduleResponse(xml);
  }

  /**
   * GetResource - get rendered widget HTML
   */
  async getResource(layoutId, regionId, mediaId) {
    const xml = await this.call('GetResource', {
      serverKey: this.config.cmsKey,
      hardwareKey: this.config.hardwareKey,
      layoutId: String(layoutId),
      regionId: String(regionId),
      mediaId: String(mediaId)
    });

    return xml;
  }

  /**
   * NotifyStatus - report current status
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

    return await this.call('NotifyStatus', {
      serverKey: this.config.cmsKey,
      hardwareKey: this.config.hardwareKey,
      status: JSON.stringify(status)
    });
  }

  /**
   * MediaInventory - report downloaded files
   */
  async mediaInventory(inventoryXml) {
    return await this.call('MediaInventory', {
      serverKey: this.config.cmsKey,
      hardwareKey: this.config.hardwareKey,
      mediaInventory: inventoryXml
    });
  }

  /**
   * BlackList - report broken media to CMS
   * @param {string} mediaId - The media file ID
   * @param {string} type - File type ('media' or 'layout')
   * @param {string} reason - Reason for blacklisting
   * @returns {Promise<boolean>}
   */
  async blackList(mediaId, type, reason) {
    try {
      const xml = await this.call('BlackList', {
        serverKey: this.config.cmsKey,
        hardwareKey: this.config.hardwareKey,
        mediaId: String(mediaId),
        type: type || 'media',
        reason: reason || 'Failed to render'
      });
      log.info(`BlackListed ${type}/${mediaId}: ${reason}`);
      return xml === 'true';
    } catch (error) {
      log.warn('BlackList failed:', error);
      return false;
    }
  }

  /**
   * SubmitLog - submit player logs to CMS for remote debugging
   * @param {string} logXml - XML string containing log entries
   * @returns {Promise<boolean>} - true if logs were successfully submitted
   */
  async submitLog(logXml) {
    const xml = await this.call('SubmitLog', {
      serverKey: this.config.cmsKey,
      hardwareKey: this.config.hardwareKey,
      logXml: logXml
    });

    return xml === 'true';
  }

  /**
   * SubmitScreenShot - submit screenshot to CMS for display verification
   * @param {string} base64Image - Base64-encoded PNG image data
   * @returns {Promise<boolean>} - true if screenshot was successfully submitted
   */
  async submitScreenShot(base64Image) {
    const xml = await this.call('SubmitScreenShot', {
      serverKey: this.config.cmsKey,
      hardwareKey: this.config.hardwareKey,
      screenShot: base64Image
    });

    return xml === 'true';
  }

  /**
   * SubmitStats - submit proof of play statistics
   * @param {string} statsXml - XML-encoded stats string
   * @returns {Promise<boolean>} - true if stats were successfully submitted
   */
  /**
   * ReportFaults - submit fault data to CMS for dashboard alerts
   * @param {string} faultJson - JSON-encoded fault data
   * @returns {Promise<boolean>}
   */
  async reportFaults(faultJson) {
    return this.call('ReportFaults', {
      serverKey: this.config.cmsKey,
      hardwareKey: this.config.hardwareKey,
      fault: faultJson
    });
  }

  /**
   * GetWeather - get current weather data for schedule criteria
   * @returns {Promise<string>} Weather data XML from CMS
   */
  async getWeather() {
    return this.call('GetWeather', {
      serverKey: this.config.cmsKey,
      hardwareKey: this.config.hardwareKey
    });
  }

  async submitStats(statsXml) {
    try {
      const xml = await this.call('SubmitStats', {
        serverKey: this.config.cmsKey,
        hardwareKey: this.config.hardwareKey,
        statXml: statsXml
      });

      const success = xml === 'true';
      log.info(`SubmitStats result: ${success}`);
      return success;
    } catch (error) {
      log.error('SubmitStats failed:', error);
      throw error;
    }
  }
}
