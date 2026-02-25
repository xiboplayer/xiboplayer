/**
 * PlayerCore - Platform-independent orchestration module
 *
 * Pure orchestration logic without platform-specific concerns (UI, DOM, storage).
 * Can be reused across PWA, Electron, mobile platforms.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────┐
 * │ PlayerCore (Pure Orchestration)                     │
 * │ - Collection cycle coordination                     │
 * │ - Schedule checking                                 │
 * │ - Layout transition logic                           │
 * │ - Event emission (not DOM manipulation)             │
 * │ - XMDS communication                                │
 * │ - XMR integration                                   │
 * └─────────────────────────────────────────────────────┘
 *                          ↓
 * ┌─────────────────────────────────────────────────────┐
 * │ Platform Layer (PWA/Electron/Mobile)                │
 * │ - UI updates (status display, progress bars)        │
 * │ - DOM manipulation                                  │
 * │ - Platform-specific storage                         │
 * │ - Blob URL management                               │
 * │ - Event listeners for PlayerCore events             │
 * └─────────────────────────────────────────────────────┘
 *
 * Usage:
 *   const core = new PlayerCore({
 *     config,
 *     xmds,
 *     cache,
 *     schedule,
 *     renderer,
 *     xmrWrapper
 *   });
 *
 *   // Listen to events
 *   core.on('collection-start', () => { ... });
 *   core.on('layout-ready', (layoutId) => { ... });
 *
 *   // Start collection
 *   await core.collect();
 */

import { EventEmitter, createLogger, applyCmsLogLevel } from '@xiboplayer/utils';
import { calculateTimeline, parseLayoutDuration } from '@xiboplayer/schedule';
import { CacheAnalyzer } from '@xiboplayer/cache';
import { DataConnectorManager } from './data-connectors.js';

const log = createLogger('PlayerCore');

// IndexedDB database/store for offline cache
const OFFLINE_DB_NAME = 'xibo-offline-cache';
const OFFLINE_DB_VERSION = 1;
const OFFLINE_STORE = 'cache';

/** Extract layout ID from a schedule filename like "123.xlf" */
function parseLayoutFile(f) {
  return parseInt(String(f).replace('.xlf', ''), 10);
}

/** Open the offline cache IndexedDB (creates store on first use) */
function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
        db.createObjectStore(OFFLINE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class PlayerCore extends EventEmitter {
  constructor(options) {
    super();

    // Required dependencies (injected)
    this.config = options.config;
    this.xmds = options.xmds;
    this.cache = options.cache;
    this.schedule = options.schedule;
    this.renderer = options.renderer;
    this.XmrWrapper = options.xmrWrapper;
    this.statsCollector = options.statsCollector; // Optional: proof of play tracking
    this.displaySettings = options.displaySettings; // Optional: CMS display settings manager

    // Data connectors manager (real-time data for widgets)
    this.dataConnectorManager = new DataConnectorManager();

    // State
    this.xmr = null;
    this.currentLayoutId = null;
    this.collecting = false;
    this.collectionInterval = null;
    this.pendingLayouts = new Map(); // layoutId -> required media IDs
    this.offlineMode = false; // Track whether we're currently in offline mode
    this._normalCollectInterval = null; // Saved interval to restore after offline retry
    this._offlineRetrySeconds = 0; // Current backoff interval (0 = not retrying)

    // CRC32 checksums for skip optimization (avoid redundant XMDS calls)
    this._lastCheckRf = null;
    this._lastCheckSchedule = null;

    // Layout override state (for changeLayout/overlayLayout via XMR → revertToSchedule)
    this._layoutOverride = null; // { layoutId, type: 'change'|'overlay' }
    this._lastRequiredFiles = []; // Track files for MediaInventory

    // Scheduled commands tracking (avoid re-executing same command)
    this._executedCommands = new Set();

    // Display commands from RegisterDisplay (used by XMR commandAction)
    this.displayCommands = null;

    // Fault reporting agent (independent timer, faster than collection cycle)
    this._faultReportingInterval = null;
    this._faultReportingSeconds = 60; // Default: check for faults every 60s

    // Unsafe layout blacklist: layoutId → { failures: number, blacklisted: boolean, reason: string }
    this._layoutBlacklist = new Map();
    this._blacklistThreshold = 3; // Consecutive failures before blacklisting

    // Status tracking for NotifyStatus enrichment
    this._lastLayoutChangeTime = null; // ISO timestamp of last layout switch
    this._statusCode = 2; // 1=running, 2=downloading, 3=error

    // Schedule cycle state (round-robin through multiple layouts)
    this._currentLayoutIndex = 0;

    // Multi-display sync configuration (from RegisterDisplay syncGroup settings)
    this.syncConfig = null;
    this.syncManager = null; // Optional: set via setSyncManager() after RegisterDisplay

    // Layout durations for timeline calculation (layoutFile/layoutId → seconds)
    this._layoutDurations = new Map();

    // Cache analyzer for stale media detection and storage health
    this.cacheAnalyzer = this.cache ? new CacheAnalyzer(this.cache) : null;

    // In-memory offline cache (populated from IndexedDB on first load)
    this._offlineCache = { schedule: null, settings: null, requiredFiles: null };
    this._offlineDbReady = this._initOfflineCache();
  }

  // ── Offline Cache (IndexedDB) ──────────────────────────────────────

  /** Load offline cache from IndexedDB into memory on startup */
  async _initOfflineCache() {
    try {
      const db = await openOfflineDb();
      const tx = db.transaction(OFFLINE_STORE, 'readonly');
      const store = tx.objectStore(OFFLINE_STORE);

      const [schedule, settings, requiredFiles] = await Promise.all([
        new Promise(r => { const req = store.get('schedule'); req.onsuccess = () => r(req.result ?? null); req.onerror = () => r(null); }),
        new Promise(r => { const req = store.get('settings'); req.onsuccess = () => r(req.result ?? null); req.onerror = () => r(null); }),
        new Promise(r => { const req = store.get('requiredFiles'); req.onsuccess = () => r(req.result ?? null); req.onerror = () => r(null); }),
      ]);

      this._offlineCache = { schedule, settings, requiredFiles };
      db.close();
      log.info('Offline cache loaded from IndexedDB',
        schedule ? '(has schedule)' : '(empty)');
    } catch (e) {
      log.warn('Failed to load offline cache from IndexedDB:', e);
    }
  }

  /** Save a key to both in-memory cache and IndexedDB (fire-and-forget) */
  async _offlineSave(key, data) {
    this._offlineCache[key] = data;
    try {
      const db = await openOfflineDb();
      const tx = db.transaction(OFFLINE_STORE, 'readwrite');
      tx.objectStore(OFFLINE_STORE).put(data, key);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (e) {
      log.warn('Failed to save offline cache:', key, e);
    }
  }

  /** Check if we have any cached data to fall back on */
  hasCachedData() {
    return this._offlineCache.schedule !== null;
  }

  /** Check if the browser reports being offline */
  isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  /** Check if currently in offline mode */
  isInOfflineMode() {
    return this.offlineMode;
  }

  /**
   * Run an offline collection cycle using cached data.
   * Evaluates the cached schedule and continues playback.
   */
  collectOffline() {
    log.warn('Offline mode — using cached schedule');

    if (!this.offlineMode) {
      this.offlineMode = true;
      this.emit('offline-mode', true);
    }

    // Exponential backoff: 30s → 60s → 120s → ... → capped at normal interval
    // Recovers quickly from brief outages but doesn't hammer when truly offline
    if (this.collectionInterval) {
      if (!this._normalCollectInterval) {
        this._normalCollectInterval = this._currentCollectInterval;
        this._offlineRetrySeconds = 30;
      } else {
        // Double the backoff, cap at normal interval
        this._offlineRetrySeconds = Math.min(
          this._offlineRetrySeconds * 2,
          this._normalCollectInterval
        );
      }
      this._setCollectionTimer(this._offlineRetrySeconds);
      log.info(`Offline: retry in ${this._offlineRetrySeconds}s`);
    }

    // Load cached settings for collection interval (first run only)
    if (!this.collectionInterval) {
      const cachedReg = this._offlineCache.settings;
      if (cachedReg?.settings) {
        this.setupCollectionInterval(cachedReg.settings);
        this._normalCollectInterval = this._currentCollectInterval;
        this._offlineRetrySeconds = 30;
        this._setCollectionTimer(this._offlineRetrySeconds);
        log.info(`Offline: retry in ${this._offlineRetrySeconds}s`);
      }
    }

    // Load cached schedule and apply it
    const cachedSchedule = this._offlineCache.schedule;
    if (cachedSchedule) {
      this.schedule.setSchedule(cachedSchedule);
      this.emit('schedule-received', cachedSchedule);
    }

    // Evaluate current schedule
    const layoutFiles = this.schedule.getCurrentLayouts();
    log.info('Offline layouts:', layoutFiles);
    this.emit('layouts-scheduled', layoutFiles);

    this._evaluateAndSwitchLayout(layoutFiles, 'Offline');

    this.emit('collection-complete');
  }

  /**
   * Evaluate the current schedule and switch layouts if needed.
   * Shared by both collect() and collectOffline() after emitting 'layouts-scheduled'.
   * @param {string[]} layoutFiles - Currently scheduled layout filenames
   * @param {string} context - Log context label (e.g. 'Offline' or '')
   */
  async _evaluateAndSwitchLayout(layoutFiles, context) {
    const prefix = context ? `${context}: ` : '';

    if (layoutFiles.length > 0) {
      if (this.currentLayoutId) {
        const currentStillScheduled = layoutFiles.some(f =>
          parseLayoutFile(f) === this.currentLayoutId
        );
        if (currentStillScheduled) {
          const idx = layoutFiles.findIndex(f =>
            parseLayoutFile(f) === this.currentLayoutId
          );
          if (idx >= 0) this._currentLayoutIndex = idx;
          log.debug(`Layout ${this.currentLayoutId} still in schedule${context ? ` (${context.toLowerCase()})` : ''}, continuing playback`);
          this.emit('layout-already-playing', this.currentLayoutId);
        } else {
          this._currentLayoutIndex = 0;
          const next = this.getNextLayout();
          if (next) {
            log.info(`${prefix}switching to layout ${next.layoutId}${!context ? ` (from ${this.currentLayoutId})` : ''}`);
            this.emit('layout-prepare-request', next.layoutId);
          }
        }
      } else {
        this._currentLayoutIndex = 0;
        const next = this.getNextLayout();
        if (next) {
          log.info(`${prefix}switching to layout ${next.layoutId}`);
          this.emit('layout-prepare-request', next.layoutId);
        }
      }
    } else {
      log.info(`${context ? `${context}: n` : 'N'}o layouts${context ? ' in cached schedule' : ' scheduled, falling back to default'}`);
      this.emit('no-layouts-scheduled');
    }

    // Build layout durations and log upcoming timeline
    await this._buildLayoutDurations();
    this.logUpcomingTimeline();
  }

  /**
   * Force an immediate collection (used by platform layer on 'online' event)
   */
  async collectNow() {
    this._lastCheckRf = null;
    this._lastCheckSchedule = null;
    return this.collect();
  }

  /**
   * Start collection cycle
   * Pure orchestration - emits events instead of updating UI
   */
  async collect() {
    // Prevent concurrent collections
    if (this.collecting) {
      log.debug('Collection already in progress, skipping');
      return;
    }

    this.collecting = true;

    try {
      // Ensure offline cache is loaded from IndexedDB before checking
      await this._offlineDbReady;

      log.info('Starting collection cycle...');
      this.emit('collection-start');

      // Check if browser reports offline
      if (this.isOffline()) {
        if (this.hasCachedData()) {
          return this.collectOffline();
        }
        throw new Error('Offline with no cached data — cannot start playback');
      }

      // Ensure RSA key pair exists before registering
      if (this.config.ensureXmrKeyPair) {
        await this.config.ensureXmrKeyPair();
      }

      // Register display
      log.debug('Collection step: registerDisplay');
      const regResult = await this.xmds.registerDisplay();
      log.info(`Display registered: ${regResult.code}${regResult.tags?.length ? `, tags: ${regResult.tags.join(', ')}` : ''}`);
      log.debug('Register result:', JSON.stringify(regResult));

      // Cache settings for offline use
      this._offlineSave('settings', regResult);

      // Exit offline mode if we were in it
      if (this.offlineMode) {
        this.offlineMode = false;
        log.info('Back online — resuming normal collection');
        this.emit('offline-mode', false);

        // Restore normal collection interval (was shortened for offline retry)
        if (this._normalCollectInterval) {
          this._setCollectionTimer(this._normalCollectInterval);
          this._normalCollectInterval = null;
          this._offlineRetrySeconds = 0;
        }
      }

      // Apply display settings if DisplaySettings manager is available
      if (this.displaySettings && regResult.settings) {
        const result = this.displaySettings.applySettings(regResult.settings);
        if (result.changed.includes('collectInterval')) {
          // Collection interval changed - update interval
          this.updateCollectionInterval(result.settings.collectInterval);
        }

        // Apply CMS logLevel (respects local overrides)
        if (regResult.settings.logLevel) {
          const applied = applyCmsLogLevel(regResult.settings.logLevel);
          if (applied) {
            log.info('Log level updated from CMS:', regResult.settings.logLevel);
            this.emit('log-level-changed', regResult.settings.logLevel);
          }
        }
      }

      // Pass display properties to schedule for criteria evaluation
      if (this.schedule?.setDisplayProperties && regResult.settings) {
        this.schedule.setDisplayProperties(regResult.settings);
      }

      // Store sync config if display is in a sync group
      if (regResult.syncConfig) {
        this.syncConfig = regResult.syncConfig;
        log.info('Sync group:', regResult.syncConfig.isLead ? 'LEAD' : `follower → ${regResult.syncConfig.syncGroup}`,
          `(switchDelay: ${regResult.syncConfig.syncSwitchDelay}ms, videoPauseDelay: ${regResult.syncConfig.syncVideoPauseDelay}ms)`);
        this.emit('sync-config', regResult.syncConfig);
      }

      // Extract config from display tags (key|value convention)
      this._applyTagConfig(regResult.tags);

      // Store display commands for XMR commandAction resolution
      if (regResult.commands && regResult.commands.length > 0) {
        this.displayCommands = {};
        for (const cmd of regResult.commands) {
          this.displayCommands[cmd.commandCode] = cmd;
        }
        log.debug('Display commands:', Object.keys(this.displayCommands).join(', '));
      }

      this.emit('register-complete', regResult);

      // Initialize XMR if available
      log.debug('Collection step: initializeXmr');
      await this.initializeXmr(regResult);

      // CRC32 skip optimization: only fetch RequiredFiles/Schedule when CMS data changed
      const checkRf = regResult.checkRf || '';
      const checkSchedule = regResult.checkSchedule || '';

      // Get required files (skip if CRC unchanged)
      if (!this._lastCheckRf || this._lastCheckRf !== checkRf) {
        // RequiredFiles changed — CMS may have fixed broken layouts
        this.resetBlacklist();

        log.debug('Collection step: requiredFiles');
        const rfResult = await this.xmds.requiredFiles();
        // RequiredFiles returns { files, purge } — files to download, items to delete
        const files = rfResult.files || rfResult;
        const purgeItems = rfResult.purge || [];
        log.info('Required files:', files.length, purgeItems.length > 0 ? `(+ ${purgeItems.length} purge)` : '');
        this._lastCheckRf = checkRf;
        this.emit('files-received', files);

        // Cache required files for offline use
        this._offlineSave('requiredFiles', rfResult);

        if (purgeItems.length > 0) {
          this.emit('purge-request', purgeItems);
        }

        // Get schedule (skip if CRC unchanged)
        if (!this._lastCheckSchedule || this._lastCheckSchedule !== checkSchedule) {
          log.debug('Collection step: schedule');
          const schedule = await this.xmds.schedule();
          log.info('Schedule received');
          this._lastCheckSchedule = checkSchedule;
          log.debug('Collection step: processing schedule');
          this.emit('schedule-received', schedule);
          this.schedule.setSchedule(schedule);
          this._executedCommands.clear();
          this.updateDataConnectors();
          this._offlineSave('schedule', schedule);
          this.logUpcomingTimeline();
        }

        log.debug('Collection step: download-request + mediaInventory');
        const currentLayouts = this.schedule.getCurrentLayouts();

        // Layout IDs in playback order (rotated from current index)
        const layoutIds = currentLayouts.map(f => parseLayoutFile(f));
        const layoutOrder = [];
        for (let i = 0; i < layoutIds.length; i++) {
          const idx = (this._currentLayoutIndex + i) % layoutIds.length;
          layoutOrder.push(layoutIds[idx]);
        }

        this._lastRequiredFiles = files;

        // Download window enforcement (#81) — skip downloads outside configured window
        if (this.displaySettings?.isInDownloadWindow && !this.displaySettings.isInDownloadWindow()) {
          const nextWindow = this.displaySettings.getNextDownloadWindow?.();
          log.info(`Outside download window, skipping downloads${nextWindow ? ` (next: ${nextWindow.toLocaleTimeString()})` : ''}`);
        } else {
          this.emit('download-request', { layoutOrder, files, layoutDependants: Object.fromEntries(this.schedule.getDependantsMap()) });
        }

        // Non-blocking cache analysis (stale media detection)
        if (this.cacheAnalyzer) {
          this.cacheAnalyzer.analyze(files).then(report => {
            this.emit('cache-analysis', report);
          }).catch(err => log.warn('Cache analysis failed:', err));
        }

        // Submit media inventory to CMS (reports cached files)
        this.submitMediaInventory(files);
      } else {
        if (checkRf) {
          log.info('RequiredFiles CRC unchanged, skipping download check');
        }
        if (this._lastCheckSchedule !== checkSchedule) {
          const schedule = await this.xmds.schedule();
          log.info('Schedule received (RF unchanged but schedule changed)');
          this._lastCheckSchedule = checkSchedule;
          this.emit('schedule-received', schedule);
          this.schedule.setSchedule(schedule);
          this._executedCommands.clear();
          this.updateDataConnectors();
          this._offlineSave('schedule', schedule);
          this.logUpcomingTimeline();
        } else if (checkSchedule) {
          log.info('Schedule CRC unchanged, skipping');
        }
      }

      // Fetch weather data for schedule criteria evaluation (#15)
      await this._fetchWeatherData();

      log.debug('Collection step: evaluateSchedule');
      // Evaluate current schedule
      const layoutFiles = this.schedule.getCurrentLayouts();
      log.info('Current layouts:', layoutFiles);
      this.emit('layouts-scheduled', layoutFiles);

      this._evaluateAndSwitchLayout(layoutFiles, '');

      // Process scheduled commands (auto-execute commands whose time has arrived)
      this._processScheduledCommands();

      // If no layouts scheduled and we're playing one that was filtered (e.g., maxPlaysPerHour),
      // force switch to default layout if available
      if (layoutFiles.length === 0 && this.currentLayoutId && this.schedule.schedule?.default) {
        const defaultLayoutId = parseLayoutFile(this.schedule.schedule.default);
        log.info(`Current layout filtered by schedule, switching to default layout ${defaultLayoutId}`);
        this.currentLayoutId = null; // Clear to force switch
        this.emit('layout-prepare-request', defaultLayoutId);
      }

      // Submit stats if enabled and collector is available
      if (regResult.settings?.statsEnabled === 'On' || regResult.settings?.statsEnabled === '1') {
        if (this.statsCollector) {
          log.info('Stats enabled, submitting proof of play');
          this.emit('submit-stats-request');
        } else {
          log.warn('Stats enabled but no StatsCollector provided');
        }
      }

      // Submit logs to CMS (always, regardless of stats setting)
      this.emit('submit-logs-request');

      // Submit faults immediately (higher priority than logs)
      this.emit('submit-faults-request');

      // Setup collection interval on first run
      if (!this.collectionInterval && regResult.settings) {
        this.setupCollectionInterval(regResult.settings);
      }

      // Start fault reporting agent (independent of collection cycle)
      if (!this._faultReportingInterval) {
        this._startFaultReportingAgent();
      }

      // Recalculate timeline after every collection cycle completes,
      // even if schedule CRC was unchanged — durations or time may have shifted.
      this.logUpcomingTimeline();

      this.emit('collection-complete');

    } catch (error) {
      // Offline fallback: if network failed but we have cached data, use it
      if (this.hasCachedData()) {
        log.warn('Collection failed, falling back to cached data:', error?.message || error);
        this.emit('collection-error', error);
        return this.collectOffline();
      }

      log.error('Collection error:', error);
      this.emit('collection-error', error);
      throw error;
    } finally {
      this.collecting = false;
    }
  }

  /**
   * Initialize XMR WebSocket connection
   */
  async initializeXmr(regResult) {
    const xmrUrl = regResult.settings?.xmrWebSocketAddress || regResult.settings?.xmrNetworkAddress;
    if (!xmrUrl) {
      log.warn('XMR not configured: no xmrWebSocketAddress or xmrNetworkAddress in CMS settings');
      this.emit('xmr-misconfigured', {
        reason: 'missing',
        message: 'XMR address not configured in CMS. Go to CMS Admin → Settings → Configuration → XMR and set the WebSocket address.',
      });
      return;
    }

    // Validate URL protocol — PWA players need ws:// or wss://, not tcp://
    if (xmrUrl.startsWith('tcp://')) {
      log.warn(`XMR address uses tcp:// protocol which is not supported by PWA players: ${xmrUrl}`);
      log.warn('Configure XMR_WS_ADDRESS in CMS Admin → Settings → Configuration → XMR (e.g. wss://your-domain/xmr)');
      this.emit('xmr-misconfigured', {
        reason: 'wrong-protocol',
        url: xmrUrl,
        message: `XMR uses tcp:// protocol (not supported by PWA). Set XMR WebSocket Address to wss://your-domain/xmr in CMS Settings.`,
      });
      return;
    }

    // Detect placeholder/example URLs
    if (/example\.(org|com|net)/i.test(xmrUrl)) {
      log.warn(`XMR address contains placeholder domain: ${xmrUrl}`);
      log.warn('Configure the real XMR address in CMS Admin → Settings → Configuration → XMR');
      this.emit('xmr-misconfigured', {
        reason: 'placeholder',
        url: xmrUrl,
        message: `XMR address is still the default placeholder (${xmrUrl}). Update it in CMS Settings.`,
      });
      return;
    }

    const xmrCmsKey = regResult.settings?.xmrCmsKey || regResult.settings?.serverKey || this.config.serverKey;
    log.debug('XMR CMS Key:', xmrCmsKey ? 'present' : 'missing');

    if (!this.xmr) {
      log.info('Initializing XMR WebSocket:', xmrUrl);
      this.xmr = new this.XmrWrapper(this.config, this);
      await this.xmr.start(xmrUrl, xmrCmsKey);
      this.emit('xmr-connected', xmrUrl);
    } else if (!this.xmr.isConnected()) {
      log.info('XMR disconnected, attempting to reconnect...');
      this.xmr.reconnectAttempts = 0;
      await this.xmr.start(xmrUrl, xmrCmsKey);
      this.emit('xmr-reconnected', xmrUrl);
    } else {
      log.debug('XMR already connected');
    }
  }

  /**
   * Setup collection interval
   */
  setupCollectionInterval(settings) {
    // Use DisplaySettings if available, otherwise fallback to raw settings
    const collectIntervalSeconds = this.displaySettings
      ? this.displaySettings.getCollectInterval()
      : parseInt(settings.collectInterval || '300', 10);

    this._setCollectionTimer(collectIntervalSeconds);
    this.emit('collection-interval-set', collectIntervalSeconds);
  }

  /**
   * Update collection interval dynamically
   * Called when CMS changes the collection interval
   */
  updateCollectionInterval(newIntervalSeconds) {
    if (this.collectionInterval) {
      this._setCollectionTimer(newIntervalSeconds);
      this.emit('collection-interval-updated', newIntervalSeconds);
    }
  }

  /**
   * Start the fault reporting agent.
   * Runs on an independent timer (default 60s) to submit faults faster
   * than the normal collection cycle (300s). This ensures the CMS dashboard
   * gets fault alerts with lower latency.
   */
  _startFaultReportingAgent() {
    if (this._faultReportingInterval) clearInterval(this._faultReportingInterval);

    log.info(`Fault reporting agent started (interval: ${this._faultReportingSeconds}s)`);
    this._faultReportingInterval = setInterval(() => {
      this.emit('submit-faults-request');
    }, this._faultReportingSeconds * 1000);
  }

  /** Internal: (re)create the collection setInterval timer */
  _setCollectionTimer(seconds) {
    if (this.collectionInterval) clearInterval(this.collectionInterval);
    this._currentCollectInterval = seconds;
    log.info(`Collection interval: ${seconds}s`);
    this.collectionInterval = setInterval(() => {
      log.debug('Running scheduled collection cycle...');
      this.collect().catch(error => {
        log.error('Collection error:', error);
        this.emit('collection-error', error);
      });
    }, seconds * 1000);
  }

  /**
   * Request layout change (called by XMR or schedule)
   * Pure orchestration - emits events for platform to handle
   */
  async requestLayoutChange(layoutId) {
    log.info(`Layout change requested: ${layoutId}`);

    // Clear current layout tracking so it will switch
    this.currentLayoutId = null;

    this.emit('layout-change-requested', layoutId);
  }

  /**
   * Mark layout as ready and current
   * Called by platform after it successfully renders the layout
   */
  setCurrentLayout(layoutId) {
    this.currentLayoutId = layoutId;
    this._lastLayoutChangeTime = new Date().toISOString();
    this._statusCode = 1; // Running
    this.pendingLayouts.delete(layoutId);
    this.emit('layout-current', layoutId);
    // Re-log timeline from current time on each layout change
    this.logUpcomingTimeline();
  }

  /**
   * Mark layout as pending (waiting for media)
   * Called by platform when layout needs media downloads
   */
  setPendingLayout(layoutId, requiredMediaIds) {
    this.pendingLayouts.set(layoutId, requiredMediaIds);
    this.emit('layout-pending', layoutId, requiredMediaIds);
  }

  /**
   * Clear current layout (for replay)
   * Called by platform when layout ends
   */
  clearCurrentLayout() {
    this.currentLayoutId = null;
    this.emit('layout-cleared');
  }

  /**
   * Get the next layout from the schedule using round-robin cycling.
   * Skips blacklisted layouts. Returns { layoutId, layoutFile } or null.
   */
  getNextLayout() {
    const layoutFiles = this.schedule.getCurrentLayouts();
    if (layoutFiles.length === 0) {
      return null;
    }

    // Wrap index in case schedule shrank
    if (this._currentLayoutIndex >= layoutFiles.length) {
      this._currentLayoutIndex = 0;
    }

    // Try each layout starting from current index, skip blacklisted
    for (let i = 0; i < layoutFiles.length; i++) {
      const idx = (this._currentLayoutIndex + i) % layoutFiles.length;
      const layoutFile = layoutFiles[idx];
      const layoutId = parseLayoutFile(layoutFile);

      if (!this.isLayoutBlacklisted(layoutId)) {
        this._currentLayoutIndex = idx;
        return { layoutId, layoutFile };
      }
    }

    // All layouts blacklisted — return first anyway to avoid blank screen
    log.warn('All scheduled layouts are blacklisted, using first layout as fallback');
    const layoutFile = layoutFiles[this._currentLayoutIndex];
    const layoutId = parseLayoutFile(layoutFile);
    return { layoutId, layoutFile };
  }

  /**
   * Peek at the next layout in the schedule without advancing the index.
   * Used by the preload system to know which layout to pre-build.
   * Returns { layoutId, layoutFile } or null if no next layout or same as current.
   */
  peekNextLayout() {
    const layoutFiles = this.schedule.getInterleavedLayouts?.() || this.schedule.getCurrentLayouts();
    if (layoutFiles.length <= 1) {
      // Single layout or empty schedule - no different layout to preload
      return null;
    }

    // Find next non-blacklisted layout
    for (let i = 1; i < layoutFiles.length; i++) {
      const idx = (this._currentLayoutIndex + i) % layoutFiles.length;
      const layoutFile = layoutFiles[idx];
      const layoutId = parseLayoutFile(layoutFile);

      if (layoutId !== this.currentLayoutId && !this.isLayoutBlacklisted(layoutId)) {
        return { layoutId, layoutFile };
      }
    }

    return null;
  }

  /**
   * Advance to the next layout in the schedule (round-robin).
   * Called by platform layer when a layout finishes (layoutEnd event).
   * Increments the index and emits layout-prepare-request for the next layout,
   * or triggers replay if only one layout is scheduled.
   */
  advanceToNextLayout() {
    // Don't cycle if we're in a layout override (XMR changeLayout/overlayLayout)
    if (this._layoutOverride) {
      log.info('Layout override active, not advancing schedule');
      return;
    }

    const layoutFiles = this.schedule.getInterleavedLayouts?.() || this.schedule.getCurrentLayouts();
    log.info(`Advancing schedule: ${layoutFiles.length} layout(s) available, current index ${this._currentLayoutIndex}`);

    // ── Never-stop guarantee ────────────────────────────────────────
    // If no layouts are available at all (every layout is rate-limited
    // or filtered), replay the current layout as a last resort.
    // maxPlaysPerHour is respected in all other cases — this only fires
    // when the alternative would be a blank screen.
    if (layoutFiles.length === 0) {
      if (this.currentLayoutId) {
        log.info(`No layouts available (all rate-limited), replaying ${this.currentLayoutId} to avoid blank screen`);
        const replayId = this.currentLayoutId;
        this.currentLayoutId = null;
        this.emit('layout-prepare-request', replayId);
      } else {
        log.info('No layouts scheduled during advance');
        this.emit('no-layouts-scheduled');
      }
      return;
    }

    // Find next non-blacklisted layout (wraps around, tries all)
    let layoutFile, layoutId;
    for (let i = 1; i <= layoutFiles.length; i++) {
      const idx = (this._currentLayoutIndex + i) % layoutFiles.length;
      const file = layoutFiles[idx];
      const id = parseLayoutFile(file);

      if (!this.isLayoutBlacklisted(id)) {
        this._currentLayoutIndex = idx;
        layoutFile = file;
        layoutId = id;
        break;
      }
    }

    // All layouts blacklisted — fall back to replaying current
    if (!layoutFile) {
      if (this.currentLayoutId) {
        log.warn('All layouts blacklisted, replaying current to avoid blank screen');
        const replayId = this.currentLayoutId;
        this.currentLayoutId = null;
        this.emit('layout-prepare-request', replayId);
      } else {
        this.emit('no-layouts-scheduled');
      }
      return;
    }

    // Multi-display sync: if this is a sync event and we have a SyncManager,
    // delegate layout transitions to the sync protocol
    if (this.syncManager && this.schedule.isSyncEvent(layoutFile)) {
      if (this.isSyncLead()) {
        // Lead: coordinate with followers before showing
        log.info(`[Sync] Lead requesting coordinated layout change: ${layoutId}`);
        this.syncManager.requestLayoutChange(layoutId).catch(err => {
          log.error('[Sync] Layout change failed:', err);
          // Fallback: show layout anyway
          this.emit('layout-prepare-request', layoutId);
        });
        return;
      } else {
        // Follower: don't advance independently — wait for lead's layout-change signal
        log.info(`[Sync] Follower waiting for lead signal (not advancing independently)`);
        return;
      }
    }

    if (layoutId === this.currentLayoutId) {
      // Same layout (single layout schedule or wrapped back) — trigger replay
      log.info(`Next layout ${layoutId} is same as current, triggering replay`);
      this.currentLayoutId = null; // Clear to allow re-render
    }

    log.info(`Advancing to layout ${layoutId} (index ${this._currentLayoutIndex}/${layoutFiles.length})`);
    this.emit('layout-prepare-request', layoutId);
  }

  /**
   * Go back to the previous layout in the schedule (round-robin, wraps around).
   * Called by platform layer in response to manual navigation (keyboard/remote).
   * Skips sync-manager logic — manual navigation is local only.
   */
  advanceToPreviousLayout() {
    if (this._layoutOverride) {
      log.info('Layout override active, not going back');
      return;
    }

    const layoutFiles = this.schedule.getCurrentLayouts();
    if (layoutFiles.length === 0) return;

    // Decrement index (wrap around)
    const prevIndex = (this._currentLayoutIndex - 1 + layoutFiles.length) % layoutFiles.length;

    const layoutFile = layoutFiles[prevIndex];
    const layoutId = parseLayoutFile(layoutFile);

    // No-op if it's the same layout (single-layout schedule) — don't restart
    if (layoutId === this.currentLayoutId) {
      log.info('Only one layout in schedule, nothing to go back to');
      return;
    }

    this._currentLayoutIndex = prevIndex;
    log.info(`Going back to layout ${layoutId} (index ${this._currentLayoutIndex}/${layoutFiles.length})`);
    this.emit('layout-prepare-request', layoutId);
  }

  /**
   * Notify that a file is ready (called by platform for both layout and media files)
   * Checks if any pending layouts can now be rendered
   */
  notifyMediaReady(fileId, fileType = 'media') {
    log.debug(`File ${fileId} ready (${fileType})`);

    // Check if any pending layouts are now complete
    for (const [layoutId, requiredFiles] of this.pendingLayouts.entries()) {
      // Check if this file is needed by this layout
      // For layout files: match layout ID with file ID (layout 78 needs layout/78)
      // For media files: check if fileId is in requiredFiles array
      const isLayoutFile = fileType === 'layout' && layoutId === parseInt(fileId);
      const isRequiredMedia = fileType === 'media' && requiredFiles.includes(parseInt(fileId));

      if (isLayoutFile || isRequiredMedia) {
        log.debug(`${fileType} ${fileId} was needed by pending layout ${layoutId}, checking if ready...`);
        this.emit('check-pending-layout', layoutId, requiredFiles);
      }
    }
  }

  /**
   * Notify layout status to CMS
   */
  async notifyLayoutStatus(layoutId) {
    try {
      const status = {
        currentLayoutId: layoutId,
        deviceName: this.config?.displayName || '',
        displayName: this.config?.displayName || '',
        lastCommandSuccess: this._lastCommandSuccess ?? true,
        code: this._statusCode,
        lastLayoutChangeTime: this._lastLayoutChangeTime || new Date().toISOString(),
      };

      // Add geo-location if available
      if (this.config?.latitude) status.latitude = this.config.latitude;
      if (this.config?.longitude) status.longitude = this.config.longitude;

      await this.xmds.notifyStatus(status);
      this.emit('status-notified', layoutId);
    } catch (error) {
      log.warn('Failed to notify status:', error);
      this.emit('status-notify-failed', layoutId, error);
    }
  }

  /**
   * Report geo location (called by XMR when CMS pushes coordinates)
   * Updates schedule location for geo-fencing and triggers schedule re-evaluation.
   * @param {Object} data - { latitude, longitude }
   */
  reportGeoLocation(data) {
    const lat = parseFloat(data?.latitude);
    const lng = parseFloat(data?.longitude);

    if (isNaN(lat) || isNaN(lng)) {
      log.warn('reportGeoLocation: invalid coordinates', data);
      return;
    }

    log.info(`Geo location from CMS: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);

    if (this.schedule?.setLocation) {
      this.schedule.setLocation(lat, lng);
    }

    this.emit('location-updated', { latitude: lat, longitude: lng, source: 'cms' });
    this.checkSchedule();
  }

  /**
   * Request geo location using a fallback chain:
   * 1. Browser Geolocation API (GPS / OS-level)
   * 2. Google Geolocation API (if GOOGLE_GEO_API_KEY is configured)
   * 3. IP-based geolocation (free, no key required)
   * @returns {Promise<{latitude: number, longitude: number}|null>}
   */
  async requestGeoLocation() {
    // Try browser geolocation first (works with GPS or Google API key baked into Chromium)
    const browser = await this._tryBrowserGeolocation();
    if (browser) return this._applyLocation(browser.latitude, browser.longitude, 'browser');

    // Try Google Geolocation API if key is configured
    const apiKey = this.config?.googleGeoApiKey;
    if (apiKey) {
      const google = await this._tryGoogleGeolocation(apiKey);
      if (google) return this._applyLocation(google.latitude, google.longitude, 'google-api');
    }

    // Fall back to IP-based geolocation (free, no key)
    const ip = await this._tryIpGeolocation();
    if (ip) return this._applyLocation(ip.latitude, ip.longitude, 'ip-geolocation');

    log.warn('All geolocation methods failed');
    return null;
  }

  /**
   * Apply a resolved location: update schedule, emit event, trigger re-evaluation.
   * @param {number} lat
   * @param {number} lng
   * @param {string} source - 'browser' | 'google-api' | 'ip-geolocation'
   * @returns {{latitude: number, longitude: number}}
   * @private
   */
  /**
   * Extract config values from CMS display tags using key|value convention.
   * Tags like "geoApiKey|AIzaSy..." are parsed and applied to player config.
   * @param {string[]} tags - Array of tag strings from RegisterDisplay
   * @private
   */
  _applyTagConfig(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return;

    const TAG_CONFIG_MAP = {
      'geoApiKey': 'googleGeoApiKey',
    };

    for (const tag of tags) {
      const pipeIdx = tag.indexOf('|');
      if (pipeIdx === -1) continue;

      const key = tag.substring(0, pipeIdx);
      const value = tag.substring(pipeIdx + 1);
      const configKey = TAG_CONFIG_MAP[key];

      if (configKey && value && this.config) {
        log.info(`Config from CMS tag: ${key} → ${configKey}`);
        this.config[configKey] = value;
      }
    }
  }

  _applyLocation(lat, lng, source) {
    log.info(`Geolocation (${source}): ${lat.toFixed(4)}, ${lng.toFixed(4)}`);

    if (this.schedule?.setLocation) {
      this.schedule.setLocation(lat, lng);
    }

    this.emit('location-updated', { latitude: lat, longitude: lng, source });
    this.checkSchedule();

    return { latitude: lat, longitude: lng };
  }

  /**
   * Try the browser Geolocation API (navigator.geolocation).
   * @returns {Promise<{latitude: number, longitude: number}|null>}
   * @private
   */
  async _tryBrowserGeolocation() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return null;

    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 10000,
          maximumAge: 300000, // 5 minutes
          enableHighAccuracy: false
        });
      });
      return { latitude: position.coords.latitude, longitude: position.coords.longitude };
    } catch (error) {
      log.warn('Browser geolocation failed:', error?.message || error);
      return null;
    }
  }

  /**
   * Try Google Geolocation API (direct HTTPS POST, bypasses Chromium's built-in service).
   * @param {string} apiKey - Google API key
   * @returns {Promise<{latitude: number, longitude: number}|null>}
   * @private
   */
  async _tryGoogleGeolocation(apiKey) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/geolocation/v1/geolocate?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ considerIp: true }),
          signal: AbortSignal.timeout(5000)
        }
      );
      if (!res.ok) {
        log.warn(`Google Geolocation API returned ${res.status}`);
        return null;
      }
      const data = await res.json();
      if (data.location?.lat != null && data.location?.lng != null) {
        return { latitude: data.location.lat, longitude: data.location.lng };
      }
      return null;
    } catch (error) {
      log.warn('Google Geolocation API failed:', error?.message || error);
      return null;
    }
  }

  /**
   * Try IP-based geolocation using free HTTPS providers (no API key needed).
   * Tries ipapi.co first, then freeipapi.com as fallback.
   * @returns {Promise<{latitude: number, longitude: number}|null>}
   * @private
   */
  async _tryIpGeolocation() {
    const providers = [
      {
        url: 'https://ipapi.co/json/',
        parse: (data) => data.latitude != null && data.longitude != null
          ? { latitude: data.latitude, longitude: data.longitude }
          : null
      },
      {
        url: 'https://freeipapi.com/api/json',
        parse: (data) => data.latitude != null && data.longitude != null
          ? { latitude: data.latitude, longitude: data.longitude }
          : null
      }
    ];

    for (const provider of providers) {
      try {
        const res = await fetch(provider.url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const data = await res.json();
        const location = provider.parse(data);
        if (location) return location;
      } catch (error) {
        log.warn(`IP geolocation (${provider.url}) failed:`, error?.message || error);
      }
    }
    return null;
  }

  /**
   * Re-evaluate current schedule and switch layouts if needed.
   * Called after location updates or other schedule-affecting changes.
   */
  checkSchedule() {
    const layoutFiles = this.schedule.getCurrentLayouts();
    this.emit('layouts-scheduled', layoutFiles);
    this._evaluateAndSwitchLayout(layoutFiles, '');
  }

  /**
   * Capture screenshot (called by XMR wrapper)
   * Emits event for platform layer to handle
   */
  async captureScreenshot() {
    log.info('Screenshot requested');
    this.emit('screenshot-request');
  }

  /**
   * Change to a specific layout (called by XMR wrapper)
   * Tracks override state so revertToSchedule() can undo it.
   */
  async changeLayout(layoutId, options) {
    log.info('Layout change requested via XMR:', layoutId);
    const id = parseInt(layoutId, 10);
    const duration = options?.duration || 0;
    const changeMode = options?.changeMode || 'replace';
    this._layoutOverride = { layoutId: id, type: 'change', duration, changeMode };
    this.currentLayoutId = null; // Force re-render
    this.emit('layout-prepare-request', id);

    // Auto-revert after duration (if specified)
    if (duration > 0) {
      setTimeout(() => {
        if (this._layoutOverride?.layoutId === id) {
          log.info(`Layout override duration expired (${duration}s), reverting to schedule`);
          this.revertToSchedule();
        }
      }, duration * 1000);
    }
  }

  /**
   * Push an overlay layout on top of current content (called by XMR wrapper)
   * @param {number|string} layoutId - Layout to overlay
   */
  async overlayLayout(layoutId, options) {
    log.info('Overlay layout requested via XMR:', layoutId);
    const id = parseInt(layoutId, 10);
    const duration = options?.duration || 0;
    this._layoutOverride = { layoutId: id, type: 'overlay', duration };
    this.emit('overlay-layout-request', id);

    // Auto-revert after duration (if specified)
    if (duration > 0) {
      setTimeout(() => {
        if (this._layoutOverride?.layoutId === id) {
          log.info(`Overlay duration expired (${duration}s), reverting to schedule`);
          this.revertToSchedule();
        }
      }, duration * 1000);
    }
  }

  /**
   * Revert to scheduled content after changeLayout/overlayLayout override
   */
  async revertToSchedule() {
    log.info('Reverting to scheduled content');
    this._layoutOverride = null;
    this.currentLayoutId = null;
    this.emit('revert-to-schedule');

    // Re-evaluate schedule to get the right layout
    const layoutFiles = this.schedule.getCurrentLayouts();
    if (layoutFiles.length > 0) {
      const layoutFile = layoutFiles[0];
      const layoutId = parseLayoutFile(layoutFile);
      this.emit('layout-prepare-request', layoutId);
    } else {
      this.emit('no-layouts-scheduled');
    }
  }

  /**
   * Purge all cached content and re-download (called by XMR wrapper)
   */
  async purgeAll() {
    log.info('Purge all cache requested via XMR');
    this._lastCheckRf = null;
    this._lastCheckSchedule = null;
    this.emit('purge-all-request');
    // Trigger immediate re-collection after purge
    return this.collectNow();
  }

  /**
   * Execute a command (HTTP only in browser context)
   * @param {string} commandCode - The command code from CMS
   * @param {Object} commands - Commands map from display settings
   */
  async executeCommand(commandCode, commands) {
    log.info('Execute command requested:', commandCode);

    if (!commands || !commands[commandCode]) {
      log.warn('Unknown command code:', commandCode);
      this._lastCommandSuccess = false;
      this.emit('command-result', { code: commandCode, success: false, reason: 'Unknown command' });
      return;
    }

    const command = commands[commandCode];
    const commandString = command.commandString || command.value || '';

    // Only HTTP commands are possible in a browser
    if (commandString.startsWith('http|')) {
      const parts = commandString.split('|');
      const url = parts[1];
      const contentType = parts[2] || 'application/json';

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': contentType }
        });
        const success = response.ok;
        this._lastCommandSuccess = success;
        log.info(`HTTP command ${commandCode} result: ${response.status}`);
        this.emit('command-result', { code: commandCode, success, status: response.status });
      } catch (error) {
        this._lastCommandSuccess = false;
        log.error(`HTTP command ${commandCode} failed:`, error);
        this.emit('command-result', { code: commandCode, success: false, reason: error.message });
      }
    } else {
      // Emit event for platform layer (Electron/Chromium) to handle native commands
      // (shell, RS232, Android intent, etc.)
      log.info('Delegating non-HTTP command to platform layer:', commandCode);
      this.emit('execute-native-command', { code: commandCode, commandString });
    }
  }

  /**
   * Trigger a webhook action (called by XMR wrapper)
   * @param {string} triggerCode - The trigger code to fire
   */
  triggerWebhook(triggerCode) {
    log.info('Webhook trigger from XMR:', triggerCode);
    this.handleTrigger(triggerCode);
  }

  /**
   * Force refresh of data connectors (called by XMR wrapper)
   */
  refreshDataConnectors() {
    log.info('Data connector refresh requested via XMR');
    this.dataConnectorManager.refreshAll();
    this.emit('data-connectors-refreshed');
  }

  /**
   * Submit media inventory to CMS
   * Reports which files are cached and complete.
   * @param {Array} files - List of files from RequiredFiles
   */
  async submitMediaInventory(files) {
    if (!files || files.length === 0) return;

    try {
      // Build inventory XML: <files><file type="media" id="1" complete="1" md5="abc" lastChecked="123"/></files>
      // complete: use file.complete if set by caller (cache layer), default to "1"
      const now = Math.floor(Date.now() / 1000);
      const fileEntries = files
        .filter(f => ['media', 'layout', 'resource', 'dependency', 'widget'].includes(f.type))
        .map(f => {
          const complete = f.complete !== undefined ? (f.complete ? '1' : '0') : '1';
          const fileType = f.fileType ? ` fileType="${f.fileType}"` : '';
          return `<file type="${f.type}" id="${f.id}" complete="${complete}" md5="${f.md5 || ''}" lastChecked="${now}"${fileType}/>`;
        })
        .join('');
      const inventoryXml = `<files>${fileEntries}</files>`;

      await this.xmds.mediaInventory(inventoryXml);
      log.info(`Media inventory submitted: ${files.length} files`);
      this.emit('media-inventory-submitted', files.length);
    } catch (error) {
      log.warn('MediaInventory submission failed:', error);
    }
  }

  /**
   * BlackList a media file (report broken media to CMS)
   * @param {string|number} mediaId - The media ID
   * @param {string} type - File type ('media' or 'layout')
   * @param {string} reason - Reason for blacklisting
   */
  async blackList(mediaId, type, reason) {
    try {
      await this.xmds.blackList(mediaId, type, reason);
      this.emit('media-blacklisted', { mediaId, type, reason });
    } catch (error) {
      log.warn('BlackList failed:', error);
    }
  }

  /**
   * Report a layout render failure. After N consecutive failures
   * (default 3), the layout is blacklisted and skipped in schedule
   * evaluation. Blacklisted layouts are reported to CMS via the
   * BlackList XMDS method.
   *
   * @param {number} layoutId - The layout that failed
   * @param {string} reason - Human-readable failure description
   */
  reportLayoutFailure(layoutId, reason) {
    const id = Number(layoutId);
    const entry = this._layoutBlacklist.get(id) || { failures: 0, blacklisted: false, reason: '' };
    entry.failures++;
    entry.reason = reason;

    if (!entry.blacklisted && entry.failures >= this._blacklistThreshold) {
      entry.blacklisted = true;
      log.warn(`Layout ${id} blacklisted after ${entry.failures} consecutive failures: ${reason}`);
      this.emit('layout-blacklisted', { layoutId: id, reason, failures: entry.failures });

      // Report to CMS (non-blocking)
      this.blackList(id, 'layout', reason);
    } else if (!entry.blacklisted) {
      log.info(`Layout ${id} failure ${entry.failures}/${this._blacklistThreshold}: ${reason}`);
    }

    this._layoutBlacklist.set(id, entry);
  }

  /**
   * Report a successful layout render. Resets the failure counter for
   * this layout, removing it from the blacklist if it was blacklisted.
   *
   * @param {number} layoutId - The layout that rendered successfully
   */
  reportLayoutSuccess(layoutId) {
    const id = Number(layoutId);
    if (this._layoutBlacklist.has(id)) {
      const was = this._layoutBlacklist.get(id);
      this._layoutBlacklist.delete(id);
      if (was.blacklisted) {
        log.info(`Layout ${id} removed from blacklist (rendered successfully)`);
        this.emit('layout-unblacklisted', { layoutId: id });
      }
    }
  }

  /**
   * Check if a layout is currently blacklisted.
   * @param {number} layoutId
   * @returns {boolean}
   */
  isLayoutBlacklisted(layoutId) {
    const entry = this._layoutBlacklist.get(Number(layoutId));
    return entry?.blacklisted === true;
  }

  /**
   * Get all currently blacklisted layout IDs.
   * @returns {number[]}
   */
  getBlacklistedLayouts() {
    const result = [];
    for (const [id, entry] of this._layoutBlacklist) {
      if (entry.blacklisted) result.push(id);
    }
    return result;
  }

  /**
   * Reset the blacklist. Called when RequiredFiles changes (CMS may
   * have fixed broken layouts).
   */
  resetBlacklist() {
    if (this._layoutBlacklist.size > 0) {
      log.info(`Blacklist reset (${this._layoutBlacklist.size} entries cleared)`);
      this._layoutBlacklist.clear();
      this.emit('blacklist-reset');
    }
  }

  /**
   * Check if currently in a layout override (from XMR changeLayout/overlayLayout)
   */
  isLayoutOverridden() {
    return this._layoutOverride !== null;
  }

  /**
   * Handle interactive trigger (from IC or touch events)
   * Looks up matching action in schedule and executes it
   * @param {string} triggerCode - The trigger code from the IC request
   */
  handleTrigger(triggerCode) {
    const action = this.schedule.findActionByTrigger(triggerCode);
    if (!action) {
      log.debug('No scheduled action matches trigger:', triggerCode);
      return;
    }

    log.info(`Action triggered: ${action.actionType} (trigger: ${triggerCode})`);

    switch (action.actionType) {
      case 'navLayout':
      case 'navigateToLayout':
        if (action.layoutCode) {
          this.changeLayout(action.layoutCode);
        }
        break;
      case 'navWidget':
      case 'navigateToWidget':
        this.emit('navigate-to-widget', action);
        break;
      case 'command':
        this.emit('execute-command', action.commandCode);
        break;
      default:
        log.warn('Unknown action type:', action.actionType);
    }
  }

  /**
   * Update data connectors from current schedule
   * Reconfigures and restarts polling when schedule changes.
   */
  updateDataConnectors() {
    const connectors = this.schedule.getDataConnectors();

    if (connectors.length > 0) {
      log.info(`Configuring ${connectors.length} data connector(s)`);
    }

    this.dataConnectorManager.setConnectors(connectors);

    if (connectors.length > 0) {
      this.dataConnectorManager.startPolling();
      this.emit('data-connectors-started', connectors.length);
    }
  }

  /**
   * Process scheduled commands from the CMS schedule.
   * Checks for command events whose scheduled date has arrived and executes them.
   * Each command is only executed once (tracked by code+date key in _executedCommands).
   */
  _processScheduledCommands() {
    if (!this.schedule?.getCommands) return;

    const commands = this.schedule.getCommands();
    if (commands.length === 0) return;

    const now = new Date();

    for (const command of commands) {
      if (!command.code || !command.date) continue;

      // Unique key to track execution (same command can be scheduled multiple times)
      const commandKey = `${command.code}|${command.date}`;

      // Skip already executed commands
      if (this._executedCommands.has(commandKey)) continue;

      // Check if the command's scheduled time has arrived
      const commandDate = new Date(command.date);
      if (isNaN(commandDate.getTime())) {
        log.warn('Scheduled command has invalid date:', command.date);
        continue;
      }

      if (now >= commandDate) {
        log.info(`Executing scheduled command: ${command.code} (scheduled: ${command.date})`);
        this._executedCommands.add(commandKey);

        // Handle built-in commands directly
        if (command.code === 'collectNow') {
          // Trigger immediate collection on next tick (avoid re-entrance)
          setTimeout(() => this.collectNow().catch(e => log.error('collectNow command failed:', e)), 0);
        } else {
          // Emit event for platform layer to handle (reboot, restart, etc.)
          this.emit('scheduled-command', command);
        }
      }
    }
  }

  /**
   * Fetch weather data from CMS and pass to schedule for criteria evaluation.
   * Non-blocking: weather fetch failure doesn't prevent schedule evaluation.
   */
  async _fetchWeatherData() {
    if (!this.xmds?.getWeather || !this.schedule?.setWeatherData) return;

    try {
      const weatherJson = await this.xmds.getWeather();
      const weatherData = typeof weatherJson === 'string' ? JSON.parse(weatherJson) : weatherJson;
      this.schedule.setWeatherData(weatherData);
      log.info('Weather data updated:', Object.keys(weatherData).join(', '));
    } catch (e) {
      log.warn('GetWeather failed (non-critical):', e?.message || e);
    }
  }

  /**
   * Get the DataConnectorManager instance
   * Used by platform layer to serve data to widgets via IC /realtime
   * @returns {DataConnectorManager}
   */
  getDataConnectorManager() {
    return this.dataConnectorManager;
  }

  /**
   * Set the SyncManager instance for multi-display coordination.
   * Called by platform layer after RegisterDisplay returns syncConfig.
   *
   * @param {SyncManager} syncManager - SyncManager instance
   */
  setSyncManager(syncManager) {
    this.syncManager = syncManager;
    log.info('SyncManager attached:', syncManager.isLead ? 'LEAD' : 'FOLLOWER');
  }

  /**
   * Check if this display is part of a sync group
   * @returns {boolean}
   */
  isInSyncGroup() {
    return this.syncConfig !== null;
  }

  /**
   * Check if this display is the sync group leader
   * @returns {boolean}
   */
  isSyncLead() {
    return this.syncConfig?.isLead === true;
  }

  /**
   * Get sync configuration
   * @returns {Object|null} { syncGroup, syncPublisherPort, syncSwitchDelay, syncVideoPauseDelay, isLead }
   */
  getSyncConfig() {
    return this.syncConfig;
  }

  // ── Timeline (offline schedule prediction) ─────────────────────────

  /**
   * Parse all cached layout XLFs to extract durations for timeline calculation.
   * Called after collection completes and layouts are known.
   */
  async _buildLayoutDurations() {
    if (!this.cache?.getFile) return; // Cache doesn't support direct file access

    const layoutFiles = this.schedule.getCurrentLayouts();
    const defaultFile = this.schedule.schedule?.default;
    const allFiles = [...new Set([...layoutFiles, ...(defaultFile ? [defaultFile] : [])])];

    let parsed = 0;
    for (const file of allFiles) {
      const layoutId = parseLayoutFile(file);
      try {
        const xlfXml = await this.cache.getFile('layout', layoutId);
        if (xlfXml) {
          const duration = parseLayoutDuration(xlfXml);
          // Only set if no runtime-corrected value exists yet.
          // Runtime corrections (from video metadata / probeLayoutDurations) are
          // more accurate than static XLF parsing which estimates videos at 60s.
          if (!this._layoutDurations.has(file)) {
            this._layoutDurations.set(file, duration);
          }
          if (!this._layoutDurations.has(String(layoutId))) {
            this._layoutDurations.set(String(layoutId), duration);
          }
          parsed++;
        }
      } catch (e) {
        log.debug(`Could not parse duration for layout ${layoutId}:`, e.message);
      }
    }
    if (parsed > 0) {
      log.info(`[Timeline] Parsed durations for ${parsed} layouts`);
    }
  }

  /**
   * Calculate and log the upcoming playback timeline (next 2 hours).
   * Emits 'timeline-updated' with the full timeline array.
   */
  logUpcomingTimeline() {
    if (this._layoutDurations.size === 0) return;
    if (!this.schedule.getLayoutsAtTime) return; // Schedule doesn't support time queries

    const timeline = calculateTimeline(this.schedule, this._layoutDurations, {
      currentLayoutStartedAt: this._lastLayoutChangeTime ? new Date(this._lastLayoutChangeTime) : null,
    });
    if (timeline.length === 0) return;

    const lines = timeline.slice(0, 20).map(e => {
      const s = e.startTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const end = e.endTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `  ${s}-${end}  Layout ${e.layoutFile} (${e.duration}s)${e.isDefault ? ' [default]' : ''}`;
    });
    log.info(`[Timeline] Next ${timeline.length} plays:\n${lines.join('\n')}`);
    this.emit('timeline-updated', timeline);
  }

  /**
   * Record/correct a layout's actual duration (e.g., from video loadedmetadata).
   * Updates the durations map and re-logs the timeline if it changed.
   * @param {string} file - Layout file or layout ID string
   * @param {number} duration - Actual duration in seconds
   */
  recordLayoutDuration(file, duration) {
    const prev = this._layoutDurations.get(file);
    if (prev === duration) return; // No change

    // Never downgrade a known duration — a larger measured value (e.g. from video
    // metadata) is always more accurate than a smaller XLF/default guess.
    if (prev && prev > 60 && duration < prev) return;

    this._layoutDurations.set(file, duration);
    log.debug(`[Timeline] Duration corrected: layout ${file} ${prev || '?'}s → ${duration}s`);
    this.logUpcomingTimeline();
  }

  /**
   * Cleanup
   */
  cleanup() {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
    }

    if (this._faultReportingInterval) {
      clearInterval(this._faultReportingInterval);
      this._faultReportingInterval = null;
    }

    if (this.xmr) {
      this.xmr.stop();
      this.xmr = null;
    }

    // Stop multi-display sync
    if (this.syncManager) {
      this.syncManager.stop();
      this.syncManager = null;
    }

    // Stop data connector polling
    this.dataConnectorManager.cleanup();

    // Emit cleanup-complete before removing listeners
    this.emit('cleanup-complete');
    this.removeAllListeners();
  }

  /**
   * Get current layout ID
   */
  getCurrentLayoutId() {
    return this.currentLayoutId;
  }

  /**
   * Check if collecting
   */
  isCollecting() {
    return this.collecting;
  }

  /**
   * Get pending layouts
   */
  getPendingLayouts() {
    return Array.from(this.pendingLayouts.keys());
  }

}
