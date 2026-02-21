/**
 * Fetch with retry and exponential backoff
 *
 * Wraps native fetch() with configurable retry logic for transient failures.
 * Only retries on network errors and 5xx server errors (not 4xx client errors).
 * On final attempt, returns the response as-is so the caller can handle errors.
 */

import { createLogger } from './logger.js';

const log = createLogger('FetchRetry');

const DEFAULT_429_DELAY_MS = 30000;
const MAX_429_DELAY_MS = 120000;

/**
 * Parse a Retry-After header value into milliseconds.
 * Supports both delta-seconds ("120") and HTTP-date ("Fri, 21 Feb 2026 12:00:00 GMT").
 * Returns a sensible default if the header is missing or unparseable.
 * The returned delay is NOT capped by maxDelayMs — the server's rate-limit
 * instruction takes priority over our backoff ceiling.
 * @param {string|null} headerValue
 * @returns {number} delay in milliseconds (clamped to MAX_429_DELAY_MS)
 */
function parseRetryAfter(headerValue) {
  if (!headerValue) return DEFAULT_429_DELAY_MS;

  // Try delta-seconds first (most common)
  const seconds = Number(headerValue);
  if (!isNaN(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_429_DELAY_MS);
  }

  // Try HTTP-date format (RFC 7231 §7.1.3)
  const date = new Date(headerValue);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return Math.min(Math.max(delayMs, 0), MAX_429_DELAY_MS);
  }

  return DEFAULT_429_DELAY_MS;
}

/**
 * Fetch with automatic retry on failure
 * @param {string|URL} url - URL to fetch
 * @param {RequestInit} [options] - Fetch options
 * @param {Object} [retryOptions] - Retry configuration
 * @param {number} [retryOptions.maxRetries=3] - Maximum retry attempts
 * @param {number} [retryOptions.baseDelayMs=1000] - Base delay between retries (doubles each time)
 * @param {number} [retryOptions.maxDelayMs=30000] - Maximum delay between retries
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 30000 } = retryOptions;

  let lastError;
  let lastResponse;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // HTTP 429 Too Many Requests — respect Retry-After header
      if (response.status === 429) {
        const delayMs = parseRetryAfter(response.headers.get('Retry-After'));
        log.debug(`429 Rate limited, waiting ${delayMs}ms (Retry-After: ${response.headers.get('Retry-After')})`);
        lastResponse = response;
        lastError = new Error(`HTTP 429: Too Many Requests`);
        lastError.status = 429;
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue; // Skip the normal backoff delay below
        }
        break; // Exhausted retries
      }

      // Don't retry other client errors (4xx) — they won't change with retries
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response;
      }

      // Server error (5xx) — retryable, but return on last attempt
      lastResponse = response;
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
      lastError.status = response.status;
    } catch (error) {
      // Network error — retryable
      lastError = error;
      lastResponse = null;
    }

    if (attempt < maxRetries) {
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const jitter = delay * (0.5 + Math.random() * 0.5); // 50-100% of delay
      log.debug(`Retry ${attempt + 1}/${maxRetries} in ${Math.round(jitter)}ms:`, String(url).slice(0, 80));
      await new Promise(resolve => setTimeout(resolve, jitter));
    }
  }

  // On exhausted retries: return response if we have one (let caller handle),
  // throw if we only have network errors
  if (lastResponse) {
    return lastResponse;
  }
  throw lastError;
}
