// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Criteria Evaluator
 *
 * Evaluates schedule criteria against current player state.
 * Criteria are conditions set in the CMS that determine whether
 * a layout/overlay should display on a given player.
 *
 * Supported metrics:
 * - dayOfWeek: Current day name (Monday-Sunday)
 * - dayOfMonth: Day number (1-31)
 * - month: Month number (1-12)
 * - hour: Hour (0-23)
 * - isoDay: ISO day of week (1=Monday, 7=Sunday)
 *
 * Weather metrics (require weatherData in options):
 * - weatherTemp: Current temperature
 * - weatherHumidity: Current humidity percentage
 * - weatherWindSpeed: Current wind speed
 * - weatherCondition: Current weather condition (e.g. "Clear", "Rain")
 * - weatherCloudCover: Cloud cover percentage
 *
 * Supported conditions:
 * - equals, notEquals
 * - greaterThan, greaterThanOrEquals, lessThan, lessThanOrEquals
 * - contains, notContains, startsWith, endsWith
 * - in (comma-separated list)
 *
 * Display property metrics are resolved via a property map
 * provided at evaluation time.
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('schedule:criteria');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Weather metric name → weatherData property mapping
 */
const WEATHER_METRICS = {
  weatherTemp: 'temperature',
  weatherHumidity: 'humidity',
  weatherWindSpeed: 'windSpeed',
  weatherCondition: 'condition',
  weatherCloudCover: 'cloudCover',
};

/**
 * Get built-in metric value from current date/time
 * @param {string} metric - Metric name
 * @param {Date} now - Current date
 * @param {Object} displayProperties - Display property map from CMS
 * @param {Object} weatherData - Weather data from GetWeather XMDS call
 * @returns {string|null} Metric value or null if unknown
 */
function getMetricValue(metric, now, displayProperties = {}, weatherData = {}) {
  switch (metric) {
    case 'dayOfWeek':
      return DAY_NAMES[now.getDay()];
    case 'dayOfMonth':
      return String(now.getDate());
    case 'month':
      return String(now.getMonth() + 1);
    case 'hour':
      return String(now.getHours());
    case 'isoDay':
      return String(now.getDay() === 0 ? 7 : now.getDay());
    default:
      // Check weather metrics
      if (WEATHER_METRICS[metric]) {
        const weatherKey = WEATHER_METRICS[metric];
        if (weatherData[weatherKey] !== undefined) {
          return String(weatherData[weatherKey]);
        }
        log.debug(`Weather metric "${metric}" requested but no weather data available`);
        return null;
      }
      // Check display properties (custom fields set in CMS)
      if (displayProperties[metric] !== undefined) {
        return String(displayProperties[metric]);
      }
      log.debug(`Unknown metric: ${metric}`);
      return null;
  }
}

/**
 * Evaluate a single condition
 * @param {string} actual - Actual value from player state
 * @param {string} condition - Condition operator
 * @param {string} expected - Expected value from criteria
 * @param {string} type - Value type ('string' or 'number')
 * @returns {boolean}
 */
function evaluateCondition(actual, condition, expected, type) {
  if (actual === null) return false;

  // Number comparison
  if (type === 'number') {
    const a = parseFloat(actual);
    const e = parseFloat(expected);
    if (isNaN(a) || isNaN(e)) return false;

    switch (condition) {
      case 'equals': return a === e;
      case 'notEquals': return a !== e;
      case 'greaterThan': return a > e;
      case 'greaterThanOrEquals': return a >= e;
      case 'lessThan': return a < e;
      case 'lessThanOrEquals': return a <= e;
      default: return false;
    }
  }

  // String comparison (case-insensitive)
  const a = actual.toLowerCase();
  const e = expected.toLowerCase();

  switch (condition) {
    case 'equals': return a === e;
    case 'notEquals': return a !== e;
    case 'contains': return a.includes(e);
    case 'notContains': return !a.includes(e);
    case 'startsWith': return a.startsWith(e);
    case 'endsWith': return a.endsWith(e);
    case 'in': return e.split(',').map(s => s.trim().toLowerCase()).includes(a);
    case 'greaterThan': return a > e;
    case 'lessThan': return a < e;
    default:
      log.debug(`Unknown condition: ${condition}`);
      return false;
  }
}

/**
 * Evaluate all criteria for a schedule item.
 * All criteria must match (AND logic) for the item to display.
 *
 * @param {Array<{metric: string, condition: string, type: string, value: string}>} criteria
 * @param {Object} options
 * @param {Date} [options.now] - Current date (defaults to new Date())
 * @param {Object} [options.displayProperties] - Display property map from CMS
 * @param {Object} [options.weatherData] - Weather data from GetWeather XMDS call
 * @returns {boolean} True if all criteria match (or no criteria)
 */
export function evaluateCriteria(criteria, options = {}) {
  if (!criteria || criteria.length === 0) return true;

  const now = options.now || new Date();
  const displayProperties = options.displayProperties || {};
  const weatherData = options.weatherData || {};

  for (const criterion of criteria) {
    const actual = getMetricValue(criterion.metric, now, displayProperties, weatherData);
    const matches = evaluateCondition(actual, criterion.condition, criterion.value, criterion.type);

    if (!matches) {
      log.debug(`Criteria failed: ${criterion.metric} ${criterion.condition} "${criterion.value}" (actual: "${actual}")`);
      return false;
    }
  }

  return true;
}
