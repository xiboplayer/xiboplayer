// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Offline Schedule Timeline Calculator
 *
 * Calculates deterministic playback timelines by parsing layout XLF durations
 * and simulating round-robin scheduling. Enables the player to answer
 * "what's the playback plan for the next N hours?" while offline.
 */

/**
 * Parse layout duration from XLF XML string.
 * Lightweight parser — uses DOMParser, no rendering.
 *
 * Single source of truth for XLF-based duration calculation.
 * Supports a 3-phase progressive refinement pipeline:
 *   Phase 1 (ESTIMATE):     parseLayoutDuration(xlf) — static duration from XLF
 *   Phase 2 (PROBE):        parseLayoutDuration(xlf, videoDurations) — refined with real video lengths
 *   Phase 3 (LIVE UPDATE):  renderer's updateLayoutDuration() — corrections from DURATION comments
 *
 * Duration resolution order:
 *  1. Explicit <layout duration="60"> attribute
 *  2. Sum of widget <media duration="X"> per region (max across regions)
 *  3. Fallback: 60s
 *
 * @param {string} xlfXml - Raw XLF XML string
 * @param {Map<string, number>|null} [videoDurations=null] - Optional map of fileId → probed duration in seconds
 * @returns {{ duration: number, isDynamic: boolean }} Duration in seconds and whether any widget has useDuration=0
 */
export function parseLayoutDuration(xlfXml, videoDurations = null) {
  const doc = new DOMParser().parseFromString(xlfXml, 'text/xml');
  const layoutEl = doc.querySelector('layout');
  if (!layoutEl) return { duration: 60, isDynamic: false };

  // 1. Explicit layout duration attribute
  const explicit = parseInt(layoutEl.getAttribute('duration') || '0', 10);
  if (explicit > 0) return { duration: explicit, isDynamic: false };

  // 2. Calculate from widget durations (max region wins — regions play in parallel)
  let maxDuration = 0;
  let isDynamic = false;
  for (const regionEl of layoutEl.querySelectorAll('region')) {
    const regionType = regionEl.getAttribute('type');
    if (regionType === 'drawer') continue; // Drawers are action-triggered, not timed
    const isCanvas = regionType === 'canvas';
    let regionDuration = 0;
    for (const mediaEl of regionEl.querySelectorAll('media')) {
      const dur = parseInt(mediaEl.getAttribute('duration') || '0', 10);
      const useDuration = parseInt(mediaEl.getAttribute('useDuration') || '1', 10);
      const fileId = mediaEl.getAttribute('fileId') || '';
      const probed = videoDurations?.get(fileId);

      let widgetDuration;
      if (probed !== undefined) {
        widgetDuration = probed;           // Phase 2: probed video duration
      } else if (dur > 0 && useDuration !== 0) {
        widgetDuration = dur;              // Explicit CMS duration
      } else {
        // Video with useDuration=0 means "play to end" — estimate 60s,
        // corrected later via recordLayoutDuration() when video metadata loads
        widgetDuration = 60;
        isDynamic = true;
      }

      if (isCanvas) {
        // Canvas regions play all widgets simultaneously — duration is max, not sum
        regionDuration = Math.max(regionDuration, widgetDuration);
      } else {
        regionDuration += widgetDuration;
      }
    }
    maxDuration = Math.max(maxDuration, regionDuration);
  }

  const duration = maxDuration > 0 ? maxDuration : 60;
  return { duration, isDynamic };
}

/**
 * Compare two arrays of layout files for equality.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Check if a layout can play at a given time based on simulated play history.
 * Replicates ScheduleManager.canPlayLayout() logic for timeline prediction.
 *
 * Even-distribution rules:
 *   1. Total plays in sliding 1-hour window < maxPlaysPerHour
 *   2. Time since last play >= (60 / maxPlaysPerHour) minutes
 *
 * @param {number[]} history - Simulated play timestamps (ms) for this layout
 * @param {number} maxPlaysPerHour - Max plays per hour (0 = unlimited)
 * @param {number} timeMs - Current simulated time in ms
 * @returns {boolean}
 */
function canSimulatedPlay(history, maxPlaysPerHour, timeMs) {
  if (!maxPlaysPerHour || maxPlaysPerHour === 0) return true;

  const oneHourAgo = timeMs - 3600000;
  const playsInLastHour = history.filter(t => t > oneHourAgo);

  // Check 1: under hourly limit
  if (playsInLastHour.length >= maxPlaysPerHour) return false;

  // Check 2: minimum gap for even distribution
  if (playsInLastHour.length > 0) {
    const minGapMs = 3600000 / maxPlaysPerHour;
    const lastPlay = Math.max(...playsInLastHour);
    if (timeMs - lastPlay < minGapMs) return false;
  }

  return true;
}

/**
 * From a list of layout metadata, apply simulated rate limiting and priority
 * filtering to determine which layouts can actually play at the given time.
 * Mirrors the real player logic: filter rate-limited layouts first, then
 * pick highest remaining priority.
 *
 * @param {Array<{file: string, priority: number, maxPlaysPerHour: number}>} allLayouts
 * @param {Map<string, number[]>} simPlays - Simulated play history
 * @param {number} timeMs - Current simulated time in ms
 * @returns {string[]} Layout files that can play, highest priority first
 */
function getPlayableLayouts(allLayouts, simPlays, timeMs) {
  // Step 1: Filter out rate-limited layouts
  const eligible = allLayouts.filter(l => {
    if (!l.maxPlaysPerHour || l.maxPlaysPerHour === 0) return true;
    const history = simPlays.get(l.file) || [];
    return canSimulatedPlay(history, l.maxPlaysPerHour, timeMs);
  });

  if (eligible.length === 0) return [];

  // Step 2: Pick highest priority from remaining layouts
  const maxPriority = Math.max(...eligible.map(l => l.priority));
  return eligible
    .filter(l => l.priority === maxPriority)
    .map(l => l.file);
}

/**
 * Calculate a deterministic playback timeline by walking the pre-built schedule queue.
 *
 * The queue already has all constraints baked in (maxPlaysPerHour, priorities,
 * dayparting, default layout fills). This function simply cycles through it from
 * the current position, generating time-stamped entries for the overlay.
 *
 * @param {Array<{layoutId: string, duration: number}>} queue - Pre-built schedule queue from buildScheduleQueue()
 * @param {number} queuePosition - Current position in the queue (from schedule._queuePosition)
 * @param {Object} [options]
 * @param {Date}   [options.from]    - Start time (default: now)
 * @param {number} [options.hours]   - Hours to project (default: 2)
 * @param {string} [options.defaultLayout] - Default layout file (to tag isDefault entries)
 * @param {Map<string, number>} [options.durations] - Live durations map (overrides queue entry durations with corrected values)
 * @param {Date}   [options.currentLayoutStartedAt] - When current layout started (adjusts first entry to remaining time)
 * @returns {Array<{layoutFile: string, startTime: Date, endTime: Date, duration: number, isDefault: boolean}>}
 */
export function calculateTimeline(queue, queuePosition, options = {}) {
  const from = options.from || new Date();
  const hours = options.hours || 2;
  const to = new Date(from.getTime() + hours * 3600000);
  const currentLayoutStartedAt = options.currentLayoutStartedAt || null;
  const defaultLayout = options.defaultLayout || null;
  const durations = options.durations || null;

  if (!queue || queue.length === 0) return [];

  const timeline = [];
  let currentTime = new Date(from);
  // queuePosition has already advanced past the currently-playing layout
  // (via popNextFromQueue), so entries here start from the NEXT layout.
  // The current layout's duration is passed directly to the overlay.
  let pos = queuePosition % queue.length;
  const maxEntries = 500;

  while (currentTime < to && timeline.length < maxEntries) {
    const entry = queue[pos];
    // Use live-corrected duration (from video metadata, etc.) if available,
    // otherwise fall back to the queue's baked-in duration
    let dur = (durations && durations.get(entry.layoutId)) || entry.duration;

    const endMs = currentTime.getTime() + dur * 1000;

    timeline.push({
      layoutFile: entry.layoutId,
      startTime: new Date(currentTime),
      endTime: new Date(endMs),
      duration: dur,
      isDefault: defaultLayout ? entry.layoutId === defaultLayout : false,
    });

    currentTime = new Date(endMs);
    pos = (pos + 1) % queue.length;
  }

  return timeline;
}

// ── LCM-based deterministic schedule queue ──────────────────────────────

/**
 * Greatest common divisor (Euclidean algorithm).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function gcd(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

/**
 * Least common multiple of two integers.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function lcm(a, b) {
  if (a === 0 || b === 0) return 0;
  return Math.abs(Math.round(a) * Math.round(b)) / gcd(a, b);
}

/**
 * LCM of an array of integers.
 * @param {number[]} values
 * @returns {number}
 */
function lcmArray(values) {
  return values.reduce((acc, v) => lcm(acc, v), 1);
}

/**
 * Build a deterministic playback queue by simulating one LCM period.
 *
 * Uses getPlayableLayouts() (the same priority-fallback + rate-limit logic
 * that calculateTimeline uses) to simulate playback for one repeating cycle.
 * This ensures the queue matches the timeline overlay exactly: high-priority
 * rate-limited layouts get their slots, then lower-priority layouts fill gaps.
 *
 * @param {Array<{file: string, priority: number, maxPlaysPerHour: number}>} allLayouts
 *   All time-active layouts from schedule.getAllLayoutsAtTime()
 * @param {Map<string, number>} durations
 *   Map of layoutFile → duration in seconds
 * @param {Object} [options]
 * @param {string}  [options.defaultLayout] - Default layout file (CMS fallback)
 * @param {number}  [options.defaultDuration] - Fallback duration (default: 60)
 * @param {Set<string>} [options.dynamicLayouts] - Set of layout files that are dynamic (video, useDuration=0)
 * @returns {{ queue: Array<{layoutId: string, duration: number}>, periodSeconds: number }}
 */
export function buildScheduleQueue(allLayouts, durations, options = {}) {
  const {
    defaultLayout = null,
    defaultDuration = 60,
  } = options;

  if (allLayouts.length === 0 && !defaultLayout) {
    return { queue: [], periodSeconds: 0 };
  }

  // Build CMS duration lookup — use CMS-reported duration as fallback
  // when the durations map (from XLF parsing / video metadata) has no entry.
  const cmsDurations = new Map();
  for (const l of allLayouts) {
    if (l.duration > 0) cmsDurations.set(l.file, l.duration);
  }
  const getDuration = (file) => durations.get(file) || cmsDurations.get(file) || defaultDuration;

  // Step 1: Identify rate-limited layouts to calculate LCM period
  const rateLimited = allLayouts.filter(l => l.maxPlaysPerHour > 0);

  let periodSeconds;
  if (rateLimited.length > 0) {
    const intervals = rateLimited.map(l => Math.round(3600 / l.maxPlaysPerHour));
    periodSeconds = lcmArray(intervals);
    // Cap at 2 hours to prevent absurd periods
    if (periodSeconds > 7200) periodSeconds = 7200;
  } else {
    // No rate-limited layouts — single round-robin cycle
    const totalDuration = allLayouts.reduce((sum, l) => sum + getDuration(l.file), 0)
      + (defaultLayout && !allLayouts.some(l => l.file === defaultLayout)
        ? getDuration(defaultLayout)
        : 0);
    periodSeconds = totalDuration || defaultDuration;
  }

  // Step 2: Simulate playback for one period using getPlayableLayouts()
  const queue = [];
  const simPlays = new Map(); // file → [timestampMs] for rate-limit tracking
  let cursorMs = 0;
  const periodMs = periodSeconds * 1000;
  const maxEntries = 500; // safety cap

  while (cursorMs < periodMs && queue.length < maxEntries) {
    // Get playable layouts at current simulated time (priority fallback + rate limits)
    const playable = getPlayableLayouts(allLayouts, simPlays, cursorMs);

    if (playable.length === 0) {
      // All layouts exhausted — use default
      if (defaultLayout) {
        const dur = getDuration(defaultLayout);
        queue.push({ layoutId: defaultLayout, duration: dur });
        cursorMs += dur * 1000;
      } else {
        // No default — skip ahead 60s to avoid infinite loop
        cursorMs += 60000;
      }
      continue;
    }

    // Play all playable layouts in round-robin order (one each), then re-evaluate
    for (let i = 0; i < playable.length && cursorMs < periodMs && queue.length < maxEntries; i++) {
      const file = playable[i];
      const dur = getDuration(file);

      queue.push({ layoutId: file, duration: dur });

      // Record simulated play for rate-limit tracking
      if (!simPlays.has(file)) simPlays.set(file, []);
      simPlays.get(file).push(cursorMs);

      cursorMs += dur * 1000;

      // Re-evaluate after each play: if the playable set changed, break to outer loop
      const nextPlayable = getPlayableLayouts(allLayouts, simPlays, cursorMs);
      if (!arraysEqual(playable, nextPlayable)) break;
    }
  }

  // Handle edge case: no layouts and only default
  if (queue.length === 0 && defaultLayout) {
    const defDur = getDuration(defaultLayout);
    queue.push({ layoutId: defaultLayout, duration: defDur });
  }

  return { queue, periodSeconds };
}
