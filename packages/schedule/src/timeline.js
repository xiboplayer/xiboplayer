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
 * Duration resolution order:
 *  1. Explicit <layout duration="60"> attribute
 *  2. Sum of widget <media duration="X"> per region (max across regions)
 *  3. Fallback: 60s
 *
 * @param {string} xlfXml - Raw XLF XML string
 * @returns {number} Duration in seconds
 */
export function parseLayoutDuration(xlfXml) {
  const doc = new DOMParser().parseFromString(xlfXml, 'text/xml');
  const layoutEl = doc.querySelector('layout');
  if (!layoutEl) return 60;

  // 1. Explicit layout duration attribute
  const explicit = parseInt(layoutEl.getAttribute('duration') || '0', 10);
  if (explicit > 0) return explicit;

  // 2. Calculate from widget durations (max region wins — regions play in parallel)
  let maxDuration = 0;
  for (const regionEl of layoutEl.querySelectorAll('region')) {
    let regionDuration = 0;
    for (const mediaEl of regionEl.querySelectorAll('media')) {
      const dur = parseInt(mediaEl.getAttribute('duration') || '0', 10);
      const useDuration = parseInt(mediaEl.getAttribute('useDuration') || '1', 10);
      if (dur > 0 && useDuration !== 0) {
        regionDuration += dur;
      } else {
        // Video with useDuration=0 means "play to end" — estimate 60s,
        // corrected later via recordLayoutDuration() when video metadata loads
        regionDuration += 60;
      }
    }
    maxDuration = Math.max(maxDuration, regionDuration);
  }

  return maxDuration > 0 ? maxDuration : 60;
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
 * Seed simulated play history from real play history.
 * Maps layoutId-based history to layoutFile-based history.
 * @param {Map<string, number[]>} realHistory - schedule.playHistory (layoutId → [timestamps])
 * @returns {Map<string, number[]>} layoutFile → [timestamps]
 */
function seedPlayHistory(realHistory) {
  const simulated = new Map();
  if (!realHistory) return simulated;

  for (const [layoutId, timestamps] of realHistory) {
    const file = `${layoutId}.xlf`;
    simulated.set(file, [...timestamps]);
  }
  return simulated;
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
 * Calculate a deterministic playback timeline by simulating round-robin scheduling
 * with rate limiting (maxPlaysPerHour) and priority fallback. Produces a real
 * schedule prediction that matches actual player behavior.
 *
 * When high-priority layouts hit their maxPlaysPerHour limit, the simulation
 * falls back to lower-priority scheduled layouts before using the CMS default.
 *
 * @param {Object} schedule - ScheduleManager instance (needs getAllLayoutsAtTime(), schedule.default, playHistory)
 * @param {Map<string, number>} durations - Map of layoutFile → duration in seconds
 * @param {Object} [options]
 * @param {Date}   [options.from]    - Start time (default: now)
 * @param {number} [options.hours]   - Hours to simulate (default: 2)
 * @param {number} [options.defaultDuration] - Fallback duration in seconds (default: 60)
 * @param {Date}   [options.currentLayoutStartedAt] - When current layout started (adjusts first entry to remaining time)
 * @returns {Array<{layoutFile: string, startTime: Date, endTime: Date, duration: number, isDefault: boolean}>}
 */
export function calculateTimeline(schedule, durations, options = {}) {
  const from = options.from || new Date();
  const hours = options.hours || 2;
  const to = new Date(from.getTime() + hours * 3600000);
  const defaultDuration = options.defaultDuration || 60;
  const currentLayoutStartedAt = options.currentLayoutStartedAt || null;
  const timeline = [];
  let currentTime = new Date(from);
  let isFirstEntry = true;

  // Use getAllLayoutsAtTime if available (new API), fall back to getLayoutsAtTime (old API)
  const hasFullApi = typeof schedule.getAllLayoutsAtTime === 'function';

  // Seed simulated play history from real plays
  const simPlays = seedPlayHistory(schedule.playHistory);

  const maxEntries = 500;

  while (currentTime < to && timeline.length < maxEntries) {
    const timeMs = currentTime.getTime();
    let playable;

    let hiddenLayouts = null;

    if (hasFullApi) {
      // Full simulation: get ALL active layouts, apply rate limiting + priority
      const allLayouts = schedule.getAllLayoutsAtTime(currentTime);
      playable = allLayouts.length > 0
        ? getPlayableLayouts(allLayouts, simPlays, timeMs)
        : [];
      // Detect hidden layouts (lower priority, not playing)
      if (allLayouts.length > playable.length) {
        hiddenLayouts = allLayouts
          .filter(l => !playable.includes(l.file))
          .map(l => ({ file: l.file, priority: l.priority }));
      }
    } else {
      // Legacy fallback: no rate limiting simulation
      playable = schedule.getLayoutsAtTime(currentTime);
    }

    if (playable.length === 0) {
      // No playable layouts — use CMS default or skip ahead
      const defaultFile = schedule.schedule?.default;
      if (defaultFile) {
        const dur = durations.get(defaultFile) || defaultDuration;
        timeline.push({
          layoutFile: defaultFile,
          startTime: new Date(currentTime),
          endTime: new Date(timeMs + dur * 1000),
          duration: dur,
          isDefault: true,
        });
        currentTime = new Date(timeMs + dur * 1000);
      } else {
        currentTime = new Date(timeMs + 60000);
      }
      continue;
    }

    // Round-robin through playable layouts
    for (let i = 0; i < playable.length && currentTime < to && timeline.length < maxEntries; i++) {
      const file = playable[i];
      let dur = durations.get(file) || defaultDuration;

      // First entry: use remaining duration if we know when the current layout started
      if (isFirstEntry && currentLayoutStartedAt) {
        const elapsedSec = (from.getTime() - currentLayoutStartedAt.getTime()) / 1000;
        const remaining = Math.max(1, Math.round(dur - elapsedSec));
        dur = remaining;
        isFirstEntry = false;
      }

      const endMs = currentTime.getTime() + dur * 1000;

      const entry = {
        layoutFile: file,
        startTime: new Date(currentTime),
        endTime: new Date(endMs),
        duration: dur,
        isDefault: false,
      };
      if (hiddenLayouts && hiddenLayouts.length > 0) {
        entry.hidden = hiddenLayouts;
      }
      timeline.push(entry);

      // Record simulated play
      if (hasFullApi) {
        if (!simPlays.has(file)) simPlays.set(file, []);
        simPlays.get(file).push(currentTime.getTime());
      }

      currentTime = new Date(endMs);

      // Re-evaluate: if playable set changed, re-enter outer loop
      if (hasFullApi) {
        const nextAll = schedule.getAllLayoutsAtTime(currentTime);
        const nextPlayable = nextAll.length > 0
          ? getPlayableLayouts(nextAll, simPlays, currentTime.getTime())
          : [];
        if (!arraysEqual(playable, nextPlayable)) break;
      } else {
        const next = schedule.getLayoutsAtTime(currentTime);
        if (!arraysEqual(playable, next)) break;
      }
    }
  }

  return timeline;
}
