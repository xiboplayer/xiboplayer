/**
 * Schedule manager - determines which layouts to show
 */

import { createLogger } from '@xiboplayer/utils';
import { evaluateCriteria } from './criteria.js';

const log = createLogger('Schedule');

export class ScheduleManager {
  constructor(options = {}) {
    this.schedule = null;
    this.playHistory = new Map(); // Track plays per layout: layoutId -> [timestamps]
    this.interruptScheduler = options.interruptScheduler || null; // Optional interrupt scheduler
    this.displayProperties = options.displayProperties || {}; // CMS display custom properties
    this.weatherData = {}; // Weather data from GetWeather XMDS call
    this.playerLocation = null; // { latitude, longitude } from Geolocation API
    this._layoutMetadata = new Map(); // layoutFile → { syncEvent, shareOfVoice, ... }
  }

  /**
   * Update schedule from XMDS
   */
  setSchedule(schedule) {
    this.schedule = schedule;
  }

  /**
   * Update weather data for criteria evaluation
   * @param {Object} data - Parsed weather object { temperature, humidity, windSpeed, condition, cloudCover }
   */
  setWeatherData(data) {
    this.weatherData = data || {};
  }

  /**
   * Get data connectors from current schedule
   * @returns {Array} Data connector configurations, or empty array
   */
  getDataConnectors() {
    return this.schedule?.dataConnectors || [];
  }

  /**
   * Check if a schedule item is active based on recurrence rules.
   * Supports Week, Day, and Month recurrence types.
   */
  isRecurringScheduleActive(item, now) {
    // If no recurrence, it's not a recurring schedule
    if (!item.recurrenceType) {
      return true; // Not a recurring schedule, use date/time checks instead
    }

    // Check recurrence range first (applies to all types)
    if (item.recurrenceRange) {
      const rangeEnd = new Date(item.recurrenceRange);
      if (now > rangeEnd) {
        return false; // Recurrence has ended
      }
    }

    switch (item.recurrenceType) {
      case 'Week': {
        // Check if current day of week matches recurrenceRepeatsOn
        // recurrenceRepeatsOn format: "1,2,3,4,5" (1=Monday, 7=Sunday, ISO format)
        if (item.recurrenceRepeatsOn) {
          const currentDayOfWeek = this.getIsoDayOfWeek(now);
          const allowedDays = item.recurrenceRepeatsOn.split(',').map(d => parseInt(d.trim()));
          if (!allowedDays.includes(currentDayOfWeek)) {
            return false;
          }
        }
        return true;
      }

      case 'Day': {
        // Daily recurrence with optional interval (recurrenceDetail)
        // If recurrenceDetail > 1, only active every N days from fromdt
        const interval = item.recurrenceDetail || 1;
        if (interval > 1 && item.fromdt) {
          const startDate = new Date(item.fromdt);
          const diffMs = now.getTime() - startDate.getTime();
          const diffDays = Math.floor(diffMs / 86400000);
          if (diffDays < 0 || diffDays % interval !== 0) {
            return false;
          }
        }
        return true;
      }

      case 'Month': {
        // Monthly recurrence — recurrenceRepeatsOn is day-of-month (1-31)
        if (item.recurrenceRepeatsOn) {
          const allowedDays = item.recurrenceRepeatsOn.split(',').map(d => parseInt(d.trim()));
          const currentDayOfMonth = now.getDate();
          if (!allowedDays.includes(currentDayOfMonth)) {
            return false;
          }
        }
        // If recurrenceDetail > 1, only active every N months from fromdt
        const interval = item.recurrenceDetail || 1;
        if (interval > 1 && item.fromdt) {
          const startDate = new Date(item.fromdt);
          const monthsDiff = (now.getFullYear() - startDate.getFullYear()) * 12
            + now.getMonth() - startDate.getMonth();
          if (monthsDiff < 0 || monthsDiff % interval !== 0) {
            return false;
          }
        }
        return true;
      }

      default:
        log.debug(`Unsupported recurrence type: ${item.recurrenceType}`);
        return true; // Unknown type, fallback to date/time checks
    }
  }

  /**
   * Get ISO day of week (1=Monday, 7=Sunday)
   */
  getIsoDayOfWeek(date) {
    const day = date.getDay(); // 0=Sunday, 6=Saturday
    return day === 0 ? 7 : day; // Convert to ISO (1=Monday, 7=Sunday)
  }

  /**
   * Check if current time is within the schedule's time window
   * Handles both date ranges and time-of-day for dayparting
   */
  isTimeActive(item, now) {
    const from = item.fromdt ? new Date(item.fromdt) : null;
    const to = item.todt ? new Date(item.todt) : null;

    // For recurring schedules, check time-of-day instead of full datetime
    if (item.recurrenceType === 'Week' || item.recurrenceType === 'Day' || item.recurrenceType === 'Month') {
      // Extract time from fromdt/todt and compare with current time
      if (from && to) {
        const currentTime = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        const fromTime = from.getHours() * 3600 + from.getMinutes() * 60 + from.getSeconds();
        const toTime = to.getHours() * 3600 + to.getMinutes() * 60 + to.getSeconds();

        // Handle midnight crossing
        if (fromTime <= toTime) {
          // Normal case: 09:00 - 17:00
          return currentTime >= fromTime && currentTime <= toTime;
        } else {
          // Midnight crossing: 22:00 - 02:00
          return currentTime >= fromTime || currentTime <= toTime;
        }
      }
      return true;
    }

    // For non-recurring schedules, use full date/time comparison
    if (from && now < from) return false;
    if (to && now > to) return false;
    return true;
  }

  /**
   * Get current layouts to display
   * Returns array of layout files, prioritized
   *
   * Campaign behavior:
   * - Priority applies at campaign level, not individual layout level
   * - All layouts in a campaign share the campaign's priority
   * - Layouts within a campaign are returned in order for cycling
   * - Standalone layouts compete with campaigns at their own priority
   *
   * Dayparting behavior:
   * - Schedules can recur weekly on specific days (recurrenceType='Week')
   * - recurrenceRepeatsOn specifies days: "1,2,3,4,5" (Mon-Fri, ISO format)
   * - Time matching uses time-of-day for recurring schedules
   * - Non-recurring schedules use full date/time ranges
   *
   * Interrupt behavior (shareOfVoice):
   * - Layouts with shareOfVoice > 0 are interrupts
   * - They must play for a percentage of each hour
   * - Normal layouts fill remaining time
   * - Interrupts are interleaved with normal layouts
   */
  getCurrentLayouts() {
    return this._getLayoutsAt(new Date());
  }

  /**
   * Get layouts active at a specific time.
   * Skips rate limiting and interrupt processing (those depend on real-time state).
   * Used by timeline calculator to predict future playback.
   * @param {Date} time - The time to evaluate
   * @returns {string[]} Layout files active at that time
   */
  getLayoutsAtTime(time) {
    return this._getLayoutsAt(time, { skipRateLimiting: true, skipInterrupts: true, quiet: true });
  }

  /**
   * Get ALL time-active layouts with metadata, without priority or rate-limit filtering.
   * Used by calculateTimeline() to simulate real playback with rate limiting and
   * priority fallback (e.g., when high-priority layouts hit maxPlaysPerHour, lower
   * priority layouts fill the gap).
   *
   * @param {Date} time - The time to evaluate
   * @returns {Array<{file: string, priority: number, maxPlaysPerHour: number}>}
   */
  getAllLayoutsAtTime(time) {
    if (!this.schedule) return [];

    const now = time;
    const results = [];

    // Standalone layouts
    if (this.schedule.layouts) {
      for (const layout of this.schedule.layouts) {
        if (!this.isRecurringScheduleActive(layout, now)) continue;
        if (!this.isTimeActive(layout, now)) continue;
        if (layout.criteria && layout.criteria.length > 0) {
          if (!evaluateCriteria(layout.criteria, { now, displayProperties: this.displayProperties, weatherData: this.weatherData })) continue;
        }
        if (layout.isGeoAware && layout.geoLocation) {
          if (!this.isWithinGeoFence(layout.geoLocation)) continue;
        }
        results.push({
          file: layout.file,
          priority: layout.priority || 0,
          maxPlaysPerHour: layout.maxPlaysPerHour || 0,
        });
      }
    }

    // Campaign layouts
    if (this.schedule.campaigns) {
      for (const campaign of this.schedule.campaigns) {
        if (!this.isRecurringScheduleActive(campaign, now)) continue;
        if (!this.isTimeActive(campaign, now)) continue;
        for (const layout of campaign.layouts) {
          results.push({
            file: layout.file,
            priority: campaign.priority || 0,
            maxPlaysPerHour: layout.maxPlaysPerHour || 0,
          });
        }
      }
    }

    return results;
  }

  /**
   * Detect schedule conflicts: time windows where multiple layouts compete
   * and lower-priority ones are hidden.
   *
   * Scans the schedule in 1-minute increments over the given window.
   * At each point, collects all time-active layouts (after criteria/geofence
   * filtering but before priority filtering). If multiple priorities exist,
   * the lower-priority entries are reported as hidden.
   *
   * @param {Object} [options]
   * @param {Date}   [options.from]  - Start time (default: now)
   * @param {number} [options.hours] - Hours to scan (default: 24)
   * @returns {Array<{startTime: Date, endTime: Date, winner: {file: string, priority: number}, hidden: Array<{file: string, priority: number}>}>}
   */
  detectConflicts(options = {}) {
    const from = options.from || new Date();
    const hours = options.hours || 24;
    const to = new Date(from.getTime() + hours * 3600000);
    const stepMs = 60000; // 1-minute granularity
    const conflicts = [];
    let current = null; // Current conflict window being built

    for (let t = from.getTime(); t < to.getTime(); t += stepMs) {
      const time = new Date(t);
      const allLayouts = this.getAllLayoutsAtTime(time);

      if (allLayouts.length === 0) {
        // No layouts → close any open conflict
        if (current) { conflicts.push(current); current = null; }
        continue;
      }

      const maxPriority = Math.max(...allLayouts.map(l => l.priority));
      const hidden = allLayouts.filter(l => l.priority < maxPriority);

      if (hidden.length === 0) {
        // No conflict at this time
        if (current) { conflicts.push(current); current = null; }
        continue;
      }

      // Conflict exists — build or extend window
      const winners = allLayouts.filter(l => l.priority === maxPriority);
      const winnerKey = winners.map(w => w.file).sort().join(',');
      const hiddenKey = hidden.map(h => `${h.file}:${h.priority}`).sort().join(',');

      if (current && current._winnerKey === winnerKey && current._hiddenKey === hiddenKey) {
        // Same conflict continues — extend window
        current.endTime = new Date(t + stepMs);
      } else {
        // New or changed conflict
        if (current) conflicts.push(current);
        current = {
          startTime: new Date(t),
          endTime: new Date(t + stepMs),
          winner: { file: winners[0].file, priority: maxPriority },
          hidden: hidden.map(h => ({ file: h.file, priority: h.priority })),
          _winnerKey: winnerKey,
          _hiddenKey: hiddenKey,
        };
      }
    }

    if (current) conflicts.push(current);

    // Clean internal keys
    for (const c of conflicts) {
      delete c._winnerKey;
      delete c._hiddenKey;
    }

    return conflicts;
  }

  /**
   * Internal: evaluate schedule at a given time.
   * @param {Date} now - Time to evaluate
   * @param {Object} [options] - Options
   * @param {boolean} [options.skipRateLimiting] - Skip maxPlaysPerHour checks
   * @param {boolean} [options.skipInterrupts] - Skip interrupt/shareOfVoice processing
   */
  _getLayoutsAt(now, options = {}) {
    if (!this.schedule) {
      return [];
    }

    const { skipRateLimiting = false, skipInterrupts = false, quiet = false } = options;
    const _log = quiet ? () => {} : (...args) => log.info(...args);
    const activeItems = []; // Mix of campaign objects and standalone layouts

    // Track the highest priority of any time-active layout BEFORE rate-limit
    // filtering.  Used by advanceToNextLayout() to detect when only lower-
    // priority layouts remain (all high-priority ones are rate-limited) and
    // replay the current layout instead of downgrading.
    this._maxActivePriority = 0;

    // Find all active campaigns
    if (this.schedule.campaigns) {
      for (const campaign of this.schedule.campaigns) {
        // Check recurrence and time window
        if (!this.isRecurringScheduleActive(campaign, now)) {
          continue;
        }
        if (!this.isTimeActive(campaign, now)) {
          continue;
        }

        this._maxActivePriority = Math.max(this._maxActivePriority, campaign.priority || 0);

        // Campaign is active - add it as a single item with its priority
        activeItems.push({
          type: 'campaign',
          priority: campaign.priority,
          layouts: campaign.layouts, // Keep full layout objects for interrupt processing
          campaignId: campaign.id
        });
      }
    }

    // Find all active standalone layouts
    if (this.schedule.layouts) {
      for (const layout of this.schedule.layouts) {
        // Check recurrence and time window
        if (!this.isRecurringScheduleActive(layout, now)) {
          continue;
        }
        if (!this.isTimeActive(layout, now)) {
          continue;
        }

        // Check criteria conditions (date/time, display properties)
        if (layout.criteria && layout.criteria.length > 0) {
          if (!evaluateCriteria(layout.criteria, { now, displayProperties: this.displayProperties, weatherData: this.weatherData })) {
            _log('[Schedule] Layout', layout.id, 'filtered by criteria');
            continue;
          }
        }

        // Check geo-fencing
        if (layout.isGeoAware && layout.geoLocation) {
          if (!this.isWithinGeoFence(layout.geoLocation)) {
            _log('[Schedule] Layout', layout.id, 'filtered by geofence');
            continue;
          }
        }

        // Track priority before rate-limit filtering
        this._maxActivePriority = Math.max(this._maxActivePriority, layout.priority || 0);

        // Check max plays per hour (skip for future time queries)
        if (!skipRateLimiting && !this.canPlayLayout(layout.id, layout.maxPlaysPerHour)) {
          _log('[Schedule] Layout', layout.id, 'filtered by maxPlaysPerHour (limit:', layout.maxPlaysPerHour, ')');
          // Continue to check other layouts, but don't add this one
          continue;
        }

        activeItems.push({
          type: 'layout',
          priority: layout.priority || 0,
          layouts: [layout], // Keep full layout object for interrupt processing
          layoutId: layout.id
        });
      }
    }

    // If no active schedules, return default
    if (activeItems.length === 0) {
      return this.schedule.default ? [this.schedule.default] : [];
    }

    // Find maximum priority across all items (campaigns and layouts)
    let maxPriority = Math.max(...activeItems.map(item => item.priority));
    _log('[Schedule] Max priority:', maxPriority, 'from', activeItems.length, 'active items');

    // Collect all layouts from items with max priority
    let allLayouts = [];
    for (const item of activeItems) {
      if (item.priority === maxPriority) {
        _log('[Schedule] Including priority', item.priority, 'layouts:', item.layouts.map(l => l.file));
        // Add all layouts from this campaign or standalone layout
        allLayouts.push(...item.layouts);
      } else {
        _log('[Schedule] Skipping priority', item.priority, '< max', maxPriority);
      }
    }

    // Build layout metadata map (syncEvent, shareOfVoice, etc.)
    this._layoutMetadata.clear();
    for (const layout of allLayouts) {
      this._layoutMetadata.set(layout.file, {
        syncEvent: layout.syncEvent || false,
        shareOfVoice: layout.shareOfVoice || 0,
        scheduleid: layout.scheduleid,
        priority: layout.priority || 0,
      });
    }

    // Process interrupts if interrupt scheduler is available (skip for future time queries)
    if (!skipInterrupts && this.interruptScheduler) {
      const { normalLayouts, interruptLayouts } = this.interruptScheduler.separateLayouts(allLayouts);

      if (interruptLayouts.length > 0) {
        _log('[Schedule] Found', interruptLayouts.length, 'interrupt layouts with shareOfVoice');
        const processedLayouts = this.interruptScheduler.processInterrupts(normalLayouts, interruptLayouts);
        // Extract file IDs from processed layouts
        const result = processedLayouts.map(l => l.file);
        _log('[Schedule] Final layouts (with interrupts):', result);
        return result;
      }
    }

    // No interrupts, return layout files
    const result = allLayouts.map(l => l.file);
    _log('[Schedule] Final layouts:', result);
    return result;
  }

  /**
   * Check if schedule needs update (every minute)
   */
  shouldCheckSchedule(lastCheck) {
    if (!lastCheck) return true;
    const elapsed = Date.now() - lastCheck;
    return elapsed >= 60000; // 1 minute
  }

  /**
   * Check if layout can play based on maxPlaysPerHour with even distribution.
   *
   * Instead of allowing bursts (3 plays back-to-back then nothing for 50 min),
   * plays are distributed evenly across the hour:
   *   maxPlaysPerHour=3 → minimum 20 min gap between plays
   *   maxPlaysPerHour=6 → minimum 10 min gap between plays
   *
   * Two checks:
   *   1. Total plays in sliding 1-hour window < maxPlaysPerHour
   *   2. Time since last play >= (60 / maxPlaysPerHour) minutes
   *
   * @param {string} layoutId - Layout ID to check
   * @param {number} maxPlaysPerHour - Maximum plays allowed per hour (0 = unlimited)
   * @returns {boolean} True if layout can play, false if exceeded limit
   */
  canPlayLayout(layoutId, maxPlaysPerHour) {
    // If maxPlaysPerHour is 0 or undefined, unlimited plays
    if (!maxPlaysPerHour || maxPlaysPerHour === 0) {
      return true;
    }

    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);

    // Get play history for this layout
    const history = this.playHistory.get(layoutId) || [];

    // Filter to plays within the last hour
    const playsInLastHour = history.filter(timestamp => timestamp > oneHourAgo);

    // Check 1: Total plays in last hour must be under limit
    if (playsInLastHour.length >= maxPlaysPerHour) {
      log.info(`Layout ${layoutId} has reached max plays per hour (${playsInLastHour.length}/${maxPlaysPerHour})`);
      return false;
    }

    // Check 2: Minimum gap between plays for even distribution
    // e.g., 3/hour → 1 every 20 min, 6/hour → 1 every 10 min
    if (playsInLastHour.length > 0) {
      const minGapMs = (60 * 60 * 1000) / maxPlaysPerHour;
      const lastPlayTime = Math.max(...playsInLastHour);
      const elapsed = now - lastPlayTime;

      if (elapsed < minGapMs) {
        const remainingMin = ((minGapMs - elapsed) / 60000).toFixed(1);
        log.info(`Layout ${layoutId} spacing: next play in ${remainingMin} min (${playsInLastHour.length}/${maxPlaysPerHour} plays, ${Math.round(minGapMs/60000)} min gap)`);
        return false;
      }
    }

    return true;
  }

  /**
   * Record that a layout was played
   * @param {string} layoutId - Layout ID that was played
   */
  recordPlay(layoutId) {
    if (!this.playHistory.has(layoutId)) {
      this.playHistory.set(layoutId, []);
    }

    const history = this.playHistory.get(layoutId);
    history.push(Date.now());

    // Clean up old entries (older than 1 hour)
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    const cleaned = history.filter(timestamp => timestamp > oneHourAgo);
    this.playHistory.set(layoutId, cleaned);

    log.info(`Recorded play for layout ${layoutId} (${cleaned.length} plays in last hour)`);
  }

  /**
   * Get the max priority of any time-active layout (ignoring rate-limit filtering).
   * Returns 0 if no layouts are active or if getCurrentLayouts() hasn't been called.
   * @returns {number}
   */
  getMaxActivePriority() {
    return this._maxActivePriority || 0;
  }

  /**
   * Check if a layout file is a sync event (part of multi-display sync group)
   * @param {string} layoutFile - Layout file identifier (e.g., '123')
   * @returns {boolean}
   */
  isSyncEvent(layoutFile) {
    const meta = this._layoutMetadata.get(layoutFile);
    return meta?.syncEvent === true;
  }

  /**
   * Get metadata for a layout file (syncEvent, shareOfVoice, etc.)
   * @param {string} layoutFile - Layout file identifier
   * @returns {Object|null} Metadata or null if not found
   */
  getLayoutMetadata(layoutFile) {
    return this._layoutMetadata.get(layoutFile) || null;
  }

  /**
   * Get current layouts with the default layout interleaved between scheduled layouts.
   *
   * Xibo CMS expects the default layout (fallback) to play between each scheduled
   * layout in the rotation. For example, with layouts [A, B, C] and default D,
   * the result is [A, D, B, D, C, D].
   *
   * No interleaving when:
   * - There is no default layout configured
   * - There are no scheduled layouts (only default plays)
   * - There is only one scheduled layout (no gaps to fill)
   *
   * @returns {string[]} Layout files with default interleaved
   */
  getInterleavedLayouts() {
    const layouts = this.getCurrentLayouts();
    const defaultLayout = this.schedule?.default;

    // No interleaving needed: no default, no layouts, or single layout
    if (!defaultLayout || layouts.length <= 1) {
      return layouts;
    }

    // If the only layout is the default itself, return as-is
    if (layouts.length === 1 && layouts[0] === defaultLayout) {
      return layouts;
    }

    // Interleave: A, D, B, D, C, D
    const interleaved = [];
    for (const layout of layouts) {
      interleaved.push(layout);
      interleaved.push(defaultLayout);
    }

    log.info('[Schedule] Interleaved', layouts.length, 'layouts with default', defaultLayout);
    return interleaved;
  }

  /**
   * Check if any current layouts are sync events
   * @returns {boolean}
   */
  hasSyncEvents() {
    for (const meta of this._layoutMetadata.values()) {
      if (meta.syncEvent) return true;
    }
    return false;
  }

  /**
   * Get currently active actions (within their time window)
   * @returns {Array} Active action objects
   */
  getActiveActions() {
    if (!this.schedule?.actions) return [];

    const now = new Date();
    return this.schedule.actions.filter(action => this.isTimeActive(action, now));
  }

  /**
   * Get scheduled commands
   * @returns {Array} Command objects
   */
  getCommands() {
    return this.schedule?.commands || [];
  }

  /**
   * Find action by trigger code
   * @param {string} triggerCode - The trigger code to match
   * @returns {Object|null} Matching action or null
   */
  findActionByTrigger(triggerCode) {
    const activeActions = this.getActiveActions();
    return activeActions.find(a => a.triggerCode === triggerCode) || null;
  }

  /**
   * Clear play history (useful for testing or reset)
   */
  clearPlayHistory() {
    this.playHistory.clear();
    log.info('Play history cleared');
  }

  /**
   * Set player's current GPS location (from Geolocation API or XMR command)
   * @param {number} latitude
   * @param {number} longitude
   */
  setLocation(latitude, longitude) {
    this.playerLocation = { latitude, longitude };
    log.info(`Location set: ${latitude}, ${longitude}`);
  }

  /**
   * Set display properties from CMS (custom fields for criteria evaluation)
   * @param {Object} properties - Key-value map of display properties
   */
  setDisplayProperties(properties) {
    this.displayProperties = properties || {};
  }

  /**
   * Check if player is within a geo-fence.
   * geoLocation format from CMS: "lat,lng" (point + default radius)
   * or "lat1,lng1;lat2,lng2;..." (polygon — future)
   *
   * Default radius: 500 meters (Xibo default for point geofences)
   *
   * @param {string} geoLocation - Geo-fence specification from CMS
   * @param {number} [defaultRadius=500] - Default radius in meters for point geofences
   * @returns {boolean} True if within geofence or no location available
   */
  isWithinGeoFence(geoLocation, defaultRadius = 500) {
    if (!this.playerLocation) {
      // No location available — be permissive, show the content
      log.debug('No player location, skipping geofence check');
      return true;
    }

    if (!geoLocation) return true;

    // Parse "lat,lng" format
    const parts = geoLocation.split(',').map(s => parseFloat(s.trim()));
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) {
      log.warn('Invalid geoLocation format:', geoLocation);
      return true; // Invalid format, be permissive
    }

    const fenceLat = parts[0];
    const fenceLng = parts[1];
    const radius = parts[2] || defaultRadius; // Optional 3rd param: radius in meters

    const distance = this.haversineDistance(
      this.playerLocation.latitude, this.playerLocation.longitude,
      fenceLat, fenceLng
    );

    const within = distance <= radius;
    log.info(`Geofence: ${distance.toFixed(0)}m from (${fenceLat},${fenceLng}), radius ${radius}m → ${within ? 'WITHIN' : 'OUTSIDE'}`);
    return within;
  }

  /**
   * Haversine formula: calculate distance between two GPS coordinates
   * @param {number} lat1 - Latitude 1 (degrees)
   * @param {number} lon1 - Longitude 1 (degrees)
   * @param {number} lat2 - Latitude 2 (degrees)
   * @param {number} lon2 - Longitude 2 (degrees)
   * @returns {number} Distance in meters
   */
  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const toRad = deg => deg * Math.PI / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

export const scheduleManager = new ScheduleManager();
