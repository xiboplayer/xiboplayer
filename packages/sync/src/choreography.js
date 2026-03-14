// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Transition choreography — compute stagger delays for cascading
 * layout transitions across multiple displays.
 *
 * Each display has a position (0-indexed) and the choreography determines
 * the order in which displays execute their transition. The stagger delay
 * is applied locally by each display when it receives the layout-show signal.
 *
 * Choreographies:
 *   wave-right   — sweep left to right
 *   wave-left    — sweep right to left
 *   center-out   — explode from center to edges
 *   outside-in   — implode from edges to center
 *   random       — random delay per display
 *   simultaneous — all at once (default, no delay)
 *
 * @module @xiboplayer/sync/choreography
 */

/**
 * Compute the stagger delay for a display based on its position and choreography.
 *
 * @param {Object} options
 * @param {string} options.choreography — choreography name
 * @param {number} options.position — this display's 0-indexed position in the wall
 * @param {number} options.totalDisplays — total number of displays in the group
 * @param {number} options.staggerMs — base delay between consecutive displays (ms)
 * @returns {number} delay in ms before this display should execute its transition
 *
 * @example
 * // 4 displays, wave-right with 150ms stagger:
 * // position 0 → 0ms, position 1 → 150ms, position 2 → 300ms, position 3 → 450ms
 * computeStagger({ choreography: 'wave-right', position: 2, totalDisplays: 4, staggerMs: 150 })
 * // → 300
 *
 * @example
 * // 5 displays, center-out with 100ms stagger:
 * // position 0 → 200ms, position 1 → 100ms, position 2 → 0ms, position 3 → 100ms, position 4 → 200ms
 * computeStagger({ choreography: 'center-out', position: 0, totalDisplays: 5, staggerMs: 100 })
 * // → 200
 */
export function computeStagger({ choreography, position, totalDisplays, staggerMs }) {
  if (!choreography || choreography === 'simultaneous' || totalDisplays <= 1 || !staggerMs) {
    return 0;
  }

  const last = totalDisplays - 1;
  const center = last / 2;

  switch (choreography) {
    case 'wave-right':
      return position * staggerMs;

    case 'wave-left':
      return (last - position) * staggerMs;

    case 'center-out':
      return Math.round(Math.abs(position - center)) * staggerMs;

    case 'outside-in': {
      const maxDist = Math.round(center);
      return (maxDist - Math.round(Math.abs(position - center))) * staggerMs;
    }

    case 'random':
      return Math.floor(Math.random() * last * staggerMs);

    default:
      return 0;
  }
}
