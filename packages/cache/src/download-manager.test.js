// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * DownloadManager Tests — Flat Queue Architecture
 *
 * Tests for:
 * - DownloadTask: Single-fetch unit (one HTTP request)
 * - FileDownload: Orchestrator (HEAD + creates tasks)
 * - DownloadQueue: Flat queue with single concurrency limit
 * - DownloadManager: Public facade
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DownloadTask, FileDownload, DownloadQueue, DownloadManager, LayoutTaskBuilder, BARRIER, PRIORITY } from './download-manager.js';
import { mockFetch, mockChunkedFetch, createTestBlob, waitFor, createSpy } from './test-utils.js';

// ============================================================================
// DownloadTask — Single HTTP fetch unit
// ============================================================================

describe('DownloadTask', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('State Machine', () => {
    it('should start in pending state', () => {
      const task = new DownloadTask({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });

      expect(task.state).toBe('pending');
      expect(task.blob).toBeNull();
      expect(task.chunkIndex).toBeNull();
    });

    it('should transition pending -> downloading -> complete', async () => {
      const testBlob = createTestBlob(1024);
      const task = new DownloadTask({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });

      mockFetch({
        'GET http://test.com/file.mp4': { blob: testBlob }
      });

      await task.start();

      expect(task.state).toBe('complete');
      expect(task.blob).toBeInstanceOf(Blob);
      expect(task.blob.size).toBe(1024);
    });

    it('should transition to failed on HTTP error after retries', async () => {
      const task = new DownloadTask({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });

      mockFetch({
        'GET http://test.com/file.mp4': { ok: false, status: 500 }
      });

      await expect(task.start()).rejects.toThrow('Fetch failed: 500');
      expect(task.state).toBe('failed');
    }, 5000); // Retry backoff: 500ms + 1s + 1.5s = 3s
  });

  describe('Range Requests', () => {
    it('should send Range header for chunk tasks', async () => {
      const sourceBlob = createTestBlob(200);
      const task = new DownloadTask(
        { id: '1', type: 'media', path: 'http://test.com/file.mp4' },
        { chunkIndex: 0, rangeStart: 0, rangeEnd: 99 }
      );

      const fetchMock = mockChunkedFetch(sourceBlob);

      await task.start();

      expect(task.chunkIndex).toBe(0);
      expect(task.blob.size).toBe(100);

      // Verify Range header was sent
      const call = fetchMock.mock.calls.find(c => c[1]?.headers?.Range);
      expect(call[1].headers.Range).toBe('bytes=0-99');
    });
  });

  describe('Retry Logic', () => {
    it('should retry on failure with exponential backoff', async () => {
      const testBlob = createTestBlob(1024);
      let attempts = 0;

      global.fetch = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
          return { ok: false, status: 503, headers: { get: () => null } };
        }
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          blob: () => Promise.resolve(testBlob)
        };
      });

      const task = new DownloadTask({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });
      await task.start();

      expect(task.state).toBe('complete');
      expect(attempts).toBe(3);
    }, 5000); // Retry backoff: 500ms + 1s = 1.5s before 3rd attempt
  });
});

// ============================================================================
// FileDownload — Orchestrator
// ============================================================================

describe('FileDownload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('State Machine', () => {
    it('should start in pending state', () => {
      const file = new FileDownload({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });

      expect(file.state).toBe('pending');
      expect(file.downloadedBytes).toBe(0);
      expect(file.totalBytes).toBe(0);
      expect(file.totalChunks).toBe(0);
      expect(file.onChunkDownloaded).toBeNull();
    });
  });

  describe('Small File Downloads (≤ 100MB)', () => {
    it('should create single task and resolve wait() with blob', async () => {
      const testBlob = createTestBlob(1024);

      mockFetch({
        'HEAD http://test.com/file.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file.mp4': { blob: testBlob }
      });

      const file = new FileDownload(
        { id: '1', type: 'media', path: 'http://test.com/file.mp4' }
      );

      // Simulate what DownloadQueue does
      const mockQueue = { enqueueChunkTasks: vi.fn(), processQueue: vi.fn() };
      mockQueue.enqueueChunkTasks.mockImplementation((tasks) => {
        // Immediately start tasks (simulate queue processing)
        for (const task of tasks) {
          task.start()
            .then(() => task._parentFile.onTaskComplete(task))
            .catch(err => task._parentFile.onTaskFailed(task, err));
        }
      });

      await file.prepare(mockQueue);

      expect(file.tasks.length).toBe(1);
      expect(file.tasks[0].chunkIndex).toBeNull(); // Full file, not a chunk

      const blob = await file.wait();

      expect(file.state).toBe('complete');
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBe(1024);
      expect(file.downloadedBytes).toBe(1024);
    });

    it('should update downloadedBytes correctly', async () => {
      const testBlob = createTestBlob(5000);

      mockFetch({
        'HEAD http://test.com/file.mp4': { headers: { 'Content-Length': '5000' } },
        'GET http://test.com/file.mp4': { blob: testBlob }
      });

      const file = new FileDownload(
        { id: '1', type: 'media', path: 'http://test.com/file.mp4' }
      );

      const mockQueue = {
        enqueueChunkTasks: vi.fn((tasks) => {
          for (const task of tasks) {
            task.start()
              .then(() => task._parentFile.onTaskComplete(task))
              .catch(err => task._parentFile.onTaskFailed(task, err));
          }
        })
      };

      await file.prepare(mockQueue);
      await file.wait();

      expect(file.downloadedBytes).toBe(5000);
      expect(file.totalBytes).toBe(5000);
    });
  });

  describe('wait()', () => {
    it('should support multiple concurrent waiters', async () => {
      const testBlob = createTestBlob(1024);

      mockFetch({
        'HEAD http://test.com/file.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file.mp4': { blob: testBlob }
      });

      const file = new FileDownload(
        { id: '1', type: 'media', path: 'http://test.com/file.mp4' }
      );

      // Set up waiters before download starts
      const waiter1 = file.wait();
      const waiter2 = file.wait();
      const waiter3 = file.wait();

      const mockQueue = {
        enqueueChunkTasks: vi.fn((tasks) => {
          for (const task of tasks) {
            task.start()
              .then(() => task._parentFile.onTaskComplete(task))
              .catch(err => task._parentFile.onTaskFailed(task, err));
          }
        })
      };

      await file.prepare(mockQueue);

      // All waiters resolve with same blob
      const [blob1, blob2, blob3] = await Promise.all([waiter1, waiter2, waiter3]);
      expect(blob1).toBe(blob2);
      expect(blob2).toBe(blob3);
      expect(blob1.size).toBe(1024);
    });

    it('should still create download task when HEAD fails (graceful fallback)', async () => {
      // HEAD failure is non-fatal — the GET will be attempted
      const testBlob = createTestBlob(512);
      global.fetch = vi.fn(async (url, opts) => {
        if (opts?.method === 'HEAD') {
          return { ok: false, status: 404, headers: { get: () => null } };
        }
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          blob: () => Promise.resolve(testBlob)
        };
      });

      const file = new FileDownload(
        { id: '1', type: 'media', path: 'http://test.com/file.mp4' }
      );

      const waiter1 = file.wait();
      const waiter2 = file.wait();

      const mockQueue = {
        enqueueChunkTasks: vi.fn((tasks) => {
          for (const task of tasks) {
            task.start()
              .then(() => task._parentFile.onTaskComplete(task))
              .catch(err => task._parentFile.onTaskFailed(task, err));
          }
        })
      };
      await file.prepare(mockQueue);

      // Both waiters resolve (GET succeeds despite HEAD failing)
      const [blob1, blob2] = await Promise.all([waiter1, waiter2]);
      expect(blob1).toBe(blob2);
      expect(file.state).toBe('complete');
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error('Network error')));

      const file = new FileDownload(
        { id: '1', type: 'media', path: 'http://test.com/file.mp4' }
      );

      const mockQueue = { enqueueChunkTasks: vi.fn() };
      await file.prepare(mockQueue);

      await expect(file.wait()).rejects.toThrow('Network error');
      expect(file.state).toBe('failed');
    });

    it('should fail when both HEAD and GET fail', async () => {
      // When HEAD fails (size unknown) and GET also fails → download fails
      global.fetch = vi.fn(async () => {
        return { ok: false, status: 500, headers: { get: () => null } };
      });

      const file = new FileDownload(
        { id: '1', type: 'media', path: 'http://test.com/file.mp4' }
      );

      const mockQueue = {
        enqueueChunkTasks: vi.fn((tasks) => {
          for (const task of tasks) {
            task.start()
              .then(() => task._parentFile.onTaskComplete(task))
              .catch(err => task._parentFile.onTaskFailed(task, err));
          }
        })
      };
      await file.prepare(mockQueue);

      await expect(file.wait()).rejects.toThrow('Fetch failed: 500');
      expect(file.state).toBe('failed');
    }, 10000);
  });
});

// ============================================================================
// FileDownload - Skip HEAD when size is known
// ============================================================================

describe('FileDownload - Skip HEAD', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should skip HEAD when fileInfo.size is provided', async () => {
    const testBlob = createTestBlob(1024);
    const fetchSpy = vi.fn(async (url, opts) => {
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        blob: () => Promise.resolve(testBlob)
      };
    });
    global.fetch = fetchSpy;

    const file = new FileDownload(
      { id: '1', type: 'media', path: 'http://test.com/file.mp4', size: 1024 }
    );

    const mockQueue = {
      enqueueChunkTasks: vi.fn((tasks) => {
        for (const task of tasks) {
          task.start()
            .then(() => task._parentFile.onTaskComplete(task))
            .catch(err => task._parentFile.onTaskFailed(task, err));
        }
      })
    };

    await file.prepare(mockQueue);
    await file.wait();

    // No HEAD request should have been made — only GET
    const headCalls = fetchSpy.mock.calls.filter(c => c[1]?.method === 'HEAD');
    expect(headCalls.length).toBe(0);
    expect(file.totalBytes).toBe(1024);
    expect(file.state).toBe('complete');
  });

  it('should fall back to HEAD when size is 0', async () => {
    const testBlob = createTestBlob(2048);
    global.fetch = vi.fn(async (url, opts) => {
      if (opts?.method === 'HEAD') {
        return {
          ok: true, status: 200,
          headers: { get: (name) => name === 'Content-Length' ? '2048' : 'video/mp4' }
        };
      }
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        blob: () => Promise.resolve(testBlob)
      };
    });

    const file = new FileDownload(
      { id: '1', type: 'media', path: 'http://test.com/file.mp4', size: 0 }
    );

    const mockQueue = {
      enqueueChunkTasks: vi.fn((tasks) => {
        for (const task of tasks) {
          task.start()
            .then(() => task._parentFile.onTaskComplete(task))
            .catch(err => task._parentFile.onTaskFailed(task, err));
        }
      })
    };

    await file.prepare(mockQueue);
    await file.wait();

    // HEAD was called as fallback
    const headCalls = global.fetch.mock.calls.filter(c => c[1]?.method === 'HEAD');
    expect(headCalls.length).toBe(1);
    expect(file.totalBytes).toBe(2048);
  });

  it('should fall back to HEAD when size is missing', async () => {
    const testBlob = createTestBlob(512);
    global.fetch = vi.fn(async (url, opts) => {
      if (opts?.method === 'HEAD') {
        return {
          ok: true, status: 200,
          headers: { get: (name) => name === 'Content-Length' ? '512' : null }
        };
      }
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        blob: () => Promise.resolve(testBlob)
      };
    });

    const file = new FileDownload(
      { id: '1', type: 'media', path: 'http://test.com/file.mp4' }
    );

    const mockQueue = {
      enqueueChunkTasks: vi.fn((tasks) => {
        for (const task of tasks) {
          task.start()
            .then(() => task._parentFile.onTaskComplete(task))
            .catch(err => task._parentFile.onTaskFailed(task, err));
        }
      })
    };

    await file.prepare(mockQueue);

    const headCalls = global.fetch.mock.calls.filter(c => c[1]?.method === 'HEAD');
    expect(headCalls.length).toBe(1);
  });

  it('should infer content type from file extension', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      blob: () => Promise.resolve(createTestBlob(100))
    }));

    const file = new FileDownload(
      { id: '1', type: 'media', path: 'http://test.com/image.png', size: 100 }
    );

    const mockQueue = {
      enqueueChunkTasks: vi.fn((tasks) => {
        for (const task of tasks) {
          task.start()
            .then(() => task._parentFile.onTaskComplete(task))
            .catch(err => task._parentFile.onTaskFailed(task, err));
        }
      })
    };

    await file.prepare(mockQueue);

    expect(file._contentType).toBe('image/png');
  });
});

// ============================================================================
// FileDownload - Progressive Streaming
// ============================================================================

describe('FileDownload - Progressive Streaming', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('onChunkDownloaded callback', () => {
    it('should initialize onChunkDownloaded as null', () => {
      const file = new FileDownload({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });
      expect(file.onChunkDownloaded).toBeNull();
    });

    it('should call onChunkDownloaded for each chunk during chunked download', async () => {
      // 200MB file → will use chunks (threshold is 100MB)
      const fileSize = 200 * 1024 * 1024;
      const sourceBlob = createTestBlob(fileSize, 'video/mp4');

      mockChunkedFetch(sourceBlob);

      const file = new FileDownload(
        { id: '1', type: 'media', path: 'http://test.com/big.mp4' },
        { chunkSize: 50 * 1024 * 1024 }
      );

      const chunkCalls = [];
      file.onChunkDownloaded = vi.fn(async (index, blob, total) => {
        chunkCalls.push({ index, size: blob.size, total });
      });

      // Process tasks sequentially — onTaskComplete is async (awaits
      // onChunkDownloaded), so concurrent fire-and-forget causes _resolve()
      // to race ahead of pending callbacks.
      const mockQueue = {
        enqueueChunkTasks: vi.fn(async (tasks) => {
          for (const task of tasks) {
            try {
              await task.start();
              await task._parentFile.onTaskComplete(task);
            } catch (err) {
              task._parentFile.onTaskFailed(task, err);
            }
          }
        })
      };

      await file.prepare(mockQueue);
      await file.wait();

      // 200MB / 50MB = 4 chunks
      expect(file.onChunkDownloaded).toHaveBeenCalledTimes(4);
      expect(chunkCalls.length).toBe(4);

      for (const call of chunkCalls) {
        expect(call.total).toBe(4);
        expect(call.size).toBeGreaterThan(0);
      }

      // All chunk indices should be present
      const indices = chunkCalls.map(c => c.index).sort();
      expect(indices).toEqual([0, 1, 2, 3]);
    });

    it('should return empty blob when onChunkDownloaded is set', async () => {
      const fileSize = 200 * 1024 * 1024;
      const sourceBlob = createTestBlob(fileSize, 'video/mp4');

      mockChunkedFetch(sourceBlob);

      const file = new FileDownload(
        { id: '1', type: 'media', path: 'http://test.com/big.mp4' },
        { chunkSize: 50 * 1024 * 1024 }
      );

      file.onChunkDownloaded = vi.fn(async () => {});

      const mockQueue = {
        enqueueChunkTasks: vi.fn((tasks) => {
          for (const task of tasks) {
            task.start()
              .then(() => task._parentFile.onTaskComplete(task))
              .catch(err => task._parentFile.onTaskFailed(task, err));
          }
        })
      };

      await file.prepare(mockQueue);
      const blob = await file.wait();

      expect(blob.size).toBe(0);
      expect(file.state).toBe('complete');
    });

    it('should return full blob when onChunkDownloaded is NOT set', async () => {
      const fileSize = 200 * 1024 * 1024;
      const sourceBlob = createTestBlob(fileSize, 'video/mp4');

      mockChunkedFetch(sourceBlob);

      const file = new FileDownload(
        { id: '1', type: 'media', path: 'http://test.com/big.mp4' },
        { chunkSize: 50 * 1024 * 1024 }
      );

      // No callback → traditional reassembly
      const mockQueue = {
        enqueueChunkTasks: vi.fn((tasks) => {
          for (const task of tasks) {
            task.start()
              .then(() => task._parentFile.onTaskComplete(task))
              .catch(err => task._parentFile.onTaskFailed(task, err));
          }
        })
      };

      await file.prepare(mockQueue);
      const blob = await file.wait();

      expect(blob.size).toBe(fileSize);
      expect(file.state).toBe('complete');
    });

    it('should not call onChunkDownloaded for small files (single request)', async () => {
      const fileSize = 10 * 1024 * 1024; // 10MB - below 100MB threshold
      const sourceBlob = createTestBlob(fileSize);

      mockChunkedFetch(sourceBlob);

      const file = new FileDownload(
        { id: '1', type: 'media', path: 'http://test.com/small.mp4' },
        { chunkSize: 50 * 1024 * 1024 }
      );

      file.onChunkDownloaded = vi.fn(async () => {});

      const mockQueue = {
        enqueueChunkTasks: vi.fn((tasks) => {
          for (const task of tasks) {
            task.start()
              .then(() => task._parentFile.onTaskComplete(task))
              .catch(err => task._parentFile.onTaskFailed(task, err));
          }
        })
      };

      await file.prepare(mockQueue);
      const blob = await file.wait();

      // Small file uses single task → callback not called
      expect(file.onChunkDownloaded).not.toHaveBeenCalled();
      expect(blob.size).toBe(fileSize);
    });

    it('should handle async callback errors gracefully', async () => {
      const fileSize = 200 * 1024 * 1024;
      const sourceBlob = createTestBlob(fileSize, 'video/mp4');

      mockChunkedFetch(sourceBlob);

      const file = new FileDownload(
        { id: '1', type: 'media', path: 'http://test.com/big.mp4' },
        { chunkSize: 50 * 1024 * 1024 }
      );

      // Callback throws — should not crash download
      file.onChunkDownloaded = vi.fn(async () => {
        throw new Error('Cache storage failed');
      });

      const mockQueue = {
        enqueueChunkTasks: vi.fn((tasks) => {
          for (const task of tasks) {
            task.start()
              .then(() => task._parentFile.onTaskComplete(task))
              .catch(err => task._parentFile.onTaskFailed(task, err));
          }
        })
      };

      await file.prepare(mockQueue);
      await file.wait();

      expect(file.state).toBe('complete');
      expect(file.onChunkDownloaded).toHaveBeenCalledTimes(4);
    });
  });
});

// ============================================================================
// DownloadQueue
// ============================================================================

describe('DownloadQueue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Concurrency Control', () => {
    it('should respect concurrency limit', async () => {
      const queue = new DownloadQueue({ concurrency: 2 });

      // Mock slow downloads to test concurrency
      const testBlob = createTestBlob(1024);
      global.fetch = vi.fn(async (url, options) => {
        // Delay to simulate network
        await new Promise(resolve => setTimeout(resolve, 100));

        if (options?.method === 'HEAD') {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name) => name === 'Content-Length' ? '1024' : null
            }
          };
        }

        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          blob: () => Promise.resolve(testBlob)
        };
      });

      // Enqueue 5 files
      queue.enqueue({ id: '1', type: 'media', path: 'http://test.com/file1.mp4' });
      queue.enqueue({ id: '2', type: 'media', path: 'http://test.com/file2.mp4' });
      queue.enqueue({ id: '3', type: 'media', path: 'http://test.com/file3.mp4' });
      queue.enqueue({ id: '4', type: 'media', path: 'http://test.com/file4.mp4' });
      queue.enqueue({ id: '5', type: 'media', path: 'http://test.com/file5.mp4' });

      // Wait for HEAD requests + queue processing to start
      await new Promise(resolve => setTimeout(resolve, 200));

      // Invariant: running <= concurrency
      expect(queue.running).toBeLessThanOrEqual(2);
    });

    it('should process queue as tasks complete', async () => {
      const queue = new DownloadQueue({ concurrency: 2 });

      const testBlob = createTestBlob(1024);
      mockFetch({
        'HEAD http://test.com/file1.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file1.mp4': { blob: testBlob },
        'HEAD http://test.com/file2.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file2.mp4': { blob: testBlob },
        'HEAD http://test.com/file3.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file3.mp4': { blob: testBlob }
      });

      const file1 = queue.enqueue({ id: '1', type: 'media', path: 'http://test.com/file1.mp4' });
      const file2 = queue.enqueue({ id: '2', type: 'media', path: 'http://test.com/file2.mp4' });
      const file3 = queue.enqueue({ id: '3', type: 'media', path: 'http://test.com/file3.mp4' });

      // Wait for all to complete
      await Promise.all([file1.wait(), file2.wait(), file3.wait()]);

      // Post-condition: all complete, files stay in active until removeCompleted()
      expect(queue.running).toBe(0);
      expect(queue.queue.length).toBe(0);
      expect(queue.active.size).toBe(3);

      // Simulate caller removing after caching
      queue.removeCompleted('media/1');
      queue.removeCompleted('media/2');
      queue.removeCompleted('media/3');
      expect(queue.active.size).toBe(0);
    });
  });

  describe('Idempotent Enqueue', () => {
    it('should return same FileDownload for duplicate file IDs', async () => {
      const queue = new DownloadQueue();

      const testBlob = createTestBlob(1024);
      mockFetch({
        'HEAD http://test.com/file.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file.mp4': { blob: testBlob }
      });

      const file1 = queue.enqueue({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });
      const file2 = queue.enqueue({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });

      expect(file1).toBe(file2);
      expect(queue.active.size).toBe(1);
    });

    it('should deduplicate same file with different signed URLs', () => {
      const queue = new DownloadQueue();
      const testBlob = createTestBlob(1024);
      mockFetch({
        'HEAD http://test.com/file.mp4?token=abc': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file.mp4?token=abc': { blob: testBlob }
      });

      const file1 = queue.enqueue({ id: '1', type: 'media', path: 'http://test.com/file.mp4?token=abc' });
      const file2 = queue.enqueue({ id: '1', type: 'media', path: 'http://test.com/file.mp4?token=xyz' });

      expect(file1).toBe(file2);
      expect(queue.active.size).toBe(1);
    });

    it('should create different FileDownloads for different file IDs', () => {
      const queue = new DownloadQueue();
      const testBlob = createTestBlob(1024);
      mockFetch({
        'HEAD http://test.com/file1.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file1.mp4': { blob: testBlob },
        'HEAD http://test.com/file2.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file2.mp4': { blob: testBlob }
      });

      const file1 = queue.enqueue({ id: '1', type: 'media', path: 'http://test.com/file1.mp4' });
      const file2 = queue.enqueue({ id: '2', type: 'media', path: 'http://test.com/file2.mp4' });

      expect(file1).not.toBe(file2);
      expect(queue.active.size).toBe(2);
    });
  });

  describe('getTask()', () => {
    it('should return active FileDownload', () => {
      const queue = new DownloadQueue();
      const testBlob = createTestBlob(1024);
      mockFetch({
        'HEAD http://test.com/file.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file.mp4': { blob: testBlob }
      });

      const file = queue.enqueue({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });
      const retrieved = queue.getTask('media/1');

      expect(retrieved).toBe(file);
    });

    it('should return null for non-existent task', () => {
      const queue = new DownloadQueue();
      expect(queue.getTask('media/999')).toBeNull();
    });
  });

  describe('clear()', () => {
    it('should clear queue and active files', () => {
      const queue = new DownloadQueue();
      const testBlob = createTestBlob(1024);
      mockFetch({
        'HEAD http://test.com/file1.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file1.mp4': { blob: testBlob },
        'HEAD http://test.com/file2.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file2.mp4': { blob: testBlob },
        'HEAD http://test.com/file3.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file3.mp4': { blob: testBlob }
      });

      queue.enqueue({ id: '1', type: 'media', path: 'http://test.com/file1.mp4' });
      queue.enqueue({ id: '2', type: 'media', path: 'http://test.com/file2.mp4' });
      queue.enqueue({ id: '3', type: 'media', path: 'http://test.com/file3.mp4' });

      queue.clear();

      expect(queue.queue.length).toBe(0);
      expect(queue.active.size).toBe(0);
      expect(queue.running).toBe(0);
    });
  });
});

// ============================================================================
// DownloadQueue - Priority
// ============================================================================

// ============================================================================
// DownloadManager
// ============================================================================

describe('DownloadManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('API Delegation', () => {
    it('should delegate enqueue to queue', () => {
      const testBlob = createTestBlob(1024);
      mockFetch({
        'HEAD http://test.com/file.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file.mp4': { blob: testBlob }
      });
      const manager = new DownloadManager({ concurrency: 4 });

      const file = manager.enqueue({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });

      expect(file).toBeInstanceOf(FileDownload);
      expect(manager.queue.active.has('media/1')).toBe(true);
    });

    it('should delegate getTask to queue', () => {
      const testBlob = createTestBlob(1024);
      mockFetch({
        'HEAD http://test.com/file.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file.mp4': { blob: testBlob }
      });
      const manager = new DownloadManager();

      const file = manager.enqueue({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });
      const retrieved = manager.getTask('media/1');

      expect(retrieved).toBe(file);
    });

    it('should delegate getProgress to queue', () => {
      const testBlob = createTestBlob(1024);
      mockFetch({
        'HEAD http://test.com/file.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file.mp4': { blob: testBlob }
      });
      const manager = new DownloadManager();

      manager.enqueue({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });

      const progress = manager.getProgress();

      expect(progress).toBeDefined();
      expect(typeof progress).toBe('object');
    });

    it('should delegate clear to queue', () => {
      const testBlob = createTestBlob(1024);
      mockFetch({
        'HEAD http://test.com/file.mp4': { headers: { 'Content-Length': '1024' } },
        'GET http://test.com/file.mp4': { blob: testBlob }
      });
      const manager = new DownloadManager();

      manager.enqueue({ id: '1', type: 'media', path: 'http://test.com/file.mp4' });
      manager.clear();

      expect(manager.queue.queue.length).toBe(0);
      expect(manager.queue.active.size).toBe(0);
    });
  });

  describe('Configuration', () => {
    it('should pass concurrency to queue', () => {
      const manager = new DownloadManager({ concurrency: 8 });

      expect(manager.queue.concurrency).toBe(8);
    });

    it('should pass chunkSize to queue', () => {
      const manager = new DownloadManager({ chunkSize: 25 * 1024 * 1024 });

      expect(manager.queue.chunkSize).toBe(25 * 1024 * 1024);
    });

    it('should use defaults if not specified', () => {
      const manager = new DownloadManager();

      expect(manager.queue.concurrency).toBe(6); // DEFAULT_CONCURRENCY
      expect(manager.queue.chunkSize).toBe(50 * 1024 * 1024); // DEFAULT_CHUNK_SIZE
    });
  });
});

// ============================================================================
// Resume Support
// ============================================================================

describe('FileDownload - Resume', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should skip cached chunks when resuming', async () => {
    const fileSize = 200 * 1024 * 1024; // 200MB = 4 chunks
    const sourceBlob = createTestBlob(fileSize, 'video/mp4');

    mockChunkedFetch(sourceBlob);

    // Chunks 0 and 1 already cached
    const file = new FileDownload(
      { id: '1', type: 'media', path: 'http://test.com/big.mp4', skipChunks: new Set([0, 1]) },
      { chunkSize: 50 * 1024 * 1024 }
    );

    const mockQueue = {
      enqueueChunkTasks: vi.fn((tasks) => {
        for (const task of tasks) {
          task.start()
            .then(() => task._parentFile.onTaskComplete(task))
            .catch(err => task._parentFile.onTaskFailed(task, err));
        }
      })
    };

    await file.prepare(mockQueue);

    // Should only create tasks for chunks 2 and 3
    expect(file.tasks.length).toBe(2);
    expect(file.tasks[0].chunkIndex).toBe(2);
    expect(file.tasks[1].chunkIndex).toBe(3);

    // All tasks should be normal priority (resume mode)
    expect(file.tasks.every(t => t._priority === 0)).toBe(true); // PRIORITY.normal

    await file.wait();

    expect(file.state).toBe('complete');
    // downloadedBytes includes skipped chunks
    expect(file.downloadedBytes).toBeGreaterThan(0);
  });

  it('should resolve immediately when all chunks cached', async () => {
    const fileSize = 200 * 1024 * 1024;
    const sourceBlob = createTestBlob(fileSize, 'video/mp4');

    mockChunkedFetch(sourceBlob);

    // All 4 chunks already cached
    const file = new FileDownload(
      { id: '1', type: 'media', path: 'http://test.com/big.mp4', skipChunks: new Set([0, 1, 2, 3]) },
      { chunkSize: 50 * 1024 * 1024 }
    );

    const mockQueue = { enqueueChunkTasks: vi.fn() };

    await file.prepare(mockQueue);

    // No tasks should be created
    expect(file.tasks.length).toBe(0);
    expect(mockQueue.enqueueChunkTasks).not.toHaveBeenCalled();

    const blob = await file.wait();
    expect(blob.size).toBe(0); // Empty blob — data already in cache
    expect(file.state).toBe('complete');
  });
});

// ============================================================================
// BARRIER — Hard gate in download queue
// ============================================================================

describe('BARRIER', () => {
  it('should be a unique Symbol', () => {
    expect(typeof BARRIER).toBe('symbol');
    expect(BARRIER.toString()).toContain('BARRIER');
  });
});

describe('DownloadQueue - Barrier Support', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: create a DownloadTask with a mock parent FileDownload.
   * The task is in 'pending' state and can be started via _startTask().
   */
  function createMockTask(fileId, opts = {}) {
    const fileInfo = { id: fileId, type: 'media', path: `http://test.com/${fileId}.mp4` };
    const file = new FileDownload(fileInfo);
    file._runningCount = 0;
    file.totalChunks = opts.totalChunks ?? 1;
    const task = new DownloadTask(fileInfo, {
      chunkIndex: opts.chunkIndex ?? null,
      rangeStart: opts.rangeStart ?? null,
      rangeEnd: opts.rangeEnd ?? null
    });
    task._parentFile = file;
    task._priority = opts.priority ?? PRIORITY.normal;
    return task;
  }

  describe('enqueueOrderedTasks()', () => {
    it('should push tasks and barriers preserving order', () => {
      const queue = new DownloadQueue({ concurrency: 1 });
      // Override processQueue to prevent auto-start for this test
      queue.processQueue = vi.fn();

      const t1 = createMockTask('1');
      const t2 = createMockTask('2');
      const t3 = createMockTask('3');

      queue.enqueueOrderedTasks([t1, t2, BARRIER, t3]);

      expect(queue.queue.length).toBe(4);
      expect(queue.queue[0]).toBe(t1);
      expect(queue.queue[1]).toBe(t2);
      expect(queue.queue[2]).toBe(BARRIER);
      expect(queue.queue[3]).toBe(t3);
    });
  });

  describe('processQueue() with barriers', () => {
    it('should stop at barrier when tasks are in-flight', () => {
      const queue = new DownloadQueue({ concurrency: 6 });
      const startedTasks = [];

      // Override _startTask to track starts without actual HTTP
      queue._startTask = (task) => {
        queue.running++;
        task._parentFile._runningCount++;
        startedTasks.push(task);
      };

      const t1 = createMockTask('1');
      const t2 = createMockTask('2');
      const t3 = createMockTask('3'); // Should NOT start (behind barrier)

      queue.enqueueOrderedTasks([t1, t2, BARRIER, t3]);
      queue.processQueue();

      // t1 and t2 should start, t3 should NOT (barrier blocks)
      expect(startedTasks.length).toBe(2);
      expect(startedTasks).toContain(t1);
      expect(startedTasks).toContain(t2);
      expect(startedTasks).not.toContain(t3);
      // Barrier and t3 remain in queue
      expect(queue.queue.length).toBe(2);
      expect(queue.queue[0]).toBe(BARRIER);
      expect(queue.queue[1]).toBe(t3);
    });

    it('should pass through barrier when no tasks are in-flight', () => {
      const queue = new DownloadQueue({ concurrency: 6 });
      const startedTasks = [];

      queue._startTask = (task) => {
        queue.running++;
        task._parentFile._runningCount++;
        startedTasks.push(task);
      };

      const t1 = createMockTask('1');

      // Barrier at front with nothing running → should pass through
      queue.enqueueOrderedTasks([BARRIER, t1]);
      queue.processQueue();

      expect(startedTasks.length).toBe(1);
      expect(startedTasks[0]).toBe(t1);
      expect(queue.queue.length).toBe(0);
    });

    it('should process tasks after barrier completes', () => {
      const queue = new DownloadQueue({ concurrency: 6 });
      const startedTasks = [];

      queue._startTask = (task) => {
        queue.running++;
        task._parentFile._runningCount++;
        queue._activeTasks.push(task);
        startedTasks.push(task);
      };

      const t1 = createMockTask('1');
      const t2 = createMockTask('2');

      queue.enqueueOrderedTasks([t1, BARRIER, t2]);
      queue.processQueue();

      // Only t1 should start (barrier blocks t2)
      expect(startedTasks.length).toBe(1);
      expect(startedTasks[0]).toBe(t1);

      // Simulate t1 completing
      queue.running--;
      t1._parentFile._runningCount--;
      queue._activeTasks = [];

      // Re-process: barrier should lift, t2 should start
      queue.processQueue();

      expect(startedTasks.length).toBe(2);
      expect(startedTasks[1]).toBe(t2);
      expect(queue.queue.length).toBe(0);
    });

    it('should keep slots empty when barrier is hit (no fill-ahead)', () => {
      const queue = new DownloadQueue({ concurrency: 4 });
      const startedTasks = [];

      queue._startTask = (task) => {
        queue.running++;
        task._parentFile._runningCount++;
        startedTasks.push(task);
      };

      const t1 = createMockTask('1');
      const t2 = createMockTask('2');
      const t3 = createMockTask('3');

      // 2 tasks above barrier, 1 below. With concurrency=4, 2 slots should stay empty.
      queue.enqueueOrderedTasks([t1, t2, BARRIER, t3]);
      queue.processQueue();

      expect(startedTasks.length).toBe(2);
      expect(queue.running).toBe(2);
      // 2 of 4 slots are empty — barrier enforced
    });

    it('should handle consecutive barriers', () => {
      const queue = new DownloadQueue({ concurrency: 6 });
      const startedTasks = [];

      queue._startTask = (task) => {
        queue.running++;
        task._parentFile._runningCount++;
        startedTasks.push(task);
      };

      const t1 = createMockTask('1');
      const t2 = createMockTask('2');

      queue.enqueueOrderedTasks([t1, BARRIER, BARRIER, t2]);
      queue.processQueue();

      // t1 starts, both barriers block t2
      expect(startedTasks.length).toBe(1);
      expect(startedTasks[0]).toBe(t1);

      // Complete t1
      queue.running = 0;
      queue.processQueue();

      // Both barriers should be consumed, t2 starts
      expect(startedTasks.length).toBe(2);
      expect(startedTasks[1]).toBe(t2);
    });
  });

  describe('urgentChunk() bypasses barriers', () => {
    it('should move urgent chunk to front of queue past barriers', () => {
      const queue = new DownloadQueue({ concurrency: 1 });
      // Prevent processQueue from actually starting tasks
      queue.processQueue = vi.fn();

      const file = new FileDownload({ id: '1', type: 'media', path: 'http://test.com/1.mp4' });
      file._runningCount = 0;
      file.totalChunks = 5;
      queue.active.set('media/1', file);

      // Create tasks with barrier between them
      const chunk0 = new DownloadTask(
        { id: '1', type: 'media', path: 'http://test.com/1.mp4' },
        { chunkIndex: 0 }
      );
      chunk0._parentFile = file;
      const chunk3 = new DownloadTask(
        { id: '1', type: 'media', path: 'http://test.com/1.mp4' },
        { chunkIndex: 3 }
      );
      chunk3._parentFile = file;

      queue.queue = [chunk0, BARRIER, chunk3];

      // Urgent chunk 3 — should move to front, past barrier
      const acted = queue.urgentChunk('media', '1', 3);

      expect(acted).toBe(true);
      expect(queue.queue[0]).toBe(chunk3);
      expect(queue.queue[0]._priority).toBe(PRIORITY.urgent);
      // chunk0 and barrier should still be there
      expect(queue.queue.length).toBe(3);
    });
  });

});

// ============================================================================
// LayoutTaskBuilder — Smart builder, dumb queue
// ============================================================================

describe('LayoutTaskBuilder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: create a queue for LayoutTaskBuilder tests.
   * concurrency=0 prevents auto-processing of any tasks that leak into the real queue.
   */
  function createTestQueue(opts = {}) {
    return new DownloadQueue({ concurrency: 0, ...opts });
  }

  describe('addFile()', () => {
    it('should register file in queue.active and return FileDownload', () => {
      const queue = createTestQueue();
      const builder = new LayoutTaskBuilder(queue);

      const file = builder.addFile({ id: '1', type: 'media', path: 'http://test.com/1.mp4' });

      expect(file).toBeInstanceOf(FileDownload);
      expect(file.state).toBe('pending');
      expect(queue.active.has('media/1')).toBe(true);
      expect(queue.active.get('media/1')).toBe(file);
    });

    it('should deduplicate same file', () => {
      const queue = createTestQueue();
      const builder = new LayoutTaskBuilder(queue);

      const file1 = builder.addFile({ id: '1', type: 'media', path: 'http://test.com/1.mp4' });
      const file2 = builder.addFile({ id: '1', type: 'media', path: 'http://test.com/1.mp4' });

      expect(file1).toBe(file2);
      expect(queue.active.size).toBe(1);
    });

    it('should refresh URL with later expiry on dedup', () => {
      const queue = createTestQueue();
      const builder = new LayoutTaskBuilder(queue);

      builder.addFile({ id: '1', type: 'media', path: 'http://test.com/1.mp4?X-Amz-Expires=1000' });
      const file2 = builder.addFile({ id: '1', type: 'media', path: 'http://test.com/1.mp4?X-Amz-Expires=2000' });

      expect(file2.fileInfo.path).toContain('X-Amz-Expires=2000');
    });
  });

  describe('build()', () => {
    it('should run HEAD requests and return sorted tasks', async () => {
      const queue = createTestQueue();
      const builder = new LayoutTaskBuilder(queue);

      const testBlob = createTestBlob(1024);
      mockFetch({
        'HEAD http://test.com/1.mp4': { headers: { 'Content-Length': '1024' } },
        'HEAD http://test.com/2.mp4': { headers: { 'Content-Length': '2048' } }
      });

      builder.addFile({ id: '1', type: 'media', path: 'http://test.com/1.mp4' });
      builder.addFile({ id: '2', type: 'media', path: 'http://test.com/2.mp4' });

      const tasks = await builder.build();

      expect(tasks.length).toBe(2);
      // Sorted smallest→largest
      expect(tasks[0].fileInfo.id).toBe('1');
      expect(tasks[1].fileInfo.id).toBe('2');
    });

    it('should sort non-chunked smallest→largest', async () => {
      const queue = createTestQueue();
      const builder = new LayoutTaskBuilder(queue);

      mockFetch({
        'HEAD http://test.com/big.jpg': { headers: { 'Content-Length': '50000' } },
        'HEAD http://test.com/small.jpg': { headers: { 'Content-Length': '500' } },
        'HEAD http://test.com/med.jpg': { headers: { 'Content-Length': '5000' } }
      });

      builder.addFile({ id: 'big', type: 'media', path: 'http://test.com/big.jpg' });
      builder.addFile({ id: 'small', type: 'media', path: 'http://test.com/small.jpg' });
      builder.addFile({ id: 'med', type: 'media', path: 'http://test.com/med.jpg' });

      const tasks = await builder.build();

      expect(tasks.length).toBe(3);
      expect(tasks[0].fileInfo.id).toBe('small');
      expect(tasks[1].fileInfo.id).toBe('med');
      expect(tasks[2].fileInfo.id).toBe('big');
    });

    it('should place chunk-0 and chunk-last before BARRIER, remaining after', async () => {
      const queue = createTestQueue();
      const builder = new LayoutTaskBuilder(queue);

      // 200MB file = 4 chunks (50MB each, threshold 100MB)
      const fileSize = 200 * 1024 * 1024;
      const sourceBlob = createTestBlob(fileSize, 'video/mp4');
      mockChunkedFetch(sourceBlob);

      builder.addFile({ id: '1', type: 'media', path: 'http://test.com/big.mp4' });

      const tasks = await builder.build();

      // Should have: chunk-0, chunk-3(last), BARRIER, chunk-1, chunk-2
      const barrierIdx = tasks.indexOf(BARRIER);
      expect(barrierIdx).toBe(2); // After chunk-0 and chunk-3

      // Before barrier: chunk-0 and chunk-3 (last)
      expect(tasks[0].chunkIndex).toBe(0);
      expect(tasks[1].chunkIndex).toBe(3);

      // After barrier: remaining chunks (1, 2) sorted by index
      const afterBarrier = tasks.slice(barrierIdx + 1).filter(t => t !== BARRIER);
      expect(afterBarrier.map(t => t.chunkIndex)).toEqual([1, 2]);
    });

    it('should not add BARRIER when no chunked files', async () => {
      const queue = createTestQueue();
      const builder = new LayoutTaskBuilder(queue);

      mockFetch({
        'HEAD http://test.com/1.jpg': { headers: { 'Content-Length': '1024' } }
      });

      builder.addFile({ id: '1', type: 'media', path: 'http://test.com/1.jpg' });

      const tasks = await builder.build();

      expect(tasks.length).toBe(1);
      expect(tasks.includes(BARRIER)).toBe(false);
    });

    it('should return empty array for empty layout', async () => {
      const queue = createTestQueue();
      const builder = new LayoutTaskBuilder(queue);

      const tasks = await builder.build();

      expect(tasks).toEqual([]);
    });
  });

  describe('build() with size from RequiredFiles (no HEAD)', () => {
    it('should build instantly when fileInfo.size is provided', async () => {
      const queue = createTestQueue();
      const builder = new LayoutTaskBuilder(queue);

      // No fetch mock needed — size is provided, HEAD is skipped
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      builder.addFile({ id: '1', type: 'media', path: 'http://test.com/1.jpg', size: 1024 });
      builder.addFile({ id: '2', type: 'media', path: 'http://test.com/2.jpg', size: 2048 });

      const tasks = await builder.build();

      // No HEAD requests
      const headCalls = fetchSpy.mock.calls.filter(c => c[1]?.method === 'HEAD');
      expect(headCalls.length).toBe(0);

      // Tasks still sorted smallest→largest
      expect(tasks.length).toBe(2);
      expect(tasks[0].fileInfo.id).toBe('1');
      expect(tasks[1].fileInfo.id).toBe('2');
    });

    it('should chunk large files using declared size', async () => {
      const queue = createTestQueue();
      const builder = new LayoutTaskBuilder(queue);

      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      // 200MB file declared via size — should chunk without HEAD
      const fileSize = 200 * 1024 * 1024;
      builder.addFile({ id: '1', type: 'media', path: 'http://test.com/big.mp4', size: fileSize });

      const tasks = await builder.build();

      // No HEAD
      expect(fetchSpy).not.toHaveBeenCalled();

      // Should have chunks: chunk-0, chunk-3(last), BARRIER, chunk-1, chunk-2
      const barrierIdx = tasks.indexOf(BARRIER);
      expect(barrierIdx).toBe(2);
      expect(tasks[0].chunkIndex).toBe(0);
      expect(tasks[1].chunkIndex).toBe(3);
    });
  });

  describe('integration with enqueueOrderedTasks()', () => {
    it('should produce tasks that the queue can process', async () => {
      const queue = new DownloadQueue({ concurrency: 6 });
      const startedTasks = [];

      // Track which tasks get started
      queue._startTask = (task) => {
        queue.running++;
        task._parentFile._runningCount++;
        startedTasks.push(task);
      };

      const builder = new LayoutTaskBuilder(queue);

      mockFetch({
        'HEAD http://test.com/1.jpg': { headers: { 'Content-Length': '1024' } },
        'HEAD http://test.com/2.jpg': { headers: { 'Content-Length': '2048' } }
      });

      builder.addFile({ id: '1', type: 'media', path: 'http://test.com/1.jpg' });
      builder.addFile({ id: '2', type: 'media', path: 'http://test.com/2.jpg' });

      const tasks = await builder.build();
      queue.enqueueOrderedTasks(tasks);

      expect(startedTasks.length).toBe(2);
      // Smallest file starts first (sorted by builder)
      expect(startedTasks[0].fileInfo.id).toBe('1');
      expect(startedTasks[1].fileInfo.id).toBe('2');
    });
  });
});
