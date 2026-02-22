/**
 * RendererLite - Lightweight XLF Layout Renderer
 *
 * A standalone, reusable JavaScript library for rendering Xibo Layout Format (XLF) files.
 * Provides layout rendering without dependencies on XLR, suitable for any platform.
 *
 * Features:
 * - Parse XLF XML layout files
 * - Create region DOM elements with positioning
 * - Render widgets (text, image, video, audio, PDF, webpage)
 * - Handle widget duration timers
 * - Apply CSS transitions (fade, fly)
 * - Event emitter for lifecycle hooks
 * - Manage layout lifecycle
 *
 * Usage pattern (similar to xmr-wrapper.js):
 *
 * ```javascript
 * import { RendererLite } from './renderer-lite.js';
 *
 * const container = document.getElementById('player-container');
 * const renderer = new RendererLite({ cmsUrl: '...', hardwareKey: '...' }, container);
 *
 * // Listen to events
 * renderer.on('layoutStart', (layoutId) => console.log('Layout started:', layoutId));
 * renderer.on('layoutEnd', (layoutId) => console.log('Layout ended:', layoutId));
 * renderer.on('widgetStart', (widget) => console.log('Widget started:', widget));
 * renderer.on('widgetEnd', (widget) => console.log('Widget ended:', widget));
 * renderer.on('error', (error) => console.error('Error:', error));
 *
 * // Render a layout
 * await renderer.renderLayout(layoutXml, duration);
 *
 * // Stop current layout
 * renderer.stopCurrentLayout();
 *
 * // Cleanup
 * renderer.cleanup();
 * ```
 */

import { createNanoEvents } from 'nanoevents';
import { createLogger, isDebug } from '@xiboplayer/utils';
import { LayoutPool } from './layout-pool.js';

/**
 * Transition utilities for widget animations
 */
const Transitions = {
  /**
   * Apply fade in transition
   */
  fadeIn(element, duration) {
    const keyframes = [
      { opacity: 0 },
      { opacity: 1 }
    ];
    const timing = {
      duration: duration,
      easing: 'linear',
      fill: 'forwards'
    };
    return element.animate(keyframes, timing);
  },

  /**
   * Apply fade out transition
   */
  fadeOut(element, duration) {
    const keyframes = [
      { opacity: 1 },
      { opacity: 0 }
    ];
    const timing = {
      duration: duration,
      easing: 'linear',
      fill: 'forwards'
    };
    return element.animate(keyframes, timing);
  },

  /**
   * Get fly keyframes based on compass direction
   */
  getFlyKeyframes(direction, width, height, isIn) {
    const dirMap = {
      'N': { x: 0, y: isIn ? -height : height },
      'NE': { x: isIn ? width : -width, y: isIn ? -height : height },
      'E': { x: isIn ? width : -width, y: 0 },
      'SE': { x: isIn ? width : -width, y: isIn ? height : -height },
      'S': { x: 0, y: isIn ? height : -height },
      'SW': { x: isIn ? -width : width, y: isIn ? height : -height },
      'W': { x: isIn ? -width : width, y: 0 },
      'NW': { x: isIn ? -width : width, y: isIn ? -height : height }
    };

    const offset = dirMap[direction] || dirMap['N'];

    if (isIn) {
      return {
        from: {
          transform: `translate(${offset.x}px, ${offset.y}px)`,
          opacity: 0
        },
        to: {
          transform: 'translate(0, 0)',
          opacity: 1
        }
      };
    } else {
      return {
        from: {
          transform: 'translate(0, 0)',
          opacity: 1
        },
        to: {
          transform: `translate(${offset.x}px, ${offset.y}px)`,
          opacity: 0
        }
      };
    }
  },

  /**
   * Apply fly in transition
   */
  flyIn(element, duration, direction, regionWidth, regionHeight) {
    const keyframes = this.getFlyKeyframes(direction, regionWidth, regionHeight, true);
    const timing = {
      duration: duration,
      easing: 'ease-out',
      fill: 'forwards'
    };
    return element.animate([keyframes.from, keyframes.to], timing);
  },

  /**
   * Apply fly out transition
   */
  flyOut(element, duration, direction, regionWidth, regionHeight) {
    const keyframes = this.getFlyKeyframes(direction, regionWidth, regionHeight, false);
    const timing = {
      duration: duration,
      easing: 'ease-in',
      fill: 'forwards'
    };
    return element.animate([keyframes.from, keyframes.to], timing);
  },

  /**
   * Apply transition based on type
   */
  apply(element, transitionConfig, isIn, regionWidth, regionHeight) {
    if (!transitionConfig || !transitionConfig.type) {
      return null;
    }

    const type = transitionConfig.type.toLowerCase();
    const duration = transitionConfig.duration || 1000;
    const direction = transitionConfig.direction || 'N';

    switch (type) {
      case 'fade':
      case 'fadein':
        return isIn ? this.fadeIn(element, duration) : null;
      case 'fadeout':
        return isIn ? null : this.fadeOut(element, duration);
      case 'fly':
      case 'flyin':
        return isIn ? this.flyIn(element, duration, direction, regionWidth, regionHeight) : null;
      case 'flyout':
        return isIn ? null : this.flyOut(element, duration, direction, regionWidth, regionHeight);
      default:
        return null;
    }
  }
};

/**
 * RendererLite - Lightweight XLF renderer
 */
export class RendererLite {
  /**
   * @param {Object} config - Player configuration
   * @param {string} config.cmsUrl - CMS base URL
   * @param {string} config.hardwareKey - Display hardware key
   * @param {HTMLElement} container - DOM container for rendering
   * @param {Object} options - Renderer options
   * @param {Function} options.getMediaUrl - Function to get media file URL (mediaId) => url
   * @param {Function} options.getWidgetHtml - Function to get widget HTML (layoutId, regionId, widgetId) => html
   */
  constructor(config, container, options = {}) {
    this.config = config;
    this.container = container;
    this.options = options;

    // Logger with configurable level
    this.log = createLogger('RendererLite', options.logLevel);

    // Event emitter for lifecycle hooks
    this.emitter = createNanoEvents();

    // State
    this.currentLayout = null;
    this.currentLayoutId = null;
    this.regions = new Map(); // regionId => { element, widgets, currentIndex, timer }
    this.layoutTimer = null;
    this.layoutEndEmitted = false; // Prevents double layoutEnd on stop after timer
    this._paused = false;
    this._layoutTimerStartedAt = null;  // Date.now() when layout timer started
    this._layoutTimerDurationMs = null; // Total layout duration in ms
    this._layoutTimerRemaining = null;  // ms remaining when paused
    this.widgetTimers = new Map(); // widgetId => timer
    this.mediaUrlCache = new Map(); // fileId => blob URL (for parallel pre-fetching)
    this.layoutBlobUrls = new Map(); // layoutId => Set<blobUrl> (for lifecycle tracking)
    this.audioOverlays = new Map(); // widgetId => [HTMLAudioElement] (audio overlays for widgets)

    // Scale state (for fitting layout to screen)
    this.scaleFactor = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    // Overlay state
    this.overlayContainer = null;
    this.activeOverlays = new Map(); // layoutId => { container, layout, timer, regions }

    // Interactive action state
    this._keydownHandler = null; // Document keydown listener (single, shared)
    this._keyboardActions = []; // Active keyboard actions for current layout

    // Sub-playlist cycle state (round-robin per parentWidgetId group)
    this._subPlaylistCycleIndex = new Map();

    // Layout preload pool (2-layout pool for instant transitions)
    this.layoutPool = new LayoutPool(2);
    this.preloadTimer = null;
    this._preloadRetryTimer = null;

    // Setup container styles
    this.setupContainer();

    this.log.info('Initialized');
  }

  /**
   * Setup container element
   */
  setupContainer() {
    this.container.style.position = 'relative';
    this.container.style.width = '100%';
    this.container.style.height = '100vh'; // Use viewport height, not percentage
    this.container.style.overflow = 'hidden';

    // Watch for container resize to rescale layout
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.rescaleRegions();
      });
      this.resizeObserver.observe(this.container);
    }

    // Create overlay container for overlay layouts (higher z-index than main content)
    this.overlayContainer = document.createElement('div');
    this.overlayContainer.id = 'overlay-container';
    this.overlayContainer.style.position = 'absolute';
    this.overlayContainer.style.top = '0';
    this.overlayContainer.style.left = '0';
    this.overlayContainer.style.width = '100%';
    this.overlayContainer.style.height = '100%';
    this.overlayContainer.style.zIndex = '1000'; // Above main layout (z-index 0-999)
    this.overlayContainer.style.pointerEvents = 'none'; // Don't block clicks on main layout
    this.container.appendChild(this.overlayContainer);
  }

  /**
   * Calculate scale factor to fit layout into container
   * Centers the layout and scales regions proportionally.
   * @param {Object} layout - Parsed layout with width/height
   */
  calculateScale(layout) {
    const screenWidth = this.container.clientWidth;
    const screenHeight = this.container.clientHeight;

    if (!screenWidth || !screenHeight) return;

    const scaleX = screenWidth / layout.width;
    const scaleY = screenHeight / layout.height;
    this.scaleFactor = Math.min(scaleX, scaleY);
    this.offsetX = (screenWidth - layout.width * this.scaleFactor) / 2;
    this.offsetY = (screenHeight - layout.height * this.scaleFactor) / 2;

    this.log.info(`Scale: ${this.scaleFactor.toFixed(3)} (${layout.width}x${layout.height} → ${screenWidth}x${screenHeight}, offset ${Math.round(this.offsetX)},${Math.round(this.offsetY)})`);
  }

  /**
   * Apply scale to a region element
   * @param {HTMLElement} regionEl - Region DOM element
   * @param {Object} regionConfig - Region config with left, top, width, height
   */
  applyRegionScale(regionEl, regionConfig) {
    const sf = this.scaleFactor;
    regionEl.style.left = `${regionConfig.left * sf + this.offsetX}px`;
    regionEl.style.top = `${regionConfig.top * sf + this.offsetY}px`;
    regionEl.style.width = `${regionConfig.width * sf}px`;
    regionEl.style.height = `${regionConfig.height * sf}px`;
  }

  /**
   * Reapply scale to all current regions (e.g., on window resize)
   */
  rescaleRegions() {
    if (!this.currentLayout) return;

    this.calculateScale(this.currentLayout);

    for (const [regionId, region] of this.regions) {
      this.applyRegionScale(region.element, region.config);
      // Update region dimensions for transition calculations
      region.width = region.config.width * this.scaleFactor;
      region.height = region.config.height * this.scaleFactor;
    }

    // Rescale active overlays too
    for (const [overlayId, overlay] of this.activeOverlays) {
      this.calculateScale(overlay.layout);
      for (const [regionId, region] of overlay.regions) {
        this.applyRegionScale(region.element, region.config);
        region.width = region.config.width * this.scaleFactor;
        region.height = region.config.height * this.scaleFactor;
      }
    }
  }

  /**
   * Event emitter interface (like XMR wrapper)
   */
  on(event, callback) {
    return this.emitter.on(event, callback);
  }

  emit(event, ...args) {
    this.emitter.emit(event, ...args);
  }

  /**
   * Parse action elements from an XLF parent element (region or media)
   * @param {Element} parentEl - Parent XML element containing <action> children
   * @returns {Array} Parsed actions
   */
  parseActions(parentEl) {
    const actions = [];
    for (const actionEl of parentEl.children) {
      if (actionEl.tagName !== 'action') continue;
      actions.push({
        id: actionEl.getAttribute('id') || '',
        actionType: actionEl.getAttribute('actionType') || '',
        triggerType: actionEl.getAttribute('triggerType') || '',
        triggerCode: actionEl.getAttribute('triggerCode') || '',
        source: actionEl.getAttribute('source') || '',
        sourceId: actionEl.getAttribute('sourceId') || '',
        target: actionEl.getAttribute('target') || '',
        targetId: actionEl.getAttribute('targetId') || '',
        widgetId: actionEl.getAttribute('widgetId') || '',
        layoutCode: actionEl.getAttribute('layoutCode') || '',
        commandCode: actionEl.getAttribute('commandCode') || ''
      });
    }
    return actions;
  }

  /**
   * Parse XLF XML to layout object
   * @param {string} xlfXml - XLF XML content
   * @returns {Object} Parsed layout
   */
  parseXlf(xlfXml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xlfXml, 'text/xml');

    const layoutEl = doc.querySelector('layout');
    if (!layoutEl) {
      throw new Error('Invalid XLF: no <layout> element');
    }

    const layoutDurationAttr = layoutEl.getAttribute('duration');
    const layout = {
      schemaVersion: parseInt(layoutEl.getAttribute('schemaVersion') || '1'),
      width: parseInt(layoutEl.getAttribute('width') || '1920'),
      height: parseInt(layoutEl.getAttribute('height') || '1080'),
      duration: layoutDurationAttr ? parseInt(layoutDurationAttr) : 0, // 0 = calculate from widgets
      bgcolor: layoutEl.getAttribute('backgroundColor') || layoutEl.getAttribute('bgcolor') || '#000000',
      background: layoutEl.getAttribute('background') || null, // Background image fileId
      enableStat: layoutEl.getAttribute('enableStat') !== '0', // absent or "1" = enabled
      actions: this.parseActions(layoutEl),
      regions: []
    };

    if (layout.schemaVersion > 1) {
      this.log.debug(`XLF schema version: ${layout.schemaVersion}`);
    }

    if (layoutDurationAttr) {
      this.log.info(`Layout duration from XLF: ${layout.duration}s`);
    } else {
      this.log.info(`Layout duration NOT in XLF, will calculate from widgets`);
    }

    // Parse regions and drawers (drawers are invisible regions for interactive actions)
    const regionAndDrawerEls = layoutEl.querySelectorAll(':scope > region, :scope > drawer');
    for (const regionEl of regionAndDrawerEls) {
      const isDrawer = regionEl.tagName === 'drawer';
      const region = {
        id: regionEl.getAttribute('id'),
        width: parseInt(regionEl.getAttribute('width') || '0'),
        height: parseInt(regionEl.getAttribute('height') || '0'),
        top: parseInt(regionEl.getAttribute('top') || '0'),
        left: parseInt(regionEl.getAttribute('left') || '0'),
        zindex: parseInt(regionEl.getAttribute('zindex') || (isDrawer ? '2000' : '0')),
        enableStat: regionEl.getAttribute('enableStat') !== '0',
        actions: this.parseActions(regionEl),
        exitTransition: null,
        transitionType: null, // Region-level default widget transition type
        transitionDuration: null,
        transitionDirection: null,
        loop: true, // Default: cycle widgets. Spec: loop=0 means single media stays visible
        isDrawer,
        widgets: []
      };

      // Parse region-level options (exit transitions, loop)
      // Use direct children only to avoid matching <options> inside <media>
      const regionOptionsEl = Array.from(regionEl.children).find(el => el.tagName === 'options');
      if (regionOptionsEl) {
        const exitTransType = regionOptionsEl.querySelector('exitTransType');
        if (exitTransType && exitTransType.textContent) {
          const exitTransDuration = regionOptionsEl.querySelector('exitTransDuration');
          const exitTransDirection = regionOptionsEl.querySelector('exitTransDirection');
          region.exitTransition = {
            type: exitTransType.textContent,
            duration: parseInt((exitTransDuration && exitTransDuration.textContent) || '1000'),
            direction: (exitTransDirection && exitTransDirection.textContent) || 'N'
          };
        }

        // Region loop option: 0 = single media stays on screen, 1 = cycles (default)
        const loopEl = regionOptionsEl.querySelector('loop');
        if (loopEl) {
          region.loop = loopEl.textContent !== '0';
        }

        // Region-level default transition for widgets (applied if widget has no own transition)
        const transType = regionOptionsEl.querySelector('transitionType');
        if (transType && transType.textContent) {
          region.transitionType = transType.textContent;
          const transDuration = regionOptionsEl.querySelector('transitionDuration');
          const transDirection = regionOptionsEl.querySelector('transitionDirection');
          region.transitionDuration = parseInt((transDuration && transDuration.textContent) || '1000');
          region.transitionDirection = (transDirection && transDirection.textContent) || 'N';
        }
      }

      // Parse media/widgets (use direct children to avoid nested matches)
      for (const child of regionEl.children) {
        if (child.tagName !== 'media') continue;
        const widget = this.parseWidget(child);
        region.widgets.push(widget);
      }

      layout.regions.push(region);

      if (isDrawer) {
        this.log.info(`Parsed drawer: id=${region.id} with ${region.widgets.length} widgets`);
      }
    }

    // Calculate layout duration if not specified (duration=0)
    // Drawers don't contribute to layout duration (they're action-triggered)
    if (layout.duration === 0) {
      let maxDuration = 0;

      for (const region of layout.regions) {
        if (region.isDrawer) continue;
        let regionDuration = 0;

        // Calculate region duration based on widgets
        for (const widget of region.widgets) {
          if (widget.duration > 0) {
            regionDuration += widget.duration;
          } else {
            // Widget with duration=0 means "use media length"
            // Default to 60s here; actual duration is detected dynamically
            // from video.loadedmetadata event and updateLayoutDuration() recalculates
            regionDuration = 60;
            break;
          }
        }

        maxDuration = Math.max(maxDuration, regionDuration);
      }

      layout.duration = maxDuration > 0 ? maxDuration : 60;
      this.log.info(`Calculated layout duration: ${layout.duration}s (not specified in XLF)`);
    }

    return layout;
  }

  /**
   * Parse widget from media element
   * @param {Element} mediaEl - Media XML element
   * @returns {Object} Widget config
   */
  parseWidget(mediaEl) {
    const type = mediaEl.getAttribute('type');
    const duration = parseInt(mediaEl.getAttribute('duration') || '10');
    const useDuration = parseInt(mediaEl.getAttribute('useDuration') || '1');
    const id = mediaEl.getAttribute('id');
    const fileId = mediaEl.getAttribute('fileId'); // Media library file ID

    // Parse options
    const options = {};
    const optionsEl = mediaEl.querySelector('options');
    if (optionsEl) {
      for (const child of optionsEl.children) {
        options[child.tagName] = child.textContent;
      }
    }

    // Parse raw content
    const rawEl = mediaEl.querySelector('raw');
    const raw = rawEl ? rawEl.textContent : '';

    // Parse transitions
    const transitions = {
      in: null,
      out: null
    };

    if (options.transIn) {
      transitions.in = {
        type: options.transIn,
        duration: parseInt(options.transInDuration || '1000'),
        direction: options.transInDirection || 'N'
      };
    }

    if (options.transOut) {
      transitions.out = {
        type: options.transOut,
        duration: parseInt(options.transOutDuration || '1000'),
        direction: options.transOutDirection || 'N'
      };
    }

    // Parse widget-level actions
    const actions = this.parseActions(mediaEl);

    // Parse audio overlay nodes (<audio> child elements on the widget)
    // Spec format: <audio><uri volume="" loop="" mediaId="">filename.mp3</uri></audio>
    // Also supports flat format: <audio mediaId="" uri="" volume="" loop="">
    const audioNodes = [];
    for (const child of mediaEl.children) {
      if (child.tagName.toLowerCase() === 'audio') {
        const uriEl = child.querySelector('uri');
        if (uriEl) {
          // Spec format: attributes on <uri>, filename as text content
          audioNodes.push({
            mediaId: uriEl.getAttribute('mediaId') || null,
            uri: uriEl.textContent || '',
            volume: parseInt(uriEl.getAttribute('volume') || '100'),
            loop: uriEl.getAttribute('loop') === '1'
          });
        } else {
          // Flat format fallback: attributes directly on <audio>
          audioNodes.push({
            mediaId: child.getAttribute('mediaId') || null,
            uri: child.getAttribute('uri') || '',
            volume: parseInt(child.getAttribute('volume') || '100'),
            loop: child.getAttribute('loop') === '1'
          });
        }
      }
    }

    // Parse commands on media (shell/native commands triggered on widget start)
    // Spec: <commands><command commandCode="code" commandString="args"/></commands>
    const commands = [];
    const commandsEl = Array.from(mediaEl.children).find(el => el.tagName === 'commands');
    if (commandsEl) {
      for (const cmdEl of commandsEl.children) {
        if (cmdEl.tagName === 'command') {
          commands.push({
            commandCode: cmdEl.getAttribute('commandCode') || '',
            commandString: cmdEl.getAttribute('commandString') || ''
          });
        }
      }
    }

    // Sub-playlist attributes (widgets grouped by parentWidgetId)
    const parentWidgetId = mediaEl.getAttribute('parentWidgetId') || null;
    const displayOrder = parseInt(mediaEl.getAttribute('displayOrder') || '0');
    const cyclePlayback = mediaEl.getAttribute('cyclePlayback') === '1';
    const playCount = parseInt(mediaEl.getAttribute('playCount') || '0');
    const isRandom = mediaEl.getAttribute('isRandom') === '1';

    // Media expiry dates (per-widget time-gating within a layout)
    const fromDt = mediaEl.getAttribute('fromDt') || mediaEl.getAttribute('fromdt') || null;
    const toDt = mediaEl.getAttribute('toDt') || mediaEl.getAttribute('todt') || null;

    // Render mode: 'native' (player renders directly) or 'html' (use GetResource)
    const render = mediaEl.getAttribute('render') || null;

    return {
      type,
      duration,
      useDuration, // Whether to use specified duration (1) or media length (0)
      id,
      fileId, // Media library file ID for cache lookup
      render, // 'native' or 'html' — null means use type-based dispatch
      fromDt, // Widget valid-from date (Y-m-d H:i:s)
      toDt, // Widget valid-to date (Y-m-d H:i:s)
      enableStat: mediaEl.getAttribute('enableStat') !== '0', // absent or "1" = enabled
      webhookUrl: options.webhookUrl || null,
      options,
      raw,
      transitions,
      actions,
      audioNodes, // Audio overlays attached to this widget
      commands, // Shell commands triggered on widget start
      parentWidgetId,
      displayOrder,
      cyclePlayback,
      playCount,
      isRandom
    };
  }

  /**
   * Track blob URL for lifecycle management
   * @param {string} blobUrl - Blob URL to track
   */
  trackBlobUrl(blobUrl) {
    if (!this.currentLayoutId) return;

    if (!this.layoutBlobUrls.has(this.currentLayoutId)) {
      this.layoutBlobUrls.set(this.currentLayoutId, new Set());
    }

    this.layoutBlobUrls.get(this.currentLayoutId).add(blobUrl);
  }

  /**
   * Revoke all blob URLs for a specific layout
   * @param {number} layoutId - Layout ID
   */
  revokeBlobUrlsForLayout(layoutId) {
    const blobUrls = this.layoutBlobUrls.get(layoutId);
    if (blobUrls) {
      blobUrls.forEach(url => {
        URL.revokeObjectURL(url);
      });
      this.layoutBlobUrls.delete(layoutId);
      this.log.info(`Revoked ${blobUrls.size} blob URLs for layout ${layoutId}`);
    }
  }

  /**
   * Update layout duration based on actual widget durations
   * Called when video metadata loads and we discover actual duration
   */
  updateLayoutDuration() {
    if (!this.currentLayout) return;

    // Calculate maximum region duration
    let maxRegionDuration = 0;

    for (const region of this.currentLayout.regions) {
      if (region.isDrawer) continue;
      let regionDuration = 0;

      for (const widget of region.widgets) {
        if (widget.duration > 0) {
          regionDuration += widget.duration;
        }
      }

      maxRegionDuration = Math.max(maxRegionDuration, regionDuration);
    }

    // If we calculated a different duration, update layout
    if (maxRegionDuration > 0 && maxRegionDuration !== this.currentLayout.duration) {
      const oldDuration = this.currentLayout.duration;
      this.currentLayout.duration = maxRegionDuration;

      this.log.info(`Layout duration updated: ${oldDuration}s → ${maxRegionDuration}s (based on video metadata)`);
      this.emit('layoutDurationUpdated', this.currentLayoutId, maxRegionDuration);

      // Reset layout timer with new duration — but only if a timer is already running.
      // If startLayoutTimerWhenReady() hasn't fired yet (still waiting for widgets),
      // it will pick up the updated duration when it starts the timer.
      if (this.layoutTimer) {
        clearTimeout(this.layoutTimer);

        const layoutDurationMs = this.currentLayout.duration * 1000;
        this.layoutTimer = setTimeout(() => {
          this.log.info(`Layout ${this.currentLayoutId} duration expired (${this.currentLayout.duration}s)`);
          if (this.currentLayoutId) {
            this.layoutEndEmitted = true;
            this.emit('layoutEnd', this.currentLayoutId);
          }
        }, layoutDurationMs);

        this.log.info(`Layout timer reset to ${this.currentLayout.duration}s`);
      } else {
        this.log.info(`Layout duration updated to ${maxRegionDuration}s (timer not yet started, will use new value)`);
      }

      // Reschedule preload timer — the initial preload was based on the old
      // duration estimate (e.g. 45s for 60s default).  With the real duration
      // (e.g. 375s), the preload should fire much later so that schedule
      // cooldowns (maxPlaysPerHour) have time to expire.
      this._scheduleNextLayoutPreload(this.currentLayout);
    }
  }

  // ── Interactive Actions ──────────────────────────────────────────────

  /**
   * Attach interactive action event listeners for a layout.
   * Binds touch/click on region/widget elements and a single document keydown handler.
   */
  attachActionListeners(layout) {
    const allKeyboardActions = [];
    let touchActionCount = 0;

    // Layout-level actions (attached to the main container)
    for (const action of (layout.actions || [])) {
      if (action.triggerType === 'touch') {
        this.attachTouchAction(this.container, action, null, null);
        touchActionCount++;
      } else if (action.triggerType?.startsWith('keyboard:')) {
        allKeyboardActions.push(action);
      }
    }

    for (const regionConfig of layout.regions) {
      const region = this.regions.get(regionConfig.id);
      if (!region) continue;

      // Region-level actions
      for (const action of (regionConfig.actions || [])) {
        if (action.triggerType === 'touch') {
          this.attachTouchAction(region.element, action, regionConfig.id, null);
          touchActionCount++;
        } else if (action.triggerType.startsWith('keyboard:')) {
          allKeyboardActions.push(action);
        }
      }

      // Widget-level actions
      for (const widget of regionConfig.widgets) {
        if (!widget.actions || widget.actions.length === 0) continue;
        const widgetEl = region.widgetElements.get(widget.id);
        if (!widgetEl) continue;

        for (const action of widget.actions) {
          if (action.triggerType === 'touch') {
            this.attachTouchAction(widgetEl, action, regionConfig.id, widget.id);
            touchActionCount++;
          } else if (action.triggerType.startsWith('keyboard:')) {
            allKeyboardActions.push(action);
          }
        }
      }
    }

    this.setupKeyboardListener(allKeyboardActions);

    if (touchActionCount > 0 || allKeyboardActions.length > 0) {
      this.log.info(`Actions attached: ${touchActionCount} touch, ${allKeyboardActions.length} keyboard`);
    }
  }

  /**
   * Attach a click listener to an element for a touch-triggered action.
   */
  attachTouchAction(element, action, regionId, widgetId) {
    element.style.cursor = 'pointer';

    const handler = (event) => {
      event.stopPropagation();
      const source = widgetId ? `widget ${widgetId}` : `region ${regionId}`;
      this.log.info(`Touch action fired on ${source}: ${action.actionType}`);

      this.emit('action-trigger', {
        actionType: action.actionType,
        triggerType: 'touch',
        triggerCode: action.triggerCode,
        layoutCode: action.layoutCode,
        targetId: action.targetId,
        commandCode: action.commandCode,
        source: { regionId, widgetId }
      });
    };

    element.addEventListener('click', handler);
    if (!element._actionHandlers) element._actionHandlers = [];
    element._actionHandlers.push(handler);
  }

  /**
   * Setup document-level keyboard listener for keyboard-triggered actions.
   */
  setupKeyboardListener(keyboardActions) {
    this.removeKeyboardListener();
    this._keyboardActions = keyboardActions;
    if (keyboardActions.length === 0) return;

    this._keydownHandler = (event) => {
      const pressedKey = event.key;
      for (const action of this._keyboardActions) {
        const keycode = action.triggerType.substring('keyboard:'.length);
        if (pressedKey === keycode) {
          this.log.info(`Keyboard action (key: ${pressedKey}): ${action.actionType}`);
          this.emit('action-trigger', {
            actionType: action.actionType,
            triggerType: action.triggerType,
            triggerCode: action.triggerCode,
            layoutCode: action.layoutCode,
            targetId: action.targetId,
            commandCode: action.commandCode,
            source: { key: pressedKey }
          });
          break;
        }
      }
    };

    document.addEventListener('keydown', this._keydownHandler);
  }

  /** Remove the document-level keyboard listener */
  removeKeyboardListener() {
    if (this._keydownHandler) {
      document.removeEventListener('keydown', this._keydownHandler);
      this._keydownHandler = null;
    }
    this._keyboardActions = [];
  }

  /** Remove all action listeners (touch + keyboard) */
  removeActionListeners() {
    for (const [, region] of this.regions) {
      this._cleanElementActionHandlers(region.element);
      for (const [, widgetEl] of region.widgetElements) {
        this._cleanElementActionHandlers(widgetEl);
      }
    }
    this.removeKeyboardListener();
  }

  _cleanElementActionHandlers(element) {
    if (element._actionHandlers) {
      for (const handler of element._actionHandlers) {
        element.removeEventListener('click', handler);
      }
      delete element._actionHandlers;
      element.style.cursor = '';
    }
  }

  /**
   * Navigate to a specific widget within a region (for navWidget actions)
   */
  navigateToWidget(targetWidgetId) {
    for (const [regionId, region] of this.regions) {
      const widgetIndex = region.widgets.findIndex(w => w.id === targetWidgetId);
      if (widgetIndex === -1) continue;

      this.log.info(`Navigating to widget ${targetWidgetId} in region ${regionId} (index ${widgetIndex})`);

      // Show drawer region if hidden (drawers start display:none)
      if (region.isDrawer && region.element.style.display === 'none') {
        region.element.style.display = '';
        this.log.info(`Drawer region ${regionId} revealed`);
      }

      if (region.timer) {
        clearTimeout(region.timer);
        region.timer = null;
      }

      this.stopWidget(regionId, region.currentIndex);
      region.currentIndex = widgetIndex;
      this.renderWidget(regionId, widgetIndex);

      if (region.widgets.length > 1) {
        const widget = region.widgets[widgetIndex];
        const duration = widget.duration * 1000;
        region.timer = setTimeout(() => {
          this.stopWidget(regionId, widgetIndex);
          const nextIndex = (widgetIndex + 1) % region.widgets.length;
          region.currentIndex = nextIndex;
          // For drawers, hide again after last widget; for normal regions, continue cycling
          if (region.isDrawer && nextIndex === 0) {
            region.element.style.display = 'none';
            this.log.info(`Drawer region ${regionId} hidden (cycle complete)`);
          } else {
            this.startRegion(regionId);
          }
        }, duration);
      } else if (region.isDrawer) {
        // Single-widget drawer: hide after widget duration
        const widget = region.widgets[widgetIndex];
        const duration = widget.duration * 1000;
        region.timer = setTimeout(() => {
          this.stopWidget(regionId, widgetIndex);
          region.element.style.display = 'none';
          this.log.info(`Drawer region ${regionId} hidden (single widget done)`);
        }, duration);
      }
      return;
    }
    this.log.warn(`Target widget ${targetWidgetId} not found in any region`);
  }

  /**
   * Navigate to the next widget in a region (wraps around)
   * @param {string} [regionId] - Target region. If omitted, uses the first region.
   */
  nextWidget(regionId) {
    const region = regionId ? this.regions.get(regionId) : this.regions.values().next().value;
    if (!region || region.widgets.length <= 1) return;

    const nextIndex = (region.currentIndex + 1) % region.widgets.length;
    const targetWidget = region.widgets[nextIndex];
    this.log.info(`nextWidget → index ${nextIndex} (widget ${targetWidget.id})`);
    this.navigateToWidget(targetWidget.id);
  }

  /**
   * Navigate to the previous widget in a region (wraps around)
   * @param {string} [regionId] - Target region. If omitted, uses the first region.
   */
  previousWidget(regionId) {
    const region = regionId ? this.regions.get(regionId) : this.regions.values().next().value;
    if (!region || region.widgets.length <= 1) return;

    const prevIndex = (region.currentIndex - 1 + region.widgets.length) % region.widgets.length;
    const targetWidget = region.widgets[prevIndex];
    this.log.info(`previousWidget → index ${prevIndex} (widget ${targetWidget.id})`);
    this.navigateToWidget(targetWidget.id);
  }

  // ── Layout Rendering ──────────────────────────────────────────────

  /**
   * Render a layout
   * @param {string} xlfXml - XLF XML content
   * @param {number} layoutId - Layout ID
   * @returns {Promise<void>}
   */
  async renderLayout(xlfXml, layoutId) {
    try {
      this.log.info(`Rendering layout ${layoutId}`);

      // Check if we're replaying the same layout
      const isSameLayout = this.currentLayoutId === layoutId;

      if (isSameLayout) {
        // OPTIMIZATION: Reuse existing elements for same layout (Arexibo pattern)
        this.log.info(`Replaying layout ${layoutId} - reusing elements (no recreation!)`);

        // Stop all region timers
        for (const [regionId, region] of this.regions) {
          if (region.timer) {
            clearTimeout(region.timer);
            region.timer = null;
          }
          // Reset to first widget
          region.currentIndex = 0;
        }

        // Clear layout timer
        if (this.layoutTimer) {
          clearTimeout(this.layoutTimer);
          this.layoutTimer = null;
        }
        this.layoutEndEmitted = false;

        // DON'T call stopCurrentLayout() - keep elements alive!
        // DON'T clear mediaUrlCache - keep blob URLs alive!
        // DON'T recreate regions/elements - already exist!

        // Emit layout start event
        this.emit('layoutStart', layoutId, this.currentLayout);

        // Restart all regions from widget 0 (except drawers)
        for (const [regionId, region] of this.regions) {
          if (region.isDrawer) continue;
          this.startRegion(regionId);
        }

        // Wait for all initial widgets to be ready then start layout timer
        this.startLayoutTimerWhenReady(layoutId, this.currentLayout);

        this.log.info(`Layout ${layoutId} restarted (reused elements)`);

        // Schedule next layout preload for same-layout replay
        this._scheduleNextLayoutPreload(this.currentLayout);

        return; // EARLY RETURN - skip recreation below
      }

      // Check if this layout was preloaded in the pool
      if (this.layoutPool.has(layoutId)) {
        this.log.info(`Layout ${layoutId} found in preload pool - instant swap!`);
        await this._swapToPreloadedLayout(layoutId);
        return; // EARLY RETURN - preloaded layout swapped in
      }

      // Different layout - full teardown and rebuild
      this.log.info(`Switching to new layout ${layoutId}`);
      this.stopCurrentLayout();

      // Parse XLF
      const layout = this.parseXlf(xlfXml);
      this.currentLayout = layout;
      this.currentLayoutId = layoutId;

      // Calculate scale factor to fit layout into screen
      this.calculateScale(layout);

      // Set container background
      this.container.style.backgroundColor = layout.bgcolor;
      this.container.style.backgroundImage = ''; // Reset previous

      // Apply background image if specified in XLF
      if (layout.background && this.options.getMediaUrl) {
        try {
          const bgUrl = await this.options.getMediaUrl(parseInt(layout.background));
          if (bgUrl) {
            this.container.style.backgroundImage = `url(${bgUrl})`;
            this.container.style.backgroundSize = 'cover';
            this.container.style.backgroundPosition = 'center';
            this.container.style.backgroundRepeat = 'no-repeat';
            this.log.info(`Background image set: ${layout.background}`);
          }
        } catch (err) {
          this.log.warn('Failed to load background image:', err);
        }
      }

      // PRE-FETCH: Get all media URLs in parallel (huge speedup!)
      if (this.options.getMediaUrl) {
        const mediaPromises = [];
        this.mediaUrlCache.clear(); // Clear previous layout's cache

        for (const region of layout.regions) {
          for (const widget of region.widgets) {
            if (widget.fileId) {
              const fileId = parseInt(widget.fileId || widget.id);
              if (!this.mediaUrlCache.has(fileId)) {
                mediaPromises.push(
                  this.options.getMediaUrl(fileId)
                    .then(url => {
                      this.mediaUrlCache.set(fileId, url);
                    })
                    .catch(err => {
                      this.log.warn(`Failed to fetch media ${fileId}:`, err);
                    })
                );
              }
            }
          }
        }

        if (mediaPromises.length > 0) {
          this.log.info(`Pre-fetching ${mediaPromises.length} media URLs in parallel...`);
          await Promise.all(mediaPromises);
          this.log.info(`All media URLs pre-fetched`);
        }
      }

      // Create regions
      for (const regionConfig of layout.regions) {
        await this.createRegion(regionConfig);
      }

      // PRE-CREATE: Build all widget elements upfront (Arexibo pattern)
      this.log.info('Pre-creating widget elements for instant transitions...');
      for (const [regionId, region] of this.regions) {
        for (let i = 0; i < region.widgets.length; i++) {
          const widget = region.widgets[i];
          widget.layoutId = this.currentLayoutId;
          widget.regionId = regionId;

          try {
            const element = await this.createWidgetElement(widget, region);
            element.style.position = 'absolute';
            element.style.top = '0';
            element.style.left = '0';
            element.style.width = '100%';
            element.style.height = '100%';
            element.style.visibility = 'hidden'; // Hidden by default
            element.style.opacity = '0';
            region.element.appendChild(element);
            region.widgetElements.set(widget.id, element);
          } catch (error) {
            this.log.error(`Failed to pre-create widget ${widget.id}:`, error);
          }
        }
      }
      this.log.info('All widget elements pre-created');

      // Attach interactive action listeners (touch/click and keyboard)
      this.attachActionListeners(layout);

      // Emit layout start event
      this.emit('layoutStart', layoutId, layout);

      // Start all regions (except drawers — they're action-triggered)
      for (const [regionId, region] of this.regions) {
        if (region.isDrawer) continue;
        this.startRegion(regionId);
      }

      // Wait for all initial widgets to be ready (videos playing, images loaded)
      // THEN start the layout timer — ensures videos play to their last frame
      this.startLayoutTimerWhenReady(layoutId, layout);

      // Schedule preloading of the next layout at 75% of current duration
      this._scheduleNextLayoutPreload(layout);

      this.log.info(`Layout ${layoutId} started`);

    } catch (error) {
      this.log.error('Error rendering layout:', error);
      this.emit('error', { type: 'layoutError', error, layoutId });
      throw error;
    }
  }

  /**
   * Create a region element
   * @param {Object} regionConfig - Region configuration
   */
  async createRegion(regionConfig) {
    const regionEl = document.createElement('div');
    regionEl.id = `region_${regionConfig.id}`;
    regionEl.className = 'renderer-lite-region';
    regionEl.style.position = 'absolute';
    regionEl.style.zIndex = regionConfig.zindex;
    regionEl.style.overflow = 'hidden';

    // Drawer regions start fully hidden — shown only by navWidget actions
    if (regionConfig.isDrawer) {
      regionEl.style.display = 'none';
    }

    // Apply scaled positioning
    this.applyRegionScale(regionEl, regionConfig);

    this.container.appendChild(regionEl);

    // Filter expired widgets (fromDt/toDt time-gating within XLF)
    let widgets = regionConfig.widgets.filter(w => this._isWidgetActive(w));

    // For regions with sub-playlist cycle playback, select which widgets play this cycle
    if (widgets.some(w => w.cyclePlayback)) {
      widgets = this._applyCyclePlayback(widgets);
    }

    // Store region state (dimensions use scaled values for transitions)
    const sf = this.scaleFactor;
    this.regions.set(regionConfig.id, {
      element: regionEl,
      config: regionConfig,
      widgets,
      currentIndex: 0,
      timer: null,
      width: regionConfig.width * sf,
      height: regionConfig.height * sf,
      complete: false, // Track if region has played all widgets once
      isDrawer: regionConfig.isDrawer || false,
      widgetElements: new Map() // widgetId -> DOM element (for element reuse)
    });
  }

  /**
   * Start playing a region's widgets
   * @param {string} regionId - Region ID
   */
  startRegion(regionId) {
    const region = this.regions.get(regionId);
    this._startRegionCycle(
      region, regionId,
      (rid, idx) => this.renderWidget(rid, idx),
      (rid, idx) => this.stopWidget(rid, idx),
      () => {
        this.log.info(`Region ${regionId} completed one full cycle`);
        this.checkLayoutComplete();
      }
    );
  }

  /**
   * Create a widget element (extracted for pre-creation)
   * @param {Object} widget - Widget config
   * @param {Object} region - Region state
   * @returns {Promise<HTMLElement>} Widget DOM element
   */
  async createWidgetElement(widget, region) {
    // render="html" forces GetResource iframe regardless of native type
    if (widget.render === 'html') {
      return await this.renderGenericWidget(widget, region);
    }

    switch (widget.type) {
      case 'image':
        return await this.renderImage(widget, region);
      case 'video':
        return await this.renderVideo(widget, region);
      case 'audio':
        return await this.renderAudio(widget, region);
      case 'text':
      case 'ticker':
        return await this.renderTextWidget(widget, region);
      case 'pdf':
        return await this.renderPdf(widget, region);
      case 'webpage':
        return await this.renderWebpage(widget, region);
      case 'localvideo':
        return await this.renderVideo(widget, region);
      case 'videoin':
        return await this.renderVideoIn(widget, region);
      case 'powerpoint':
      case 'flash':
        // Legacy Windows-only types — show placeholder instead of failing silently
        this.log.warn(`Widget type '${widget.type}' is not supported on web players (widget ${widget.id})`);
        return this._renderUnsupportedPlaceholder(widget, region);
      default:
        // Generic widget (clock, calendar, weather, etc.)
        return await this.renderGenericWidget(widget, region);
    }
  }

  /**
   * Helper: Find media element within widget (works for both direct and wrapped elements)
   * @param {HTMLElement} element - Widget element (might BE the media element or contain it)
   * @param {string} tagName - Tag name to find ('VIDEO', 'AUDIO', 'IMG', 'IFRAME')
   * @returns {HTMLElement|null}
   */
  findMediaElement(element, tagName) {
    // Check if element IS the tag, or contains it as a descendant
    return element.tagName === tagName ? element : element.querySelector(tagName.toLowerCase());
  }

  /**
   * Update media element for dynamic content (videos/audio need restart)
   * @param {HTMLElement} element - Widget element
   * @param {Object} widget - Widget config
   */
  updateMediaElement(element, widget) {
    // Restart video or audio on widget show (even if looping)
    const mediaEl = this.findMediaElement(element, 'VIDEO') || this.findMediaElement(element, 'AUDIO');
    if (mediaEl) {
      // Re-acquire webcam stream if it was stopped during _hideWidget()
      if (mediaEl.tagName === 'VIDEO' && mediaEl._mediaConstraints && !mediaEl._mediaStream) {
        navigator.mediaDevices.getUserMedia(mediaEl._mediaConstraints).then(stream => {
          mediaEl.srcObject = stream;
          mediaEl._mediaStream = stream;
          this.log.info(`Webcam stream re-acquired for widget ${widget.id}`);
        }).catch(e => {
          this.log.warn('Failed to re-acquire webcam stream:', e.message);
        });
        return; // srcObject auto-plays, no need for _restartMediaElement
      }

      this._restartMediaElement(mediaEl);
      this.log.info(`${mediaEl.tagName === 'VIDEO' ? 'Video' : 'Audio'} restarted: ${widget.fileId || widget.id}`);
    }
  }

  /**
   * Restart a media element from the beginning.
   * Waits for seek to complete before playing — avoids DOMException
   * "The play() request was interrupted" when calling play() mid-seek.
   */
  _restartMediaElement(el) {
    el.currentTime = 0;
    const playAfterSeek = () => {
      el.removeEventListener('seeked', playAfterSeek);
      el.play().catch(() => {});
    };
    el.addEventListener('seeked', playAfterSeek);
    // Fallback: if seeked doesn't fire (already at 0), try play directly
    if (el.currentTime === 0 && el.readyState >= 2) {
      el.removeEventListener('seeked', playAfterSeek);
      el.play().catch(() => {});
    }
  }

  /**
   * Wait for a widget's media to be ready for playback.
   * - Video: resolves when 'playing' fires (buffered enough to render frames)
   * - Image: resolves when 'load' fires (decoded and paintable)
   * - Text/embedded/clock: resolves immediately (inline content, no async load)
   * @param {HTMLElement} element - Widget DOM element
   * @param {Object} widget - Widget config
   * @returns {Promise<void>}
   */
  waitForWidgetReady(element, widget) {
    const READY_TIMEOUT = 10000; // 10s max wait — don't block forever on broken media

    // Video widgets: wait for actual playback
    const videoEl = this.findMediaElement(element, 'VIDEO');
    if (videoEl) {
      // Already playing (replay case where video was kept alive)
      if (!videoEl.paused && videoEl.readyState >= 3) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.log.warn(`Video ready timeout (${READY_TIMEOUT}ms) for widget ${widget.id}`);
          resolve();
        }, READY_TIMEOUT);
        const onPlaying = () => {
          videoEl.removeEventListener('playing', onPlaying);
          clearTimeout(timer);
          this.log.info(`Video widget ${widget.id} ready (playing)`);
          resolve();
        };
        videoEl.addEventListener('playing', onPlaying);
      });
    }

    // Audio widgets: wait for playback to start
    const audioEl = this.findMediaElement(element, 'AUDIO');
    if (audioEl) {
      if (!audioEl.paused && audioEl.readyState >= 3) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.log.warn(`Audio ready timeout (${READY_TIMEOUT}ms) for widget ${widget.id}`);
          resolve();
        }, READY_TIMEOUT);
        const onPlaying = () => {
          audioEl.removeEventListener('playing', onPlaying);
          clearTimeout(timer);
          this.log.info(`Audio widget ${widget.id} ready (playing)`);
          resolve();
        };
        audioEl.addEventListener('playing', onPlaying);
      });
    }

    // Image widgets: wait for image decode
    const imgEl = this.findMediaElement(element, 'IMG');
    if (imgEl) {
      if (imgEl.complete && imgEl.naturalWidth > 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.log.warn(`Image ready timeout for widget ${widget.id}`);
          resolve();
        }, READY_TIMEOUT);
        const onLoad = () => {
          imgEl.removeEventListener('load', onLoad);
          clearTimeout(timer);
          resolve();
        };
        imgEl.addEventListener('load', onLoad);
      });
    }

    // Text, embedded, clock, etc. — ready immediately
    return Promise.resolve();
  }

  /**
   * Start the layout timer only after all initial widgets are ready.
   * This ensures that the layout duration counts from when content is
   * actually visible, so videos play their full duration to the last frame.
   * @param {number|string} layoutId - Layout ID
   * @param {Object} layout - Layout config with .duration
   */
  async startLayoutTimerWhenReady(layoutId, layout) {
    if (!layout || layout.duration <= 0) return;

    // Collect readiness promises for each region's first (current) widget
    const readyPromises = [];
    for (const [regionId, region] of this.regions) {
      if (region.widgets.length === 0) continue;
      const widget = region.widgets[region.currentIndex || 0];
      const element = region.widgetElements.get(widget.id);
      if (element) {
        readyPromises.push(this.waitForWidgetReady(element, widget));
      }
    }

    if (readyPromises.length > 0) {
      this.log.info(`Waiting for ${readyPromises.length} widget(s) to be ready before starting layout timer...`);
      await Promise.all(readyPromises);
      this.log.info(`All widgets ready — starting layout timer`);
    }

    // Guard: layout may have changed while we were waiting
    if (this.currentLayoutId !== layoutId) {
      this.log.warn(`Layout changed while waiting for widgets — skipping timer for ${layoutId}`);
      return;
    }

    const layoutDurationMs = layout.duration * 1000;
    this.log.info(`Layout ${layoutId} will end after ${layout.duration}s`);

    this._layoutTimerStartedAt = Date.now();
    this._layoutTimerDurationMs = layoutDurationMs;
    this.layoutTimer = setTimeout(() => {
      this.log.info(`Layout ${layoutId} duration expired (${layout.duration}s)`);
      if (this.currentLayoutId) {
        this.layoutEndEmitted = true;
        this.emit('layoutEnd', this.currentLayoutId);
      }
    }, layoutDurationMs);
  }

  /**
   * Render a widget in a region (using element reuse)
   * @param {string} regionId - Region ID
   * @param {number} widgetIndex - Widget index in region
   */
  /**
   * Core: show a widget in a region (shared by main layout + overlay)
   * Returns the widget object on success, null on failure.
   */
  async _showWidget(region, widgetIndex) {
    const widget = region.widgets[widgetIndex];
    if (!widget) return null;

    let element = region.widgetElements.get(widget.id);

    if (!element) {
      this.log.warn(`Widget ${widget.id} not pre-created, creating now`);
      element = await this.createWidgetElement(widget, region);
      element.style.position = 'absolute';
      element.style.top = '0';
      element.style.left = '0';
      element.style.width = '100%';
      element.style.height = '100%';
      region.widgetElements.set(widget.id, element);
      region.element.appendChild(element);
    }

    // Hide all other widgets in region
    // Cancel fill:forwards animations first — they override inline styles
    for (const [widgetId, widgetEl] of region.widgetElements) {
      if (widgetId !== widget.id) {
        widgetEl.getAnimations?.().forEach(a => a.cancel());
        widgetEl.style.visibility = 'hidden';
        widgetEl.style.opacity = '0';
      }
    }

    this.updateMediaElement(element, widget);
    element.getAnimations?.().forEach(a => a.cancel());
    element.style.visibility = 'visible';

    if (widget.transitions.in) {
      Transitions.apply(element, widget.transitions.in, true, region.width, region.height);
    } else {
      element.style.opacity = '1';
    }

    // Start audio overlays attached to this widget
    this._startAudioOverlays(widget);

    return widget;
  }

  /**
   * Start audio overlay elements for a widget.
   * Audio overlays are <audio> child nodes in the XLF that play alongside
   * the visual widget (e.g. background music for an image slideshow).
   * @param {Object} widget - Widget config with audioNodes array
   */
  _startAudioOverlays(widget) {
    if (!widget.audioNodes || widget.audioNodes.length === 0) return;

    // Stop any existing audio overlays for this widget first
    this._stopAudioOverlays(widget.id);

    const audioElements = [];
    for (const audioNode of widget.audioNodes) {
      if (!audioNode.uri) continue;

      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.loop = audioNode.loop;
      audio.volume = Math.max(0, Math.min(1, audioNode.volume / 100));

      // Resolve audio URI via cache/proxy
      const mediaId = parseInt(audioNode.mediaId);
      let audioSrc = mediaId ? this.mediaUrlCache.get(mediaId) : null;

      if (!audioSrc && mediaId && this.options.getMediaUrl) {
        // Async — fire and forget, set src when ready
        this.options.getMediaUrl(mediaId).then(url => {
          audio.src = url;
        }).catch(() => {
          audio.src = `${window.location.origin}/player/cache/media/${audioNode.uri}`;
        });
      } else if (!audioSrc) {
        audio.src = `${window.location.origin}/player/cache/media/${audioNode.uri}`;
      } else {
        audio.src = audioSrc;
      }

      // Append to DOM to prevent garbage collection in some browsers
      audio.style.display = 'none';
      this.container.appendChild(audio);

      // Handle autoplay restrictions gracefully (play() may return undefined in some envs)
      const playPromise = audio.play();
      if (playPromise && playPromise.catch) playPromise.catch(() => {});

      audioElements.push(audio);
      this.log.info(`Audio overlay started for widget ${widget.id}: ${audioNode.uri} (loop=${audioNode.loop}, vol=${audioNode.volume})`);
    }

    if (audioElements.length > 0) {
      this.audioOverlays.set(widget.id, audioElements);
    }
  }

  /**
   * Stop and clean up audio overlay elements for a widget.
   * @param {string} widgetId - Widget ID
   */
  _stopAudioOverlays(widgetId) {
    const audioElements = this.audioOverlays.get(widgetId);
    if (!audioElements) return;

    for (const audio of audioElements) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load(); // Release resources
      if (audio.parentNode) audio.parentNode.removeChild(audio); // Remove from DOM
    }

    this.audioOverlays.delete(widgetId);
    this.log.info(`Audio overlays stopped for widget ${widgetId}`);
  }

  /**
   * Core: hide a widget in a region (shared by main layout + overlay).
   * Returns { widget, animPromise } synchronously — callers await animPromise if needed.
   * NOT async, so callers that don't need the animation stay on the same microtask.
   */
  _hideWidget(region, widgetIndex) {
    const widget = region.widgets[widgetIndex];
    if (!widget) return { widget: null, animPromise: null };

    const widgetElement = region.widgetElements.get(widget.id);
    if (!widgetElement) return { widget: null, animPromise: null };

    let animPromise = null;
    if (widget.transitions.out) {
      const animation = Transitions.apply(
        widgetElement, widget.transitions.out, false, region.width, region.height
      );
      if (animation) {
        animPromise = new Promise(resolve => { animation.onfinish = resolve; });
      }
    }

    const videoEl = widgetElement.querySelector('video');
    if (videoEl && widget.options.loop !== '1') videoEl.pause();

    // Stop MediaStream tracks (webcam/mic) to release the device
    if (videoEl?._mediaStream) {
      videoEl._mediaStream.getTracks().forEach(t => t.stop());
      videoEl._mediaStream = null;
      videoEl.srcObject = null;
    }

    const audioEl = widgetElement.querySelector('audio');
    if (audioEl && widget.options.loop !== '1') audioEl.pause();

    // Stop audio overlays attached to this widget
    this._stopAudioOverlays(widget.id);

    return { widget, animPromise };
  }

  /**
   * Check if a widget is within its valid time window (fromDt/toDt).
   * Widgets without dates are always active.
   * @param {Object} widget - Widget config with optional fromDt/toDt
   * @returns {boolean}
   */
  _isWidgetActive(widget) {
    const now = new Date();
    if (widget.fromDt) {
      const from = new Date(widget.fromDt);
      if (now < from) return false;
    }
    if (widget.toDt) {
      const to = new Date(widget.toDt);
      if (now > to) return false;
    }
    return true;
  }

  /**
   * Parse NUMITEMS and DURATION HTML comments from GetResource responses.
   * CMS embeds these in widget HTML to override duration for dynamic content
   * (e.g. DataSet tickers, RSS feeds). Format: <!-- NUMITEMS=5 --> <!-- DURATION=30 -->
   * DURATION takes precedence; otherwise NUMITEMS × widget.duration is used.
   * @param {string} html - Widget HTML content
   * @param {Object} widget - Widget config (duration may be updated)
   */
  _parseDurationComments(html, widget) {
    const durationMatch = html.match(/<!--\s*DURATION=(\d+)\s*-->/);
    if (durationMatch) {
      const newDuration = parseInt(durationMatch[1], 10);
      if (newDuration > 0) {
        this.log.info(`Widget ${widget.id}: DURATION comment overrides duration ${widget.duration}→${newDuration}s`);
        widget.duration = newDuration;
        return;
      }
    }

    const numItemsMatch = html.match(/<!--\s*NUMITEMS=(\d+)\s*-->/);
    if (numItemsMatch) {
      const numItems = parseInt(numItemsMatch[1], 10);
      if (numItems > 0 && widget.duration > 0) {
        const newDuration = numItems * widget.duration;
        this.log.info(`Widget ${widget.id}: NUMITEMS=${numItems} × ${widget.duration}s = ${newDuration}s`);
        widget.duration = newDuration;
      }
    }
  }

  /**
   * Apply sub-playlist cycle playback filtering.
   * Groups widgets by parentWidgetId, then selects one widget per group for this cycle.
   * Non-grouped widgets pass through unchanged.
   *
   * @param {Array} widgets - All widgets in the region
   * @returns {Array} Filtered widgets for this playback cycle
   */
  _applyCyclePlayback(widgets) {
    // Track cycle indices per group for deterministic round-robin
    if (!this._subPlaylistCycleIndex) {
      this._subPlaylistCycleIndex = new Map();
    }

    // Group widgets by parentWidgetId
    const groups = new Map(); // parentWidgetId → [widgets]
    const result = [];

    for (const widget of widgets) {
      if (widget.parentWidgetId && widget.cyclePlayback) {
        if (!groups.has(widget.parentWidgetId)) {
          groups.set(widget.parentWidgetId, []);
        }
        groups.get(widget.parentWidgetId).push(widget);
      } else {
        // Non-grouped widget: add a placeholder to preserve order
        result.push({ type: 'direct', widget });
      }
    }

    // For each group, select one widget for this cycle
    for (const [groupId, groupWidgets] of groups) {
      // Sort by displayOrder
      groupWidgets.sort((a, b) => a.displayOrder - b.displayOrder);

      let selectedWidget;
      if (groupWidgets.some(w => w.isRandom)) {
        // Random selection
        const idx = Math.floor(Math.random() * groupWidgets.length);
        selectedWidget = groupWidgets[idx];
      } else {
        // Round-robin based on cycle index
        const cycleIdx = this._subPlaylistCycleIndex.get(groupId) || 0;
        selectedWidget = groupWidgets[cycleIdx % groupWidgets.length];
        this._subPlaylistCycleIndex.set(groupId, cycleIdx + 1);
      }

      this.log.info(`Sub-playlist cycle: group ${groupId} selected widget ${selectedWidget.id} (${groupWidgets.length} in group)`);
      result.push({ type: 'direct', widget: selectedWidget });
    }

    return result.map(r => r.widget);
  }

  /**
   * Core: cycle through widgets in a region (shared by main layout + overlay)
   * @param {Object} region - Region state object
   * @param {string} regionId - Region ID
   * @param {Function} showFn - (regionId, widgetIndex) => show widget
   * @param {Function} hideFn - (regionId, widgetIndex) => hide widget
   * @param {Function} [onCycleComplete] - Called when region completes one full cycle
   */
  _startRegionCycle(region, regionId, showFn, hideFn, onCycleComplete) {
    if (!region || region.widgets.length === 0) return;

    // Non-looping region with a single widget: show it and stay (spec: loop=0)
    if (region.widgets.length === 1) {
      showFn(regionId, 0);
      return;
    }

    const playNext = () => {
      const widgetIndex = region.currentIndex;
      const widget = region.widgets[widgetIndex];

      showFn(regionId, widgetIndex);

      const duration = widget.duration * 1000;
      region.timer = setTimeout(() => {
        this._handleWidgetCycleEnd(widget, region, regionId, widgetIndex, showFn, hideFn, onCycleComplete, playNext);
      }, duration);
    };

    playNext();
  }

  /**
   * Handle widget cycle end — shared logic for timer-based and event-based cycling
   */
  _handleWidgetCycleEnd(widget, region, regionId, widgetIndex, showFn, hideFn, onCycleComplete, playNext) {
    // Emit widgetAction if widget has a webhook URL configured
    if (widget.webhookUrl) {
      this.emit('widgetAction', {
        type: 'durationEnd',
        widgetId: widget.id,
        layoutId: this.currentLayoutId,
        regionId,
        url: widget.webhookUrl
      });
    }

    hideFn(regionId, widgetIndex);

    const nextIndex = (region.currentIndex + 1) % region.widgets.length;
    if (nextIndex === 0 && !region.complete) {
      region.complete = true;
      onCycleComplete?.();
    }

    // Non-looping region (loop=0): stop after one full cycle
    if (nextIndex === 0 && region.config?.loop === false) {
      // Show the last widget again and keep it visible
      showFn(regionId, region.widgets.length - 1);
      return;
    }

    region.currentIndex = nextIndex;
    playNext();
  }

  async renderWidget(regionId, widgetIndex) {
    const region = this.regions.get(regionId);
    if (!region) return;

    try {
      const widget = await this._showWidget(region, widgetIndex);
      if (widget) {
        this.log.info(`Showing widget ${widget.type} (${widget.id}) in region ${regionId}`);
        this.emit('widgetStart', {
          widgetId: widget.id, regionId, layoutId: this.currentLayoutId,
          mediaId: parseInt(widget.fileId || widget.id) || null,
          type: widget.type, duration: widget.duration,
          enableStat: widget.enableStat
        });

        // Execute commands attached to this widget (shell/native commands)
        if (widget.commands && widget.commands.length > 0) {
          for (const cmd of widget.commands) {
            this.emit('widgetCommand', {
              commandCode: cmd.commandCode,
              commandString: cmd.commandString,
              widgetId: widget.id,
              regionId,
              layoutId: this.currentLayoutId
            });
          }
        }
      }
    } catch (error) {
      this.log.error(`Error rendering widget:`, error);
      this.emit('error', { type: 'widgetError', error, widgetId: region.widgets[widgetIndex]?.id, regionId });
    }
  }

  /**
   * Stop a widget (with element reuse - don't revoke blob URLs!)
   * @param {string} regionId - Region ID
   * @param {number} widgetIndex - Widget index
   */
  async stopWidget(regionId, widgetIndex) {
    const region = this.regions.get(regionId);
    if (!region) return;

    const { widget, animPromise } = this._hideWidget(region, widgetIndex);
    if (animPromise) await animPromise;
    if (widget) {
      this.emit('widgetEnd', {
        widgetId: widget.id, regionId, layoutId: this.currentLayoutId,
        mediaId: parseInt(widget.fileId || widget.id) || null,
        type: widget.type,
        enableStat: widget.enableStat
      });
    }
  }

  /**
   * Render image widget
   */
  async renderImage(widget, region) {
    const img = document.createElement('img');
    img.className = 'renderer-lite-widget';
    img.style.width = '100%';
    img.style.height = '100%';
    // Scale type: stretch → fill (ignore ratio), center → none (natural size), fit → cover (fill region, crop excess)
    // Matches CMS xibo-layout-renderer behavior: fit uses background-size:cover
    const scaleType = widget.options.scaleType;
    const fitMap = { stretch: 'fill', center: 'none', fit: 'cover' };
    img.style.objectFit = fitMap[scaleType] || 'contain';

    // Alignment: map alignId/valignId to CSS object-position
    // XLF tags are <alignId> and <valignId> (from CMS image.xml property ids)
    const alignMap = { left: 'left', center: 'center', right: 'right' };
    const valignMap = { top: 'top', middle: 'center', bottom: 'bottom' };
    const hPos = alignMap[widget.options.alignId] || 'center';
    const vPos = valignMap[widget.options.valignId] || 'center';
    img.style.objectPosition = `${hPos} ${vPos}`;

    img.style.opacity = '0';

    // Get media URL from cache (already pre-fetched!) or fetch on-demand
    const fileId = parseInt(widget.fileId || widget.id);
    let imageSrc = this.mediaUrlCache.get(fileId);

    if (!imageSrc && this.options.getMediaUrl) {
      imageSrc = await this.options.getMediaUrl(fileId);
    } else if (!imageSrc) {
      imageSrc = `${window.location.origin}/player/cache/media/${widget.options.uri}`;
    }

    img.src = imageSrc;
    return img;
  }

  /**
   * Render video widget
   */
  async renderVideo(widget, region) {
    const video = document.createElement('video');
    video.className = 'renderer-lite-widget';
    video.style.width = '100%';
    video.style.height = '100%';
    const vScaleType = widget.options.scaleType;
    const vFitMap = { stretch: 'fill', center: 'none', fit: 'contain' };
    video.style.objectFit = vFitMap[vScaleType] || 'contain';
    video.style.opacity = '1'; // Immediately visible
    video.autoplay = true;
    video.preload = 'auto'; // Eagerly buffer - chunks are pre-warmed in SW BlobCache
    video.muted = widget.options.mute === '1';
    video.loop = false; // Don't use native loop - we handle it manually to avoid black frames
    video.controls = false; // Hidden by default — toggle with V key in PWA
    video.playsInline = true; // Prevent fullscreen on mobile

    // Handle video end - pause on last frame instead of showing black
    // Widget cycling will restart the video via updateMediaElement()
    video.addEventListener('ended', () => {
      if (widget.options.loop === '1') {
        // For looping videos: seek back to start but stay paused on first frame
        // This avoids black frames - shows first frame until widget cycles
        video.currentTime = 0;
        this.log.info(`Video ${fileId} ended - reset to start, waiting for widget cycle to replay`);
      } else {
        // For non-looping videos: stay paused on last frame
        this.log.info(`Video ${fileId} ended - paused on last frame`);
      }
    });

    // Get media URL from cache (already pre-fetched!) or fetch on-demand
    const fileId = parseInt(widget.fileId || widget.id);
    let videoSrc = this.mediaUrlCache.get(fileId);

    if (!videoSrc && this.options.getMediaUrl) {
      videoSrc = await this.options.getMediaUrl(fileId);
    } else if (!videoSrc) {
      videoSrc = `${window.location.origin}/player/cache/media/${fileId}`;
    }

    // HLS/DASH streaming support
    const isHlsStream = videoSrc.includes('.m3u8');
    if (isHlsStream) {
      // Try native HLS first (Safari, iOS, some Android)
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        this.log.info(`HLS stream (native): ${fileId}`);
        video.src = videoSrc;
      } else {
        // Dynamic import hls.js for Chrome/Firefox (code-split, not in main bundle)
        try {
          const { default: Hls } = await import('hls.js');
          if (Hls.isSupported()) {
            const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
            hls.loadSource(videoSrc);
            hls.attachMedia(video);
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal) {
                this.log.error(`HLS fatal error: ${data.type}`, data.details);
                hls.destroy();
              }
            });
            this.log.info(`HLS stream (hls.js): ${fileId}`);
          } else {
            this.log.warn(`HLS not supported on this browser for ${fileId}`);
            video.src = videoSrc; // Fallback — may not work
          }
        } catch (e) {
          this.log.warn(`hls.js not available, falling back to native: ${e.message}`);
          video.src = videoSrc;
        }
      }
    } else {
      video.src = videoSrc;
    }

    // Detect video duration for dynamic layout timing (when useDuration=0)
    video.addEventListener('loadedmetadata', () => {
      const videoDuration = Math.floor(video.duration);
      this.log.info(`Video ${fileId} duration detected: ${videoDuration}s`);

      // If widget has useDuration=0, update widget duration with actual video length
      if (widget.duration === 0 || widget.useDuration === 0) {
        widget.duration = videoDuration;
        this.log.info(`Updated widget ${widget.id} duration to ${videoDuration}s (useDuration=0)`);

        // Recalculate layout duration if needed
        this.updateLayoutDuration();
      }
    });

    // Debug video loading
    video.addEventListener('loadeddata', () => {
      this.log.info('Video loaded and ready:', fileId);
    });

    // Handle video errors
    video.addEventListener('error', (e) => {
      const error = video.error;
      const errorCode = error?.code;
      const errorMessage = error?.message || 'Unknown error';

      // Log all video errors for debugging, but never show to users
      // These are often transient codec warnings that don't prevent playback
      this.log.warn(`Video error (non-fatal, logged only): ${fileId}, code: ${errorCode}, time: ${video.currentTime.toFixed(1)}s, message: ${errorMessage}`);

      // Do NOT emit error events - video errors are logged but not surfaced to UI
      // Video will either recover (transient decode error) or fail completely (handled elsewhere)
    });

    video.addEventListener('playing', () => {
      this.log.info('Video playing:', fileId);
    });

    this.log.info('Video element created:', fileId, video.src);

    return video;
  }

  /**
   * Render videoin (webcam/microphone) widget.
   * Uses getUserMedia() to capture live video from camera hardware.
   * @param {Object} widget - Widget config with options (sourceId, showFullScreen, mirror, mute, captureAudio)
   * @param {Object} region - Region dimensions (width, height)
   * @returns {HTMLVideoElement}
   */
  async renderVideoIn(widget, region) {
    const video = document.createElement('video');
    video.className = 'renderer-lite-widget';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = widget.options.showFullScreen === '1' ? 'cover' : 'contain';
    video.autoplay = true;
    video.playsInline = true;
    video.controls = false;
    video.muted = widget.options.mute !== '0'; // Muted by default to prevent audio feedback

    // Mirror mode (front-facing camera)
    if (widget.options.mirror === '1') {
      video.style.transform = 'scaleX(-1)';
    }

    // Build getUserMedia constraints
    const videoConstraints = {
      width: { ideal: region.width },
      height: { ideal: region.height },
    };
    const deviceId = widget.options.sourceId || widget.options.deviceId;
    if (deviceId) {
      videoConstraints.deviceId = { exact: deviceId };
    } else {
      videoConstraints.facingMode = widget.options.facingMode || 'environment';
    }

    const constraints = {
      video: videoConstraints,
      audio: widget.options.captureAudio === '1',
    };

    // Store constraints for re-acquisition after layout transitions
    video._mediaConstraints = constraints;

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      video._mediaStream = stream;
      this.log.info(`Webcam stream acquired for widget ${widget.id} (tracks: ${stream.getTracks().length})`);
    } catch (e) {
      this.log.warn(`getUserMedia failed for widget ${widget.id}: ${e.message}`);
      return this._renderUnsupportedPlaceholder(
        { ...widget, type: 'Camera unavailable' },
        region
      );
    }

    return video;
  }

  /**
   * Render audio widget
   */
  async renderAudio(widget, region) {
    const container = document.createElement('div');
    container.className = 'renderer-lite-widget audio-widget';
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';
    container.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    container.style.opacity = '0';

    // Audio element
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.loop = widget.options.loop === '1';
    audio.volume = parseFloat(widget.options.volume || '100') / 100;

    // Get media URL from cache (already pre-fetched!) or fetch on-demand
    const fileId = parseInt(widget.fileId || widget.id);
    let audioSrc = this.mediaUrlCache.get(fileId);

    if (!audioSrc && this.options.getMediaUrl) {
      audioSrc = await this.options.getMediaUrl(fileId);
    } else if (!audioSrc) {
      audioSrc = `${window.location.origin}/player/cache/media/${fileId}`;
    }

    audio.src = audioSrc;

    // Handle audio end - similar to video ended handling
    audio.addEventListener('ended', () => {
      if (widget.options.loop === '1') {
        audio.currentTime = 0;
        this.log.info(`Audio ${fileId} ended - reset to start, waiting for widget cycle to replay`);
      } else {
        this.log.info(`Audio ${fileId} ended - playback complete`);
      }
    });

    // Detect audio duration for dynamic layout timing (when useDuration=0)
    audio.addEventListener('loadedmetadata', () => {
      const audioDuration = Math.floor(audio.duration);
      this.log.info(`Audio ${fileId} duration detected: ${audioDuration}s`);

      if (widget.duration === 0 || widget.useDuration === 0) {
        widget.duration = audioDuration;
        this.log.info(`Updated widget ${widget.id} duration to ${audioDuration}s (useDuration=0)`);
        this.updateLayoutDuration();
      }
    });

    // Handle audio errors
    audio.addEventListener('error', () => {
      const error = audio.error;
      this.log.warn(`Audio error (non-fatal): ${fileId}, code: ${error?.code}, message: ${error?.message || 'Unknown'}`);
    });

    // Visual feedback
    const icon = document.createElement('div');
    icon.innerHTML = '♪';
    icon.style.fontSize = '120px';
    icon.style.color = 'white';
    icon.style.marginBottom = '20px';

    const info = document.createElement('div');
    info.style.color = 'white';
    info.style.fontSize = '24px';
    info.textContent = 'Playing Audio';

    const filename = document.createElement('div');
    filename.style.color = 'rgba(255,255,255,0.7)';
    filename.style.fontSize = '16px';
    filename.style.marginTop = '10px';
    filename.textContent = widget.options.uri;

    container.appendChild(audio);
    container.appendChild(icon);
    container.appendChild(info);
    container.appendChild(filename);

    return container;
  }

  /**
   * Render text/ticker widget
   */
  async renderTextWidget(widget, region) {
    const iframe = document.createElement('iframe');
    iframe.className = 'renderer-lite-widget';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.opacity = '0';

    // Get widget HTML (may return { url } for cache-path loading or string for blob)
    let html = widget.raw;
    if (this.options.getWidgetHtml) {
      const result = await this.options.getWidgetHtml(widget);
      if (result && typeof result === 'object' && result.url) {
        // Use cache URL — SW serves HTML and intercepts sub-resources
        iframe.src = result.url;

        // On hard reload (Ctrl+Shift+R), iframe navigation bypasses SW → server 404
        // Detect and fall back to blob URL with original CMS signed URLs
        if (result.fallback) {
          const self = this;
          iframe.addEventListener('load', function() {
            try {
              // Our cached widget HTML has a <base> tag; server 404 page doesn't
              if (!iframe.contentDocument?.querySelector('base')) {
                self.log.warn('Cache URL failed (hard reload?), using original CMS URLs');
                const blob = new Blob([result.fallback], { type: 'text/html' });
                const blobUrl = URL.createObjectURL(blob);
                self.trackBlobUrl(blobUrl);
                iframe.src = blobUrl;
              }
            } catch (e) { /* cross-origin — should not happen */ }
          }, { once: true });
        }

        // Parse NUMITEMS/DURATION from fallback HTML (cache path)
        if (result.fallback) {
          this._parseDurationComments(result.fallback, widget);
        }

        return iframe;
      }
      html = result;
    }

    if (html) {
      // Parse NUMITEMS/DURATION HTML comments for dynamic widget duration
      this._parseDurationComments(html, widget);
    }

    // Fallback: Create blob URL for iframe
    const blob = new Blob([html], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    iframe.src = blobUrl;

    // Track blob URL for lifecycle management
    this.trackBlobUrl(blobUrl);

    return iframe;
  }

  /**
   * Render PDF widget
   */
  async renderPdf(widget, region) {
    const container = document.createElement('div');
    container.className = 'renderer-lite-widget pdf-widget';
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.backgroundColor = '#525659';
    container.style.opacity = '0';
    container.style.position = 'relative';

    // Load PDF.js if available
    if (typeof window.pdfjsLib === 'undefined') {
      try {
        const pdfjsModule = await import('pdfjs-dist');
        window.pdfjsLib = pdfjsModule;
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${window.location.origin}/player/pdf.worker.min.mjs`;
      } catch (error) {
        this.log.error('PDF.js not available:', error);
        container.innerHTML = '<div style="color:white;padding:20px;text-align:center;">PDF viewer unavailable</div>';
        container.style.opacity = '1';
        return container;
      }
    }

    // Get PDF URL from cache (already pre-fetched!) or fetch on-demand
    const fileId = parseInt(widget.fileId || widget.id);
    let pdfUrl = this.mediaUrlCache.get(fileId);

    if (!pdfUrl && this.options.getMediaUrl) {
      pdfUrl = await this.options.getMediaUrl(fileId);
    } else if (!pdfUrl) {
      pdfUrl = `${window.location.origin}/player/cache/media/${widget.options.uri}`;
    }

    // Render PDF
    try {
      const loadingTask = window.pdfjsLib.getDocument(pdfUrl);
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1); // Render first page

      const viewport = page.getViewport({ scale: 1 });
      const scale = Math.min(
        region.width / viewport.width,
        region.height / viewport.height
      );
      const scaledViewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = scaledViewport.width;
      canvas.height = scaledViewport.height;
      canvas.style.display = 'block';
      canvas.style.margin = 'auto';

      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: scaledViewport }).promise;

      container.appendChild(canvas);

    } catch (error) {
      this.log.error('PDF render failed:', error);
      container.innerHTML = '<div style="color:white;padding:20px;text-align:center;">Failed to load PDF</div>';
    }

    container.style.opacity = '1';
    return container;
  }

  /**
   * Render webpage widget
   */
  async renderWebpage(widget, region) {
    // modeId=1 (or absent) = Open Natively (direct URL), modeId=0 = Manual/GetResource
    const modeId = parseInt(widget.options.modeId || '1');
    if (modeId === 0) {
      // GetResource mode: treat like a generic widget (fetch HTML from CMS)
      return await this.renderGenericWidget(widget, region);
    }

    const iframe = document.createElement('iframe');
    iframe.className = 'renderer-lite-widget';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.opacity = '0';
    iframe.src = widget.options.uri;

    return iframe;
  }

  /**
   * Render generic widget (clock, calendar, weather, etc.)
   */
  async renderGenericWidget(widget, region) {
    const iframe = document.createElement('iframe');
    iframe.className = 'renderer-lite-widget';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.opacity = '0';

    // Get widget HTML (may return { url } for cache-path loading or string for blob)
    let html = widget.raw;
    if (this.options.getWidgetHtml) {
      const result = await this.options.getWidgetHtml(widget);
      if (result && typeof result === 'object' && result.url) {
        // Use cache URL — SW serves HTML and intercepts sub-resources
        iframe.src = result.url;

        // On hard reload (Ctrl+Shift+R), iframe navigation bypasses SW → server 404
        // Detect and fall back to blob URL with original CMS signed URLs
        if (result.fallback) {
          const self = this;
          iframe.addEventListener('load', function() {
            try {
              // Our cached widget HTML has a <base> tag; server 404 page doesn't
              if (!iframe.contentDocument?.querySelector('base')) {
                self.log.warn('Cache URL failed (hard reload?), using original CMS URLs');
                const blob = new Blob([result.fallback], { type: 'text/html' });
                const blobUrl = URL.createObjectURL(blob);
                self.trackBlobUrl(blobUrl);
                iframe.src = blobUrl;
              }
            } catch (e) { /* cross-origin — should not happen */ }
          }, { once: true });
        }

        // Parse NUMITEMS/DURATION from fallback HTML (cache path)
        if (result.fallback) {
          this._parseDurationComments(result.fallback, widget);
        }

        return iframe;
      }
      html = result;
    }

    if (html) {
      // Parse NUMITEMS/DURATION HTML comments for dynamic widget duration
      // Format: <!-- NUMITEMS=5 --> and <!-- DURATION=30 -->
      this._parseDurationComments(html, widget);

      const blob = new Blob([html], { type: 'text/html' });
      const blobUrl = URL.createObjectURL(blob);
      iframe.src = blobUrl;

      // Track blob URL for lifecycle management
      this.trackBlobUrl(blobUrl);
    } else {
      this.log.warn(`No HTML for widget ${widget.id}`);
      iframe.srcdoc = '<div style="padding:20px;">Widget content unavailable</div>';
    }

    return iframe;
  }

  /**
   * Render a placeholder for unsupported widget types (powerpoint, flash)
   */
  _renderUnsupportedPlaceholder(widget, region) {
    const div = document.createElement('div');
    div.className = 'renderer-lite-widget';
    div.style.width = '100%';
    div.style.height = '100%';
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.justifyContent = 'center';
    div.style.backgroundColor = '#111';
    div.style.color = '#666';
    div.style.fontSize = '14px';
    div.textContent = `Unsupported: ${widget.type}`;
    return div;
  }

  // ── Layout Preload Pool ─────────────────────────────────────────────

  /**
   * Schedule preloading of the next layout at 75% of current layout duration.
   * Emits 'request-next-layout-preload' so the platform layer can peek at the
   * schedule and call preloadLayout() with the next layout's XLF.
   * @param {Object} layout - Current layout object with .duration
   */
  _scheduleNextLayoutPreload(layout) {
    if (this.preloadTimer) {
      clearTimeout(this.preloadTimer);
      this.preloadTimer = null;
    }
    if (this._preloadRetryTimer) {
      clearTimeout(this._preloadRetryTimer);
      this._preloadRetryTimer = null;
    }

    const duration = layout.duration || 60; // seconds
    const preloadDelay = duration * 1000 * 0.75; // 75% through
    const retryDelay = duration * 1000 * 0.90;   // 90% retry

    this.log.info(`Scheduling next layout preload in ${(preloadDelay / 1000).toFixed(1)}s (75% of ${duration}s)`);

    this.preloadTimer = setTimeout(() => {
      this.preloadTimer = null;
      this.emit('request-next-layout-preload');
    }, preloadDelay);

    // Retry at 90% if the 75% attempt couldn't find a layout (e.g. cooldowns
    // hadn't expired yet).  The platform handler is idempotent — if a layout
    // is already in the pool it skips, so this is safe even if 75% succeeded.
    this._preloadRetryTimer = setTimeout(() => {
      this._preloadRetryTimer = null;
      this.emit('request-next-layout-preload');
    }, retryDelay);
  }

  /**
   * Preload a layout into the pool as a warm (hidden) entry.
   * Creates the full DOM hierarchy (regions + widgets) in a hidden container,
   * pre-fetches media, but does NOT start widget cycling or layout timer.
   *
   * This is called by the platform layer in response to 'request-next-layout-preload'.
   *
   * @param {string} xlfXml - XLF XML content for the layout
   * @param {number} layoutId - Layout ID
   * @returns {Promise<boolean>} true if preload succeeded, false on failure
   */
  async preloadLayout(xlfXml, layoutId) {
    // Don't preload if already in pool
    if (this.layoutPool.has(layoutId)) {
      this.log.info(`Layout ${layoutId} already in preload pool, skipping`);
      return true;
    }

    // Don't preload the currently playing layout
    if (this.currentLayoutId === layoutId) {
      this.log.info(`Layout ${layoutId} is current, skipping preload`);
      return true;
    }

    try {
      this.log.info(`Preloading layout ${layoutId} into pool...`);

      // Parse XLF
      const layout = this.parseXlf(xlfXml);

      // Calculate scale factor
      this.calculateScale(layout);

      // Create a hidden wrapper container for the preloaded layout
      const wrapper = document.createElement('div');
      wrapper.id = `preload_layout_${layoutId}`;
      wrapper.className = 'renderer-lite-preload-wrapper';
      wrapper.style.position = 'absolute';
      wrapper.style.top = '0';
      wrapper.style.left = '0';
      wrapper.style.width = '100%';
      wrapper.style.height = '100%';
      wrapper.style.visibility = 'hidden';
      wrapper.style.zIndex = '-1'; // Behind everything

      // Set background
      wrapper.style.backgroundColor = layout.bgcolor;

      // Apply background image if specified
      if (layout.background && this.options.getMediaUrl) {
        try {
          const bgUrl = await this.options.getMediaUrl(parseInt(layout.background));
          if (bgUrl) {
            wrapper.style.backgroundImage = `url(${bgUrl})`;
            wrapper.style.backgroundSize = 'cover';
            wrapper.style.backgroundPosition = 'center';
            wrapper.style.backgroundRepeat = 'no-repeat';
          }
        } catch (err) {
          this.log.warn('Preload: Failed to load background image:', err);
        }
      }

      // Pre-fetch all media URLs in parallel
      const preloadMediaUrlCache = new Map();
      if (this.options.getMediaUrl) {
        const mediaPromises = [];

        for (const region of layout.regions) {
          for (const widget of region.widgets) {
            if (widget.fileId) {
              const fileId = parseInt(widget.fileId || widget.id);
              if (!preloadMediaUrlCache.has(fileId)) {
                mediaPromises.push(
                  this.options.getMediaUrl(fileId)
                    .then(url => {
                      preloadMediaUrlCache.set(fileId, url);
                    })
                    .catch(err => {
                      this.log.warn(`Preload: Failed to fetch media ${fileId}:`, err);
                    })
                );
              }
            }
          }
        }

        if (mediaPromises.length > 0) {
          this.log.info(`Preload: fetching ${mediaPromises.length} media URLs...`);
          await Promise.all(mediaPromises);
        }
      }

      // Temporarily swap mediaUrlCache so createWidgetElement uses preload cache
      const savedMediaUrlCache = this.mediaUrlCache;
      const savedCurrentLayoutId = this.currentLayoutId;
      this.mediaUrlCache = preloadMediaUrlCache;

      // Create regions in the hidden wrapper
      const preloadRegions = new Map();
      const sf = this.scaleFactor;

      for (const regionConfig of layout.regions) {
        const regionEl = document.createElement('div');
        regionEl.id = `preload_region_${layoutId}_${regionConfig.id}`;
        regionEl.className = 'renderer-lite-region';
        regionEl.style.position = 'absolute';
        regionEl.style.zIndex = regionConfig.zindex;
        regionEl.style.overflow = 'hidden';

        // Apply scaled positioning
        this.applyRegionScale(regionEl, regionConfig);

        wrapper.appendChild(regionEl);

        const region = {
          element: regionEl,
          config: regionConfig,
          widgets: regionConfig.widgets,
          currentIndex: 0,
          timer: null,
          width: regionConfig.width * sf,
          height: regionConfig.height * sf,
          complete: false,
          widgetElements: new Map()
        };

        preloadRegions.set(regionConfig.id, region);
      }

      // Track blob URLs for the preloaded layout separately
      const preloadBlobUrls = new Set();
      const savedLayoutBlobUrls = this.layoutBlobUrls;
      this.layoutBlobUrls = new Map();
      this.layoutBlobUrls.set(layoutId, preloadBlobUrls);

      // Temporarily set currentLayoutId for trackBlobUrl to work
      this.currentLayoutId = layoutId;

      // Pre-create all widget elements
      for (const [regionId, region] of preloadRegions) {
        for (let i = 0; i < region.widgets.length; i++) {
          const widget = region.widgets[i];
          widget.layoutId = layoutId;
          widget.regionId = regionId;

          try {
            const element = await this.createWidgetElement(widget, region);
            element.style.position = 'absolute';
            element.style.top = '0';
            element.style.left = '0';
            element.style.width = '100%';
            element.style.height = '100%';
            element.style.visibility = 'hidden';
            element.style.opacity = '0';
            region.element.appendChild(element);
            region.widgetElements.set(widget.id, element);
          } catch (error) {
            this.log.error(`Preload: Failed to create widget ${widget.id}:`, error);
          }
        }
      }

      // Restore state
      this.mediaUrlCache = savedMediaUrlCache;
      this.currentLayoutId = savedCurrentLayoutId;

      // Pause all videos in preloaded layout (autoplay starts them even when hidden)
      wrapper.querySelectorAll('video').forEach(v => v.pause());

      // Collect any blob URLs tracked during preload
      const trackedBlobUrls = this.layoutBlobUrls.get(layoutId) || new Set();
      trackedBlobUrls.forEach(url => preloadBlobUrls.add(url));

      // Restore original layoutBlobUrls
      this.layoutBlobUrls = savedLayoutBlobUrls;

      // Add wrapper to main container (hidden)
      this.container.appendChild(wrapper);

      // Add to pool as warm
      this.layoutPool.add(layoutId, {
        container: wrapper,
        layout,
        regions: preloadRegions,
        blobUrls: preloadBlobUrls,
        mediaUrlCache: preloadMediaUrlCache
      });

      this.log.info(`Layout ${layoutId} preloaded into pool (${preloadRegions.size} regions, ${preloadMediaUrlCache.size} media)`);
      return true;

    } catch (error) {
      this.log.error(`Preload failed for layout ${layoutId}:`, error);
      return false;
    }
  }

  /**
   * Swap to a preloaded layout from the pool (instant transition).
   * Hides the current layout container and shows the preloaded one,
   * then starts widget cycling and layout timer.
   *
   * @param {number} layoutId - Layout ID to swap to
   */
  async _swapToPreloadedLayout(layoutId) {
    const preloaded = this.layoutPool.get(layoutId);
    if (!preloaded) {
      this.log.error(`Cannot swap: layout ${layoutId} not in pool`);
      return;
    }

    // ── Tear down old layout ──
    this.removeActionListeners();

    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = null;
    }

    if (this.preloadTimer) {
      clearTimeout(this.preloadTimer);
      this.preloadTimer = null;
    }
    if (this._preloadRetryTimer) {
      clearTimeout(this._preloadRetryTimer);
      this._preloadRetryTimer = null;
    }

    const oldLayoutId = this.currentLayoutId;

    if (oldLayoutId && this.layoutPool.has(oldLayoutId)) {
      // Old layout was preloaded — evict from pool (safe: removes its wrapper div)
      this.layoutPool.evict(oldLayoutId);
    } else {
      // Old layout was rendered normally — manual cleanup.
      // Region elements live directly in this.container (not a wrapper),
      // so we must remove them individually.
      for (const [regionId, region] of this.regions) {
        if (region.timer) {
          clearTimeout(region.timer);
          region.timer = null;
        }
        // Release video resources
        region.element.querySelectorAll('video').forEach(v => {
          v.pause();
          v.removeAttribute('src');
          v.load();
        });
        // Apply region exit transition if configured, then remove
        if (region.config && region.config.exitTransition) {
          const animation = Transitions.apply(
            region.element, region.config.exitTransition, false,
            region.width, region.height
          );
          if (animation) {
            const el = region.element;
            animation.onfinish = () => el.remove();
          } else {
            region.element.remove();
          }
        } else {
          region.element.remove();
        }
      }
      // Revoke blob URLs
      if (oldLayoutId) {
        this.revokeBlobUrlsForLayout(oldLayoutId);
      }
      for (const [fileId, blobUrl] of this.mediaUrlCache) {
        if (blobUrl && typeof blobUrl === 'string' && blobUrl.startsWith('blob:')) {
          URL.revokeObjectURL(blobUrl);
        }
      }
    }

    // Emit layoutEnd for old layout if timer hasn't already
    if (oldLayoutId && !this.layoutEndEmitted) {
      this.emit('layoutEnd', oldLayoutId);
    }

    this.regions.clear();
    this.mediaUrlCache.clear();

    // ── Activate preloaded layout ──
    preloaded.container.style.visibility = 'visible';
    preloaded.container.style.zIndex = '0';

    // Update renderer state to the preloaded layout
    this.layoutPool.setHot(layoutId);
    this.currentLayout = preloaded.layout;
    this.currentLayoutId = layoutId;
    this.regions = preloaded.regions;
    this.mediaUrlCache = preloaded.mediaUrlCache || new Map();
    this.layoutEndEmitted = false;

    // Update container background to match preloaded layout
    this.container.style.backgroundColor = preloaded.layout.bgcolor;
    if (preloaded.container.style.backgroundImage) {
      this.container.style.backgroundImage = preloaded.container.style.backgroundImage;
      this.container.style.backgroundSize = preloaded.container.style.backgroundSize;
      this.container.style.backgroundPosition = preloaded.container.style.backgroundPosition;
      this.container.style.backgroundRepeat = preloaded.container.style.backgroundRepeat;
    } else {
      this.container.style.backgroundImage = '';
    }

    // Recalculate scale for the preloaded layout
    this.calculateScale(preloaded.layout);

    // Attach interactive action listeners
    this.attachActionListeners(preloaded.layout);

    // Emit layout start event
    this.emit('layoutStart', layoutId, preloaded.layout);

    // Reset all regions and start widget cycling
    for (const [regionId, region] of this.regions) {
      region.currentIndex = 0;
      region.complete = false;
      this.startRegion(regionId);
    }

    // Recalculate layout duration from widget durations.
    // During preload, video loadedmetadata updated widget.duration but
    // updateLayoutDuration() updated this.currentLayout (the old layout),
    // so preloaded.layout.duration may still be the XLF default (e.g. 60s).
    this.updateLayoutDuration();

    // Wait for widgets to be ready then start layout timer
    this.startLayoutTimerWhenReady(layoutId, preloaded.layout);

    // Schedule next preload
    this._scheduleNextLayoutPreload(preloaded.layout);

    this.log.info(`Swapped to preloaded layout ${layoutId} (instant transition)`);
  }

  /**
   * Check if all regions have completed one full cycle
   * This is informational only - layout timer is authoritative
   */
  checkLayoutComplete() {
    // Check if all regions with multiple widgets have completed one cycle
    let allComplete = true;
    for (const [regionId, region] of this.regions) {
      // Only check multi-widget regions
      if (region.widgets.length > 1 && !region.complete) {
        allComplete = false;
        break;
      }
    }

    if (allComplete && this.currentLayoutId) {
      this.log.info(`All multi-widget regions completed one cycle`);
      // NOTE: We DON'T emit layoutEnd here - layout timer is authoritative
      // This is just informational logging for debugging
    }
  }

  /**
   * Stop current layout
   */
  stopCurrentLayout() {
    if (!this.currentLayout) return;

    this.log.info(`Stopping layout ${this.currentLayoutId}`);

    // Remove interactive action listeners before teardown
    this.removeActionListeners();

    // Clear layout timer
    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = null;
    }

    // Clear preload timers
    if (this.preloadTimer) {
      clearTimeout(this.preloadTimer);
      this.preloadTimer = null;
    }
    if (this._preloadRetryTimer) {
      clearTimeout(this._preloadRetryTimer);
      this._preloadRetryTimer = null;
    }

    // If layout was preloaded (has its own wrapper div in pool), evict safely.
    // Normally-rendered layouts are NOT in the pool, so we do manual cleanup.
    if (this.currentLayoutId && this.layoutPool.has(this.currentLayoutId)) {
      this.layoutPool.evict(this.currentLayoutId);
    } else {
      // Normally-rendered layout - manual cleanup (regions are in this.container)

      // Revoke all blob URLs for this layout (tracked lifecycle management)
      if (this.currentLayoutId) {
        this.revokeBlobUrlsForLayout(this.currentLayoutId);
      }

      // Stop all regions
      for (const [regionId, region] of this.regions) {
        if (region.timer) {
          clearTimeout(region.timer);
          region.timer = null;
        }

        // Stop current widget
        if (region.widgets.length > 0) {
          this.stopWidget(regionId, region.currentIndex);
        }

        // Apply region exit transition if configured, then remove
        if (region.config && region.config.exitTransition) {
          const animation = Transitions.apply(
            region.element, region.config.exitTransition, false,
            region.width, region.height
          );
          if (animation) {
            // Remove element after exit transition completes
            const el = region.element;
            animation.onfinish = () => el.remove();
          } else {
            region.element.remove();
          }
        } else {
          region.element.remove();
        }
      }

      // Revoke media blob URLs from cache
      for (const [fileId, blobUrl] of this.mediaUrlCache) {
        if (blobUrl && blobUrl.startsWith('blob:')) {
          URL.revokeObjectURL(blobUrl);
        }
      }
    }

    // Clear state
    this.regions.clear();
    this.mediaUrlCache.clear();

    // Emit layout end event only if timer hasn't already emitted it.
    // Timer-based layoutEnd (natural expiry) is authoritative — stopCurrentLayout
    // is called afterwards during the switch to the next layout, so we skip the
    // duplicate. But if the layout is forcibly stopped mid-playback (e.g., XMR
    // schedule change), the timer hasn't fired yet, so we DO emit here.
    if (this.currentLayoutId && !this.layoutEndEmitted) {
      this.emit('layoutEnd', this.currentLayoutId);
    }

    this.layoutEndEmitted = false;
    this.currentLayout = null;
    this.currentLayoutId = null;
  }

  /**
   * Render an overlay layout on top of the main layout
   * @param {string} xlfXml - XLF XML content for overlay
   * @param {number} layoutId - Overlay layout ID
   * @param {number} priority - Overlay priority (higher = on top)
   * @returns {Promise<void>}
   */
  async renderOverlay(xlfXml, layoutId, priority = 0) {
    try {
      this.log.info(`Rendering overlay ${layoutId} (priority ${priority})`);

      // Check if this overlay is already active
      if (this.activeOverlays.has(layoutId)) {
        this.log.warn(`Overlay ${layoutId} already active, skipping`);
        return;
      }

      // Parse XLF
      const layout = this.parseXlf(xlfXml);

      // Create overlay container
      const overlayDiv = document.createElement('div');
      overlayDiv.id = `overlay_${layoutId}`;
      overlayDiv.className = 'renderer-lite-overlay';
      overlayDiv.style.position = 'absolute';
      overlayDiv.style.top = '0';
      overlayDiv.style.left = '0';
      overlayDiv.style.width = '100%';
      overlayDiv.style.height = '100%';
      overlayDiv.style.zIndex = String(1000 + priority); // Higher priority = higher z-index
      overlayDiv.style.pointerEvents = 'auto'; // Enable clicks on overlay
      overlayDiv.style.backgroundColor = layout.bgcolor;

      // Pre-fetch all media URLs for overlay
      if (this.options.getMediaUrl) {
        const mediaPromises = [];
        for (const region of layout.regions) {
          for (const widget of region.widgets) {
            if (widget.fileId) {
              const fileId = parseInt(widget.fileId || widget.id);
              if (!this.mediaUrlCache.has(fileId)) {
                mediaPromises.push(
                  this.options.getMediaUrl(fileId)
                    .then(url => {
                      this.mediaUrlCache.set(fileId, url);
                    })
                    .catch(err => {
                      this.log.warn(`Failed to fetch overlay media ${fileId}:`, err);
                    })
                );
              }
            }
          }
        }

        if (mediaPromises.length > 0) {
          this.log.info(`Pre-fetching ${mediaPromises.length} overlay media URLs...`);
          await Promise.all(mediaPromises);
        }
      }

      // Calculate scale for overlay layout
      this.calculateScale(layout);

      // Create regions for overlay
      const overlayRegions = new Map();
      const sf = this.scaleFactor;
      for (const regionConfig of layout.regions) {
        const regionEl = document.createElement('div');
        regionEl.id = `overlay_${layoutId}_region_${regionConfig.id}`;
        regionEl.className = 'renderer-lite-region overlay-region';
        regionEl.style.position = 'absolute';
        regionEl.style.zIndex = String(regionConfig.zindex);
        regionEl.style.overflow = 'hidden';

        // Apply scaled positioning
        this.applyRegionScale(regionEl, regionConfig);

        overlayDiv.appendChild(regionEl);

        // Store region state (dimensions use scaled values)
        overlayRegions.set(regionConfig.id, {
          element: regionEl,
          config: regionConfig,
          widgets: regionConfig.widgets,
          currentIndex: 0,
          timer: null,
          width: regionConfig.width * sf,
          height: regionConfig.height * sf,
          complete: false,
          widgetElements: new Map()
        });
      }

      // Pre-create widget elements for overlay
      for (const [regionId, region] of overlayRegions) {
        for (const widget of region.widgets) {
          widget.layoutId = layoutId;
          widget.regionId = regionId;

          try {
            const element = await this.createWidgetElement(widget, region);
            element.style.visibility = 'hidden';
            element.style.opacity = '0';
            region.element.appendChild(element);
            region.widgetElements.set(widget.id, element);
          } catch (error) {
            this.log.error(`Failed to pre-create overlay widget ${widget.id}:`, error);
          }
        }
      }

      // Add overlay to container
      this.overlayContainer.appendChild(overlayDiv);

      // Store overlay state
      this.activeOverlays.set(layoutId, {
        container: overlayDiv,
        layout: layout,
        regions: overlayRegions,
        timer: null,
        priority: priority
      });

      // Emit overlay start event
      this.emit('overlayStart', layoutId, layout);

      // Start all overlay regions
      for (const [regionId, region] of overlayRegions) {
        this.startOverlayRegion(layoutId, regionId);
      }

      // Set overlay timer based on duration
      if (layout.duration > 0) {
        const durationMs = layout.duration * 1000;
        const overlayState = this.activeOverlays.get(layoutId);
        if (overlayState) {
          overlayState.timer = setTimeout(() => {
            this.log.info(`Overlay ${layoutId} duration expired (${layout.duration}s)`);
            this.emit('overlayEnd', layoutId);
          }, durationMs);
        }
      }

      this.log.info(`Overlay ${layoutId} started`);

    } catch (error) {
      this.log.error('Error rendering overlay:', error);
      this.emit('error', { type: 'overlayError', error, layoutId });
      throw error;
    }
  }

  /**
   * Start playing an overlay region's widgets
   * @param {number} overlayId - Overlay layout ID
   * @param {string} regionId - Region ID
   */
  startOverlayRegion(overlayId, regionId) {
    const overlayState = this.activeOverlays.get(overlayId);
    if (!overlayState) return;

    const region = overlayState.regions.get(regionId);
    this._startRegionCycle(
      region, regionId,
      (rid, idx) => this.renderOverlayWidget(overlayId, rid, idx),
      (rid, idx) => this.stopOverlayWidget(overlayId, rid, idx),
      () => this.log.info(`Overlay ${overlayId} region ${regionId} completed one full cycle`)
    );
  }

  /**
   * Render a widget in an overlay region
   * @param {number} overlayId - Overlay layout ID
   * @param {string} regionId - Region ID
   * @param {number} widgetIndex - Widget index in region
   */
  async renderOverlayWidget(overlayId, regionId, widgetIndex) {
    const overlayState = this.activeOverlays.get(overlayId);
    if (!overlayState) return;

    const region = overlayState.regions.get(regionId);
    if (!region) return;

    try {
      const widget = await this._showWidget(region, widgetIndex);
      if (widget) {
        this.log.info(`Showing overlay widget ${widget.type} (${widget.id}) in overlay ${overlayId} region ${regionId}`);
        this.emit('overlayWidgetStart', {
          overlayId, widgetId: widget.id, regionId,
          type: widget.type, duration: widget.duration
        });
      }
    } catch (error) {
      this.log.error(`Error rendering overlay widget:`, error);
      this.emit('error', { type: 'overlayWidgetError', error, widgetId: region.widgets[widgetIndex]?.id, regionId, overlayId });
    }
  }

  /**
   * Stop an overlay widget
   * @param {number} overlayId - Overlay layout ID
   * @param {string} regionId - Region ID
   * @param {number} widgetIndex - Widget index
   */
  async stopOverlayWidget(overlayId, regionId, widgetIndex) {
    const overlayState = this.activeOverlays.get(overlayId);
    if (!overlayState) return;

    const region = overlayState.regions.get(regionId);
    if (!region) return;

    const { widget, animPromise } = this._hideWidget(region, widgetIndex);
    if (animPromise) await animPromise;
    if (widget) {
      this.emit('overlayWidgetEnd', {
        overlayId, widgetId: widget.id, regionId, type: widget.type
      });
    }
  }

  /**
   * Stop and remove an overlay layout
   * @param {number} layoutId - Overlay layout ID
   */
  stopOverlay(layoutId) {
    const overlayState = this.activeOverlays.get(layoutId);
    if (!overlayState) {
      this.log.warn(`Overlay ${layoutId} not active`);
      return;
    }

    this.log.info(`Stopping overlay ${layoutId}`);

    // Clear overlay timer
    if (overlayState.timer) {
      clearTimeout(overlayState.timer);
      overlayState.timer = null;
    }

    // Stop all overlay regions
    for (const [regionId, region] of overlayState.regions) {
      if (region.timer) {
        clearTimeout(region.timer);
        region.timer = null;
      }

      // Stop current widget
      if (region.widgets.length > 0) {
        this.stopOverlayWidget(layoutId, regionId, region.currentIndex);
      }
    }

    // Remove overlay container from DOM
    if (overlayState.container) {
      overlayState.container.remove();
    }

    // Revoke blob URLs for this overlay
    this.revokeBlobUrlsForLayout(layoutId);

    // Remove from active overlays
    this.activeOverlays.delete(layoutId);

    // Emit overlay end event
    this.emit('overlayEnd', layoutId);

    this.log.info(`Overlay ${layoutId} stopped`);
  }

  /**
   * Stop all active overlays
   */
  stopAllOverlays() {
    const overlayIds = Array.from(this.activeOverlays.keys());
    for (const overlayId of overlayIds) {
      this.stopOverlay(overlayId);
    }
    this.log.info('All overlays stopped');
  }

  /**
   * Get active overlay IDs
   * @returns {Array<number>}
   */
  getActiveOverlays() {
    return Array.from(this.activeOverlays.keys());
  }

  /**
   * Pause playback: stop layout timer, pause all media, stop widget cycling.
   * The layout timer's remaining time is saved so resume() can restart it.
   */
  pause() {
    if (this._paused) return;
    this._paused = true;

    // Save remaining layout time
    if (this.layoutTimer && this._layoutTimerStartedAt) {
      const elapsed = Date.now() - this._layoutTimerStartedAt;
      this._layoutTimerRemaining = Math.max(0, this._layoutTimerDurationMs - elapsed);
      clearTimeout(this.layoutTimer);
      this.layoutTimer = null;
    }

    // Stop all region widget-cycling timers
    for (const [, region] of this.regions) {
      if (region.timer) {
        clearTimeout(region.timer);
        region.timer = null;
      }
    }

    // Pause all video/audio elements
    this._forEachMedia(el => el.pause());

    this.emit('paused');
    this.log.info('Playback paused');
  }

  /**
   * Check if playback is currently paused.
   */
  isPaused() {
    return this._paused;
  }

  /**
   * Resume playback: restart layout timer with remaining time, resume media and widget cycling.
   */
  resume() {
    if (!this._paused) return;
    this._paused = false;

    // Resume layout timer with remaining time
    if (this._layoutTimerRemaining != null && this._layoutTimerRemaining > 0) {
      this._layoutTimerStartedAt = Date.now();
      this._layoutTimerDurationMs = this._layoutTimerRemaining;
      const layoutId = this.currentLayoutId;
      this.layoutTimer = setTimeout(() => {
        this.log.info(`Layout ${layoutId} duration expired (resumed)`);
        if (this.currentLayoutId) {
          this.layoutEndEmitted = true;
          this.emit('layoutEnd', this.currentLayoutId);
        }
      }, this._layoutTimerRemaining);
      this._layoutTimerRemaining = null;
    }

    // Resume all video/audio
    this._forEachMedia(el => el.play().catch(() => {}));

    // Restart region widget cycling (re-enters cycle from current widget)
    for (const [regionId] of this.regions) {
      this.startRegion(regionId);
    }

    this.emit('resumed');
    this.log.info('Playback resumed');
  }

  /**
   * Apply a function to every video/audio element in all regions.
   */
  _forEachMedia(fn) {
    for (const [, region] of this.regions) {
      region.element?.querySelectorAll('video, audio').forEach(fn);
    }
  }

  /**
   * Cleanup renderer
   */
  cleanup() {
    this.stopAllOverlays();
    this.stopCurrentLayout();

    // Clean up any remaining audio overlays
    for (const widgetId of this.audioOverlays.keys()) {
      this._stopAudioOverlays(widgetId);
    }

    // Clear the layout preload pool
    this.layoutPool.clear();

    if (this.preloadTimer) {
      clearTimeout(this.preloadTimer);
      this.preloadTimer = null;
    }
    if (this._preloadRetryTimer) {
      clearTimeout(this._preloadRetryTimer);
      this._preloadRetryTimer = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.container.innerHTML = '';
    this.log.info('Cleaned up');
  }
}
