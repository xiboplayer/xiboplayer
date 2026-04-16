// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
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

import { EventEmitter } from '@xiboplayer/utils';
import { createLogger, isDebug, PLAYER_API } from '@xiboplayer/utils';
import { parseLayoutDuration } from '@xiboplayer/schedule';
import { asBool, ExprOutOfScope, evalExpr, XpStateStore, parseXpStateInit } from '@xiboplayer/expr';
import { LayoutPool } from './layout-pool.js';

/**
 * Transition utilities for widget animations
 */
export const Transitions = {
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
   * Apply slide-in transition (layout-level #337).
   *
   * Identical in shape to flyIn but keeps opacity at 1 throughout —
   * slides are pure positional animations for layout-to-layout
   * transitions where both layouts are fully rendered and the effect
   * is a carousel-style push/pull.
   */
  slideIn(element, duration, direction, width, height) {
    const dirMap = {
      N: { x: 0, y: -height },
      NE: { x: width, y: -height },
      E: { x: width, y: 0 },
      SE: { x: width, y: height },
      S: { x: 0, y: height },
      SW: { x: -width, y: height },
      W: { x: -width, y: 0 },
      NW: { x: -width, y: -height }
    };
    const offset = dirMap[direction] || dirMap.E;
    return element.animate(
      [
        { transform: `translate(${offset.x}px, ${offset.y}px)` },
        { transform: 'translate(0, 0)' }
      ],
      { duration, easing: 'ease-out', fill: 'forwards' }
    );
  },

  /**
   * Apply slide-out transition (layout-level #337).
   *
   * Pushes the outgoing layout off in the given direction.
   */
  slideOut(element, duration, direction, width, height) {
    const dirMap = {
      N: { x: 0, y: -height },
      NE: { x: width, y: -height },
      E: { x: width, y: 0 },
      SE: { x: width, y: height },
      S: { x: 0, y: height },
      SW: { x: -width, y: height },
      W: { x: -width, y: 0 },
      NW: { x: -width, y: -height }
    };
    const offset = dirMap[direction] || dirMap.W;
    return element.animate(
      [
        { transform: 'translate(0, 0)' },
        { transform: `translate(${offset.x}px, ${offset.y}px)` }
      ],
      { duration, easing: 'ease-in', fill: 'forwards' }
    );
  },

  /**
   * Apply wipe-in transition (layout-level #337).
   *
   * Reveals the incoming layout by progressively shrinking a
   * clip-path inset from one edge. The `direction` picks which edge
   * is the "start" of the reveal — E means "wipe reveals starting
   * from the left edge moving east", matching the barWipe convention.
   */
  wipeIn(element, duration, direction) {
    // inset(<top> <right> <bottom> <left>) — 100% on an edge hides
    // everything past that edge, 0% on an edge reveals everything.
    const insetByDirection = {
      E:  { from: 'inset(0 100% 0 0)',  to: 'inset(0 0 0 0)' },
      W:  { from: 'inset(0 0 0 100%)',  to: 'inset(0 0 0 0)' },
      S:  { from: 'inset(0 0 100% 0)',  to: 'inset(0 0 0 0)' },
      N:  { from: 'inset(100% 0 0 0)',  to: 'inset(0 0 0 0)' },
      // Diagonals: wipe from the named corner to its opposite
      SE: { from: 'inset(0 100% 100% 0)', to: 'inset(0 0 0 0)' },
      SW: { from: 'inset(0 0 100% 100%)', to: 'inset(0 0 0 0)' },
      NE: { from: 'inset(100% 100% 0 0)', to: 'inset(0 0 0 0)' },
      NW: { from: 'inset(100% 0 0 100%)', to: 'inset(0 0 0 0)' }
    };
    const clip = insetByDirection[direction] || insetByDirection.E;
    return element.animate(
      [{ clipPath: clip.from }, { clipPath: clip.to }],
      { duration, easing: 'ease-out', fill: 'forwards' }
    );
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
        return isIn ? this.fadeIn(element, duration) : this.fadeOut(element, duration);
      case 'fadein':
        return isIn ? this.fadeIn(element, duration) : null;
      case 'fadeout':
        return isIn ? null : this.fadeOut(element, duration);
      case 'fly':
        return isIn
          ? this.flyIn(element, duration, direction, regionWidth, regionHeight)
          : this.flyOut(element, duration, direction, regionWidth, regionHeight);
      case 'flyin':
        return isIn ? this.flyIn(element, duration, direction, regionWidth, regionHeight) : null;
      case 'flyout':
        return isIn ? null : this.flyOut(element, duration, direction, regionWidth, regionHeight);
      case 'slide':
        return isIn
          ? this.slideIn(element, duration, direction, regionWidth, regionHeight)
          : this.slideOut(element, duration, direction, regionWidth, regionHeight);
      case 'wipe':
        // Wipe is a reveal-only effect — the outgoing layout isn't
        // animated, the incoming one "uncovers" itself on top.
        return isIn ? this.wipeIn(element, duration, direction) : null;
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
   * @param {Map<string,string>} [options.fileIdToSaveAs] - Map from numeric file ID to storedAs filename (for layout backgrounds)
   * @param {Function} options.getWidgetHtml - Function to get widget HTML (layoutId, regionId, widgetId) => html
   */
  constructor(config, container, options = {}) {
    this.config = config;
    this.container = container;
    this.options = options;

    // Logger with configurable level
    this.log = createLogger('RendererLite', options.logLevel);

    // Event emitter for lifecycle hooks
    this.emitter = new EventEmitter();

    // State
    this.currentLayout = null;
    this.currentLayoutId = null;
    this._preloadingLayoutId = null; // Set during preload for blob URL tracking
    this._preloadingPromise = null;  // Promise for in-flight preload (await instead of skip)
    this.regions = new Map(); // regionId => { element, widgets, currentIndex, timer }
    this.layoutTimer = null;
    this.layoutEndEmitted = false; // Prevents double layoutEnd on stop after timer
    this._deferredTimerLayoutId = null; // Set when timer is deferred for dynamic layouts
    this._deferredTimerFallback = null; // Safety timeout: starts layout timer if metadata never arrives
    this._paused = false;
    this._layoutTimerStartedAt = null;  // Date.now() when layout timer started
    this._layoutTimerDurationMs = null; // Total layout duration in ms
    this.layoutBlobUrls = new Map(); // layoutId => Set<blobUrl> (for lifecycle tracking)
    this.audioOverlays = new Map(); // widgetId => [HTMLAudioElement] (audio overlays for widgets)

    // Bound methods (avoid lambda allocation per call in startRegion/_advanceRegion)
    this._stopWidgetBound = (rid, idx) => this.stopWidget(rid, idx);
    this._renderWidgetBound = (rid, idx) => this.renderWidget(rid, idx);

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

    // Widget lifecycle tracking — ensures symmetric start/stop
    this._startedWidgets = new Set(); // "regionId:widgetIndex" keys

    // SMIL State Track B — runtime xp:state store. Null until the host
    // application (PWA / Electron / etc.) injects a store via
    // setStateStore(). When present, widgets with xpIf= are evaluated
    // at _showWidget time and hidden on a false result.
    this._stateStore = null;
    this._stateUnsubscribe = null;

    // Layout preload pool (2-layout pool for instant transitions)
    this.layoutPool = new LayoutPool(2);
    this.preloadTimer = null;
    this._preloadRetryTimer = null;

    // Layout-to-layout transition default (#337). Applied when the
    // incoming layout has no per-layout layoutTransitionIn override.
    // Setting type to 'instant' preserves the pre-#337 hard-cut
    // behaviour byte-for-byte.
    this.layoutTransition = this._normalizeLayoutTransition(
      options.layoutTransition
    );

    // Setup container styles
    this.setupContainer();

    // Interactive Control (XIC) event handlers
    this.emitter.on('interactiveTrigger', (data) => this._handleInteractiveTrigger(data));
    this.emitter.on('widgetExpire', (data) => this._handleWidgetExpire(data));
    this.emitter.on('widgetExtendDuration', (data) => this._handleWidgetExtendDuration(data));
    this.emitter.on('widgetSetDuration', (data) => this._handleWidgetSetDuration(data));

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

    // Watch for container resize to rescale layout (debounced to avoid spam)
    this._resizeSuppressed = false;
    if (typeof ResizeObserver !== 'undefined') {
      let resizeTimer = null;
      this.resizeObserver = new ResizeObserver(() => {
        if (this._resizeSuppressed) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => this.rescaleRegions(), 150);
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
    this.emitter.on(event, callback);
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
   * Normalize a layout transition spec from constructor options.
   *
   * Accepts either a partial object, null, or undefined, and returns a
   * canonical shape: {type, duration, direction}. Defaults to the
   * backwards-compatible `instant` type so existing callers see no
   * behavioural change.
   *
   * @param {Object|null|undefined} spec
   * @returns {{type: string, duration: number, direction: string|undefined}}
   */
  _normalizeLayoutTransition(spec) {
    const type = spec?.type || 'instant';
    const duration = Number.isFinite(spec?.duration) ? spec.duration : 500;
    const direction = spec?.direction || undefined;
    return { type, duration, direction };
  }

  /**
   * Resolve the effective layout transition spec for an incoming
   * layout. Per-layout overrides (from parseXlf) beat the
   * renderer-wide default; unspecified fields fall back to the
   * default's values.
   *
   * @param {Object} incomingLayout - parsed layout object
   * @returns {{type: string, duration: number, direction: string|undefined}}
   */
  _resolveLayoutTransition(incomingLayout) {
    const layoutOverride = incomingLayout?.layoutTransitionIn;
    if (!layoutOverride || !layoutOverride.type) {
      return this.layoutTransition;
    }
    return {
      type: layoutOverride.type,
      duration: Number.isFinite(layoutOverride.duration)
        ? layoutOverride.duration
        : this.layoutTransition.duration,
      direction: layoutOverride.direction || this.layoutTransition.direction,
    };
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

    // Layout-to-layout transitions (#337). When present, these attributes
    // describe the visual effect to apply when this layout becomes the
    // active one. The "In" suffix mirrors the transIn/transOut
    // convention on <media> widgets. Absent = use the renderer's
    // configured default (or "instant" if no default is set).
    //
    // Supported types: instant (default, hard cut), fade, slide, wipe.
    // Direction (slide + wipe) uses the same 8-way compass as widget fly:
    // N, NE, E, SE, S, SW, W, NW.
    const layoutTransitionInType = layoutEl.getAttribute('layoutTransitionIn');
    const layoutTransitionInDurationAttr = layoutEl.getAttribute(
      'layoutTransitionInDuration'
    );
    const layoutTransitionInDirection = layoutEl.getAttribute(
      'layoutTransitionInDirection'
    );

    // Parse layout-level <tags><tag>…</tag></tags>. Used by the sync
    // bridge (roadmap #236) to read markers such as
    // `xp-sync-group:NAME` that the xiboplayer-smil-tools translator
    // emits when the source SMIL carries `xp:sync-group="…"`.
    // Only direct children of <layout> are considered — nested <tag>
    // elements inside <media><actions> etc. are ignored.
    const tags = [];
    for (const child of layoutEl.children) {
      if (child.tagName !== 'tags') continue;
      for (const tagEl of child.children) {
        if (tagEl.tagName !== 'tag') continue;
        const text = (tagEl.textContent || '').trim();
        if (text) tags.push(text);
      }
    }

    const layout = {
      schemaVersion: parseInt(layoutEl.getAttribute('schemaVersion') || '1'),
      width: parseInt(layoutEl.getAttribute('width') || '1920'),
      height: parseInt(layoutEl.getAttribute('height') || '1080'),
      duration: layoutDurationAttr ? parseInt(layoutDurationAttr) : 0, // 0 = calculate from widgets
      bgcolor: layoutEl.getAttribute('backgroundColor') || layoutEl.getAttribute('bgcolor') || '#000000',
      background: layoutEl.getAttribute('background') || null, // Background image fileId
      enableStat: layoutEl.getAttribute('enableStat') !== '0', // absent or "1" = enabled
      actions: this.parseActions(layoutEl),
      tags, // Layout-level tags (e.g. "xp-sync-group:lobby-wall")
      layoutTransitionIn: layoutTransitionInType
        ? {
            type: layoutTransitionInType,
            duration: layoutTransitionInDurationAttr
              ? parseInt(layoutTransitionInDurationAttr)
              : undefined,
            direction: layoutTransitionInDirection || undefined,
          }
        : null,
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
      const regionType = regionEl.getAttribute('type') || null;
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
        isCanvas: regionType === 'canvas', // Canvas regions render all widgets simultaneously
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
        // SMIL State Track B — xp-state-init widgets are metadata-only.
        // Their widget options declare the initial state the layout
        // expects (xpStateInit as a string carrier, xpStateScope,
        // xpLanguage, xpDefaultDatasource). They never produce a DOM
        // element: we collect the first one per layout and let the
        // renderLayout hook materialise the store. Any subsequent
        // xp-state-init on the same layout wins last (warning logged).
        if (widget.type === 'xp-state-init') {
          if (layout.xpStateInit) {
            this.log.warn(
              `Multiple xp-state-init widgets on layout — using widget ${widget.id} (last one wins)`
            );
          }
          layout.xpStateInit = {
            widgetId: widget.id,
            rawValue: widget.options.xpStateInit ?? '',
            scope: widget.options.xpStateScope ?? 'session',
            language: widget.options.xpLanguage ?? null,
            defaultDatasource: widget.options.xpDefaultDatasource ?? null
          };
          continue;  // do NOT add to render queue
        }
        region.widgets.push(widget);
      }

      // Auto-detect canvas from CMS "global" widget (CMS bundles canvas sub-widgets
      // into a single type="global" media element in the XLF)
      if (!region.isCanvas && region.widgets.some(w => w.type === 'global')) {
        region.isCanvas = true;
      }

      layout.regions.push(region);

      if (isDrawer) {
        this.log.info(`Parsed drawer: id=${region.id} with ${region.widgets.length} widgets`);
      }

      if (region.isCanvas) {
        this.log.info(`Parsed canvas region: id=${region.id} with ${region.widgets.length} widgets (all render simultaneously)`);
      }
    }

    // Calculate layout duration if not specified (duration=0)
    // Uses shared parseLayoutDuration() — single source of truth for XLF-based duration calc
    if (layout.duration === 0) {
      const { duration, isDynamic } = parseLayoutDuration(xlfXml);
      layout.duration = duration;
      layout.isDynamic = isDynamic;
      this.log.info(`Calculated layout duration: ${layout.duration}s (not specified in XLF)${isDynamic ? ' [dynamic — has useDuration=0 video]' : ''}`);
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

    // SMIL State Track B pass-through fields (plan 240/242).
    //
    // The CMS custom-module ships xp:* as widget *options* —
    //   <options>
    //     <option name="xpIf">a = 1</option>
    //     …
    //   </options>
    // — which is how round-tripping through PUT /widget/:id stays
    // byte-identical (see xibo-players/xibo-cms-private#1). Earlier
    // prototypes put these on the <media> element as attributes;
    // we still fall back to attributes so hand-rolled test XLFs and
    // legacy translator output keep working.
    //
    // xpIf is the runtime guard expression — evaluated at show time
    // against the injected XpStateStore. xpDayPart / xpDatasource /
    // xpJsonpath / xpMatch / xpBegin / xpEnd are captured for
    // completeness (same-shape gates, handled by other subsystems).
    // See xp-translation-matrix.md.
    const xpIf = options.xpIf ?? mediaEl.getAttribute('xpIf') ?? null;
    const xpDayPart = options.xpDayPart ?? mediaEl.getAttribute('xpDayPart') ?? null;
    const xpDatasource = options.xpDatasource ?? mediaEl.getAttribute('xpDatasource') ?? null;
    const xpJsonpath = options.xpJsonpath ?? mediaEl.getAttribute('xpJsonpath') ?? null;
    const xpMatch = options.xpMatch ?? mediaEl.getAttribute('xpMatch') ?? null;
    const xpBegin = options.xpBegin ?? mediaEl.getAttribute('xpBegin') ?? null;
    const xpEnd = options.xpEnd ?? mediaEl.getAttribute('xpEnd') ?? null;

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
      isRandom,
      // SMIL State Track B — runtime gating attributes (read from
      // widget <options> preferentially, with attribute fallback)
      xpIf,
      xpDayPart,
      xpDatasource,
      xpJsonpath,
      xpMatch,
      xpBegin,
      xpEnd
    };
  }

  /**
   * Track blob URL for lifecycle management
   * @param {string} blobUrl - Blob URL to track
   */
  trackBlobUrl(blobUrl) {
    const layoutId = this._preloadingLayoutId || this.currentLayoutId || 0;

    if (!layoutId) {
      this.log.warn('trackBlobUrl called without currentLayoutId, tracking under key 0');
    }

    if (!this.layoutBlobUrls.has(layoutId)) {
      this.layoutBlobUrls.set(layoutId, new Set());
    }

    this.layoutBlobUrls.get(layoutId).add(blobUrl);
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

    // Update layout duration if recalculated value differs.
    // Both upgrades (video metadata revealing longer duration) and downgrades
    // (DURATION comment correcting an overestimate) are legitimate.
    if (maxRegionDuration > 0 && maxRegionDuration !== this.currentLayout.duration) {
      const oldDuration = this.currentLayout.duration;
      this.currentLayout.duration = maxRegionDuration;
      this.currentLayout._durationFromMetadata = true;

      this.log.info(`Layout duration updated: ${oldDuration}s → ${maxRegionDuration}s (based on video metadata)`);
      const final_ = !this._hasUnprobedVideos();
      this.emit('layoutDurationUpdated', this.currentLayoutId, maxRegionDuration, final_);

      // Deferred timer: video metadata arrived, start the timer now
      if (this._deferredTimerLayoutId === this.currentLayoutId && !this.layoutTimer) {
        if (this._hasUnprobedVideos()) {
          this.log.info(`Layout duration updated to ${maxRegionDuration}s but still has unprobed videos — keeping timer deferred`);
        } else {
          // Cancel safety fallback — metadata arrived in time
          if (this._deferredTimerFallback) {
            clearTimeout(this._deferredTimerFallback);
            this._deferredTimerFallback = null;
          }
          const elapsed = Date.now() - (this._layoutTimerStartedAt || Date.now());
          const remainingMs = Math.max(1000, maxRegionDuration * 1000 - elapsed);
          this._deferredTimerLayoutId = null;
          this._layoutTimerDurationMs = remainingMs;
          this.layoutTimer = setTimeout(() => {
            this.log.info(`Layout ${this.currentLayoutId} duration expired (${this.currentLayout.duration}s)`);
            if (this.currentLayoutId) {
              this.layoutEndEmitted = true;
              this.emit('layoutEnd', this.currentLayoutId);
            }
          }, remainingMs);
          this.log.info(`All video durations resolved — deferred timer started: ${(remainingMs / 1000).toFixed(1)}s remaining (waited ${(elapsed / 1000).toFixed(1)}s for metadata)`);
        }
      } else if (this.layoutTimer) {
        // Reset layout timer with REMAINING time — not full duration.
        clearTimeout(this.layoutTimer);

        const elapsed = Date.now() - (this._layoutTimerStartedAt || Date.now());
        const remainingMs = Math.max(1000, this.currentLayout.duration * 1000 - elapsed);
        this.layoutTimer = setTimeout(() => {
          this.log.info(`Layout ${this.currentLayoutId} duration expired (${this.currentLayout.duration}s)`);
          if (this.currentLayoutId) {
            this.layoutEndEmitted = true;
            this.emit('layoutEnd', this.currentLayoutId);
          }
        }, remainingMs);

        this.log.info(`Layout timer adjusted to ${(remainingMs / 1000).toFixed(1)}s remaining (elapsed ${(elapsed / 1000).toFixed(1)}s of ${this.currentLayout.duration}s)`);
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

  // ── SMIL State Track B ──────────────────────────────────────────────

  /**
   * Inject an XpStateStore for runtime `xpIf=` evaluation. The store
   * backs `<setvalue>` / `<newvalue>` / `<delvalue>` in SMIL State and
   * persists per its configured scope (document/session/display).
   *
   * Wiring is idempotent — calling twice swaps stores and unsubscribes
   * the previous change listener. Pass `null` to disable runtime
   * evaluation (widgets with `xpIf=` then show unconditionally, matching
   * pre-Track-B behaviour).
   *
   * @param {object|null} store - instance of @xiboplayer/expr.XpStateStore
   *   (or any duck-typed object exposing `get/has/on('change', …)`)
   */
  setStateStore(store) {
    if (this._stateUnsubscribe) {
      try { this._stateUnsubscribe(); } catch (_err) { /* best effort */ }
      this._stateUnsubscribe = null;
    }
    this._stateStore = store || null;
    if (this._stateStore && typeof this._stateStore.on === 'function') {
      // Re-evaluate xp:if on every state change. The handler is
      // deliberately broad — the renderer walks its current widgets
      // and toggles visibility. More fine-grained subscriptions
      // (change:<key>) can land in a future pass.
      this._stateUnsubscribe = this._stateStore.on('change', () => {
        this.reevaluateXpIf();
      });
    }
  }

  /**
   * Current state store, or null if none injected.
   * @returns {object|null}
   */
  getStateStore() {
    return this._stateStore;
  }

  /**
   * Evaluate a widget's `xpIf=` attribute against the current store.
   * Returns true when the widget should be shown. Absent xpIf is
   * treated as true (no runtime gating). An evaluation error
   * (ExprOutOfScope) hides the widget — the safe default prevents
   * broken expressions from leaking content that was meant to be
   * conditionally suppressed.
   *
   * @param {object} widget - parsed widget (must carry `.xpIf`)
   * @returns {boolean}
   */
  _evaluateXpIf(widget) {
    if (!widget || !widget.xpIf) return true;
    if (!this._stateStore) return true;  // no store → no runtime gating
    try {
      const v = evalExpr(widget.xpIf, this._stateStore);
      return asBool(v);
    } catch (err) {
      if (err instanceof ExprOutOfScope) {
        this.log.warn(`xpIf evaluation failed (widget ${widget.id}): ${err.message} — hiding widget`);
      } else {
        this.log.error(`xpIf unexpected error (widget ${widget.id}):`, err);
      }
      return false;
    }
  }

  /**
   * Re-evaluate every live widget's xpIf against the current store and
   * toggle DOM visibility. Called automatically on store `change`
   * events; host code can also trigger it manually after batch updates.
   */
  reevaluateXpIf() {
    if (!this._stateStore) return;
    for (const region of this.regions.values()) {
      if (!region || !region.widgets) continue;
      for (const widget of region.widgets) {
        if (!widget.xpIf) continue;
        const el = region.widgetElements?.get(widget.id);
        if (!el) continue;
        const visible = this._evaluateXpIf(widget);
        // Use a data-attribute so tests + downstream code can observe
        // without parsing CSS. The inline style toggle is what actually
        // hides the widget; transitions are intentionally skipped for
        // re-evaluations (no animation spam on state churn).
        el.dataset.xpIf = visible ? 'true' : 'false';
        if (visible) {
          // Only un-hide the currently-active widget; do not resurrect
          // background widgets hidden by region cycling. We detect the
          // active widget by presence of `visibility: visible`.
          if (el.style.visibility !== 'hidden' || el.dataset.xpIfActive === '1') {
            el.style.visibility = 'visible';
            el.style.opacity = '1';
          }
        } else {
          el.style.visibility = 'hidden';
          el.style.opacity = '0';
        }
      }
    }
    this.emit('xpIfReevaluated');
  }

  /**
   * Materialise an XpStateStore from an xp-state-init widget (plan 242).
   *
   * xp-state-init widgets on a layout are metadata-only — they declare
   * the initial state, scope, language, and default datasource that
   * downstream xpIf / AVT / datasource bindings evaluate against. This
   * method:
   *
   *   1. Decodes the `xpStateInit` widget option via parseXpStateInit
   *      (handles zstd+b64 / gzip+b64 / plain JSON carriers).
   *   2. Seeds `lang` from the `xpLanguage` option when present (so
   *      `smil-language()` resolves correctly on the first render).
   *   3. Constructs an XpStateStore with the declared scope.
   *   4. Injects it via setStateStore() (which unsubscribes any prior
   *      store and re-subscribes change listeners).
   *
   * If the layout has no xp-state-init widget or decoding fails, we
   * leave any previously-injected store in place — a host application
   * may have injected a store earlier and we must not clobber it.
   *
   * @param {object} layout - parsed layout (from parseXlf)
   * @returns {XpStateStore|null} the store that was injected, or null
   *   if no xp-state-init was present / decoding failed
   */
  _applyXpStateInit(layout) {
    if (!layout || !layout.xpStateInit) return null;

    const init = layout.xpStateInit;
    if (!init.rawValue) {
      this.log.warn(
        `xp-state-init widget ${init.widgetId} has empty xpStateInit option — skipping`
      );
      return null;
    }

    let initialState;
    try {
      initialState = parseXpStateInit(init.rawValue);
    } catch (err) {
      this.log.error(
        `xp-state-init widget ${init.widgetId} decode failed: ${err.message} — keeping existing store`
      );
      return null;
    }

    // Language seed — xp:language ends up in the store under the
    // `lang` key so evalExpr's `smil-language()` built-in resolves
    // without a separate plumbing channel.
    if (init.language && typeof initialState === 'object' && !('lang' in initialState)) {
      initialState.lang = init.language;
    }

    const scope = init.scope || 'session';
    let store;
    try {
      store = new XpStateStore({ scope, initialState });
    } catch (err) {
      this.log.error(
        `xp-state-init widget ${init.widgetId}: XpStateStore construction failed: ${err.message}`
      );
      return null;
    }

    this.setStateStore(store);
    this.log.info(
      `xp-state-init applied: widget=${init.widgetId} scope=${scope} keys=${Object.keys(initialState).length}`
    );
    return store;
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

  // ── Interactive Control (XIC) ─────────────────────────────────────

  /**
   * Find a region containing a widget by widget ID.
   * Searches main regions first, then overlay regions.
   * @param {string} widgetId
   * @returns {{ regionId: string, region: Object, widget: Object, widgetIndex: number, regionMap: Map }|null}
   */
  _findRegionByWidgetId(widgetId) {
    // Search main regions
    for (const [regionId, region] of this.regions) {
      const widgetIndex = region.widgets.findIndex(w => w.id === widgetId);
      if (widgetIndex !== -1) {
        return { regionId, region, widget: region.widgets[widgetIndex], widgetIndex, regionMap: this.regions };
      }
    }
    // Search overlay regions
    for (const overlay of this.activeOverlays.values()) {
      if (!overlay.regions) continue;
      for (const [regionId, region] of overlay.regions) {
        const widgetIndex = region.widgets.findIndex(w => w.id === widgetId);
        if (widgetIndex !== -1) {
          return { regionId, region, widget: region.widgets[widgetIndex], widgetIndex, regionMap: overlay.regions };
        }
      }
    }
    return null;
  }

  /**
   * Advance a region to its next widget using the standard cycle.
   * @param {string} regionId
   * @param {Map} regionMap - The Map containing this region (main or overlay)
   */
  _advanceRegion(regionId, regionMap) {
    const region = regionMap.get(regionId);
    if (!region) return;
    region.currentIndex = (region.currentIndex + 1) % region.widgets.length;
    const isMain = regionMap === this.regions;
    this._startRegionCycle(
      region, regionId,
      isMain ? this._renderWidgetBound : this._renderWidgetBound,
      isMain ? this._stopWidgetBound : this._stopWidgetBound,
      isMain ? () => this.checkLayoutComplete() : undefined
    );
  }

  /**
   * Handle interactiveTrigger XIC event — navigate to a target widget.
   * @param {{ targetId: string, triggerCode: string }} data
   */
  _handleInteractiveTrigger({ targetId, triggerCode }) {
    this.log.info(`XIC interactiveTrigger: target=${targetId} code=${triggerCode}`);
    const found = this._findRegionByWidgetId(targetId);
    if (found) {
      this.navigateToWidget(targetId);
    } else {
      this.log.warn(`XIC interactiveTrigger: widget ${targetId} not found`);
    }
  }

  /**
   * Handle widgetExpire XIC event — immediately expire a widget and advance.
   * @param {{ widgetId: string }} data
   */
  _handleWidgetExpire({ widgetId }) {
    const found = this._findRegionByWidgetId(widgetId);
    if (!found) {
      this.log.warn(`XIC widgetExpire: widget ${widgetId} not found`);
      return;
    }
    const { regionId, region, widgetIndex, regionMap } = found;
    this.log.info(`XIC widgetExpire: widget=${widgetId} region=${regionId}`);
    if (region.timer) {
      clearTimeout(region.timer);
      region.timer = null;
    }
    this.stopWidget(regionId, widgetIndex);
    this._advanceRegion(regionId, regionMap);
  }

  /**
   * Handle widgetExtendDuration XIC event — extend the current widget timer.
   * @param {{ widgetId: string, duration: number }} data - duration in seconds (added to remaining)
   */
  _handleWidgetExtendDuration({ widgetId, duration }) {
    const found = this._findRegionByWidgetId(widgetId);
    if (!found) {
      this.log.warn(`XIC widgetExtendDuration: widget ${widgetId} not found`);
      return;
    }
    const { regionId, region } = found;
    this.log.info(`XIC widgetExtendDuration: widget=${widgetId} +${duration}s`);
    if (region.timer) {
      clearTimeout(region.timer);
      region.timer = null;
    }
    // Re-arm timer with the extended duration
    region.timer = setTimeout(() => {
      this.stopWidget(regionId, region.currentIndex);
      this._advanceRegion(regionId, found.regionMap);
    }, duration * 1000);
  }

  /**
   * Handle widgetSetDuration XIC event — replace the widget timer with an absolute duration.
   * @param {{ widgetId: string, duration: number }} data - duration in seconds (absolute)
   */
  _handleWidgetSetDuration({ widgetId, duration }) {
    const found = this._findRegionByWidgetId(widgetId);
    if (!found) {
      this.log.warn(`XIC widgetSetDuration: widget ${widgetId} not found`);
      return;
    }
    const { regionId, region } = found;
    this.log.info(`XIC widgetSetDuration: widget=${widgetId} ${duration}s`);
    if (region.timer) {
      clearTimeout(region.timer);
      region.timer = null;
    }
    // Set timer with the absolute duration
    region.timer = setTimeout(() => {
      this.stopWidget(regionId, region.currentIndex);
      this._advanceRegion(regionId, found.regionMap);
    }, duration * 1000);
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
          } else if (region.isDrawer) {
            // Continue cycling through remaining drawer widgets (will hide on wrap to 0)
            this.navigateToWidget(region.widgets[nextIndex].id);
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

  // ── Layout Helpers ───────────────────────────────────────────────

  /**
   * Get media file URL for storedAs filename.
   * @param {string} storedAs - The storedAs filename (e.g. "42_abc123.jpg")
   * @returns {string} Full URL for the media file
   */
  _mediaFileUrl(storedAs) {
    return `${window.location.origin}${PLAYER_API}/media/file/${storedAs}`;
  }

  /**
   * Position a widget element to fill its region (hidden by default).
   * @param {HTMLElement} element
   */
  _positionWidgetElement(element) {
    Object.assign(element.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      visibility: 'hidden',
      opacity: '0',
    });
  }

  /**
   * Apply a background image with cover styling.
   * @param {HTMLElement} element
   * @param {string} url - Image URL
   */
  _applyBackgroundImage(element, url) {
    Object.assign(element.style, {
      backgroundImage: `url(${url})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    });
  }

  /**
   * Clear all region timers in a region map.
   * @param {Map} regions - Region map (regionId → region)
   */
  _clearRegionTimers(regions) {
    for (const [, region] of regions) {
      if (region.timer) {
        clearTimeout(region.timer);
        region.timer = null;
      }
    }
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

        // Stop all region timers and widgets, then reset to first widget
        this._clearRegionTimers(this.regions);
        this._stopAllRegionWidgets(this.regions, this._stopWidgetBound);
        for (const [, region] of this.regions) {
          region.currentIndex = 0;
          region.complete = false;
        }

        // Clear layout timer
        if (this.layoutTimer) {
          clearTimeout(this.layoutTimer);
          this.layoutTimer = null;
        }

        this.layoutEndEmitted = false;
        this._deferredTimerLayoutId = null;
        if (this._deferredTimerFallback) {
          clearTimeout(this._deferredTimerFallback);
          this._deferredTimerFallback = null;
        }

        // DON'T call stopCurrentLayout() - keep elements alive!
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

      // SMIL State Track B — if the layout carries an xp-state-init
      // widget (metadata-only, skipped from the render queue), decode
      // its payload and materialise an XpStateStore before any widget
      // is shown (so the first xpIf evaluation sees the seeded state).
      this._applyXpStateInit(layout);

      // Calculate scale factor to fit layout into screen
      this.calculateScale(layout);

      // Set container background
      this.container.style.backgroundColor = layout.bgcolor;
      this.container.style.backgroundImage = ''; // Reset previous

      // Apply background image if specified in XLF
      // With storedAs refactor, background may be a filename (e.g. "43.png") or a numeric fileId
      if (layout.background) {
        const saveAs = this.options.fileIdToSaveAs?.get(String(layout.background)) || layout.background;
        this._applyBackgroundImage(this.container, this._mediaFileUrl(saveAs));
        this.log.info(`Background image set: ${layout.background} → ${saveAs}`);
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
            this._positionWidgetElement(element);
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

      // Report calculated duration so the schedule queue/timeline uses it
      // instead of the 60s default. For layouts with unprobed videos, this
      // is an estimate that will be corrected by updateLayoutDuration().
      if (layout.duration > 0) {
        const final_ = !this._hasUnprobedVideos();
        this.emit('layoutDurationUpdated', layoutId, layout.duration, final_);
      }

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
   * Build a region DOM element and state entry.
   * Shared by createRegion, preloadLayout, and renderOverlay.
   *
   * @param {Object} regionConfig - Region configuration from parsed XLF
   * @param {string} elementId - DOM element ID for the region div
   * @param {HTMLElement} parentEl - Parent element to append the region to
   * @param {Object} [extraState] - Additional properties merged into region state
   * @returns {Object} Region state object { element, config, widgets, ... }
   */
  _createRegionEntry(regionConfig, elementId, parentEl, extraState = {}) {
    const { className = 'renderer-lite-region', ...stateProps } = extraState;

    const regionEl = document.createElement('div');
    regionEl.id = elementId;
    regionEl.className = className;
    regionEl.style.position = 'absolute';
    regionEl.style.zIndex = String(regionConfig.zindex);
    regionEl.style.overflow = 'hidden';

    // Apply scaled positioning
    this.applyRegionScale(regionEl, regionConfig);

    parentEl.appendChild(regionEl);

    const sf = this.scaleFactor;
    return {
      element: regionEl,
      config: regionConfig,
      widgets: regionConfig.widgets,
      currentIndex: 0,
      timer: null,
      width: regionConfig.width * sf,
      height: regionConfig.height * sf,
      complete: false,
      widgetElements: new Map(),
      ...stateProps,
    };
  }

  /**
   * Create a region element
   * @param {Object} regionConfig - Region configuration
   */
  async createRegion(regionConfig) {
    const region = this._createRegionEntry(
      regionConfig,
      `region_${regionConfig.id}`,
      this.container,
      {
        isDrawer: regionConfig.isDrawer || false,
        isCanvas: regionConfig.isCanvas || false,
      }
    );

    // Drawer regions start fully hidden — shown only by navWidget actions
    if (regionConfig.isDrawer) {
      region.element.style.display = 'none';
    }

    // Filter expired widgets (fromDt/toDt time-gating within XLF)
    let widgets = regionConfig.widgets.filter(w => this._isWidgetActive(w));

    // For regions with sub-playlist cycle playback, select which widgets play this cycle
    if (widgets.some(w => w.cyclePlayback)) {
      widgets = this._applyCyclePlayback(widgets);
    }
    region.widgets = widgets;

    this.regions.set(regionConfig.id, region);
  }

  /**
   * Start playing a region's widgets
   * @param {string} regionId - Region ID
   */
  startRegion(regionId) {
    const region = this.regions.get(regionId);
    this._startRegionCycle(
      region, regionId,
      this._renderWidgetBound,
      this._stopWidgetBound,
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
    // render="html" forces GetResource iframe regardless of native type,
    // EXCEPT for types we handle natively (PDF: CMS bundle can't work cross-origin)
    if (widget.render === 'html' && widget.type !== 'pdf') {
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
    // Always call play() — for preloaded-then-paused videos, seeked may not
    // fire (currentTime already 0) and readyState may be < 2 (not buffered yet).
    // play() handles both cases: if not ready, it queues; if ready, it plays.
    el.play().catch(() => {});
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
        const onLoad = () => {
          imgEl.removeEventListener('load', onLoad);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          imgEl.removeEventListener('load', onLoad);
          this.log.warn(`Image ready timeout for widget ${widget.id}`);
          resolve();
        }, READY_TIMEOUT);
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

    // Dynamic layouts (useDuration=0 videos): defer timer until video metadata
    // provides real durations. Safety timeout ensures corrupt/missing videos
    // don't freeze the display forever.
    // Skip deferral if updateLayoutDuration() already set the duration from
    // video metadata (e.g. during preload or a previous play of this layout).
    if (layout.isDynamic && !layout._durationFromMetadata && this._hasUnprobedVideos()) {
      this._deferredTimerLayoutId = layoutId;
      this._layoutTimerStartedAt = Date.now();
      this.log.info(`Layout ${layoutId} has unprobed videos — deferring timer until metadata loads`);

      // Safety: if metadata never arrives (corrupt file, codec error), start
      // the timer with the estimated duration after 30s so the display keeps cycling.
      this._deferredTimerFallback = setTimeout(() => {
        this._deferredTimerFallback = null;
        if (this._deferredTimerLayoutId === layoutId && !this.layoutTimer) {
          this.log.warn(`Layout ${layoutId}: metadata timeout after 30s — starting timer with ${layout.duration}s estimate`);
          this._deferredTimerLayoutId = null;
          this._startLayoutTimer(layoutId, layout);
        }
      }, 30000);

      return;
    }

    this._startLayoutTimer(layoutId, layout);
  }

  /**
   * Check if any region's longest-running video widget (useDuration=0) hasn't
   * been probed yet. Used to decide whether to defer the layout timer.
   *
   * Only checks widgets that have had <video> elements created (during preload
   * or show). Widgets that haven't been displayed yet can never be probed —
   * checking them would always force a 30s timeout on layouts with multiple
   * video widgets per region.
   *
   * Returns false if the layout duration has already been updated from video
   * metadata (meaning at least one probe succeeded and updateLayoutDuration
   * computed a real duration), since the timer can start with that value.
   */
  _hasUnprobedVideos() {
    // If any video was probed and updateLayoutDuration ran, the layout duration
    // is already based on real metadata — no need to defer further.
    for (const [, region] of this.regions) {
      for (const widget of region.widgets) {
        if (widget.type === 'video' && widget.useDuration === 0 && widget._probed) return false;
      }
    }
    // No videos probed at all — check if there are any that need probing
    for (const [, region] of this.regions) {
      for (const widget of region.widgets) {
        if (widget.type === 'video' && widget.useDuration === 0) return true;
      }
    }
    return false;
  }

  /**
   * Actually start the layout timer. Called directly or after deferred timer resolves.
   */
  _startLayoutTimer(layoutId, layout) {
    this._deferredTimerLayoutId = null;
    if (this._deferredTimerFallback) {
      clearTimeout(this._deferredTimerFallback);
      this._deferredTimerFallback = null;
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

    // Hide all other widgets in region (skip for canvas — all widgets stay visible)
    // Cancel fill:forwards animations first — they override inline styles
    if (!region.isCanvas) {
      for (const [widgetId, widgetEl] of region.widgetElements) {
        if (widgetId !== widget.id) {
          widgetEl.getAnimations?.().forEach(a => a.cancel());
          widgetEl.style.visibility = 'hidden';
          widgetEl.style.opacity = '0';
          // Clear the active marker on widgets we're hiding — otherwise
          // reevaluateXpIf() might resurrect them on the next state
          // change. Only the widget being shown this cycle is active.
          if (widgetEl.dataset) widgetEl.dataset.xpIfActive = '0';
        }
      }
    }

    // SMIL State Track B — evaluate xp:if before binding the widget to
    // the DOM timeline. When the guard is false the widget stays hidden
    // but the region timer continues (it will advance to the next
    // widget as if the expression had folded to false at build time).
    if (element.dataset) element.dataset.xpIfActive = '1';
    const xpIfVisible = this._evaluateXpIf(widget);
    if (!xpIfVisible) {
      this.updateMediaElement(element, widget);
      element.getAnimations?.().forEach(a => a.cancel());
      element.style.visibility = 'hidden';
      element.style.opacity = '0';
      element.dataset.xpIf = 'false';
      this.emit('xpIfHidden', { widgetId: widget.id, regionId: region.config?.id, expr: widget.xpIf });
      return widget;
    }
    if (element.dataset && widget.xpIf) element.dataset.xpIf = 'true';

    this.updateMediaElement(element, widget);
    element.getAnimations?.().forEach(a => a.cancel());
    element.style.visibility = 'visible';

    if (widget.transitions.in) {
      Transitions.apply(element, widget.transitions.in, true, region.width, region.height);
    } else {
      element.style.opacity = '1';
    }

    // Resume PDF page cycling if this widget was previously paused
    if (element._pdfResume) {
      element._pdfResume();
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

      // Direct URL from storedAs filename
      audio.src = audioNode.uri ? this._mediaFileUrl(audioNode.uri) : '';

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
    if (videoEl) {
      videoEl.pause();

      // Stop MediaStream tracks (webcam/mic) to release the device
      if (videoEl._mediaStream) {
        videoEl._mediaStream.getTracks().forEach(t => t.stop());
        videoEl._mediaStream = null;
        videoEl.srcObject = null;
      }

      // Destroy HLS.js instance to free worker + buffers
      if (videoEl._hlsInstance) {
        videoEl._hlsInstance.destroy();
        videoEl._hlsInstance = null;
      }

      // Release decoded video buffers (GPU dmabufs) — without this, paused
      // videos hold texture memory until the layout is evicted from the pool.
      // removeAttribute('src') + load() forces the browser to drop the decoded
      // frame, releasing GPU dmabufs immediately instead of at pool eviction.
      videoEl.removeAttribute('src');
      videoEl.load();

      // Remove event listeners to prevent accumulation across widget cycles
      if (videoEl._eventCleanup) {
        for (const [event, handler] of videoEl._eventCleanup) {
          videoEl.removeEventListener(event, handler);
        }
        videoEl._eventCleanup = null;
      }
    }

    const audioEl = widgetElement.querySelector('audio');
    if (audioEl && widget.options.loop !== '1') audioEl.pause();

    // Remove audio event listeners
    if (audioEl?._eventCleanup) {
      for (const [event, handler] of audioEl._eventCleanup) {
        audioEl.removeEventListener(event, handler);
      }
      audioEl._eventCleanup = null;
    }

    // Stop audio overlays attached to this widget
    this._stopAudioOverlays(widget.id);

    // Stop PDF page cycling timers
    if (widgetElement._pdfCleanup) {
      widgetElement._pdfCleanup();
    }

    // Stop embedded widget iframes (HLS live streams, webcams, etc.)
    // Setting src=about:blank kills all network activity (HLS segment fetches,
    // WebSocket connections, SSE streams) and releases video decode buffers.
    const iframes = widgetElement.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) {
          doc.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
          doc.querySelectorAll('audio').forEach(a => { a.pause(); a.removeAttribute('src'); a.load(); });
        }
      } catch (_) {}
      iframe.src = 'about:blank';
    }

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
    const oldDuration = widget.duration;

    const durationMatch = html.match(/<!--\s*DURATION=(\d+)\s*-->/);
    if (durationMatch) {
      const newDuration = parseInt(durationMatch[1], 10);
      if (newDuration > 0) {
        this.log.info(`Widget ${widget.id}: DURATION comment overrides duration ${widget.duration}→${newDuration}s`);
        widget.duration = newDuration;
        if (widget.duration !== oldDuration) this.updateLayoutDuration();
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

    if (widget.duration !== oldDuration) this.updateLayoutDuration();
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
        // Round-robin based on cycle index, respecting playCount
        const state = this._subPlaylistCycleIndex.get(groupId) || { widgetIdx: 0, playsDone: 0 };
        selectedWidget = groupWidgets[state.widgetIdx % groupWidgets.length];
        const effectivePlayCount = selectedWidget.playCount || 1;

        state.playsDone++;
        if (state.playsDone >= effectivePlayCount) {
          state.widgetIdx++;
          state.playsDone = 0;
        }
        this._subPlaylistCycleIndex.set(groupId, state);
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

    // Canvas regions: render ALL widgets simultaneously (stacked), no cycling.
    // Duration = max widget duration; region completes when the longest widget expires.
    if (region.isCanvas) {
      this._startCanvasRegion(region, regionId, showFn, onCycleComplete);
      return;
    }

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
      this.log.info(`Region ${regionId} widget ${widget.id} (${widget.type}) playing for ${widget.duration}s (useDuration=${widget.useDuration}, index ${widgetIndex}/${region.widgets.length})`);
      region.timer = setTimeout(() => {
        this._handleWidgetCycleEnd(widget, region, regionId, widgetIndex, showFn, hideFn, onCycleComplete, playNext);
      }, duration);
    };

    playNext();
  }

  /**
   * Start a canvas region — render all widgets simultaneously (stacked).
   * Canvas regions show every widget at once rather than cycling through them.
   * The region duration is the maximum widget duration.
   * @param {Object} region - Region state
   * @param {string} regionId - Region ID
   * @param {Function} showFn - Show widget function (regionId, widgetIndex)
   * @param {Function} onCycleComplete - Callback when region completes
   */
  _startCanvasRegion(region, regionId, showFn, onCycleComplete) {
    // Show all widgets at once
    for (let i = 0; i < region.widgets.length; i++) {
      showFn(regionId, i);
    }

    // Mark region as complete after max widget duration
    const maxDuration = Math.max(...region.widgets.map(w => w.duration)) * 1000;
    if (maxDuration > 0) {
      region.timer = setTimeout(() => {
        if (!region.complete) {
          region.complete = true;
          onCycleComplete?.();
        }
      }, maxDuration);
    } else {
      // No duration — immediately complete
      region.complete = true;
      onCycleComplete?.();
    }
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

    // Non-looping single-widget region (loop=0): don't replay.
    // Multi-widget regions (playlists) always cycle regardless of loop setting —
    // in Xibo, loop=0 only means "don't repeat a single media item."
    if (nextIndex === 0 && region.config?.loop === false && region.widgets.length === 1) {
      showFn(regionId, 0);
      return;
    }

    // Don't start next widget if layout has already ended (race with layout timer)
    if (this.layoutEndEmitted) return;

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
        this._startedWidgets.add(`${regionId}:${widgetIndex}`);
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
    const key = `${regionId}:${widgetIndex}`;
    if (!this._startedWidgets.delete(key)) return; // idempotent: already stopped

    const region = this.regions.get(regionId);
    if (!region) return;

    const { widget, animPromise } = this._hideWidget(region, widgetIndex);
    // Emit widgetEnd immediately — don't wait for exit animation.
    // If we await animPromise first, a pool eviction can remove the DOM element,
    // causing the animation's onfinish to never fire and widgetEnd to be lost.
    if (widget) {
      this.emit('widgetEnd', {
        widgetId: widget.id, regionId, layoutId: this.currentLayoutId,
        mediaId: parseInt(widget.fileId || widget.id) || null,
        type: widget.type,
        enableStat: widget.enableStat
      });
    }
    if (animPromise) await animPromise;
  }

  /**
   * Stop all started widgets across regions (symmetric counterpart to startRegion)
   * Canvas regions start ALL widgets; non-canvas regions have one active widget.
   * @param {Map} regions - Region map
   * @param {Function} stopFn - (regionId, widgetIndex) => void
   */
  _stopAllRegionWidgets(regions, stopFn) {
    for (const [regionId, region] of regions) {
      if (region.isCanvas) {
        for (let i = 0; i < region.widgets.length; i++) {
          stopFn(regionId, i);
        }
      } else if (region.widgets.length > 0) {
        stopFn(regionId, region.currentIndex);
      }
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
    // Scale type mapping (CMS image.xml):
    // center (default) → contain: scale proportionally to fit region, centered
    // stretch → fill: ignore aspect ratio, fill entire region
    // fit → cover: scale proportionally to fill region, crop excess
    const scaleType = widget.options.scaleType;
    const fitMap = { stretch: 'fill', center: 'contain', fit: 'cover' };
    img.style.objectFit = fitMap[scaleType] || 'contain';

    // Alignment: map alignId/valignId to CSS object-position
    // XLF tags are <alignId> and <valignId> (from CMS image.xml property ids)
    const alignMap = { left: 'left', center: 'center', right: 'right' };
    const valignMap = { top: 'top', middle: 'center', bottom: 'bottom' };
    const hPos = alignMap[widget.options.alignId] || 'center';
    const vPos = valignMap[widget.options.valignId] || 'center';
    img.style.objectPosition = `${hPos} ${vPos}`;

    img.style.opacity = '0';

    // Direct URL from storedAs filename — store key = widget reference = serve URL
    const src = widget.options.uri
      ? this._mediaFileUrl(widget.options.uri)
      : '';

    img.src = src;
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

    // Direct URL from storedAs filename
    const storedAs = widget.options.uri || '';
    const fileId = widget.fileId || widget.id;

    // Handle video end - pause on last frame instead of showing black
    // Widget cycling will restart the video via updateMediaElement()
    const onEnded = () => {
      if (widget.options.loop === '1') {
        video.currentTime = 0;
        this.log.info(`Video ${storedAs} ended - reset to start, waiting for widget cycle to replay`);
      } else {
        this.log.info(`Video ${storedAs} ended - paused on last frame`);
      }
    };
    video.addEventListener('ended', onEnded);
    const videoSrc = storedAs ? this._mediaFileUrl(storedAs) : '';

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
            video._hlsInstance = hls; // Store for cleanup on eviction
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal) {
                this.log.error(`HLS fatal error: ${data.type}`, data.details);
                hls.destroy();
                video._hlsInstance = null;
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
    // Capture the layout ID at creation time — during preload, _preloadingLayoutId
    // is the target layout (currentLayoutId is still the playing layout).
    const createdForLayoutId = this._preloadingLayoutId || this.currentLayoutId;
    const onLoadedMetadata = () => {
      const videoDuration = video.duration;
      this.log.info(`Video ${storedAs} duration detected: ${videoDuration}s`);

      if (widget.duration === 0 || widget.useDuration === 0) {
        widget.duration = videoDuration;
        widget._probed = true;
        this.log.info(`Updated widget ${widget.id} duration to ${videoDuration}s (useDuration=0)`);

        if (this.currentLayoutId === createdForLayoutId) {
          this.updateLayoutDuration();
        } else {
          this.log.info(`Video ${storedAs} duration set but layout timer not updated (preloaded for layout ${createdForLayoutId}, current is ${this.currentLayoutId})`);
        }
      }
    };
    video.addEventListener('loadedmetadata', onLoadedMetadata);

    const onLoadedData = () => {
      this.log.info('Video loaded and ready:', storedAs);
    };
    video.addEventListener('loadeddata', onLoadedData);

    const onError = () => {
      const error = video.error;
      const errorCode = error?.code;
      const errorMessage = error?.message || 'Unknown error';
      this.log.warn(`Video error: ${storedAs}, code: ${errorCode}, time: ${video.currentTime.toFixed(1)}s, message: ${errorMessage}`);

      // Set fallback duration so the deferred timer can proceed.
      // Without this, a corrupt video leaves widget.duration=0 forever,
      // _hasUnprobedVideos() stays true, and the deferred timer never unblocks.
      if (widget.useDuration === 0 && widget.duration === 0) {
        widget.duration = 60;
        this.log.info(`Set fallback duration 60s for errored widget ${widget.id}`);
        if (this.currentLayoutId === createdForLayoutId) {
          this.updateLayoutDuration();
        }
      }

      this.emit('videoError', { storedAs, fileId, errorCode, errorMessage, currentTime: video.currentTime });
    };
    video.addEventListener('error', onError);

    const onPlaying = () => {
      this.log.info('Video playing:', storedAs);
    };
    video.addEventListener('playing', onPlaying);

    // Store listener references for cleanup in _hideWidget()
    video._eventCleanup = [
      ['ended', onEnded],
      ['loadedmetadata', onLoadedMetadata],
      ['loadeddata', onLoadedData],
      ['error', onError],
      ['playing', onPlaying],
    ];

    this.log.info('Video element created:', storedAs, video.src);

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

    // Direct URL from storedAs filename
    const storedAs = widget.options.uri || '';
    const fileId = widget.fileId || widget.id;
    audio.src = storedAs ? this._mediaFileUrl(storedAs) : '';

    // Handle audio end - similar to video ended handling
    const onAudioEnded = () => {
      if (widget.options.loop === '1') {
        audio.currentTime = 0;
        this.log.info(`Audio ${storedAs} ended - reset to start, waiting for widget cycle to replay`);
      } else {
        this.log.info(`Audio ${storedAs} ended - playback complete`);
      }
    };
    audio.addEventListener('ended', onAudioEnded);

    // Detect audio duration for dynamic layout timing (when useDuration=0)
    const audioCreatedForLayoutId = this._preloadingLayoutId || this.currentLayoutId;
    const onAudioLoadedMetadata = () => {
      const audioDuration = Math.floor(audio.duration);
      this.log.info(`Audio ${storedAs} duration detected: ${audioDuration}s`);

      if (widget.duration === 0 || widget.useDuration === 0) {
        widget.duration = audioDuration;
        this.log.info(`Updated widget ${widget.id} duration to ${audioDuration}s (useDuration=0)`);

        if (this.currentLayoutId === audioCreatedForLayoutId) {
          this.updateLayoutDuration();
        } else {
          this.log.info(`Audio ${storedAs} duration set but layout timer not updated (preloaded for layout ${audioCreatedForLayoutId}, current is ${this.currentLayoutId})`);
        }
      }
    };
    audio.addEventListener('loadedmetadata', onAudioLoadedMetadata);

    // Handle audio errors
    const onAudioError = () => {
      const error = audio.error;
      this.log.warn(`Audio error (non-fatal): ${storedAs}, code: ${error?.code}, message: ${error?.message || 'Unknown'}`);
    };
    audio.addEventListener('error', onAudioError);

    // Store listener references for cleanup in _hideWidget()
    audio._eventCleanup = [
      ['ended', onAudioEnded],
      ['loadedmetadata', onAudioLoadedMetadata],
      ['error', onAudioError],
    ];

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
    return await this._renderIframeWidget(widget, region);
  }

  /**
   * Render PDF widget — single reusable canvas, page-by-page cycling.
   *
   * Memory strategy:
   * - One canvas is created and reused for all pages (no DOM churn)
   * - Each page is rendered sequentially (avoids concurrent render errors)
   * - page.cleanup() releases PDF.js internal page buffers after each render
   * - pdf.destroy() releases the entire document on widget teardown
   * - Active renderTask is cancelled on cleanup to prevent stale renders
   */
  async renderPdf(widget, region) {
    const container = document.createElement('div');
    container.className = 'renderer-lite-widget pdf-widget';
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.backgroundColor = 'transparent';
    container.style.opacity = '0';
    container.style.position = 'relative';

    // Load PDF.js if available
    if (typeof window.pdfjsLib === 'undefined') {
      try {
        const pdfjsModule = await import('pdfjs-dist');
        window.pdfjsLib = pdfjsModule;
        // Derive worker path from current page location (works for /player/pwa/ and /player/)
        const basePath = window.location.pathname.replace(/\/[^/]*$/, '/');
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${window.location.origin}${basePath}pdf.worker.min.mjs`;
      } catch (error) {
        this.log.error('PDF.js not available:', error);
        container.innerHTML = '<div style="color:white;padding:20px;text-align:center;">PDF viewer unavailable</div>';
        container.style.opacity = '1';
        return container;
      }
    }

    // Direct URL from storedAs filename
    const pdfUrl = widget.options.uri
      ? this._mediaFileUrl(widget.options.uri)
      : '';

    // Render PDF with multi-page cycling
    try {
      const loadingTask = window.pdfjsLib.getDocument(pdfUrl);
      const pdf = await loadingTask.promise;
      const totalPages = pdf.numPages;
      const duration = widget.duration || 60;
      const timePerPage = (duration * 1000) / totalPages;
      this.log.info(`[pdf] PDF loaded: ${totalPages} pages, ${duration}s duration, ${(timePerPage / 1000).toFixed(1)}s/page`);

      // Measure page size from first page to set up the single reusable canvas
      const page1 = await pdf.getPage(1);
      const viewport0 = page1.getViewport({ scale: 1 });
      const scale = Math.min(region.width / viewport0.width, region.height / viewport0.height);
      page1.cleanup();

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page';
      canvas.width = Math.floor(viewport0.width * scale);
      canvas.height = Math.floor(viewport0.height * scale);
      canvas.style.cssText = 'display:block;margin:auto;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);';
      const ctx = canvas.getContext('2d');
      container.appendChild(canvas);

      // Page indicator (bottom-right, v1-style pill) — debug only
      const indicator = document.createElement('div');
      indicator.style.cssText = 'position:absolute;bottom:10px;right:10px;background:rgba(0,0,0,0.7);color:white;padding:8px 12px;border-radius:4px;font:14px system-ui;z-index:1;';
      if (!isDebug()) indicator.style.display = 'none';
      container.appendChild(indicator);

      let currentPage = 1;
      let cycleTimer = null;
      let activeRenderTask = null;
      let stopped = false;

      // Render one page at a time on the single canvas. Sequential scheduling
      // (setTimeout after render completes) avoids the "Cannot use the same
      // canvas during multiple render() operations" error from PDF.js.
      const cyclePage = async () => {
        if (stopped) return;
        indicator.textContent = `Page ${currentPage} / ${totalPages}`;

        const page = await pdf.getPage(currentPage);
        const scaledViewport = page.getViewport({ scale });

        // Clear and render on the reusable canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        activeRenderTask = page.render({ canvasContext: ctx, viewport: scaledViewport });
        try {
          await activeRenderTask.promise;
        } catch (e) {
          // RenderingCancelledException is expected when stopped during render
          if (stopped) return;
          throw e;
        }
        activeRenderTask = null;
        page.cleanup(); // Release PDF.js internal page buffers

        // Schedule next page (only after current render completes)
        if (totalPages > 1 && !stopped) {
          cycleTimer = setTimeout(() => {
            currentPage = currentPage >= totalPages ? 1 : currentPage + 1;
            cyclePage();
          }, timePerPage);
        }
      };

      await cyclePage();

      // Pause: stop page cycling (called by _hideWidget during region cycling / replay)
      // Returns a promise that resolves when the active render is fully cancelled.
      let cancelPromise = null;
      container._pdfCleanup = () => {
        stopped = true;
        if (cycleTimer) clearTimeout(cycleTimer);
        cycleTimer = null;
        if (activeRenderTask) {
          const task = activeRenderTask;
          activeRenderTask = null;
          task.cancel();
          cancelPromise = task.promise.catch(() => {}); // wait for cancellation to propagate
        }
      };

      // Resume: restart page cycling from page 1 (called by _showWidget on reuse)
      // Always cleanup first — the PDF may still be rendering from preload
      // (pre-create starts cyclePage immediately, but the widget isn't "shown"
      // until the layout swap, so _pdfCleanup was never called).
      container._pdfResume = async () => {
        container._pdfCleanup(); // stop any in-flight render
        if (cancelPromise) { await cancelPromise; cancelPromise = null; }
        stopped = false;
        currentPage = 1;
        cyclePage();
      };

      // Destroy: release GPU + PDF resources (called on element removal / eviction)
      container._pdfDestroy = () => {
        container._pdfCleanup();
        canvas.width = 0;
        canvas.height = 0;
        pdf.destroy();
      };

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
    // CMS may percent-encode the URI in XLF (e.g. https%3A%2F%2F → https://)
    const uri = decodeURIComponent(widget.options.uri || '');
    iframe.src = uri;

    return iframe;
  }

  /**
   * Render generic widget (clock, calendar, weather, etc.)
   */
  async renderGenericWidget(widget, region) {
    return await this._renderIframeWidget(widget, region);
  }

  /**
   * Shared iframe rendering for text/ticker and generic widgets.
   * Creates an iframe, resolves widget HTML via getWidgetHtml (cache URL or blob),
   * and parses NUMITEMS/DURATION comments for dynamic widget duration.
   */
  async _renderIframeWidget(widget, region) {
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
  hasPreloadedLayout(layoutId) {
    return this.layoutPool.has(layoutId);
  }

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

    // If already in-flight, wait for it instead of skipping (prevents the race
    // where showLayout is called before the background preload finishes adding
    // the layout to the pool).
    if (this._preloadingLayoutId === layoutId && this._preloadingPromise) {
      this.log.info(`Layout ${layoutId} preload in-flight, waiting for it...`);
      return this._preloadingPromise;
    }

    // Store the preload promise so concurrent callers can await it
    this._preloadingPromise = this._doPreloadLayout(xlfXml, layoutId);
    return this._preloadingPromise;
  }

  async _doPreloadLayout(xlfXml, layoutId) {
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
      // With storedAs refactor, background may be a filename or a numeric fileId
      if (layout.background) {
        const saveAs = this.options.fileIdToSaveAs?.get(String(layout.background)) || layout.background;
        this._applyBackgroundImage(wrapper, this._mediaFileUrl(saveAs));
      }

      const savedCurrentLayoutId = this.currentLayoutId;

      // Create regions in the hidden wrapper
      const preloadRegions = new Map();
      for (const regionConfig of layout.regions) {
        const region = this._createRegionEntry(
          regionConfig,
          `preload_region_${layoutId}_${regionConfig.id}`,
          wrapper
        );
        preloadRegions.set(regionConfig.id, region);
      }

      // Track blob URLs for the preloaded layout separately
      const preloadBlobUrls = new Set();
      const savedLayoutBlobUrls = this.layoutBlobUrls;
      this.layoutBlobUrls = new Map();
      this.layoutBlobUrls.set(layoutId, preloadBlobUrls);

      // Set _preloadingLayoutId so trackBlobUrl routes to the correct layout
      // without corrupting currentLayoutId (which other code reads during awaits)
      this._preloadingLayoutId = layoutId;

      // Pre-create all widget elements
      for (const [regionId, region] of preloadRegions) {
        for (let i = 0; i < region.widgets.length; i++) {
          const widget = region.widgets[i];
          widget.layoutId = layoutId;
          widget.regionId = regionId;

          try {
            const element = await this.createWidgetElement(widget, region);
            this._positionWidgetElement(element);
            region.element.appendChild(element);
            region.widgetElements.set(widget.id, element);
          } catch (error) {
            this.log.error(`Preload: Failed to create widget ${widget.id}:`, error);
          }
        }
      }

      // Restore state
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
      });

      this.log.info(`Layout ${layoutId} preloaded into pool (${preloadRegions.size} regions)`);
      return true;

    } catch (error) {
      this.log.error(`Preload failed for layout ${layoutId}:`, error);
      return false;
    } finally {
      if (this._preloadingLayoutId === layoutId) {
        this._preloadingLayoutId = null;
        this._preloadingPromise = null;
      }
    }
  }

  /**
   * Swap to a preloaded layout from the pool.
   *
   * Dispatches on the resolved layout transition spec:
   * - `instant` (default)   → hard cut via _swapToPreloadedLayoutInstant
   * - `fade|slide|wipe|...` → cross-fade overlap via
   *   _swapToPreloadedLayoutWithTransition
   *
   * Per-layout overrides (from the XLF `layoutTransitionIn` attribute)
   * beat the renderer's configured default. See #337.
   *
   * @param {number} layoutId - Layout ID to swap to
   */
  async _swapToPreloadedLayout(layoutId) {
    const preloaded = this.layoutPool.get(layoutId);
    if (!preloaded) {
      this.log.error(`Cannot swap: layout ${layoutId} not in pool`);
      return;
    }

    const spec = this._resolveLayoutTransition(preloaded.layout);

    if (spec.type === 'instant') {
      return this._swapToPreloadedLayoutInstant(layoutId, preloaded);
    }
    return this._swapToPreloadedLayoutWithTransition(layoutId, preloaded, spec);
  }

  /**
   * Instant swap path — the pre-#337 fast swap that hard-cuts from
   * old to new with zero animation overhead. This is the default and
   * covers the common "no transition configured" case.
   *
   * Kept as a dedicated method (rather than a branch) so the
   * transition path can extract shared helpers without destabilising
   * the fast path's behaviour.
   *
   * @param {number} layoutId
   * @param {Object} preloaded - pool entry from layoutPool.get(layoutId)
   */
  async _swapToPreloadedLayoutInstant(layoutId, preloaded) {
    // ── Tear down old layout ──
    this.removeActionListeners();
    this._clearLayoutTimers();

    const oldLayoutId = this.currentLayoutId;
    const alreadyEmittedEnd = this.layoutEndEmitted;

    this.layoutEndEmitted = false;
    // Keep currentLayout/currentLayoutId until widgets are stopped,
    // so widgetEnd events carry the correct layoutId (not null).

    if (oldLayoutId && this.layoutPool.has(oldLayoutId)) {
      // Stop all widgets before evicting (symmetric widgetEnd events)
      this._clearRegionTimers(this.regions);
      this._stopAllRegionWidgets(this.regions, this._stopWidgetBound);
      // Old layout was preloaded — evict from pool (safe: removes its wrapper div)
      this.layoutPool.evict(oldLayoutId);
    } else {
      // Old layout was rendered normally — manual cleanup.
      // Region elements live directly in this.container (not a wrapper),
      // so we must remove them individually.
      this._clearRegionTimers(this.regions);
      this._stopAllRegionWidgets(this.regions, this._stopWidgetBound);
      for (const [, region] of this.regions) {
        // Release video/audio resources before removing from DOM
        LayoutPool.releaseMediaElements(region.element);
        // Apply region exit transition if configured, then remove
        if (region.config?.exitTransition) {
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
    }

    // Now safe to clear old layout state — widgets have been stopped with correct layoutId
    this.currentLayout = null;
    this.currentLayoutId = null;
    this.regions.clear();

    // ── Activate preloaded layout ──
    this._activatePreloadedLayout(layoutId, preloaded, oldLayoutId, alreadyEmittedEnd);

    this.log.info(`Swapped to preloaded layout ${layoutId} (instant transition)`);
    this._logResourceStats(layoutId);
  }

  /**
   * Transition swap path — cross-fade / slide / wipe between layouts
   * using the LayoutPool's overlap architecture (#337).
   *
   * The preloaded wrapper already lives inside `this.container` at
   * zIndex=-1 (hidden). For the transition we:
   *
   *   1. Stop old widgets with the OLD layoutId still set (so their
   *      widgetEnd events carry the correct layoutId).
   *   2. Raise the new wrapper above the old (zIndex=1).
   *   3. Update renderer state to the new layout and start its
   *      widgets — they play over the top of the still-visible old
   *      content during the transition window.
   *   4. Kick off the incoming animation on the new wrapper and,
   *      for fade/slide, a matching outgoing animation on the old
   *      container. `wipe` is reveal-only — the old container
   *      disappears instantly when the incoming wipe completes.
   *   5. On the incoming animation's onfinish, tear down the old
   *      layout the same way the instant path would have done
   *      synchronously.
   *
   * Notes:
   *   - Audio from the old layout keeps playing during the overlap.
   *     Authors who want silent transitions should use `instant` or
   *     mute the last audio widget on the outgoing layout.
   *   - `layoutEnd` for the old layout is emitted up-front (same
   *     point as the instant path, right after currentLayoutId
   *     updates) so stats accounting isn't gated on the animation
   *     clock. The DOM/media cleanup still waits for onfinish.
   *   - Multi-display sync (#337 DoD): no sync-manager changes are
   *     needed. `onLayoutShow` fires on every display at the same
   *     moment via the lead's `showAt` contract, each display
   *     applies its choreography stagger, and the transition spec
   *     comes from the layout XLF (same on every display) so all
   *     displays start and finish the transition in lock-step.
   *
   * @param {number} layoutId
   * @param {Object} preloaded - pool entry from layoutPool.get(layoutId)
   * @param {{type:string,duration:number,direction?:string}} spec
   */
  async _swapToPreloadedLayoutWithTransition(layoutId, preloaded, spec) {
    this.removeActionListeners();
    this._clearLayoutTimers();

    const oldLayoutId = this.currentLayoutId;
    const alreadyEmittedEnd = this.layoutEndEmitted;
    this.layoutEndEmitted = false;

    // Capture old state before we mutate `this.regions` so the
    // deferred teardown in onfinish can still reach it.
    const oldRegions = this.regions;
    const oldIsPooled =
      oldLayoutId !== null && this.layoutPool.has(oldLayoutId);
    const oldContainer = oldIsPooled
      ? this.layoutPool.get(oldLayoutId).container
      : null;

    // Phase 1 — stop old widgets while currentLayoutId still points
    // at the old layout (widgetEnd events fire with the correct id).
    this._clearRegionTimers(oldRegions);
    this._stopAllRegionWidgets(oldRegions, this._stopWidgetBound);

    // Clear old state AFTER widgets have emitted. The DOM is still
    // alive and will be removed by _teardownOldLayoutAfterTransition
    // once the animation finishes.
    this.currentLayout = null;
    this.currentLayoutId = null;
    this.regions = new Map();

    // Phase 2 — raise the preloaded wrapper above the old content.
    // The preload path appends wrappers at zIndex=-1 hidden; the
    // instant path sets them to zIndex=0 on activation. For the
    // overlap transition we use zIndex=1 so the new layout visibly
    // paints on top, and restore it to 0 at the end of the animation
    // (matches the steady-state convention of the instant path).
    preloaded.container.style.visibility = 'visible';
    preloaded.container.style.zIndex = '1';
    // Start the incoming layout at the animation's "from" state:
    // opacity 0 for fade, translated off-screen for slide, fully
    // clipped for wipe. The Transitions.apply() call will drive the
    // animation from there.
    if (spec.type === 'fade') {
      preloaded.container.style.opacity = '0';
    }

    // Phase 3 — activate new layout state + start its widgets.
    this._activatePreloadedLayout(layoutId, preloaded, oldLayoutId, alreadyEmittedEnd);

    // Phase 4 — kick off the animations. The incoming animation drives
    // the teardown timing in its onfinish; the outgoing one runs in
    // parallel purely for visual effect.
    const layoutWidth = preloaded.layout.width;
    const layoutHeight = preloaded.layout.height;

    const incoming = Transitions.apply(
      preloaded.container,
      spec,
      true,
      layoutWidth,
      layoutHeight
    );
    let outgoing = null;
    if (oldContainer && (spec.type === 'fade' || spec.type === 'slide')) {
      outgoing = Transitions.apply(
        oldContainer,
        spec,
        false,
        layoutWidth,
        layoutHeight
      );
    }

    const finalizeTeardown = () => {
      // Restore the preloaded wrapper to the same zIndex the instant
      // path leaves it at, so any subsequent swap finds the DOM in a
      // consistent state.
      preloaded.container.style.zIndex = '0';
      preloaded.container.style.opacity = '';

      this._teardownOldLayoutAfterTransition(
        oldLayoutId,
        oldRegions,
        oldIsPooled
      );

      // Cancel any still-running outgoing animation in case the
      // incoming finished first (different durations) — prevents the
      // old container from becoming visible again mid-cleanup.
      if (outgoing) {
        try { outgoing.cancel(); } catch (_) { /* no-op */ }
      }

      this.log.info(
        `Swapped to preloaded layout ${layoutId} (${spec.type} transition, ${spec.duration}ms)`
      );
      this._logResourceStats(layoutId);
    };

    if (incoming) {
      incoming.onfinish = finalizeTeardown;
      // Safety net: if onfinish never fires (browser bug, tab
      // backgrounded, etc.), force cleanup after duration + 50%.
      // This matches the pre-#337 worst case where cleanup was
      // synchronous — we'd rather cut abruptly than leak DOM.
      setTimeout(finalizeTeardown, Math.ceil(spec.duration * 1.5));
    } else {
      // Browser doesn't support the requested transition type —
      // fall back to an instant cleanup so nothing leaks.
      finalizeTeardown();
    }
  }

  /**
   * Shared "activate preloaded layout" block. Extracted from the
   * instant path so both swap paths produce identical state after
   * activation (state updates, event emission, background copy,
   * scale, widget start). See _swapToPreloadedLayoutInstant for the
   * historical inline version — this is a straight cut-and-lift,
   * not a rewrite.
   *
   * Preconditions: the old layout's widgets have been stopped and
   * the old state has been cleared from this.currentLayout / this.regions.
   *
   * @param {number} layoutId
   * @param {Object} preloaded - pool entry
   * @param {number|null} oldLayoutId - id of the layout we're leaving
   * @param {boolean} alreadyEmittedEnd - whether layoutEnd was already emitted for the old layout
   */
  _activatePreloadedLayout(layoutId, preloaded, oldLayoutId, alreadyEmittedEnd) {
    preloaded.container.style.visibility = 'visible';
    // The transition path raises zIndex to 1 during the animation and
    // restores it to 0 in finalizeTeardown — don't clobber that here.
    if (preloaded.container.style.zIndex !== '1') {
      preloaded.container.style.zIndex = '0';
    }

    // Update renderer state to the preloaded layout
    this.layoutPool.setHot(layoutId);
    this.currentLayout = preloaded.layout;
    this.currentLayoutId = layoutId;
    this.regions = preloaded.regions;

    // SMIL State Track B — apply xp-state-init on layout activation
    // (parity with the non-preload path in renderLayout). Preloaded
    // layouts still carry the parsed xpStateInit metadata on
    // preloaded.layout, so we can materialise the store now.
    this._applyXpStateInit(preloaded.layout);

    // Emit layoutEnd for old layout AFTER setting new currentLayoutId —
    // the listener guard in main.ts sees the new layout already playing
    // and skips advance, while stats/tracking still run.
    // Skip if the layout timer already emitted layoutEnd (avoids double stats).
    if (oldLayoutId && !alreadyEmittedEnd) {
      this.emit('layoutEnd', oldLayoutId);
    }

    // Update container background to match preloaded layout
    this.container.style.backgroundColor = preloaded.layout.bgcolor;
    if (preloaded.container.style.backgroundImage) {
      // Copy background styles from preloaded wrapper to main container
      for (const prop of ['backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat']) {
        this.container.style[prop] = preloaded.container.style[prop];
      }
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

    // Schedule next preload (unless updateLayoutDuration already did it)
    if (!this.preloadTimer) {
      this._scheduleNextLayoutPreload(preloaded.layout);
    }
  }

  /**
   * Tear down the old layout after a transition animation finishes.
   *
   * Mirrors the synchronous teardown in _swapToPreloadedLayoutInstant
   * but runs from an animation's onfinish callback (or the safety
   * timeout) so the DOM, videos, and blob URLs live long enough for
   * the visual transition to complete.
   *
   * @param {number|null} oldLayoutId
   * @param {Map} oldRegions - the this.regions captured before swap
   * @param {boolean} oldIsPooled - whether the old layout was in the pool
   */
  _teardownOldLayoutAfterTransition(oldLayoutId, oldRegions, oldIsPooled) {
    if (oldIsPooled && oldLayoutId !== null) {
      // Old layout was preloaded — evict from pool (removes wrapper).
      this.layoutPool.evict(oldLayoutId);
      return;
    }

    // Old layout was rendered normally — manual cleanup.
    for (const [, region] of oldRegions) {
      // Release video/audio resources before removing from DOM
      LayoutPool.releaseMediaElements(region.element);
      // Apply region exit transition if configured, then remove
      if (region.config?.exitTransition) {
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
    if (oldLayoutId) {
      this.revokeBlobUrlsForLayout(oldLayoutId);
    }
  }

  /**
   * Log resource allocation stats for debugging memory/GPU leaks.
   * Called after every layout swap to track DOM node accumulation,
   * video element lifecycle, and pool state.
   */
  _logResourceStats(layoutId) {
    const domNodes = document.querySelectorAll('*').length;
    const videos = document.querySelectorAll('video').length;
    const videosSrc = document.querySelectorAll('video[src]').length;
    const canvases = document.querySelectorAll('canvas').length;
    const iframes = document.querySelectorAll('iframe').length;
    const images = document.querySelectorAll('img').length;
    const poolSize = this.layoutPool ? this.layoutPool.size : 0;
    const regionCount = this.regions ? this.regions.size : 0;
    const widgetElements = [...(this.regions?.values() || [])].reduce(
      (sum, r) => sum + (r.widgetElements?.size || 0), 0
    );
    const jsHeap = performance?.memory ? {
      used: Math.round(performance.memory.usedJSHeapSize / 1048576),
      total: Math.round(performance.memory.totalJSHeapSize / 1048576),
      limit: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
    } : null;

    // Count blob URLs still tracked (potential leak indicator)
    const blobUrls = this._blobUrls ? [...this._blobUrls.values()].reduce((s, set) => s + set.size, 0) : 0;
    const blobLayouts = this._blobUrls ? this._blobUrls.size : 0;

    // Preload wrapper divs in DOM (should be 0-1 in normal operation)
    const preloadWrappers = document.querySelectorAll('.renderer-lite-preload-wrapper').length;

    // Audio overlay elements
    const audioEls = document.querySelectorAll('audio').length;

    const heapStr = jsHeap ? `heap=${jsHeap.used}/${jsHeap.total}MB (limit ${jsHeap.limit}MB)` : 'heap=N/A';
    this.log.info(
      `[Resources] layout=${layoutId} dom=${domNodes} videos=${videos}(src=${videosSrc}) ` +
      `canvas=${canvases} iframe=${iframes} img=${images} audio=${audioEls} ` +
      `pool=${poolSize} preloadWrappers=${preloadWrappers} ` +
      `regions=${regionCount} widgets=${widgetElements} ` +
      `blobs=${blobUrls}(${blobLayouts} layouts) ${heapStr}`
    );
  }

  /**
   * Get the currently showing layout ID.
   * @returns {number|null}
   */
  getCurrentLayoutId() {
    return this.currentLayoutId;
  }

  /**
   * Get the parsed <tags> array for the currently-showing layout.
   *
   * Layout-level tags are flat strings parsed from
   * `<layout><tags><tag>…</tag></tags></layout>`. The sync bridge
   * (roadmap #236) reads these to detect `xp-sync-group:NAME` markers
   * emitted by the xiboplayer-smil-tools translator.
   *
   * @returns {string[]} Tags on the current layout, or `[]` when no
   *   layout is showing or the layout carries no tags.
   */
  getCurrentLayoutTags() {
    if (!this.currentLayout || !Array.isArray(this.currentLayout.tags)) return [];
    // Return a defensive copy so callers can't mutate renderer state.
    return this.currentLayout.tags.slice();
  }

  /**
   * Show a preloaded layout (swap from pool to visible).
   * If no layoutId, shows the most recently preloaded layout.
   * No-ops if the layout is not in the pool.
   * @param {number} [layoutId]
   */
  showLayout(layoutId) {
    if (layoutId === undefined) {
      layoutId = this.layoutPool.getLatest();
      if (layoutId === undefined) {
        this.log.warn('showLayout: no preloaded layout to show');
        return;
      }
    }
    // Same layout already showing — skip swap (self-swap would evict then fail).
    // Same-layout replay is handled by renderLayout's replay path instead.
    if (this.currentLayoutId === layoutId) {
      this.log.info(`showLayout: layout ${layoutId} already showing`);
      return;
    }
    if (!this.layoutPool.has(layoutId)) {
      this.log.warn(`showLayout: layout ${layoutId} not in preload pool`);
      return;
    }
    this._swapToPreloadedLayout(layoutId);
  }

  /**
   * Check if the layout timer is active (running or deferred waiting for metadata).
   * Used to detect stalled layouts that need timer restart.
   * @returns {boolean}
   */
  hasActiveLayoutTimer() {
    return this.layoutTimer !== null || this._deferredTimerLayoutId !== null;
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
   * Clear all layout-level timers (layout duration, preload, preload retry).
   */
  _clearLayoutTimers() {
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
  }

  /**
   * Stop current layout
   */
  stopCurrentLayout() {
    if (!this.currentLayout) return;

    this.log.info(`Stopping layout ${this.currentLayoutId}`);

    const endedLayoutId = this.currentLayoutId;
    const shouldEmit = endedLayoutId && !this.layoutEndEmitted;

    this.layoutEndEmitted = false;
    this._deferredTimerLayoutId = null;
    if (this._deferredTimerFallback) {
      clearTimeout(this._deferredTimerFallback);
      this._deferredTimerFallback = null;
    }
    this.currentLayout = null;
    this.currentLayoutId = null;

    // Clear timers
    this._clearLayoutTimers();

    // Remove interactive action listeners before teardown
    this.removeActionListeners();

    // If layout was preloaded (has its own wrapper div in pool), evict safely.
    // Normally-rendered layouts are NOT in the pool, so we do manual cleanup.
    if (endedLayoutId && this.layoutPool.has(endedLayoutId)) {
      this.layoutPool.evict(endedLayoutId);
    } else {
      // Normally-rendered layout - manual cleanup (regions are in this.container)

      // Revoke all blob URLs for this layout (tracked lifecycle management)
      if (endedLayoutId) {
        this.revokeBlobUrlsForLayout(endedLayoutId);
      }

      // Stop all regions — use helper to stop ALL started widgets (canvas fix)
      this._clearRegionTimers(this.regions);
      this._stopAllRegionWidgets(this.regions, this._stopWidgetBound);
      for (const [, region] of this.regions) {
        // Release video/audio resources before removing from DOM
        LayoutPool.releaseMediaElements(region.element);

        // Apply region exit transition if configured, then remove
        if (region.config?.exitTransition) {
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

    }

    this.regions.clear();

    // Emit LAST — re-entrant renderLayout() sees currentLayout=null,
    // so stopCurrentLayout() returns early. No cascade.
    if (shouldEmit) {
      this.emit('layoutEnd', endedLayoutId);
    }
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

      // Calculate scale for overlay layout
      this.calculateScale(layout);

      // Create regions for overlay
      const overlayRegions = new Map();
      for (const regionConfig of layout.regions) {
        const region = this._createRegionEntry(
          regionConfig,
          `overlay_${layoutId}_region_${regionConfig.id}`,
          overlayDiv,
          {
            className: 'renderer-lite-region overlay-region',
            isCanvas: regionConfig.isCanvas || false,
          }
        );
        overlayRegions.set(regionConfig.id, region);
      }

      // Pre-create widget elements for overlay
      for (const [regionId, region] of overlayRegions) {
        for (const widget of region.widgets) {
          widget.layoutId = layoutId;
          widget.regionId = regionId;

          try {
            const element = await this.createWidgetElement(widget, region);
            this._positionWidgetElement(element);
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
        this._startedWidgets.add(`overlay:${overlayId}:${regionId}:${widgetIndex}`);
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
    const key = `overlay:${overlayId}:${regionId}:${widgetIndex}`;
    if (!this._startedWidgets.delete(key)) return; // idempotent

    const overlayState = this.activeOverlays.get(overlayId);
    if (!overlayState) return;

    const region = overlayState.regions.get(regionId);
    if (!region) return;

    const { widget, animPromise } = this._hideWidget(region, widgetIndex);
    // Emit immediately — don't wait for exit animation (same fix as stopWidget)
    if (widget) {
      this.emit('overlayWidgetEnd', {
        overlayId, widgetId: widget.id, regionId, type: widget.type
      });
    }
    if (animPromise) await animPromise;
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
    for (const [, region] of overlayState.regions) {
      if (region.timer) { clearTimeout(region.timer); region.timer = null; }
    }
    this._stopAllRegionWidgets(overlayState.regions,
      (rid, idx) => this.stopOverlayWidget(layoutId, rid, idx));

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
   * Pause playback: pause all media, stop widget cycling.
   * The layout timer keeps running — schedule is authoritative.
   */
  pause() {
    if (this._paused) return;
    this._paused = true;

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
    this.log.info('Playback paused (layout timer continues)');
  }

  /**
   * Check if playback is currently paused.
   */
  isPaused() {
    return this._paused;
  }

  /**
   * Resume playback: resume media and widget cycling.
   * Layout timer was never paused — no need to restore it.
   */
  resume() {
    if (!this._paused) return;
    this._paused = false;

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
    this._startedWidgets.clear();

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

    // Release xp:state subscription so the store can be garbage-collected
    // independently of the renderer (Track B wiring; the store is owned
    // by the host app, the renderer only listens).
    if (this._stateUnsubscribe) {
      try { this._stateUnsubscribe(); } catch (_err) { /* best effort */ }
      this._stateUnsubscribe = null;
    }
    this._stateStore = null;

    this.container.innerHTML = '';
    this.log.info('Cleaned up');
  }
}
