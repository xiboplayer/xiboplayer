/**
 * PWA Player with RendererLite
 *
 * Lightweight PWA player using modular PlayerCore orchestration.
 * Platform layer handles UI, DOM manipulation, and platform-specific features.
 */

import { RendererLite } from '@xiboplayer/renderer';
import { StoreClient, DownloadManager, LayoutTaskBuilder, BARRIER } from '@xiboplayer/cache';
import { PlayerCore } from '@xiboplayer/core';
import { parseLayoutDuration } from '@xiboplayer/schedule';
import { createLogger, registerLogSink, PLAYER_API } from '@xiboplayer/utils';
import { DownloadOverlay, getDefaultOverlayConfig } from './download-overlay.js';
import { TimelineOverlay, isTimelineVisible } from './timeline-overlay.js';
import { SetupOverlay } from './setup-overlay.js';

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

const log = createLogger('PWA');

// ContentStore key prefix — mirrors PLAYER_API without leading slash
const STORE_PREFIX = PLAYER_API.slice(1);

// Dynamic base path — same build serves /player/pwa/, /player/pwa-xmds/, /player/pwa-xlr/
const PLAYER_BASE = new URL('./', window.location.href).pathname.replace(/\/$/, '');

// Import core modules (will be loaded at runtime)
let cacheWidgetHtml: any;
let scheduleManager: any;
let config: any;
let RestClient: any;
let XmdsClient: any;
let ProtocolDetector: any;
let XmrWrapper: any;
let store: StoreClient;
let downloadManager: DownloadManager;
let StatsCollector: any;
let formatStats: any;
let LogReporter: any;
let formatLogs: any;
let DisplaySettings: any;
let SyncManager: any;

// SDK package versions (populated in loadCoreModules)
const sdkVersions: Record<string, string> = {};

class PwaPlayer {
  private renderer!: RendererLite;
  private core!: PlayerCore;
  private xmds!: any;
  private downloadOverlay: DownloadOverlay | null = null;
  private timelineOverlay: TimelineOverlay | null = null;
  private setupOverlay: SetupOverlay | null = null;
  private statsCollector: any = null;
  private logReporter: any = null;
  private displaySettings: any = null;
  private currentScheduleId: number = -1; // Track scheduleId for stats
  private scheduledLayoutIds: Set<number> = new Set(); // Layout IDs from current schedule
  private preparingLayoutId: number | null = null; // Guard against concurrent prepareAndRenderLayout calls
  private _pendingRetryLayoutId: number | null = null; // Queued retry when check-pending-layout arrives during preparation
  private _screenshotInterval: any = null;
  private _screenshotMethod: 'electron' | 'native' | 'html2canvas' | null = null;
  private _screenshotInFlight = false; // Concurrency guard — one capture at a time
  private _html2canvasMod: any = null; // Pre-loaded module
  private _wakeLock: any = null; // Screen Wake Lock sentinel
  private syncManager: any = null; // Multi-display sync coordinator
  private _currentLayoutEnableStat: boolean = true; // enableStat from current layout XLF
  private _probeTimer: any = null; // Debounce timer for duration probing
  private _mediaStatusTimer: ReturnType<typeof setTimeout> | null = null; // Debounce timer for media status check
  private _pendingFollowerStats: any[] | null = null; // In-flight stats delegated to lead
  private _pendingFollowerLogs: any[] | null = null; // In-flight logs delegated to lead
  private _iframeObserver: MutationObserver | null = null; // Iframe key-forwarding observer
  private _swIcHandler: any = null; // SW Interactive Control message handler
  private _chunkConfig: any = null; // Device-adaptive chunk configuration
  private _fileIdToSaveAs: Map<string, string> = new Map(); // Numeric file ID → storedAs filename
  private protocolDetector: any = null; // CMS protocol auto-detector

  async init() {
    log.info('Initializing player with RendererLite + PlayerCore...');

    // Load core modules
    await this.loadCoreModules();

    // Register Service Worker for offline-first kiosk mode
    if ('serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.register(`${PLAYER_BASE}/sw-pwa.js?v=${Date.now()}`, {
          scope: `${PLAYER_BASE}/`,
          type: 'module',
          updateViaCache: 'none'
        });
        log.info('Service Worker registered for offline mode:', registration.scope);

        // Request persistent storage (kiosk requirement)
        if (navigator.storage && navigator.storage.persist) {
          const persistent = await navigator.storage.persist();
          if (persistent) {
            log.info('Persistent storage granted - cache won\'t be evicted');
          } else {
            log.warn('Persistent storage denied - cache may be evicted');
          }
        }
      } catch (error) {
        log.warn('Service Worker registration failed:', error);
      }
    }

    // Initialize StoreClient (REST) + DownloadManager (main thread)
    log.info('Initializing cache clients...');
    store = new StoreClient();
    const { calculateChunkConfig } = await import('@xiboplayer/sw');
    this._chunkConfig = calculateChunkConfig(log);
    downloadManager = new DownloadManager({
      concurrency: this._chunkConfig.concurrency,
      chunkSize: this._chunkConfig.chunkSize,
      chunksPerFile: 2,
    });
    log.info('Cache clients ready — StoreClient + DownloadManager');

    // Create renderer
    const container = document.getElementById('player-container');
    if (!container) {
      throw new Error('No #player-container found');
    }

    this.renderer = new RendererLite(
      {
        cmsUrl: config.cmsUrl,
        hardwareKey: config.hardwareKey
      },
      container,
      {
        // Provide fileId→saveAs map for layout background resolution
        fileIdToSaveAs: this._fileIdToSaveAs,

        // Provide widget HTML resolver — check ContentStore via proxy
        getWidgetHtml: async (widget: any) => {
          const widgetPath = `${PLAYER_API}/widgets/${widget.layoutId}/${widget.regionId}/${widget.id}`;
          log.debug(`Looking for widget HTML at: ${widgetPath}`, widget);

          try {
            const exists = await store.has(`${STORE_PREFIX}/widgets`, `${widget.layoutId}/${widget.regionId}/${widget.id}`);
            if (exists) {
              log.debug(`Widget HTML found in store, using mirror URL for iframe`);
              return { url: widgetPath, fallback: widget.raw || '' };
            } else {
              log.warn(`No widget HTML found in store: ${widgetPath}`);
            }
          } catch (error) {
            log.error(`Failed to check widget HTML for ${widget.id}:`, error);
          }

          // Fallback to widget.raw (XLF template)
          log.warn(`Using widget.raw fallback for ${widget.id}`);
          return widget.raw || '';
        }
      }
    );

    // Create PlayerCore (with CMS-namespaced offline cache DB)
    this.core = new PlayerCore({
      config,
      xmds: this.xmds,
      cache: store,
      schedule: scheduleManager,
      renderer: this.renderer,
      xmrWrapper: XmrWrapper,
      statsCollector: this.statsCollector,
      displaySettings: this.displaySettings,
      cmsId: config.activeCmsId,
    });

    // Setup platform-specific event handlers
    this.setupCoreEventHandlers();
    this.setupRendererEventHandlers();
    this.setupInteractiveControl();
    this.setupDataConnectorNotify();
    this.setupRemoteControls();

    // Set display location from CMS settings when registration completes
    this.core.on('register-complete', (regResult: any) => {
      const lat = parseFloat(regResult?.settings?.latitude);
      const lng = parseFloat(regResult?.settings?.longitude);
      if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
        log.info(`Display location from CMS: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
        if (scheduleManager?.setLocation) {
          scheduleManager.setLocation(lat, lng);
        }
      } else if (this.core.requestGeoLocation) {
        // No CMS coordinates — try browser Geolocation API as fallback
        log.info('No CMS coordinates, requesting browser geolocation...');
        this.core.requestGeoLocation();
      }
    });

    // Setup UI
    this.updateConfigDisplay();

    // Online/offline event listeners for seamless offline mode
    window.addEventListener('online', () => {
      log.info('Browser reports online — triggering immediate collection');
      this.updateStatus('Back online, syncing...');
      this.removeOfflineIndicator();
      this.core.collectNow().catch((error: any) => {
        log.error('Failed to collect after coming online:', error);
      });
    });
    window.addEventListener('offline', () => {
      log.warn('Browser reports offline — continuing playback with cached data');
      this.updateStatus('Offline mode — using cached content');
      this.showOfflineIndicator();
    });

    // Initialize download progress overlay (configurable debug feature)
    // Respect controls.keyboard.debugOverlays — if disabled, don't restore overlays
    const controls = this.getControls();
    const debugOverlaysEnabled = (controls.keyboard || {}).debugOverlays === true;

    const overlayConfig = getDefaultOverlayConfig();
    if (overlayConfig.enabled && debugOverlaysEnabled) {
      this.downloadOverlay = new DownloadOverlay(overlayConfig);
      this.downloadOverlay.setProgressCallback(() => downloadManager.getProgress());
      log.info('Download overlay enabled (hover bottom-right corner)');
    }

    // Timeline overlay — created on first T key press (or if previously visible)
    if (isTimelineVisible() && debugOverlaysEnabled) {
      this.timelineOverlay = new TimelineOverlay(true, (layoutId) => this.skipToLayout(layoutId));
    }

    // Listen for certificate warnings from Electron main process
    this.setupCertWarnings();

    // Listen for XMR connection status changes
    this.setupXmrWarning();

    // Request Screen Wake Lock to prevent display sleep
    await this.requestWakeLock();

    // Re-acquire wake lock when tab becomes visible again
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.requestWakeLock();
      }
    });

    // Start collection cycle
    await this.core.collect();

    log.info('Player initialized successfully');
  }

  /**
   * Request Screen Wake Lock to prevent display from sleeping
   * Re-acquired on visibility change (browser releases it when tab is hidden)
   */
  private async requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      log.debug('Wake Lock API not supported');
      return;
    }

    try {
      this._wakeLock = await (navigator as any).wakeLock.request('screen');
      log.info('Screen Wake Lock acquired — display will stay on');

      this._wakeLock.addEventListener('release', () => {
        log.debug('Screen Wake Lock released');
        this._wakeLock = null;
      });
    } catch (error: any) {
      log.warn('Wake Lock request failed:', error?.message);
    }
  }

  /**
   * Listen for certificate warnings from Electron and show in the top bar.
   * The #overlay bar (defined in index.html) is the status bar with
   * #config-info (left) and #status (right). If it was removed (statusBarOnHover
   * not set), we recreate it. Cert warnings make the bar always visible.
   */
  private setupCertWarnings() {
    const warnedHosts = new Set<string>();

    window.addEventListener('cert-warning', ((e: CustomEvent) => {
      const { host, error } = e.detail;
      if (warnedHosts.has(host)) return;
      warnedHosts.add(host);

      log.warn(`Invalid SSL certificate accepted for stream: ${host} (${error})`);

      // Find or recreate the top bar
      let overlay = document.getElementById('overlay');
      let created = false;
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'overlay';
        // Recreate child structure: config-info | status
        const info = document.createElement('div');
        info.id = 'config-info';
        overlay.appendChild(info);
        const status = document.createElement('div');
        status.id = 'status';
        overlay.appendChild(status);
        document.body.appendChild(overlay);
        created = true;
      }

      // Find or create the cert warning span between #config-info and #status
      let certSpan = document.getElementById('cert-warnings');
      if (!certSpan) {
        certSpan = document.createElement('span');
        certSpan.id = 'cert-warnings';
        certSpan.style.cssText = 'color: #ffaa33; flex: 0 0 auto;';
        const statusEl = document.getElementById('status');
        overlay.insertBefore(certSpan, statusEl);
      }

      const hosts = [...warnedHosts].join(', ');
      certSpan.textContent = `\u26A0 SSL: ${hosts}`;

      // Don't force always-visible — let hover-only CSS handle show/hide

      // If we recreated the overlay, repopulate config info
      if (created) this.updateConfigDisplay();
    }) as EventListener);
  }

  /**
   * Show/hide an XMR disconnected warning in the top bar.
   * Placed before #cert-warnings (or before #status if no cert warnings).
   */
  private setupXmrWarning() {
    this.core.on('xmr-status', ({ connected }: { connected: boolean }) => {
      const overlay = document.getElementById('overlay');
      if (!overlay) return;

      let span = document.getElementById('xmr-warning');

      if (!connected) {
        if (!span) {
          span = document.createElement('span');
          span.id = 'xmr-warning';
          span.style.cssText = 'color: #ff6666; flex: 0 0 auto;';
          // Insert before cert-warnings or status (whichever comes first)
          const anchor = document.getElementById('cert-warnings') || document.getElementById('status');
          overlay.insertBefore(span, anchor);
        }
        span.textContent = '\u26A0 XMR disconnected';
      } else {
        span?.remove();
      }
    });
  }

  /**
   * Load core modules
   */
  private async loadCoreModules() {
    try {
      const [
        cacheModule, xmdsModule, scheduleModule, configModule,
        xmrModule, statsModule, displaySettingsModule, coreModule,
        rendererModule, syncModule,
      ] = await Promise.all([
        import('@xiboplayer/cache'),
        import('@xiboplayer/xmds'),
        import('@xiboplayer/schedule'),
        import('@xiboplayer/utils'),
        import('@xiboplayer/xmr'),
        import('@xiboplayer/stats'),
        import('@xiboplayer/settings'),
        import('@xiboplayer/core'),
        import('@xiboplayer/renderer'),
        import('@xiboplayer/sync'),
      ]);

      cacheWidgetHtml = cacheModule.cacheWidgetHtml;
      SyncManager = syncModule.SyncManager;
      scheduleManager = scheduleModule.scheduleManager;
      config = configModule.config;
      RestClient = xmdsModule.RestClient;
      XmdsClient = xmdsModule.XmdsClient;
      ProtocolDetector = xmdsModule.ProtocolDetector;
      XmrWrapper = xmrModule.XmrWrapper;
      StatsCollector = statsModule.StatsCollector;
      formatStats = statsModule.formatStats;
      LogReporter = statsModule.LogReporter;
      formatLogs = statsModule.formatLogs;
      DisplaySettings = displaySettingsModule.DisplaySettings;

      // Capture SDK package versions
      sdkVersions.core = coreModule.VERSION || '?';
      sdkVersions.cache = cacheModule.VERSION || '?';
      sdkVersions.renderer = rendererModule.VERSION || '?';
      sdkVersions.schedule = scheduleModule.VERSION || '?';
      sdkVersions.xmds = xmdsModule.VERSION || '?';
      sdkVersions.xmr = xmrModule.VERSION || '?';
      sdkVersions.utils = configModule.VERSION || '?';
      sdkVersions.stats = statsModule.VERSION || '?';
      sdkVersions.settings = displaySettingsModule.VERSION || '?';

      // Get MAC address from Electron if available (for WOL support)
      if ((window as any).electronAPI?.getSystemInfo) {
        try {
          const sysInfo = await (window as any).electronAPI.getSystemInfo();
          if (sysInfo.macAddress) {
            config.macAddress = sysInfo.macAddress;
          }
        } catch (_) { /* pure PWA — no Electron API */ }
      }

      // Transport selection:
      //   transport: "rest"   → forced REST API
      //   transport: "xmds"   → forced SOAP
      //   transport: "auto"   → probe REST → SOAP fallback (default)
      //   /player/pwa-xmds/   → forced SOAP (URL-based override)
      //   ?transport=xmds     → forced SOAP (query param override)
      const cfgTransport = config.transport !== 'auto' ? config.transport : undefined;
      const urlTransport = new URLSearchParams(window.location.search).get('transport');
      const transport = urlTransport
        || (PLAYER_BASE.includes('pwa-xmds') ? 'xmds' : null)
        || cfgTransport
        || 'auto';

      // Use ProtocolDetector for auto-detection with re-probe support
      this.protocolDetector = new ProtocolDetector(config.cmsUrl, RestClient, XmdsClient);
      const forceProtocol = (transport === 'auto') ? undefined : transport;
      const { client } = await this.protocolDetector.detect(config, forceProtocol);
      this.xmds = client;

      // Initialize stats collector (namespaced by CMS ID)
      const cmsId = config.activeCmsId;
      this.statsCollector = new StatsCollector(cmsId);
      await this.statsCollector.init();
      log.info(`Stats collector initialized${cmsId ? ` (CMS: ${cmsId})` : ''}`);

      // Initialize log reporter for CMS log submission (namespaced by CMS ID)
      this.logReporter = new LogReporter(cmsId);
      await this.logReporter.init();
      log.info(`Log reporter initialized${cmsId ? ` (CMS: ${cmsId})` : ''}`);

      // Bridge logger output to LogReporter for CMS submission
      registerLogSink(({ level, name, args }: { level: string; name: string; args: any[] }) => {
        if (!this.logReporter) return;
        const message = args.map((a: any) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        this.logReporter.log(level, `[${name}] ${message}`, 'PLAYER').catch(() => {});
      });

      // Forward console logs to proxy stdout (for journald/log analysis).
      // Controlled by debug.consoleLogs in config.json.
      // Optional debug.consoleLogsInterval (seconds) sets the batch flush interval (default 10s).
      const debugConfig = config.debug;
      if (debugConfig?.consoleLogs) {
        const flushIntervalMs = (debugConfig.consoleLogsInterval || 10) * 1000;
        let batch: Array<{ level: string; name: string; message: string; ts: string }> = [];
        let flushTimer: ReturnType<typeof setTimeout> | null = null;

        const flushLogs = () => {
          if (batch.length === 0) return;
          const payload = batch;
          batch = [];
          flushTimer = null;
          // Fire-and-forget POST — log forwarding must never block the player
          fetch('/debug/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => {});
        };

        registerLogSink(({ level, name, args }: { level: string; name: string; args: any[] }) => {
          const message = args.map((a: any) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
          batch.push({ level, name, message, ts: new Date().toISOString() });
          if (!flushTimer) {
            flushTimer = setTimeout(flushLogs, flushIntervalMs);
          }
        });

        log.info(`Console log forwarding to proxy enabled (flush every ${flushIntervalMs / 1000}s)`);
      }

      // Initialize display settings manager
      this.displaySettings = new DisplaySettings();
      log.info('Display settings manager initialized');

      // Log version and environment information for debugging
      const buildDate = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : '?';
      const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?';
      log.info(`v${appVersion} built ${buildDate}`);
      const versionParts = Object.entries(sdkVersions).map(([k, v]) => `${k}=${v}`).join(' ');
      log.info(`SDK: ${versionParts}`);
      const isElectron = !!(window as any).electronAPI;
      const electronVersion = isElectron ? (navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] || '?') : null;
      const chromeVersion = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || '?';
      const platform = isElectron ? `Electron ${electronVersion} / Chrome ${chromeVersion}` : `Chrome ${chromeVersion}`;
      log.info(`Env: PWA v${appVersion} | ${platform} | ${navigator.platform} | ${screen.width}x${screen.height}`);

      log.info('Core modules loaded');
    } catch (error) {
      log.error('Failed to load core modules:', error);
      throw error;
    }
  }

  /**
   * Setup PlayerCore event handlers (Platform-specific UI updates)
   */
  private setupCoreEventHandlers() {
    // Collection events
    this.core.on('collection-start', () => {
      this.updateStatus('Collecting data from CMS...');
    });

    this.core.on('register-complete', (regResult: any) => {
      const displayName = this.displaySettings?.getDisplayName() || regResult.displayName || config.hardwareKey;
      this.updateStatus(`Registered: ${displayName}`);

      // Update page title with display name
      if (this.displaySettings) {
        document.title = `Xibo Player - ${this.displaySettings.getDisplayName()}`;
      }
    });

    // Multi-display sync: create SyncManager when CMS provides sync config
    this.core.on('sync-config', (syncConfig: any) => {
      if (this.syncManager) {
        this.syncManager.stop();
      }

      // Cross-device sync: build WebSocket relay URL when syncGroup is an IP.
      // Lead connects to its own relay (localhost), followers connect to lead's IP.
      // When syncGroup is 'lead', this is same-machine only (BroadcastChannel).
      if (syncConfig.syncPublisherPort && syncConfig.syncGroup !== 'lead') {
        const host = syncConfig.isLead ? 'localhost' : syncConfig.syncGroup;
        syncConfig.relayUrl = `ws://${host}:${syncConfig.syncPublisherPort}/sync`;
      }

      this.syncManager = new SyncManager({
        displayId: config.hardwareKey,
        syncConfig,
        onLayoutChange: async (layoutId: string) => {
          // Follower: lead requested a layout change — load it but don't show yet
          log.info(`[Sync] Loading layout ${layoutId} (waiting for show signal)`);
          await this.prepareAndRenderLayout(parseInt(layoutId, 10));
          // Report ready to lead
          this.syncManager?.reportReady(layoutId);
        },
        onLayoutShow: (layoutId: string) => {
          // Lead/Follower: show the layout now (already rendered by prepareAndRenderLayout)
          log.info(`[Sync] Show signal for layout ${layoutId}`);
        },
        onVideoStart: (layoutId: string, regionId: string) => {
          // Resume paused video in the specified region
          log.info(`[Sync] Video start: layout ${layoutId} region ${regionId}`);
          this.renderer.resumeRegionMedia?.(regionId);
        },
        // Lead: follower delegated stats — submit on their behalf
        onStatsReport: async (followerId: string, statsXml: string, ack: () => void) => {
          log.info(`[Sync] Submitting stats for follower ${followerId}`);
          try {
            const success = await this.xmds.submitStats(statsXml, followerId);
            if (success) ack();
          } catch (err: any) {
            log.warn(`[Sync] Stats submission failed for follower ${followerId}:`, err);
          }
        },
        // Lead: follower delegated logs — submit on their behalf
        onLogsReport: async (followerId: string, logsXml: string, ack: () => void) => {
          log.info(`[Sync] Submitting logs for follower ${followerId}`);
          try {
            const success = await this.xmds.submitLog(logsXml, followerId);
            if (success) ack();
          } catch (err: any) {
            log.warn(`[Sync] Log submission failed for follower ${followerId}:`, err);
          }
        },
        // Follower: lead confirmed our stats were submitted
        onStatsAck: async (_displayId: string) => {
          log.info('[Sync] Lead confirmed stats submission');
          if (this._pendingFollowerStats && this.statsCollector) {
            await this.statsCollector.clearSubmittedStats(this._pendingFollowerStats);
            this._pendingFollowerStats = null;
          }
        },
        // Follower: lead confirmed our logs were submitted
        onLogsAck: async (_displayId: string) => {
          log.info('[Sync] Lead confirmed logs submission');
          if (this._pendingFollowerLogs && this.logReporter) {
            await this.logReporter.clearSubmittedLogs(this._pendingFollowerLogs);
            this._pendingFollowerLogs = null;
          }
        },
      });
      this.core.setSyncManager(this.syncManager);
      this.syncManager.start();
      log.info(`[Sync] SyncManager started as ${syncConfig.isLead ? 'LEAD' : 'FOLLOWER'}`);
    });

    this.core.on('files-received', (files: any[]) => {
      this.updateStatus(`Downloading ${files.length} files...`);
    });

    this.core.on('offline-mode', (isOffline: boolean) => {
      if (isOffline) {
        this.updateStatus('Offline mode — using cached content');
        this.showOfflineIndicator();
      } else {
        this.updateStatus('Back online');
        this.removeOfflineIndicator();
      }
    });

    this.core.on('purge-request', async (purgeFiles: any[]) => {
      try {
        const result = await store.remove(purgeFiles);
        log.info(`Purge complete: ${result.deleted}/${result.total} files deleted`);
      } catch (error) {
        log.warn('Purge failed:', error);
      }
    });

    this.core.on('download-request', async (groupedFiles: any) => {
      // Download orchestration runs in main thread — no SW messaging
      this.downloadOverlay?.startUpdating();
      try {
        // Push current JWT token to proxy for cache-through CMS requests
        const token = this.xmds?._token || null;
        if (token) {
          await fetch('/auth-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
          });
        }
        await this.enqueueDownloads(groupedFiles);
        log.info('Download enqueue complete');
      } catch (error) {
        log.error('Download request failed:', error);
        this.updateStatus('Download failed: ' + error, 'error');
      }
    });

    this.core.on('schedule-received', (schedule: any) => {
      this.updateStatus('Processing schedule...');

      // Extract scheduleId for stats tracking
      // Check layouts or campaigns for scheduleId
      if (schedule.layouts && schedule.layouts.length > 0) {
        this.currentScheduleId = parseInt(schedule.layouts[0].scheduleid) || -1;
      } else if (schedule.campaigns && schedule.campaigns.length > 0) {
        this.currentScheduleId = parseInt(schedule.campaigns[0].scheduleid) || -1;
      }

      // Selectively clear preloaded layouts not in the new schedule.
      // Keep warm entries whose layout ID is still scheduled — their DOM is still valid.
      // (The CMS schedule CRC changes every collection due to timestamps, even when
      // the actual layout list hasn't changed. Blindly clearing would destroy preloads.)
      if (this.renderer?.layoutPool) {
        const scheduledIds = new Set<number>();
        if (schedule.layouts) {
          for (const l of schedule.layouts) {
            const id = parseInt(String(l.file || l.id || l).replace('.xlf', ''), 10);
            if (id) scheduledIds.add(id);
          }
        }
        if (schedule.campaigns) {
          for (const c of schedule.campaigns) {
            if (c.layouts) {
              for (const l of c.layouts) {
                const id = parseInt(String(l.file || l.id || l).replace('.xlf', ''), 10);
                if (id) scheduledIds.add(id);
              }
            }
          }
        }
        const cleared = this.renderer.layoutPool.clearWarmNotIn(scheduledIds);
        if (cleared > 0) {
          log.info(`Cleared ${cleared} preloaded layout(s) no longer in schedule`);
        }
        this.scheduledLayoutIds = scheduledIds;
      }

      log.debug('Current scheduleId for stats:', this.currentScheduleId);
    });

    this.core.on('layout-prepare-request', async (layoutId: number) => {
      await this.prepareAndRenderLayout(layoutId);
    });

    this.core.on('layout-expire-current', () => {
      log.info('Schedule changed — expiring current layout');
      this.renderer.stopCurrentLayout();
      // stopCurrentLayout() emits layoutEnd → the layoutEnd handler
      // calls advanceToNextLayout() which picks the next scheduled layout
    });

    this.core.on('no-layouts-scheduled', () => {
      this.updateStatus('No layouts scheduled');
    });

    this.core.on('collection-complete', () => {
      const layoutId = this.core.getCurrentLayoutId();
      if (layoutId) {
        this.updateStatus(`Playing layout ${layoutId}`);
      } else if (this.preparingLayoutId) {
        this.updateStatus(`Downloading layout ${this.preparingLayoutId}...`);
      }

      // Duration probing is handled by the debounced re-probe (3s after last
      // file cached) — avoids 404s from probing before downloads complete.
    });

    this.core.on('collection-error', async (error: any) => {
      this.updateStatus(`Collection error: ${error}`, 'error');

      // Report fault to CMS (triggers dashboard alert)
      this.logReporter?.reportFault(
        'COLLECTION_FAILED',
        `Collection cycle failed: ${error?.message || error}`
      );
      this.submitFault('COLLECTION_FAILED', `Collection cycle failed: ${error?.message || error}`);

      // Re-probe CMS protocol on connection errors (CMS may have been upgraded)
      if (this.protocolDetector && this.protocolDetector.getProtocol() !== null) {
        try {
          const { client, protocol, changed } = await this.protocolDetector.reprobe(config);
          if (changed && client) {
            log.info(`Protocol switched to ${protocol} after connection error`);
            this.xmds = client;
            this.core.xmds = client;
          }
        } catch (reprobeError) {
          log.warn('Protocol re-probe failed:', reprobeError);
        }
      }
    });

    this.core.on('xmr-connected', (url: string) => {
      log.info('XMR connected:', url);
    });

    this.core.on('xmr-misconfigured', (info: { reason: string; url?: string; message: string }) => {
      log.warn(`XMR misconfigured (${info.reason}): ${info.message}`);
    });

    // Log level changes from CMS (overlays are controlled by config.controls, not log level)
    this.core.on('log-level-changed', () => {
      log.info(`Log level changed`);
    });

    // Overlay layout push from XMR
    this.core.on('overlay-layout-request', async (layoutId: number) => {
      log.info('Overlay layout requested:', layoutId);
      // Re-use existing overlay rendering (schedule-driven overlays already work)
      // Just need to prepare and render the overlay layout
      await this.prepareAndRenderLayout(layoutId);
    });

    // Revert to schedule (undo XMR layout override)
    this.core.on('revert-to-schedule', () => {
      log.info('Reverting to scheduled content');
      this.updateStatus('Reverting to schedule...');
    });

    // Purge all cache
    this.core.on('purge-all-request', async () => {
      log.info('Purging all cached content...');
      this.updateStatus('Purging cache...');
      try {
        // Delete all files from ContentStore
        const allFiles = await store.list();
        if (allFiles.length > 0) {
          const result = await store.remove(allFiles);
          log.info(`Purged ${result.deleted} files from ContentStore`);
        }
        // Clean up any legacy Cache API caches (pre-ContentStore migration)
        const cacheNames = await caches.keys();
        if (cacheNames.length > 0) {
          await Promise.all(cacheNames.map(name => caches.delete(name)));
          log.info(`Purged ${cacheNames.length} legacy caches`);
        }
      } catch (error) {
        log.error('Cache purge failed:', error);
      }
    });

    // Command execution result
    this.core.on('command-result', (result: any) => {
      log.info('Command result:', result);
      if (!result.success) {
        this.logReporter?.reportFault(
          'COMMAND_FAILED',
          `Command ${result.code} failed: ${result.reason || 'unknown'}`
        );
        this.submitFault('COMMAND_FAILED', `Command ${result.code} failed: ${result.reason || 'unknown'}`);
      }
    });

    // Scheduled commands (#17) — execute commands whose scheduled time has arrived
    this.core.on('scheduled-command', (command: any) => {
      log.info(`Scheduled command: ${command.code}`);
      this.core.executeCommand(command.code);
    });

    // Native command execution (#202) — shell commands delegated by PlayerCore
    // Electron: use IPC (in-process, faster). Chromium/other: HTTP to proxy server.
    this.core.on('execute-native-command', async (data: any) => {
      let result;
      if ((window as any).electronAPI?.executeShellCommand) {
        result = await (window as any).electronAPI.executeShellCommand({
          commandString: data.commandString,
        });
      } else {
        try {
          const resp = await fetch('/shell-command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commandString: data.commandString }),
          });
          result = await resp.json();
        } catch (err: any) {
          result = { success: false, reason: err.message };
        }
      }
      this.core.emit('command-result', { code: data.code, ...result });
    });

    // Display settings events
    if (this.displaySettings) {
      this.displaySettings.on('interval-changed', (newInterval: number) => {
        log.info(`Collection interval changed to ${newInterval}s`);
      });

      this.displaySettings.on('settings-applied', (_settings: any, changes: string[]) => {
        if (changes.length > 0) {
          log.info('Settings updated from CMS:', changes.join(', '));
        }
        // Start periodic screenshots once we have settings (only first time)
        if (!this._screenshotInterval) {
          this.startScreenshotInterval();
        }
      });
    }

    // Stats submission
    this.core.on('submit-stats-request', async () => {
      await this.submitStats();
    });

    // Log submission to CMS
    this.core.on('submit-logs-request', async () => {
      await this.submitLogs();
    });

    // Screenshot capture (triggered by XMR or periodic interval)
    this.core.on('screenshot-request', async () => {
      await this.captureAndSubmitScreenshot();
    });

    // Handle check-pending-layout events
    // Re-run prepareAndRenderLayout which checks XLF + actual media IDs correctly
    // (avoids the bug where setPendingLayout(id,[id]) treated layoutId as mediaId)
    this.core.on('check-pending-layout', async (layoutId: number) => {
      await this.prepareAndRenderLayout(layoutId);
    });

    // Navigate to widget (navWidget action via triggerCode from schedule-level actions)
    this.core.on('navigate-to-widget', (action: any) => {
      if (action.targetId) {
        this.renderer.navigateToWidget(action.targetId);
      } else {
        log.warn('navigate-to-widget action has no targetId:', action);
      }
    });

    // Timeline overlay — visualize upcoming schedule
    this.core.on('timeline-updated', (timeline: any[]) => {
      this.timelineOverlay?.update(timeline, this.core.getCurrentLayoutId());
    });
  }


  /**
   * Setup Interactive Control handler (receives messages from SW for widget IC requests)
   * IC library in widget iframes makes XHR to /player/pwa/ic/*, SW forwards here.
   */
  private setupInteractiveControl() {
    this._swIcHandler = (event: any) => {
      if (event.data?.type !== 'INTERACTIVE_CONTROL') return;

      const { method, path, search, body } = event.data;
      const port = event.ports?.[0];
      if (!port) return;

      const response = this.handleInteractiveControl(method, path, search, body);
      port.postMessage(response);
    };
    navigator.serviceWorker?.addEventListener('message', this._swIcHandler);
  }

  /**
   * Notify widget iframes when DataConnector data changes.
   * XIC library listens for postMessage { ctrl: 'rtNotifyData', data: { dataKey } }
   * and calls the widget's registered notifyData callback.
   */
  private setupDataConnectorNotify() {
    const dcManager = this.core.getDataConnectorManager();
    dcManager.on('data-changed', (dataKey: string) => {
      const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe');
      const message = { ctrl: 'rtNotifyData', data: { dataKey } };
      for (const iframe of iframes) {
        try {
          iframe.contentWindow?.postMessage(message, '*');
        } catch { /* cross-origin iframe, ignore */ }
      }
    });
  }

  /**
   * Setup keyboard and presenter remote controls.
   * Handles arrow keys, page up/down, space for next/prev/pause,
   * and MediaSession API for multimedia keyboard keys.
   */
  private setupRemoteControls() {
    // Keep focus on main document so keyboard shortcuts work even with widget iframes.
    // Iframes steal focus — this pulls it back after a short delay so interactive
    // widgets still work momentarily but keyboard control returns to the player.
    window.addEventListener('blur', () => {
      setTimeout(() => window.focus(), 200);
    });

    // Forward keyboard events from widget iframes to the main document.
    // Iframes have their own document, so keydown on the parent never fires
    // when an iframe has focus. We observe new iframes and attach forwarders.
    const attachIframeKeyForwarder = (iframe: HTMLIFrameElement) => {
      const tryAttach = () => {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!iframeDoc) return;
          if ((iframe as any).__keyForwarderAttached) return;
          (iframe as any).__keyForwarderAttached = true;
          iframeDoc.addEventListener('keydown', (e: KeyboardEvent) => {
            // Re-dispatch on the main document so our handler fires
            const clone = new KeyboardEvent('keydown', {
              key: e.key, code: e.code, keyCode: e.keyCode,
              ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
              bubbles: true, cancelable: true,
            });
            if (document.dispatchEvent(clone)) return; // not prevented
            e.preventDefault();
          });
        } catch { /* cross-origin iframe, ignore */ }
      };
      iframe.addEventListener('load', tryAttach);
      tryAttach();
    };

    // Attach to existing and future iframes
    Array.from(document.querySelectorAll('iframe')).forEach(f => attachIframeKeyForwarder(f as HTMLIFrameElement));
    this._iframeObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLIFrameElement) attachIframeKeyForwarder(node);
          if (node instanceof HTMLElement) {
            node.querySelectorAll('iframe').forEach(f => attachIframeKeyForwarder(f as HTMLIFrameElement));
          }
        }
      }
    });
    this._iframeObserver.observe(document.body, { childList: true, subtree: true });

    // Read control toggles from config (injected by proxy into localStorage)
    const controls = this.getControls();
    const { keyboard: kb = {} } = controls;
    const debugOverlays = kb.debugOverlays === true;
    const setupKey = kb.setupKey === true;
    const playbackControl = kb.playbackControl === true;
    const videoControls = kb.videoControls === true;

    // Keyboard / presenter remote (clicker) controls
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      // Ctrl+Q — quit (Chromium kiosk: calls server /quit; Electron: handled by menu accelerator)
      if (e.key === 'q' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        log.info('[Remote] Quit requested (Ctrl+Q)');
        fetch('/quit', { method: 'POST' }).catch(() => {});
        return;
      }

      switch (e.key) {
        case 't':
        case 'T':
          if (!debugOverlays) break;
          if (!this.timelineOverlay) {
            this.timelineOverlay = new TimelineOverlay(true, (layoutId) => this.skipToLayout(layoutId));
          }
          this.timelineOverlay.toggle();
          break;
        case 'd':
        case 'D':
          if (!debugOverlays) break;
          if (!this.downloadOverlay) {
            this.downloadOverlay = new DownloadOverlay({ enabled: true, autoHide: false });
            this.downloadOverlay.setProgressCallback(() => downloadManager.getProgress());
          }
          this.downloadOverlay.toggle();
          break;
        case 'v':
        case 'V': {
          if (!videoControls) break;
          // Collect videos from parent + all same-origin iframes (widget regions)
          const allVideos: HTMLVideoElement[] = [...document.querySelectorAll<HTMLVideoElement>('video')];
          document.querySelectorAll<HTMLIFrameElement>('iframe').forEach(iframe => {
            try { allVideos.push(...iframe.contentDocument!.querySelectorAll<HTMLVideoElement>('video')); } catch {}
          });
          const show = allVideos.length > 0 && !allVideos[0].controls;
          allVideos.forEach(v => v.controls = show);
          break;
        }
        // Playback control: next/prev/pause
        case 'ArrowRight':
        case 'PageDown':
          if (!playbackControl) break;
          log.info('[Remote] Next layout (keyboard)');
          this.core.advanceToNextLayout();
          e.preventDefault();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          if (!playbackControl) break;
          log.info('[Remote] Previous layout (keyboard)');
          this.core.advanceToPreviousLayout();
          e.preventDefault();
          break;
        case ' ':
          if (!playbackControl) break;
          log.info('[Remote] Toggle pause (keyboard)');
          if (this.renderer.isPaused()) {
            this.renderer.resume();
          } else {
            this.renderer.pause();
          }
          e.preventDefault();
          break;
        case 'r':
        case 'R':
          if (!playbackControl) break;
          if (this.core.isLayoutOverridden()) {
            log.info('[Remote] Revert to schedule (keyboard)');
            this.core.revertToSchedule();
          }
          break;
        case 's':
        case 'S':
          if (!setupKey) break;
          if (!this.setupOverlay) {
            this.setupOverlay = new SetupOverlay();
          }
          this.setupOverlay.toggle();
          e.preventDefault(); // prevent 's' from being typed into the focused input
          break;
      }
    });

    // MediaSession API for multimedia keys (only fires when media is active)
    if (playbackControl && 'mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        log.info('[Remote] Next layout (MediaSession)');
        this.core.advanceToNextLayout();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        log.info('[Remote] Previous layout (MediaSession)');
        this.core.advanceToPreviousLayout();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        log.info('[Remote] Pause (MediaSession)');
        this.renderer.pause();
      });
      navigator.mediaSession.setActionHandler('play', () => {
        log.info('[Remote] Resume (MediaSession)');
        this.renderer.resume();
      });
    }

    log.info('Remote controls initialized (keyboard + MediaSession)');
  }

  /** Read controls config (injected by proxy from config.json into localStorage). */
  private getControls(): Record<string, any> {
    return config.controls;
  }

  /**
   * Skip to a specific layout by ID (from timeline click or XMR command).
   * Uses changeLayout() which sets a layout override — press R to revert to schedule.
   */
  private skipToLayout(layoutId: number) {
    log.info(`Skipping to layout ${layoutId} (timeline click)`);
    this.core.changeLayout(layoutId);
  }

  private parseBody(body: string | null): any {
    try { return body ? JSON.parse(body) : {}; } catch (_) { return {}; }
  }

  /**
   * Handle an Interactive Control request from a widget
   */
  private handleInteractiveControl(method: string, path: string, search: string, body: string | null): any {
    log.debug('IC request:', method, path, search);

    switch (path) {
      case '/info':
        return {
          status: 200,
          body: JSON.stringify({
            hardwareKey: config.hardwareKey,
            displayName: config.displayName,
            playerType: 'pwa',
            currentLayoutId: this.core.getCurrentLayoutId()
          })
        };

      case '/trigger': {
        const data = this.parseBody(body);
        // Forward to renderer for layout-level actions (widget navigation)
        this.renderer.emit('interactiveTrigger', {
          targetId: data.id,
          triggerCode: data.trigger
        });
        // Forward to core for schedule-level actions (layout navigation)
        if (data.trigger) {
          this.core.handleTrigger(data.trigger);
        }
        return { status: 200, body: 'OK' };
      }

      case '/duration/expire': {
        const data = this.parseBody(body);
        log.info('IC: Widget duration expire requested for', data.id);
        this.renderer.emit('widgetExpire', { widgetId: data.id });
        return { status: 200, body: 'OK' };
      }

      case '/duration/extend': {
        const data = this.parseBody(body);
        log.info('IC: Widget duration extend by', data.duration, 'for', data.id);
        this.renderer.emit('widgetExtendDuration', {
          widgetId: data.id,
          duration: parseInt(data.duration)
        });
        return { status: 200, body: 'OK' };
      }

      case '/duration/set': {
        const data = this.parseBody(body);
        log.info('IC: Widget duration set to', data.duration, 'for', data.id);
        this.renderer.emit('widgetSetDuration', {
          widgetId: data.id,
          duration: parseInt(data.duration)
        });
        return { status: 200, body: 'OK' };
      }

      case '/fault': {
        const data = this.parseBody(body);
        this.logReporter?.reportFault(
          data.code || 'WIDGET_FAULT',
          data.reason || 'Widget reported fault'
        );
        this.submitFault(data.code || 'WIDGET_FAULT', data.reason || 'Widget reported fault', {
          layoutId: data.layoutId,
          regionId: data.regionId,
          widgetId: data.widgetId
        });
        return { status: 200, body: 'OK' };
      }

      case '/realtime': {
        const params = new URLSearchParams(search);
        const dataKey = params.get('dataKey');
        log.debug('IC: Realtime data request for key:', dataKey);

        if (!dataKey) {
          return { status: 400, body: JSON.stringify({ error: 'Missing dataKey parameter' }) };
        }

        const dcManager = this.core.getDataConnectorManager();
        const connectorData = dcManager.getData(dataKey);

        if (connectorData === null) {
          return { status: 404, body: JSON.stringify({ error: `No data available for key: ${dataKey}` }) };
        }

        const responseBody = typeof connectorData === 'string' ? connectorData : JSON.stringify(connectorData);
        return { status: 200, body: responseBody };
      }

      case '/criteria': {
        // Return display properties/criteria that widgets can query
        // Used by widgets to adapt content based on display characteristics
        return {
          status: 200,
          body: JSON.stringify({
            displayId: config.displayId,
            hardwareKey: config.hardwareKey,
            displayName: config.displayName,
            width: window.innerWidth,
            height: window.innerHeight,
            latitude: config.latitude || null,
            longitude: config.longitude || null,
            playerType: 'pwa'
          })
        };
      }

      default:
        return { status: 404, body: JSON.stringify({ error: 'Unknown IC route' }) };
    }
  }

  /**
   * Notify PlayerCore that a file download completed.
   * Called directly from enqueueDownloads() — no SW messaging needed.
   */
  private notifyFileCached(fileId: string, fileType: string) {
    log.debug(`Download complete: ${fileType}/${fileId}`);

    if (fileType === 'layout') {
      this.core.notifyMediaReady(parseInt(fileId), fileType);
    } else if (fileType === 'media') {
      // Pass saveAs string for media files (matches pendingLayouts entries)
      const saveAs = this._fileIdToSaveAs.get(fileId) || fileId;
      this.core.notifyMediaReady(saveAs, fileType);
    }

    // Debounced duration probe — run after downloads settle
    if (this._probeTimer) clearTimeout(this._probeTimer);
    this._probeTimer = setTimeout(() => {
      this._probeTimer = null;
      this.probeLayoutDurations().catch(() => {});
    }, 3000);

    // Debounced media status check — update timeline missing-media annotations
    if (this._mediaStatusTimer) clearTimeout(this._mediaStatusTimer);
    this._mediaStatusTimer = setTimeout(() => {
      this._mediaStatusTimer = null;
      this.checkTimelineMediaStatus().catch(() => {});
    }, 2000);
  }

  /**
   * Enqueue files for download — runs in main thread, no SW messaging.
   * Ported from MessageHandler.handleDownloadFiles() with direct callbacks.
   */
  private async enqueueDownloads(data: any) {
    const { extractMediaIdsFromXlf } = await import('@xiboplayer/sw');
    const { layoutOrder, files, layoutDependants } = data;
    const queue = downloadManager.queue;

    /** Store key = URL path without leading / and query params */
    const storeKeyFrom = (f: any) => (f.path || '').split('?')[0].replace(/^\/+/, '') || `${f.type || 'media'}/${f.id}`;

    // Build fileId→saveAs map from CMS RequiredFiles data
    for (const f of files) {
      if (f.saveAs) {
        this._fileIdToSaveAs.set(String(f.id), f.saveAs);
      }
    }

    // Build lookup maps from flat CMS file list
    const xlfFiles = new Map();
    const resources: any[] = [];
    const mediaFiles = new Map();
    const idToKeys = new Map();
    for (const f of files) {
      if (f.type === 'layout') {
        xlfFiles.set(parseInt(f.id), f);
      } else if (f.type === 'static') {
        resources.push(f);
      } else {
        const key = `${f.type}:${f.id}`;
        mediaFiles.set(key, f);
        const bareId = String(f.id);
        if (!idToKeys.has(bareId)) idToKeys.set(bareId, []);
        idToKeys.get(bareId).push(key);
      }
    }

    log.info(`Download: ${layoutOrder.length} layouts, ${mediaFiles.size} media, ${resources.length} resources`);

    // ── Step 1: Fetch + parse all XLFs (cache-through handles store/CMS) ──
    const layoutMediaMap = new Map();
    const allXlfIds = [...layoutOrder, ...[...xlfFiles.keys()].filter((id: number) => !layoutOrder.includes(id))];
    const xlfPromises = allXlfIds.map(async (layoutId: number) => {
      const xlfFile = xlfFiles.get(layoutId);
      if (!xlfFile?.path) return;

      let xlfText: string | undefined;

      // Try store first, then cache-through fetches from CMS on miss
      try {
        const resp = await fetch(xlfFile.path);
        if (resp.ok) {
          xlfText = await resp.text();
          log.info(`Fetched XLF ${layoutId} (${xlfText.length} bytes)`);
          this.notifyFileCached(String(layoutId), 'layout');
        }
      } catch (_) {}

      if (xlfText) {
        layoutMediaMap.set(layoutId, extractMediaIdsFromXlf(xlfText, log));
      }
    });
    await Promise.allSettled(xlfPromises);
    log.info(`Parsed ${layoutMediaMap.size} XLFs`);

    // Helper: enqueue a file, attach completion callback
    const enqueueFile = async (builder: any, file: any): Promise<boolean> => {
      if (!file.path || file.path === 'null' || file.path === 'undefined') return false;

      const storeKey = storeKeyFrom(file);

      // Check if already stored on disk
      try {
        const headResp = await fetch(`/store/${storeKey}`, { method: 'HEAD' });
        if (headResp.ok) return false;
      } catch (_) {}

      // Check if already downloading
      if (downloadManager.getTask(storeKey)) return false;

      // Check for existing chunks — skip already-downloaded ones
      try {
        const mcResp = await fetch(`/store/missing-chunks/${storeKey}`);
        if (mcResp.ok) {
          const { missing, numChunks } = await mcResp.json();
          if (numChunks > 0 && missing.length < numChunks) {
            const existing = new Set<number>();
            for (let i = 0; i < numChunks; i++) {
              if (!missing.includes(i)) existing.add(i);
            }
            file.skipChunks = existing;
            log.info(`Resuming ${storeKey}: ${existing.size}/${numChunks} chunks cached, ${missing.length} to download`);
          }
        }
      } catch (_) {}

      const fileDownload = builder.addFile(file);
      if (fileDownload.state !== 'pending') return false;

      // Direct callback — no postMessage needed
      fileDownload.wait().then((blob: any) => {
        const fileSize = parseInt(file.size) || blob.size;
        log.info('Download complete:', storeKey, `(${fileSize} bytes)`);

        // Mark chunked files as complete
        if (fileSize > this._chunkConfig.chunkSize) {
          fetch('/store/mark-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storeKey }),
          }).catch((e: any) => log.warn('mark-complete failed:', storeKey, e.message));
        }

        this.notifyFileCached(String(file.id), file.type);
        queue.removeCompleted(storeKey);
      }).catch((err: any) => {
        log.error('Download failed:', file.id, err);
        queue.removeCompleted(storeKeyFrom(file));
      });
      return true;
    };

    // ── Step 2: Enqueue resources ──
    const resourceBuilder = new LayoutTaskBuilder(queue);
    for (const file of resources) {
      await enqueueFile(resourceBuilder, file);
    }
    const resourceTasks = await resourceBuilder.build();
    if (resourceTasks.length > 0) {
      resourceTasks.push(BARRIER);
      queue.enqueueOrderedTasks(resourceTasks);
    }

    // ── Step 3: For each layout in play order, merge XLF + dependants ──
    const claimed = new Set();
    const nonScheduledIds = [...layoutMediaMap.keys()].filter((id: number) => !layoutOrder.includes(id));
    const filenameToMediaId = new Map();
    for (const [key, file] of mediaFiles) {
      if (file.saveAs) filenameToMediaId.set(file.saveAs, key);
    }

    const depMap = new Map();
    if (layoutDependants) {
      for (const [id, filenames] of Object.entries(layoutDependants)) {
        depMap.set(parseInt(id, 10), filenames);
      }
    }

    for (const layoutId of layoutOrder) {
      const xlfMediaIds = layoutMediaMap.get(layoutId);
      if (!xlfMediaIds) continue;

      const bareIds = new Set(xlfMediaIds);
      for (const nsId of nonScheduledIds) {
        const nsMediaIds = layoutMediaMap.get(nsId);
        if (nsMediaIds) {
          for (const id of nsMediaIds) bareIds.add(id);
        }
      }
      const deps = depMap.get(layoutId) || [];
      for (const filename of deps) {
        const key = filenameToMediaId.get(filename);
        if (key) bareIds.add(key);
      }

      const matched: any[] = [];
      for (const bareId of bareIds) {
        if (mediaFiles.has(bareId) && !claimed.has(bareId)) {
          matched.push(mediaFiles.get(bareId));
          claimed.add(bareId);
          continue;
        }
        const keys = idToKeys.get(String(bareId)) || [];
        for (const key of keys) {
          if (claimed.has(key)) continue;
          matched.push(mediaFiles.get(key));
          claimed.add(key);
        }
      }
      if (matched.length === 0) continue;

      log.info(`Layout ${layoutId}: ${matched.length} media`);
      matched.sort((a: any, b: any) => (a.size || 0) - (b.size || 0));
      const builder = new LayoutTaskBuilder(queue);
      for (const file of matched) {
        await enqueueFile(builder, file);
      }
      const orderedTasks = await builder.build();
      if (orderedTasks.length > 0) {
        orderedTasks.push(BARRIER);
        queue.enqueueOrderedTasks(orderedTasks);
      }
    }

    // Enqueue unclaimed media
    const unclaimed = [...mediaFiles.keys()].filter((id: string) => !claimed.has(id));
    if (unclaimed.length > 0) {
      log.info(`${unclaimed.length} media not in any XLF`);
      const builder = new LayoutTaskBuilder(queue);
      for (const id of unclaimed) {
        const file = mediaFiles.get(id);
        if (file) await enqueueFile(builder, file);
      }
      const orderedTasks = await builder.build();
      if (orderedTasks.length > 0) {
        queue.enqueueOrderedTasks(orderedTasks);
      }
    }

    log.info('Downloads active:', queue.running, ', queued:', queue.queue.length);
  }

  /**
   * Setup renderer event handlers
   */
  private setupRendererEventHandlers() {
    this.renderer.on('layoutStart', (layoutId: number, _layout: any) => {
      log.info('Layout started:', layoutId);
      this.updateStatus(`Playing layout ${layoutId}`);
      this.core.setCurrentLayout(layoutId);

      // Record the renderer's computed duration (from XLF region/widget analysis).
      // This ensures image-only layouts get a correct duration in the timeline
      // even when _buildLayoutDurations can't access the cache (PWA StoreClient).
      if (_layout?.duration > 0) {
        this.core.recordLayoutDuration(String(layoutId), _layout.duration);
      }

      // Store layout-level enableStat for use in layoutEnd
      this._currentLayoutEnableStat = _layout?.enableStat !== false;

      // Update timeline overlay highlight
      this.timelineOverlay?.update(null, layoutId);

      // Track stats: start layout (only if enableStat is not disabled)
      if (this.statsCollector && this._currentLayoutEnableStat) {
        this.statsCollector.startLayout(layoutId, this.currentScheduleId).catch((err: any) => {
          log.error('Failed to start layout stat:', err);
        });
      }
    });

    this.renderer.on('layoutEnd', (layoutId: number) => {
      log.info('Layout ended:', layoutId);

      // Record play at END so maxPlaysPerHour doesn't interrupt the current play.
      // Previously recorded at layoutStart, which caused periodic collections to
      // filter the layout mid-playback (e.g., 200s video cut at 168s).
      scheduleManager?.recordPlay(layoutId.toString());

      // Track stats: end layout (only if enableStat was not disabled)
      if (this.statsCollector && this._currentLayoutEnableStat) {
        this.statsCollector.endLayout(layoutId, this.currentScheduleId).catch((err: any) => {
          log.error('Failed to end layout stat:', err);
        });
      }

      // Report to CMS
      this.core.notifyLayoutStatus(layoutId);

      // Clear current layout to allow replay/advance
      this.core.clearCurrentLayout();

      // If a new layout is already pending download, don't advance
      // (avoids redundant XMDS calls and duplicate download requests)
      const pending = this.core.getPendingLayouts();
      if (pending.length > 0) {
        log.info(`Layout ${pending[0]} pending download, skipping advance`);
        return;
      }

      // Advance to the next layout in the schedule (round-robin cycling)
      // This avoids a full collect() cycle — just picks the next layout and renders it.
      // Periodic collect() cycles still run on the collection interval to sync with CMS.
      log.info('Layout cycle completed, advancing to next layout...');
      this.core.advanceToNextLayout();
    });

    this.renderer.on('widgetStart', (data: any) => {
      const { widgetId, layoutId, mediaId } = data;
      log.debug('Widget started:', data.type, widgetId, 'media:', mediaId);

      // Track stats: start widget/media (only if enableStat is not disabled)
      if (this.statsCollector && mediaId && data.enableStat !== false) {
        this.statsCollector.startWidget(mediaId, layoutId, this.currentScheduleId).catch((err: any) => {
          log.error('Failed to start widget stat:', err);
        });
      }
    });

    this.renderer.on('widgetEnd', (data: any) => {
      const { widgetId, layoutId, mediaId } = data;
      log.debug('Widget ended:', data.type, widgetId, 'media:', mediaId);

      // Track stats: end widget/media (only if enableStat is not disabled)
      if (this.statsCollector && mediaId && data.enableStat !== false) {
        this.statsCollector.endWidget(mediaId, layoutId, this.currentScheduleId).catch((err: any) => {
          log.error('Failed to end widget stat:', err);
        });
      }
    });

    // Widget commands (#202) — execute commands embedded in layout widgets
    this.renderer.on('widgetCommand', (data: any) => {
      log.info('Widget command:', data.commandCode);
      const commands = { [data.commandCode]: { commandString: data.commandString } };
      this.core.executeCommand(data.commandCode, commands);
    });

    this.renderer.on('error', (error: any) => {
      log.error('Renderer error:', error);
      this.updateStatus(`Error: ${error.type}`, 'error');

      // Report fault to CMS (triggers dashboard alert)
      this.logReporter?.reportFault(
        error.type || 'RENDERER_ERROR',
        `Renderer error: ${error.message || error.type} (layout ${error.layoutId || 'unknown'})`
      );
      this.submitFault(error.type || 'RENDERER_ERROR', `Renderer error: ${error.message || error.type}`, {
        layoutId: error.layoutId,
        regionId: error.regionId,
        widgetId: error.widgetId
      });
    });

    // Handle interactive actions from touch/click and keyboard triggers
    this.renderer.on('action-trigger', (data: any) => {
      const { actionType, triggerCode, layoutCode, targetId, commandCode } = data;
      log.info('Action trigger:', actionType, data);

      switch (actionType) {
        case 'navLayout':
        case 'navigateToLayout':
          if (triggerCode) {
            this.core.handleTrigger(triggerCode);
          } else if (layoutCode) {
            this.core.changeLayout(layoutCode);
          }
          break;

        case 'navWidget':
        case 'navigateToWidget':
          if (triggerCode) {
            this.core.handleTrigger(triggerCode);
          } else if (targetId) {
            this.renderer.navigateToWidget(targetId);
          }
          break;

        case 'previousWidget':
          this.renderer.previousWidget(data.source?.regionId);
          break;

        case 'nextWidget':
          this.renderer.nextWidget(data.source?.regionId);
          break;

        case 'command':
          if (commandCode) {
            this.core.executeCommand(commandCode);
          }
          break;

        default:
          log.warn('Unknown action type:', actionType);
      }

      // Record interaction event for proof of play (#19)
      if (this.statsCollector) {
        this.statsCollector.recordEvent('touch', this.core.getCurrentLayoutId(), data.targetId || null, this.currentScheduleId);
      }
    });

    // Widget duration webhooks (#16) — fire HTTP POST when widget duration expires
    this.renderer.on('widgetAction', (data: any) => {
      if (data.type === 'durationEnd' && data.url) {
        log.info(`Widget ${data.widgetId} duration ended, calling webhook: ${data.url}`);

        // Record webhook event for proof of play (#19)
        if (this.statsCollector) {
          this.statsCollector.recordEvent('webhook', data.layoutId, data.widgetId, this.currentScheduleId);
        }

        fetch(data.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            widgetId: data.widgetId,
            layoutId: data.layoutId,
            regionId: data.regionId,
            event: 'durationEnd',
            timestamp: new Date().toISOString()
          })
        }).catch(err => log.warn('Webhook failed (non-critical):', err));
      }
    });

    // Correct timeline duration when video metadata reveals actual duration
    this.renderer.on('layoutDurationUpdated', (layoutId: number, duration: number) => {
      this.core.recordLayoutDuration(String(layoutId), duration);
    });

    // Handle next layout preload request from renderer
    // Fired at 75% of current layout duration to pre-build the next layout's DOM
    this.renderer.on('request-next-layout-preload', async () => {
      try {
        // Peek at the next layout without advancing the schedule index
        const next = this.core.peekNextLayout();
        if (!next) {
          log.debug('No next layout to preload (single layout schedule or same layout)');
          return;
        }

        const nextLayoutId = next.layoutId;

        // Skip if already preloaded
        if (this.renderer.layoutPool.has(nextLayoutId)) {
          log.debug(`Layout ${nextLayoutId} already in preload pool`);
          return;
        }

        log.info(`Preloading next layout ${nextLayoutId}...`);

        // Get XLF from cache
        const xlfBlob = await store.get(`${STORE_PREFIX}/layouts`, nextLayoutId);
        if (!xlfBlob) {
          log.debug(`Layout ${nextLayoutId} XLF not cached, skipping preload`);
          return;
        }

        const xlfXml = await xlfBlob.text();

        // Check if all required media is cached
        const { allMedia: requiredMedia } = this.getMediaIds(xlfXml);
        const allMediaCached = await this.checkAllMediaCached(requiredMedia);

        if (!allMediaCached) {
          log.debug(`Media not fully cached for layout ${nextLayoutId}, skipping preload`);
          return;
        }

        // Fetch widget HTML before preloading (same as prepareAndRenderLayout)
        await this.fetchWidgetHtml(xlfXml, nextLayoutId);

        // Preload the layout into the renderer's pool
        const success = await this.renderer.preloadLayout(xlfXml, nextLayoutId);
        if (success) {
          log.info(`Layout ${nextLayoutId} preloaded successfully`);
        } else {
          log.warn(`Layout ${nextLayoutId} preload failed (will fall back to normal render)`);
        }
      } catch (error) {
        log.warn('Layout preload failed (non-blocking):', error);
        // Non-blocking: preload failure is graceful, normal render path will be used
      }
    });

    // Handle video playback errors — re-download only missing chunks
    this.renderer.on('videoError', async ({ storedAs }: any) => {
      if (!storedAs) return;
      const storeKey = `${PLAYER_API.slice(1)}/media/file/${storedAs}`;
      try {
        const resp = await fetch(`/store/missing-chunks/${storeKey}`);
        const { missing } = await resp.json();
        if (missing.length === 0) {
          log.warn(`Video error for ${storedAs} but no missing chunks — possible decode error`);
          return;
        }
        log.warn(`Video ${storedAs}: ${missing.length} missing chunks (${missing.join(', ')}), re-downloading`);

        // Unmark completion (keeps existing chunks on disk) so HEAD returns 404
        await fetch('/store/unmark-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeKey }),
        });

        // Trigger collection — enqueueFile will populate skipChunks for existing chunks
        this.core.collectNow().catch((err: any) => {
          log.error(`Failed to trigger re-download for ${storedAs}:`, err.message);
        });
      } catch (err: any) {
        log.error(`Failed to check/re-download ${storedAs}:`, err.message);
      }
    });
  }

  /**
   * Prepare and render layout (Platform-specific logic)
   */
  private async prepareAndRenderLayout(layoutId: number) {
    // Guard: skip if already playing this layout (another event already rendered it)
    if (this.core.getCurrentLayoutId() === layoutId) {
      log.debug(`Layout ${layoutId} already playing, skipping duplicate prepare`);
      return;
    }

    // Guard: prevent concurrent preparations of the same layout.
    // Instead of dropping the event (which caused permanent stalls when the
    // first attempt failed due to a store race), schedule a retry after
    // the current preparation finishes.
    if (this.preparingLayoutId === layoutId) {
      log.debug(`Layout ${layoutId} preparation in progress, will retry after it completes`);
      this._pendingRetryLayoutId = layoutId;
      return;
    }

    this.preparingLayoutId = layoutId;
    try {
      // Get XLF from cache
      const xlfBlob = await store.get(`${STORE_PREFIX}/layouts`, layoutId);
      if (!xlfBlob) {
        log.info('Layout not in cache yet, marking as pending:', layoutId);
        // Mark layout as pending so when it downloads, we'll retry
        // Use layoutId as required file (will trigger on layout file cached)
        this.core.setPendingLayout(layoutId, [String(layoutId)]);
        this.updateStatus(`Downloading layout ${layoutId}...`);
        return;
      }

      const xlfXml = await xlfBlob.text();

      // Check if all required media is cached
      const { allMedia: requiredMedia } = this.getMediaIds(xlfXml);
      const allMediaCached = await this.checkAllMediaCached(requiredMedia);

      if (!allMediaCached) {
        // Reorder download queue: current layout's media first, hold others.
        // All files (including all chunks) must complete before other layouts start.
        downloadManager.prioritizeLayoutFiles(requiredMedia.map(String));

        log.info(`Waiting for media to finish downloading for layout ${layoutId}`);
        this.updateStatus(`Preparing layout ${layoutId}...`);
        this.core.setPendingLayout(layoutId, requiredMedia);
        return; // Keep playing current layout until media is ready
      }

      // Fetch widget HTML (skip if already preloaded — was fetched during preload)
      if (!this.renderer.hasPreloadedLayout(layoutId)) {
        await this.fetchWidgetHtml(xlfXml, layoutId);
      }

      // Render layout
      await this.renderer.renderLayout(xlfXml, layoutId);
      this.updateStatus(`Playing layout ${layoutId}`);

    } catch (error: any) {
      log.error('Failed to prepare layout:', layoutId, error);
      this.updateStatus(`Failed to load layout ${layoutId}`, 'error');

      // Report fault to CMS (triggers dashboard alert)
      this.logReporter?.reportFault(
        'LAYOUT_LOAD_FAILED',
        `Failed to prepare layout ${layoutId}: ${error?.message || error}`
      );
      this.submitFault('LAYOUT_LOAD_FAILED', `Failed to prepare layout ${layoutId}: ${error?.message || error}`, {
        layoutId
      });
    } finally {
      this.preparingLayoutId = null;

      // If another check-pending-layout arrived while we were preparing,
      // retry after a short delay to let the ContentStore settle.
      // This fixes the race where FILE_CACHED notification arrives before
      // the PUT to ContentStore is visible to HEAD requests.
      const retryId = this._pendingRetryLayoutId;
      this._pendingRetryLayoutId = null;
      if (retryId !== null && retryId !== undefined && this.core.getCurrentLayoutId() !== retryId) {
        log.debug(`Retrying preparation for layout ${retryId} after 500ms`);
        setTimeout(() => this.prepareAndRenderLayout(retryId), 500);
      }
    }
  }

  /**
   * Get all required media file IDs and video-specific IDs from layout XLF.
   * Single parse to avoid double DOMParser overhead on the same XML.
   */
  /**
   * Get all required media saveAs filenames and video-specific ones from layout XLF.
   * Returns saveAs strings (via _fileIdToSaveAs map) for store key matching.
   */
  private getMediaIds(xlfXml: string): { allMedia: string[]; videoMedia: string[] } {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xlfXml, 'text/xml');
    const allMedia: string[] = [];
    const videoMedia: string[] = [];

    doc.querySelectorAll('media[fileId]').forEach(el => {
      const fileId = el.getAttribute('fileId');
      if (fileId) {
        const saveAs = this._fileIdToSaveAs.get(fileId) || fileId;
        allMedia.push(saveAs);
        if (el.getAttribute('type') === 'video') {
          videoMedia.push(saveAs);
        }
      }
    });

    // Include background image file ID from layout element
    const bgFileId = doc.querySelector('layout')?.getAttribute('background');
    if (bgFileId) {
      const saveAs = this._fileIdToSaveAs.get(bgFileId) || bgFileId;
      if (!allMedia.includes(saveAs)) {
        allMedia.push(saveAs);
      }
    }

    return { allMedia, videoMedia };
  }

  /**
   * Check if all required media files are cached and ready.
   * Uses StoreClient.has() → HEAD /store${PLAYER_API}/media/:id to check ContentStore.
   */
  /**
   * Check if all required media files are cached and ready.
   * Uses storedAs filenames for store key matching: /media/file/{saveAs}
   */
  private async checkAllMediaCached(mediaSaveAs: string[]): Promise<boolean> {
    for (const saveAs of mediaSaveAs) {
      try {
        const cached = await store.has(STORE_PREFIX, `media/file/${saveAs}`);
        if (!cached) {
          log.debug(`Media ${saveAs} not yet cached`);
          return false;
        }
        log.debug(`Media ${saveAs} cached`);
      } catch (error) {
        log.warn(`Unable to verify media ${saveAs}, assuming cached (offline mode)`);
      }
    }
    return true;
  }

  /**
   * Fetch widget HTML for all widgets in layout (parallel)
   */
  private async fetchWidgetHtml(xlfXml: string, layoutId: number) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xlfXml, 'text/xml');

    const fetchPromises: Promise<void>[] = [];

    for (const regionEl of doc.querySelectorAll('region')) {
      const regionId = regionEl.getAttribute('id');

      for (const mediaEl of regionEl.querySelectorAll('media')) {
        const type = mediaEl.getAttribute('type');
        const widgetId = mediaEl.getAttribute('id');
        const render = mediaEl.getAttribute('render');

        // XLF render="html" means CMS provides pre-rendered HTML via getResource.
        // render="native" means player handles the media directly (video, image, audio).
        if (render === 'html') {
          fetchPromises.push(
            (async () => {
              try {
                // Check ContentStore for existing widget HTML
                const storeId = `${layoutId}/${regionId}/${widgetId}`;
                let html: string | null = null;

                const existing = await store.get(`${STORE_PREFIX}/widgets`, storeId);
                if (existing) {
                  html = await existing.text();
                  log.debug(`Found cached widget HTML for ${type} ${widgetId}`);
                }

                if (!html) {
                  html = await this.xmds.getResource(layoutId, regionId, widgetId);
                  log.debug(`Retrieved widget HTML for ${type} ${widgetId} from CMS`);
                }
                // Always process: injects <base> tag, rewrites IC hostAddress.
                // cacheWidgetHtml is idempotent — already-rewritten URLs won't re-match.
                await cacheWidgetHtml(layoutId, regionId, widgetId, html);
                // Read back the processed version from ContentStore
                const processed = await store.get(`${STORE_PREFIX}/widgets`, storeId);
                if (processed) html = await processed.text();

                // Update raw content in XLF
                const rawEl = mediaEl.querySelector('raw');
                if (rawEl) {
                  rawEl.textContent = html;
                } else {
                  const newRaw = doc.createElement('raw');
                  newRaw.textContent = html;
                  mediaEl.appendChild(newRaw);
                }
              } catch (error) {
                log.warn(`Failed to get widget HTML for ${type} ${widgetId}:`, error);
              }
            })()
          );
        }
      }
    }

    if (fetchPromises.length > 0) {
      log.info(`Fetching ${fetchPromises.length} widget HTML resources in parallel...`);
      await Promise.all(fetchPromises);
      log.debug('All widget HTML fetched');
    }
  }

  /**
   * Check media cache status for all scheduled layouts.
   * For each layout: load XLF from cache, extract media IDs, check each with store.has().
   * Feeds results into PlayerCore.setLayoutMediaStatus() for timeline annotation.
   */
  private async checkTimelineMediaStatus() {
    if (this.scheduledLayoutIds.size === 0) return;

    for (const layoutId of this.scheduledLayoutIds) {
      const layoutFile = `${layoutId}.xlf`;
      try {
        const xlfBlob = await store.get(`${STORE_PREFIX}/layouts`, layoutId);
        if (!xlfBlob) continue;

        const xlfXml = await xlfBlob.text();
        const { allMedia } = this.getMediaIds(xlfXml);

        if (allMedia.length === 0) {
          this.core.setLayoutMediaStatus(layoutFile, true);
          continue;
        }

        const missing: string[] = [];
        for (const saveAs of allMedia) {
          try {
            const cached = await store.has(STORE_PREFIX, `media/file/${saveAs}`);
            if (!cached) missing.push(saveAs);
          } catch {
            // Assume cached on error (offline mode)
          }
        }

        this.core.setLayoutMediaStatus(layoutFile, missing.length === 0, missing);
      } catch {
        // Skip layouts we can't load
      }
    }

    // Re-emit annotated timeline
    this.core.logUpcomingTimeline();
  }

  /**
   * Probe video durations for all scheduled layouts.
   * Uses preload="metadata" — only fetches headers (~50KB), not the full video.
   * Feeds discovered durations into PlayerCore for accurate timeline calculation.
   */
  private async probeLayoutDurations() {
    if (this.scheduledLayoutIds.size === 0) return;

    for (const layoutId of this.scheduledLayoutIds) {

      try {
        const xlfBlob = await store.get(`${STORE_PREFIX}/layouts`, layoutId);
        if (!xlfBlob) continue;

        const xlfXml = await xlfBlob.text();
        const { videoMedia } = this.getMediaIds(xlfXml);
        if (videoMedia.length === 0) continue;

        // Parse XLF to find video widgets with duration=0 (use media length)
        const parser = new DOMParser();
        const doc = parser.parseFromString(xlfXml, 'text/xml');

        // Probe actual video durations, keyed by fileId
        const videoDurations = new Map<string, number>();
        for (const mediaEl of doc.querySelectorAll('media[type="video"]')) {
          const useDuration = mediaEl.getAttribute('useDuration');
          if (useDuration === '1') continue; // Has explicit CMS duration, skip

          const fileId = mediaEl.getAttribute('fileId');
          if (!fileId) continue;

          const saveAs = this._fileIdToSaveAs.get(fileId) || fileId;
          const exists = await store.has(STORE_PREFIX, `media/file/${saveAs}`);
          if (!exists) continue;

          // Probe metadata only — does NOT download the full video
          const duration = await this.probeVideoDuration(`${window.location.origin}${PLAYER_API}/media/file/${saveAs}`);
          if (duration > 0) {
            videoDurations.set(fileId, duration);
          }
        }

        if (videoDurations.size === 0) continue;

        // Phase 2: refine layout duration with probed video lengths
        const { duration: probedDuration } = parseLayoutDuration(xlfXml, videoDurations);
        if (probedDuration > 0) {
          this.core.recordLayoutDuration(String(layoutId), probedDuration);
        }
      } catch (err) {
        log.debug(`Duration probe failed for layout ${layoutId}:`, err);
      }
    }
  }

  /**
   * Probe a single video's duration using metadata only.
   * Creates a temporary <video preload="metadata"> element, reads duration, destroys it.
   */
  private probeVideoDuration(url: string): Promise<number> {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;

      const cleanup = () => {
        video.removeAttribute('src');
        video.load(); // Release resources
      };

      video.addEventListener('loadedmetadata', () => {
        const dur = video.duration;
        cleanup();
        resolve(dur);
      }, { once: true });

      video.addEventListener('error', () => {
        cleanup();
        resolve(0);
      }, { once: true });

      // Safety timeout — don't block forever
      setTimeout(() => {
        cleanup();
        resolve(0);
      }, 5000);

      video.src = url;
    });
  }

  /**
   * Update config display
   */
  private updateConfigDisplay() {
    const configEl = document.getElementById('config-info');
    if (configEl) {
      const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?';
      const buildDate = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__.replace('T', ' ').replace(/\.\d+Z$/, '') : '';
      const versionStr = buildDate ? `v${version} (${buildDate})` : `v${version}`;
      configEl.textContent = `${versionStr} | CMS: ${config.cmsUrl} | Display: ${config.displayName || 'Unknown'} | HW: ${config.hardwareKey}`;
    }
  }

  /**
   * Submit proof of play stats to CMS
   */
  private async submitStats() {
    if (!this.statsCollector) {
      log.warn('Stats collector not initialized');
      return;
    }

    // Guard: don't start a new delegation while one is in-flight
    if (this._pendingFollowerStats !== null) {
      log.debug('Stats delegation in-flight, skipping');
      return;
    }

    try {
      // Get stats ready for submission (up to 50 at a time)
      // Use aggregation level from CMS settings if available
      const aggregationLevel = this.displaySettings?.getSetting('aggregationLevel') || 'Individual';
      const stats = aggregationLevel === 'Aggregate'
        ? await this.statsCollector.getAggregatedStatsForSubmission(50)
        : await this.statsCollector.getStatsForSubmission(50);

      if (stats.length === 0) {
        log.debug('No stats to submit');
        return;
      }

      // Format stats as XML
      const statsXml = formatStats(stats);

      // Follower with live lead: delegate stats via BroadcastChannel
      if (this.syncManager && !this.syncManager.isLead && this._syncLeadAlive()) {
        log.info(`[Sync] Delegating ${stats.length} stats to lead`);
        this._pendingFollowerStats = stats;
        this.syncManager.reportStats(statsXml);
        return;
      }

      // Lead, standalone, or lead-dead follower: submit directly
      if (this.syncManager && !this.syncManager.isLead) {
        log.warn('[Sync] Lead not alive, submitting stats directly');
      }

      log.info(`Submitting ${stats.length} proof of play stats...`);

      // Submit to CMS via XMDS
      const success = await this.xmds.submitStats(statsXml);

      if (success) {
        log.info('Stats submitted successfully');
        // Clear submitted stats from database
        await this.statsCollector.clearSubmittedStats(stats);
        log.debug(`Cleared ${stats.length} submitted stats from database`);
      } else {
        log.warn('Stats submission failed (CMS returned false)');
      }
    } catch (error) {
      log.error('Failed to submit stats:', error);
    }
  }

  /**
   * Submit player logs to CMS for remote debugging
   */
  private async submitLogs() {
    if (!this.logReporter) return;

    // Guard: don't start a new delegation while one is in-flight
    if (this._pendingFollowerLogs !== null) {
      log.debug('Logs delegation in-flight, skipping');
      return;
    }

    try {
      const logs = await this.logReporter.getLogsForSubmission();

      if (logs.length === 0) {
        log.debug('No logs to submit');
        return;
      }

      const logXml = formatLogs(logs);

      // Follower with live lead: delegate logs via BroadcastChannel
      if (this.syncManager && !this.syncManager.isLead && this._syncLeadAlive()) {
        log.info(`[Sync] Delegating ${logs.length} logs to lead`);
        this._pendingFollowerLogs = logs;
        this.syncManager.reportLogs(logXml);
        return;
      }

      // Lead, standalone, or lead-dead follower: submit directly
      if (this.syncManager && !this.syncManager.isLead) {
        log.warn('[Sync] Lead not alive, submitting logs directly');
      }

      log.info(`Submitting ${logs.length} logs to CMS...`);

      const success = await this.xmds.submitLog(logXml);

      if (success) {
        log.info('Logs submitted successfully');
        await this.logReporter.clearSubmittedLogs(logs);
      } else {
        log.warn('Log submission failed (CMS returned false)');
      }
    } catch (error) {
      log.error('Failed to submit logs:', error);
    }
  }

  /**
   * Submit a fault report to CMS for the player_faults dashboard.
   * Runs alongside logReporter.reportFault() which feeds the log dashboard.
   */
  private submitFault(code: string, reason: string, details?: { layoutId?: number; regionId?: string; widgetId?: string }) {
    if (!this.xmds) return;

    const fault = JSON.stringify([{
      code,
      reason,
      date: new Date().toISOString().replace('T', ' ').substring(0, 19),
      ...details
    }]);

    this.xmds.reportFaults(fault).catch((err: any) => {
      log.debug('reportFaults failed (non-critical):', err);
    });
  }

  /**
   * Capture screenshot and submit to CMS.
   *
   * Strategy (best available, tried in order):
   *  0. Electron IPC — webContents.capturePage() via preload bridge.
   *     Pixel-perfect, captures video/WebGL/composited layers, zero DOM cost.
   *     Only available when running inside the Electron shell.
   *  1. getDisplayMedia() — native pixel capture, works on Chrome with
   *     --auto-select-desktop-capture-source flag (kiosk). Pixel-perfect,
   *     includes video, composited layers, everything the GPU renders.
   *  2. html2canvas — fallback for Firefox or Chrome without the flag.
   *     Re-renders the DOM to canvas; needs a video overlay workaround
   *     because html2canvas can't read <video> pixels.
   *
   * The first successful method is cached for subsequent calls.
   */
  private async captureAndSubmitScreenshot() {
    // Concurrency guard — skip if a capture is already in flight
    if (this._screenshotInFlight) {
      log.debug('Screenshot capture already in progress, skipping');
      return;
    }
    this._screenshotInFlight = true;

    try {
      let base64: string;

      // Electron path: use native webContents.capturePage() via IPC
      if (this._screenshotMethod === 'electron' ||
          (this._screenshotMethod === null && (window as any).electronAPI?.captureScreenshot)) {
        const electronResult = await (window as any).electronAPI.captureScreenshot();
        if (electronResult) {
          this._screenshotMethod = 'electron';
          base64 = electronResult;
        } else {
          // Electron capture returned null (window not yet painted).
          // Do NOT fall through to getDisplayMedia — it triggers a
          // permission dialog that blocks the whole UI.  Skip this
          // cycle; capturePage() will succeed on the next interval.
          log.debug('Electron screenshot not ready yet, will retry next interval');
          return;
        }
      } else {
        this._screenshotMethod = 'html2canvas';
        base64 = await this.captureHtml2Canvas();
      }

      const success = await this.xmds.submitScreenShot(base64);
      if (success) {
        log.info(`Screenshot submitted (${this._screenshotMethod})`);
      } else {
        log.warn('Screenshot submission failed');
      }
    } catch (error) {
      log.error('Failed to capture screenshot:', error);
    } finally {
      this._screenshotInFlight = false;
    }
  }

  /**
   * Capture screenshot by manually composing a canvas from visible elements.
   * - Images/video/canvas: drawn directly via ctx.drawImage() with object-fit emulation
   * - Iframes: content cloned into main document, rendered via html2canvas
   *   (html2canvas fails on cross-document elements, so we clone first)
   * - Background: read from #player-container computed style
   */
  private async captureHtml2Canvas(): Promise<string> {
    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d')!;

    // Background: black (matches player default)
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const container = document.getElementById('player-container');
    if (!container) {
      return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    }

    // Draw container background (layout bgcolor + background image)
    const containerRect = container.getBoundingClientRect();
    const containerStyle = getComputedStyle(container);
    const bgColor = containerStyle.backgroundColor;
    if (bgColor && bgColor !== 'transparent' && bgColor !== 'rgba(0, 0, 0, 0)') {
      ctx.fillStyle = bgColor;
      ctx.fillRect(containerRect.left, containerRect.top, containerRect.width, containerRect.height);
    }
    // Background image (blob URL from layout XLF)
    const bgImage = containerStyle.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      const urlMatch = bgImage.match(/url\(["']?(.*?)["']?\)/);
      if (urlMatch) {
        try {
          const bgImg = new Image();
          bgImg.crossOrigin = 'anonymous';
          await new Promise<void>((resolve) => {
            bgImg.onload = () => resolve();
            bgImg.onerror = () => resolve();
            setTimeout(() => resolve(), 2000);
            bgImg.src = urlMatch[1];
          });
          if (bgImg.naturalWidth) {
            ctx.drawImage(bgImg, containerRect.left, containerRect.top, containerRect.width, containerRect.height);
          }
        } catch (_) { /* skip failed background */ }
      }
    }

    // Ensure html2canvas is loaded (pre-loaded at init, fallback to lazy load)
    if (!this._html2canvasMod) {
      this._html2canvasMod = (await import('html2canvas')).default;
    }

    // Draw each visible widget element onto the canvas
    const elements = container.querySelectorAll('img, video, iframe, canvas');
    let drawn = 0;

    for (const el of elements) {
      const htmlEl = el as HTMLElement;
      if (htmlEl.style.visibility === 'hidden') continue;
      if (htmlEl.style.display === 'none') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      try {
        if (el instanceof HTMLImageElement) {
          if (!el.complete || !el.naturalWidth) continue;
          // Emulate object-fit: contain — draw at correct aspect ratio within bounding rect
          const fit = getComputedStyle(el).objectFit;
          if (fit === 'contain' && el.naturalWidth && el.naturalHeight) {
            const d = this.containedRect(el.naturalWidth, el.naturalHeight, rect);
            ctx.drawImage(el, d.x, d.y, d.w, d.h);
          } else {
            ctx.drawImage(el, rect.left, rect.top, rect.width, rect.height);
          }
          drawn++;
        } else if (el instanceof HTMLVideoElement) {
          if (el.readyState < 2) continue;
          // Emulate object-fit: contain — draw at correct aspect ratio within bounding rect
          const fit = getComputedStyle(el).objectFit;
          if (fit === 'contain' && el.videoWidth && el.videoHeight) {
            const d = this.containedRect(el.videoWidth, el.videoHeight, rect);
            ctx.drawImage(el, d.x, d.y, d.w, d.h);
          } else {
            ctx.drawImage(el, rect.left, rect.top, rect.width, rect.height);
          }
          drawn++;
        } else if (el instanceof HTMLCanvasElement) {
          ctx.drawImage(el, rect.left, rect.top, rect.width, rect.height);
          drawn++;
        } else if (el instanceof HTMLIFrameElement) {
          const iDoc = el.contentDocument;
          if (!iDoc?.body) continue;

          // html2canvas fails on cross-document elements (produces transparent canvas).
          // Clone the iframe's styles + content into the main document first,
          // then run html2canvas on the clone in the main document context.
          const captureDiv = document.createElement('div');
          captureDiv.style.cssText = `position:fixed;left:-9999px;top:0;width:${rect.width}px;height:${rect.height}px;overflow:hidden;`;

          // Clone stylesheets with absolute URLs (iframe base may differ)
          const linkPromises: Promise<void>[] = [];
          for (const styleEl of iDoc.querySelectorAll('style')) {
            captureDiv.appendChild(styleEl.cloneNode(true));
          }
          for (const linkEl of iDoc.querySelectorAll('link[rel="stylesheet"]')) {
            const newLink = document.createElement('link');
            newLink.rel = 'stylesheet';
            newLink.href = new URL(linkEl.getAttribute('href') || '', iDoc.baseURI).href;
            captureDiv.appendChild(newLink);
            // Wait for each stylesheet to load (or fail) instead of arbitrary delay
            linkPromises.push(new Promise<void>(resolve => {
              newLink.onload = () => resolve();
              newLink.onerror = () => resolve();
            }));
          }

          // Clone body content
          const clonedBody = iDoc.body.cloneNode(true) as HTMLElement;
          // Rewrite img src to absolute URLs — the <base> tag stays in the
          // iframe <head> so relative srcs like "36.png" would resolve against
          // the main document origin (e.g. /player/36.png → 404)
          for (const img of clonedBody.querySelectorAll('img[src]')) {
            const src = img.getAttribute('src') || '';
            if (src && !src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('blob:')) {
              img.setAttribute('src', new URL(src, iDoc.baseURI).href);
            }
          }
          captureDiv.appendChild(clonedBody);
          document.body.appendChild(captureDiv);

          // Collect natural dimensions from ORIGINAL iframe images (before html2canvas clones).
          // html2canvas doesn't support object-fit, so we fix sizing in onclone.
          const origImgs = iDoc.querySelectorAll('img');
          const imgNaturals = new Map<string, { nw: number; nh: number }>();
          origImgs.forEach((img, i) => {
            if (img.naturalWidth && img.naturalHeight) {
              imgNaturals.set(String(i), { nw: img.naturalWidth, nh: img.naturalHeight });
            }
          });

          // Wait for stylesheets to load (with 500ms safety timeout)
          if (linkPromises.length > 0) {
            await Promise.race([
              Promise.all(linkPromises),
              new Promise(r => setTimeout(r, 500)),
            ]);
          }

          const iframeCanvas = await this._html2canvasMod(captureDiv, {
            useCORS: true, allowTaint: true, logging: false,
            backgroundColor: null,
            width: rect.width, height: rect.height,
            onclone: (clonedDoc: Document) => {
              // Force visible — widget CSS animations reset to opacity:0 in cloned DOM
              const s = clonedDoc.createElement('style');
              s.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; opacity: 1 !important; }';
              clonedDoc.head.appendChild(s);

              // Fix object-fit: contain — html2canvas stretches images, ignoring object-fit.
              // Replace with explicit sizing + centering so html2canvas draws correct proportions.
              const clonedImgs = clonedDoc.querySelectorAll('img');
              clonedImgs.forEach((cImg, i) => {
                const style = clonedDoc.defaultView?.getComputedStyle(cImg);
                if (!style || style.objectFit !== 'contain') return;
                const dims = imgNaturals.get(String(i));
                if (!dims) return;

                const cW = cImg.clientWidth || parseFloat(style.width) || 0;
                const cH = cImg.clientHeight || parseFloat(style.height) || 0;
                if (!cW || !cH) return;

                const srcAspect = dims.nw / dims.nh;
                const dstAspect = cW / cH;
                let drawW: number, drawH: number;
                if (srcAspect > dstAspect) {
                  drawW = cW;
                  drawH = cW / srcAspect;
                } else {
                  drawH = cH;
                  drawW = cH * srcAspect;
                }

                // Wrap in a flex container to center, remove object-fit
                const wrapper = clonedDoc.createElement('div');
                wrapper.style.cssText = `width:${cW}px;height:${cH}px;display:flex;align-items:center;justify-content:center;overflow:hidden;`;
                cImg.style.objectFit = 'fill';
                cImg.style.width = `${drawW}px`;
                cImg.style.height = `${drawH}px`;
                cImg.parentNode?.insertBefore(wrapper, cImg);
                wrapper.appendChild(cImg);
              });
            },
          });

          document.body.removeChild(captureDiv);
          ctx.drawImage(iframeCanvas, rect.left, rect.top, rect.width, rect.height);
          drawn++;
        }
      } catch (e: any) {
        log.warn('Screenshot: failed to draw element', el.tagName, e);
      }
    }

    log.debug(`Screenshot: composed ${drawn}/${elements.length} elements`);
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  }

  /**
   * Calculate the destination rect for object-fit: contain.
   * Returns the centered rect that preserves the source aspect ratio
   * within the bounding rect (letterbox/pillarbox).
   */
  private containedRect(
    srcW: number, srcH: number, rect: DOMRect
  ): { x: number; y: number; w: number; h: number } {
    const srcAspect = srcW / srcH;
    const dstAspect = rect.width / rect.height;
    let w: number, h: number;
    if (srcAspect > dstAspect) {
      // Source is wider — fit to width, letterbox top/bottom
      w = rect.width;
      h = rect.width / srcAspect;
    } else {
      // Source is taller — fit to height, pillarbox left/right
      h = rect.height;
      w = rect.height * srcAspect;
    }
    return {
      x: rect.left + (rect.width - w) / 2,
      y: rect.top + (rect.height - h) / 2,
      w, h,
    };
  }

  /**
   * Start periodic screenshot submission
   */
  private startScreenshotInterval() {
    const intervalSecs = this.displaySettings?.getSetting('screenshotInterval') || 0;
    if (!intervalSecs || intervalSecs <= 0) return;

    // Pre-load html2canvas module so first capture is instant
    if (!this._html2canvasMod) {
      import('html2canvas').then(m => { this._html2canvasMod = m.default; });
    }

    const intervalMs = intervalSecs * 1000;
    log.info(`Starting periodic screenshots every ${intervalSecs}s`);
    this._screenshotInterval = setInterval(() => {
      this.captureAndSubmitScreenshot();
    }, intervalMs);
  }

  /**
   * Update status message (Platform-specific UI)
   */
  private updateStatus(message: string, type: 'info' | 'error' = 'info') {
    const statusEl = document.getElementById('status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `status status-${type}`;
    }
    if (type === 'error') {
      log.error('Status:', message);
    } else {
      log.info('Status:', message);
    }
  }

  private showOfflineIndicator() {
    this.timelineOverlay?.setOffline(true);
  }

  private removeOfflineIndicator() {
    this.timelineOverlay?.setOffline(false);
  }

  /**
   * Check if the sync lead is alive (for follower delegation).
   * Returns true if any peer with role 'lead' has been seen in the last 15s.
   */
  private _syncLeadAlive(): boolean {
    if (!this.syncManager) return false;
    for (const [, peer] of this.syncManager.followers) {
      if (peer.role === 'lead' && Date.now() - peer.lastSeen < 15000) {
        return true;
      }
    }
    return false;
  }

  /**
   * Cleanup
   */
  cleanup() {
    this.core.cleanup();
    this.renderer.cleanup();

    if (this._screenshotInterval) {
      clearInterval(this._screenshotInterval);
      this._screenshotInterval = null;
    }

    if (this._wakeLock) {
      this._wakeLock.release();
      this._wakeLock = null;
    }

    if (this.downloadOverlay) {
      this.downloadOverlay.destroy();
    }

    if (this.timelineOverlay) {
      this.timelineOverlay.destroy();
    }

    // Disconnect iframe observer
    if (this._iframeObserver) {
      this._iframeObserver.disconnect();
      this._iframeObserver = null;
    }

    // Remove SW message listeners
    if (navigator.serviceWorker) {
      if (this._swIcHandler) {
        navigator.serviceWorker.removeEventListener('message', this._swIcHandler);
        this._swIcHandler = null;
      }
    }

    // Clean up DownloadManager
    downloadManager?.clear();

    if (this._probeTimer) {
      clearTimeout(this._probeTimer);
      this._probeTimer = null;
    }

    if (this._mediaStatusTimer) {
      clearTimeout(this._mediaStatusTimer);
      this._mediaStatusTimer = null;
    }
  }
}

function startPlayer() {
  const player = new PwaPlayer();
  player.init().catch(error => {
    log.error('Failed to initialize:', error);
    // First boot with bad config — redirect to setup so user can fix it
    log.warn('Redirecting to setup screen...');
    window.location.href = './setup.html';
  });
  window.addEventListener('beforeunload', () => {
    player.cleanup();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startPlayer);
} else {
  startPlayer();
}
