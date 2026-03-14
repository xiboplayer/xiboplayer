// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  parseRangeHeader,
  createMediaHeaders,
  createErrorResponse,
  getChunkBoundaries,
  getChunksForRange,
  extractRangeFromChunks,
  HTTP_STATUS,
  TIMEOUTS,
} from './sw-utils.js';

describe('formatBytes', () => {
  it('returns 0 Bytes for zero', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
  });

  it('returns bytes for < 1024', () => {
    expect(formatBytes(512)).toBe('512 Bytes');
    expect(formatBytes(1)).toBe('1 Bytes');
  });

  it('returns KB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('returns MB', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(1572864)).toBe('1.5 MB');
  });

  it('returns GB', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GB');
  });

  it('respects decimals parameter', () => {
    expect(formatBytes(1536, 2)).toBe('1.50 KB');
    expect(formatBytes(1536, 0)).toBe('2 KB');
  });
});

describe('parseRangeHeader', () => {
  it('parses full range', () => {
    expect(parseRangeHeader('bytes=0-999', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('parses open-ended range', () => {
    expect(parseRangeHeader('bytes=500-', 2000)).toEqual({ start: 500, end: 1999 });
  });

  it('parses range from start', () => {
    expect(parseRangeHeader('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 });
  });
});

describe('createMediaHeaders', () => {
  it('includes Content-Type and Accept-Ranges', () => {
    const h = createMediaHeaders({ contentType: 'video/mp4' });
    expect(h['Content-Type']).toBe('video/mp4');
    expect(h['Accept-Ranges']).toBe('bytes');
    expect(h['Access-Control-Allow-Origin']).toBe('*');
  });

  it('includes Content-Length when provided', () => {
    const h = createMediaHeaders({ contentLength: 1000 });
    expect(h['Content-Length']).toBe('1000');
  });

  it('includes Cache-Control when includeCache is true', () => {
    const h = createMediaHeaders({ includeCache: true });
    expect(h['Cache-Control']).toContain('max-age=');
  });

  it('includes Content-Range when provided', () => {
    const h = createMediaHeaders({ contentRange: 'bytes 0-999/2000' });
    expect(h['Content-Range']).toBe('bytes 0-999/2000');
  });

  it('defaults to application/octet-stream', () => {
    const h = createMediaHeaders({});
    expect(h['Content-Type']).toBe('application/octet-stream');
  });
});

describe('createErrorResponse', () => {
  it('creates 404 response', () => {
    const r = createErrorResponse('not found', 404);
    expect(r.status).toBe(404);
    expect(r.statusText).toBe('Not Found');
  });

  it('creates 500 response by default', () => {
    const r = createErrorResponse('boom');
    expect(r.status).toBe(500);
    expect(r.statusText).toBe('Internal Server Error');
  });

  it('uses generic text for unknown codes', () => {
    const r = createErrorResponse('teapot', 418);
    expect(r.status).toBe(418);
    expect(r.statusText).toBe('Error');
  });
});

describe('HTTP_STATUS', () => {
  it('exports expected status codes', () => {
    expect(HTTP_STATUS.OK).toBe(200);
    expect(HTTP_STATUS.PARTIAL_CONTENT).toBe(206);
    expect(HTTP_STATUS.NOT_FOUND).toBe(404);
    expect(HTTP_STATUS.INTERNAL_ERROR).toBe(500);
  });
});

describe('TIMEOUTS', () => {
  it('exports expected timeout values', () => {
    expect(TIMEOUTS.SW_CLAIM_WAIT).toBe(100);
    expect(TIMEOUTS.DOWNLOAD_CHECK).toBe(1000);
  });
});

describe('getChunkBoundaries', () => {
  const CHUNK = 1000;
  const TOTAL = 2500;

  it('returns first chunk', () => {
    expect(getChunkBoundaries(0, CHUNK, TOTAL)).toEqual({ start: 0, end: 1000, size: 1000 });
  });

  it('returns middle chunk', () => {
    expect(getChunkBoundaries(1, CHUNK, TOTAL)).toEqual({ start: 1000, end: 2000, size: 1000 });
  });

  it('returns last (partial) chunk', () => {
    expect(getChunkBoundaries(2, CHUNK, TOTAL)).toEqual({ start: 2000, end: 2500, size: 500 });
  });
});

describe('getChunksForRange', () => {
  const CHUNK = 1000;

  it('returns single chunk for small range', () => {
    expect(getChunksForRange(0, 500, CHUNK)).toEqual({ startChunk: 0, endChunk: 0, count: 1 });
  });

  it('returns multiple chunks for spanning range', () => {
    expect(getChunksForRange(500, 1500, CHUNK)).toEqual({ startChunk: 0, endChunk: 1, count: 2 });
  });

  it('returns chunk at end of file', () => {
    expect(getChunksForRange(2000, 2499, CHUNK)).toEqual({ startChunk: 2, endChunk: 2, count: 1 });
  });
});

describe('extractRangeFromChunks', () => {
  it('extracts from single chunk', () => {
    const blob = new Blob(['0123456789']);
    const result = extractRangeFromChunks([blob], 3, 6, 10, 'text/plain');
    expect(result).toBeInstanceOf(Blob);
    expect(result.size).toBe(4); // bytes 3,4,5,6
  });

  it('extracts from multiple chunks', () => {
    const c1 = new Blob(['aaaa']); // 4 bytes
    const c2 = new Blob(['bbbb']); // 4 bytes
    const result = extractRangeFromChunks([c1, c2], 2, 5, 4, 'text/plain');
    // From chunk 0: bytes 2-3 (2 bytes), from chunk 1: bytes 0-1 (2 bytes)
    expect(result).toBeInstanceOf(Blob);
    expect(result.size).toBe(4);
  });
});
