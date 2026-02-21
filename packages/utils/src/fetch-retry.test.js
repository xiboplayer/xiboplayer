/**
 * Tests for fetchWithRetry utility
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchWithRetry } from './fetch-retry.js';

describe('fetchWithRetry', () => {
  let mockFetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return response on success', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const response = await fetchWithRetry('https://example.com');

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should return 4xx responses without retrying', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

    const response = await fetchWithRetry('https://example.com', {}, { maxRetries: 3 });

    expect(response.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No retry for 4xx
  });

  it('should retry on 5xx and return last response when exhausted', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

    const promise = fetchWithRetry('https://example.com', {}, { maxRetries: 2, baseDelayMs: 100 });

    // Advance through retry delays
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    const response = await promise;
    expect(response.status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 original + 2 retries
  });

  it('should throw on network error after retries exhausted', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const promise = fetchWithRetry('https://example.com', {}, { maxRetries: 1, baseDelayMs: 100 });
    // Attach .catch() early to prevent Node's unhandled rejection detection
    // (the rejection is intentional and will be asserted below)
    const handled = promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(200);

    await expect(promise).rejects.toThrow('Network error');
    await handled;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should succeed on retry after initial failure', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const promise = fetchWithRetry('https://example.com', {}, { maxRetries: 2, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    const response = await promise;
    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should not retry with maxRetries=0', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' });

    const response = await fetchWithRetry('https://example.com', {}, { maxRetries: 0 });

    expect(response.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should cap delay at maxDelayMs', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' });

    // With baseDelayMs=1000 and maxRetries=5, delays would be 1s, 2s, 4s, 8s, 16s
    // But maxDelayMs=3000 should cap at 3s
    const promise = fetchWithRetry('https://example.com', {}, {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 3000
    });

    // Advance enough time for all retries (jitter makes exact timing unpredictable)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(3000);
    }

    const response = await promise;
    expect(response.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('should retry on HTTP 429 with Retry-After header', async () => {
    const headers429 = { get: (name) => name === 'Retry-After' ? '1' : null };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests', headers: headers429 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const promise = fetchWithRetry('https://example.com', {}, { maxRetries: 2, baseDelayMs: 100 });

    // Advance past the 1s Retry-After delay
    await vi.advanceTimersByTimeAsync(1500);

    const response = await promise;
    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should return 429 response when retries exhausted', async () => {
    const headers429 = { get: (name) => name === 'Retry-After' ? '1' : null };
    mockFetch.mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests', headers: headers429 });

    const promise = fetchWithRetry('https://example.com', {}, { maxRetries: 1, baseDelayMs: 100 });

    // Advance past the Retry-After delay
    await vi.advanceTimersByTimeAsync(2000);

    const response = await promise;
    expect(response.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 original + 1 retry
  });

  it('should parse Retry-After as HTTP-date', async () => {
    // Set a date 2 seconds in the future
    const futureDate = new Date(Date.now() + 2000).toUTCString();
    const headers429 = { get: (name) => name === 'Retry-After' ? futureDate : null };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests', headers: headers429 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const promise = fetchWithRetry('https://example.com', {}, { maxRetries: 2, baseDelayMs: 100 });

    // Advance past the ~2s date-based delay
    await vi.advanceTimersByTimeAsync(3000);

    const response = await promise;
    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should not cap 429 delay at maxDelayMs', async () => {
    // Server asks for 5s, but maxDelayMs is only 1s — 429 should still wait 5s
    const headers429 = { get: (name) => name === 'Retry-After' ? '5' : null };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests', headers: headers429 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const promise = fetchWithRetry('https://example.com', {}, { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000 });

    // 1s is not enough — should still be waiting
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // 5s total should be enough
    await vi.advanceTimersByTimeAsync(4500);

    const response = await promise;
    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should use default 30s delay when Retry-After header is missing on 429', async () => {
    const headers429 = { get: () => null };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests', headers: headers429 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const promise = fetchWithRetry('https://example.com', {}, { maxRetries: 2, baseDelayMs: 100 });

    // 10s is not enough — default is 30s
    await vi.advanceTimersByTimeAsync(10000);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // 30s total should be enough
    await vi.advanceTimersByTimeAsync(21000);

    const response = await promise;
    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should handle Retry-After date in the past as immediate retry', async () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString();
    const headers429 = { get: (name) => name === 'Retry-After' ? pastDate : null };
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests', headers: headers429 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const promise = fetchWithRetry('https://example.com', {}, { maxRetries: 2, baseDelayMs: 100 });

    // Past date means delay=0, should retry immediately
    await vi.advanceTimersByTimeAsync(100);

    const response = await promise;
    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
