// @xiboplayer/stats - Proof of play and statistics reporting
import pkg from '../package.json' with { type: 'json' };
export const VERSION = pkg.version;

/**
 * Stats collector for proof of play tracking
 * @module @xiboplayer/stats/collector
 */
export { StatsCollector, formatStats } from './stats-collector.js';

/**
 * Log reporter for CMS logging
 * @module @xiboplayer/stats/logger
 */
export { LogReporter, formatLogs, formatFaults } from './log-reporter.js';
