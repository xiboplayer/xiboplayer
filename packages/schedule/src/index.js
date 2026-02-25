// @xiboplayer/schedule - Campaign scheduling and advanced features
// Basic scheduling, interrupts, overlays, and dayparting
import pkg from '../package.json' with { type: 'json' };
export const VERSION = pkg.version;

/**
 * Core schedule manager for basic scheduling and dayparting
 * @module @xiboplayer/schedule
 */
export { ScheduleManager, scheduleManager } from './schedule.js';

/**
 * Interrupt scheduler for shareOfVoice layouts
 * @module @xiboplayer/schedule/interrupts
 */
export { InterruptScheduler } from './interrupts.js';

/**
 * Overlay layout scheduler
 * @module @xiboplayer/schedule/overlays
 */
export { OverlayScheduler } from './overlays.js';

/**
 * Offline timeline calculator — duration parser + timeline simulator
 * @module @xiboplayer/schedule/timeline
 */
export { calculateTimeline, parseLayoutDuration, buildScheduleQueue } from './timeline.js';
