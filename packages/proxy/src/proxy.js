// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * @xiboplayer/proxy — CORS proxy + static server for Xibo Player
 *
 * Provides Express middleware that:
 * - Proxies XMDS SOAP requests (/xmds-proxy)
 * - Cache-through mirror routes: serve from store, fetch CMS on miss
 * - Serves the PWA player as static files (/player/pwa/)
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, pipeline } from 'node:stream';
import express from 'express';
import cors from 'cors';

const execPromise = promisify(exec);
import { createLogger, registerLogSink, PLAYER_API, setPlayerApi, computeCmsId } from '@xiboplayer/utils';
import { ContentStore } from './content-store.js';
import { attachSyncRelay } from './sync-relay.js';

const SKIP_HEADERS = ['transfer-encoding', 'connection', 'content-encoding', 'content-length'];

/** Redact sensitive query params (serverKey, hardwareKey, X-Amz-*) from URLs for logging */
function redactUrl(url) {
  return url.replace(/(?<=[?&])(serverKey|hardwareKey|X-Amz-[^=]*)=[^&]*/gi, '$1=***');
}

// Server-side JWT token for v2 API requests.
// Set once via POST /auth-token, injected into cache-through CMS requests.
let _bearerToken = null;

// Module-level loggers — one per subsystem, following @xiboplayer/utils conventions.
// In Node (no window/localStorage), default level is WARNING. Pass 'INFO' explicitly
// so proxy logs are always visible (these are server-side operational logs).
const logProxy = createLogger('Proxy', 'INFO');
const logFile  = createLogger('CacheThrough', 'INFO');
const logStore = createLogger('ContentStore', 'INFO');
const logConfig = createLogger('Config', 'INFO');
const logServer = createLogger('Server', 'INFO');

/**
 * Serve a chunked file from ContentStore with Range support.
 * Reads only the chunks needed for the requested range.
 */
function serveChunkedFile(req, res, store, key, meta, contentType) {
  const totalSize = meta.size || 0;
  const chunkSize = meta.chunkSize;
  const numChunks = meta.numChunks;
  const rangeHeader = req.headers.range;

  if (!totalSize || !chunkSize || !numChunks) {
    return res.status(500).json({ error: 'Incomplete chunk metadata' });
  }

  let start = 0;
  let end = totalSize - 1;
  let isRange = false;

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    start = parseInt(parts[0], 10);
    end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
    isRange = true;
  }

  const responseLen = end - start + 1;
  const startChunk = Math.floor(start / chunkSize);
  const endChunk = Math.floor(end / chunkSize);

  res.status(isRange ? 206 : 200);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', responseLen);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (isRange) {
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
  }

  // Stream chunks sequentially with backpressure handling.
  // Without backpressure, res.write() queues data in memory when the
  // client reads slower than disk I/O, causing multi-GB heap growth.
  let bytesWritten = 0;
  let currentChunk = startChunk;
  let destroyed = false;
  let activeStream = null;

  // Clean up on client disconnect — destroy any in-flight chunk stream
  req.on('close', () => {
    destroyed = true;
    if (activeStream) { activeStream.destroy(); activeStream = null; }
  });

  const writeNextChunk = () => {
    if (destroyed || currentChunk > endChunk || bytesWritten >= responseLen) {
      if (!destroyed) res.end();
      return;
    }

    const chunkStart = currentChunk * chunkSize;
    const chunkEnd = Math.min(chunkStart + chunkSize - 1, totalSize - 1);

    // Calculate the byte range within this chunk
    const readStart = currentChunk === startChunk ? start - chunkStart : 0;
    const readEnd = currentChunk === endChunk ? end - chunkStart : chunkEnd - chunkStart;

    const stream = store.getChunkReadStream(key, currentChunk, {
      start: readStart, end: readEnd,
    });

    if (!stream) {
      // Chunk not available yet (progressive download)
      if (!res.headersSent) res.status(404).end();
      else res.end();
      return;
    }

    activeStream = stream;
    currentChunk++;
    stream.on('data', (data) => {
      if (destroyed) { stream.destroy(); return; }
      bytesWritten += data.length;
      const ok = res.write(data);
      if (!ok) {
        // Backpressure: pause reading until client drains
        stream.pause();
        res.once('drain', () => stream.resume());
      }
    });
    stream.on('end', () => { activeStream = null; writeNextChunk(); });
    stream.on('error', (err) => {
      activeStream = null;
      logStore.error(`Chunk stream error: ${err.message}`);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
  };

  writeNextChunk();
}

/**
 * Create a configured Express app with CORS proxy routes and PWA static serving.
 *
 * @param {object} options
 * @param {string} options.pwaPath  — absolute path to PWA dist directory
 * @param {string} [options.appVersion='0.0.0'] — version string for User-Agent header
 * @param {object} [options.pwaConfig] — config fields to pre-seed in PWA localStorage (all non-Electron keys)
 * @param {string} [options.configFilePath] — absolute path to config.json (for POST /config writeback)
 * @param {string} [options.dataDir] — absolute path to data directory (for ContentStore storage)
 * @param {function} [options.onLog] — log sink for cross-process forwarding; receives ({ level, name, args })
 * @returns {import('express').Express}
 */
export function createProxyApp({ pwaPath, appVersion = '0.0.0', pwaConfig, configFilePath, dataDir, onLog, icHandler, allowShellCommands = false } = {}) {
  const app = express();

  // Override Player API base path if configured (before registering routes)
  if (pwaConfig?.playerApiBase) {
    setPlayerApi(pwaConfig.playerApiBase);
    logProxy.info(`Player API base path: ${PLAYER_API}`);
  }

  // Register cross-process log sink (e.g. Electron main → renderer DevTools)
  if (onLog) registerLogSink(onLog);

  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'SOAPAction',
      'X-Store-Chunk-Index', 'X-Store-Num-Chunks', 'X-Store-Chunk-Size', 'X-Store-MD5'],
    credentials: true,
  }));

  app.use(express.text({ type: 'text/xml', limit: '50mb' }));
  app.use(express.text({ type: 'application/xml', limit: '50mb' }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Make pwaConfig updatable (POST /config can change it at runtime)
  let currentPwaConfig = pwaConfig ? { ...pwaConfig } : null;

  // ─── POST /config — write config.json and update in-memory config ────
  app.post('/config', (req, res) => {
    logConfig.info('POST /config received:', JSON.stringify(req.body));
    const { cmsUrl } = req.body;
    if (!cmsUrl) return res.status(400).json({ error: 'cmsUrl is required' });

    // Update in-memory config — merge all POSTed fields (takes effect on next page load injection)
    currentPwaConfig = { ...(currentPwaConfig || {}), ...req.body };

    // Reinitialize ContentStore if CMS URL changed (new CMS-namespaced directory)
    if (dataDir && cmsUrl) {
      const newCmsId = computeCmsId(cmsUrl);
      if (newCmsId) {
        currentPwaConfig.cmsId = newCmsId;
        store = initContentStore(newCmsId);
      }
    }

    // Write config.json — merge with existing file to preserve non-POSTed keys (e.g. controls)
    if (configFilePath) {
      fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(configFilePath, 'utf8')); } catch (_) {}
      const merged = { ...existing, ...req.body };
      fs.writeFileSync(configFilePath, JSON.stringify(merged, null, 2));
      logConfig.info(`Wrote config.json: ${configFilePath}`);
    }

    res.json({ ok: true });
  });

  // ─── XMDS SOAP Proxy ──────────────────────────────────────────────
  app.all('/xmds-proxy', async (req, res) => {
    try {
      const cmsUrl = req.query.cms;
      if (!cmsUrl) return res.status(400).json({ error: 'Missing cms parameter' });

      const queryParams = new URLSearchParams(req.query);
      queryParams.delete('cms');
      const queryString = queryParams.toString();
      const xmdsUrl = `${cmsUrl}/xmds.php${queryString ? '?' + queryString : ''}`;

      logProxy.info(`${req.method} ${redactUrl(xmdsUrl)}`);

      const headers = {
        'Content-Type': req.headers['content-type'] || 'text/xml; charset=utf-8',
        'User-Agent': `XiboPlayer/${appVersion}`,
      };
      if (req.headers['soapaction']) headers['SOAPAction'] = req.headers['soapaction'];

      const response = await fetch(xmdsUrl, {
        method: req.method,
        headers,
        body: req.method !== 'GET' && req.body ? req.body : undefined,
        signal: AbortSignal.timeout(30000),
      });

      const contentType = response.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      const responseText = await response.text();
      res.status(response.status).send(responseText);
      logProxy.info(`${response.status} (${responseText.length} bytes)`);
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        logProxy.error('XMDS timeout (30s):', redactUrl(xmdsUrl));
        return res.status(504).json({ error: 'Gateway Timeout', message: 'CMS did not respond within 30s' });
      }
      logProxy.error('Error:', error.message);
      res.status(500).json({ error: 'Proxy error', message: error.message });
    }
  });


  // ─── ContentStore initialization ──────────────────────────────────
  // Namespace by CMS ID when available: cache/{cmsId}/media/
  // Falls back to flat media/ for backward compat when no cmsId.
  let store = null;
  function initContentStore(cmsId) {
    if (!dataDir) return null;
    const storeDir = cmsId
      ? path.join(dataDir, 'cache', cmsId, 'media')
      : path.join(dataDir, 'media');
    const s = new ContentStore(storeDir);
    s.init();
    logProxy.info(`ContentStore enabled: ${storeDir}`);
    return s;
  }

  const initialCmsId = pwaConfig?.cmsId || (pwaConfig?.cmsUrl ? computeCmsId(pwaConfig.cmsUrl) : null);
  store = initContentStore(initialCmsId);

  // ─── Quit ────────────────────────────────────────────────────────
  // Allow the PWA to request a clean shutdown (Ctrl+Q in Chromium kiosk).
  // The server exits, which triggers launch-kiosk.sh cleanup → kills browser.
  app.post('/quit', (_req, res) => {
    logServer.info('Quit requested — shutting down');
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 100);
  });

  // ─── Shell Command Execution (#202) ─────────────────────────────
  // Execute native shell commands from CMS (widget/display commands).
  // Gated by allowShellCommands option (default: false).
  // Used by Chromium kiosk (no IPC); Electron prefers its own IPC path.
  app.post('/shell-command', express.json(), async (req, res) => {
    if (!allowShellCommands) {
      logServer.warn('Shell command rejected (allowShellCommands: false)');
      return res.json({ success: false, reason: 'Shell commands disabled' });
    }
    const { commandString } = req.body || {};
    if (!commandString) return res.json({ success: false, reason: 'Empty command' });

    // Strip CMS type prefix (e.g., "shell|reboot" → "reboot")
    const cmd = commandString.includes('|') ? commandString.split('|').slice(1).join('|') : commandString;
    if (!cmd) return res.json({ success: false, reason: 'Empty command after prefix strip' });

    logServer.info('[Shell] Executing:', cmd);
    try {
      const { stdout, stderr } = await execPromise(cmd, { timeout: 30000 });
      logServer.info('[Shell] OK:', stdout.trim());
      res.json({ success: true, stdout: stdout.trim(), stderr: stderr.trim() });
    } catch (error) {
      logServer.error('[Shell] Failed:', error.message);
      res.json({ success: false, reason: error.message });
    }
  });

  // ─── Auth Token ──────────────────────────────────────────────────
  // Store JWT token server-side so cache-through can inject it into CMS
  // requests without passing tokens through URLs.
  app.post('/auth-token', express.json(), (req, res) => {
    _bearerToken = req.body.token || null;
    logProxy.info('Auth token', _bearerToken ? 'set' : 'cleared');
    res.json({ success: true });
  });

  // ─── Console Log Forwarding ──────────────────────────────────────
  // Receive batched log entries from the PWA renderer and write them to
  // stdout. Controlled by debug.consoleLogs in config.json.
  // journald or shell redirect captures the output.
  const _consoleLogsEnabled = !!currentPwaConfig?.debug?.consoleLogs;
  if (_consoleLogsEnabled) logProxy.info('Console log forwarding enabled');

  app.post('/debug/log', (req, res) => {
    if (!_consoleLogsEnabled) return res.status(204).end();
    const entries = Array.isArray(req.body) ? req.body : [req.body];
    for (const { level, name, message } of entries) {
      const tag = level === 'error' ? '[R ERROR]' : level === 'warning' ? '[R WARN]' : '[R]';
      console.log(`${tag} [${name}] ${message}`);
    }
    res.status(204).end();
  });

  // ─── Interactive Control (XIC) HTTP API ─────────────────────────────
  // Handles XHR from xibo-interactive-control.js in widget iframes.
  // Used by Electron/Chromium where there is no Service Worker to intercept.
  // The icHandler callbacks are provided by the platform layer (e.g. Electron main.js).
  if (icHandler) {
    const logIc = createLogger('XIC', 'INFO');

    app.get('/info', async (_req, res) => {
      try {
        const info = icHandler.getInfo ? await icHandler.getInfo() : { playerType: 'proxy' };
        res.json(info);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/trigger', async (req, res) => {
      const { id, trigger } = req.body || {};
      logIc.info(`/trigger: widget=${id} trigger=${trigger}`);
      try {
        if (icHandler.handleTrigger) await icHandler.handleTrigger(id, trigger);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/duration/expire', async (req, res) => {
      const { id } = req.body || {};
      logIc.info(`/duration/expire: widget=${id}`);
      try {
        if (icHandler.handleExpire) await icHandler.handleExpire(id);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/duration/extend', async (req, res) => {
      const { id, duration } = req.body || {};
      logIc.info(`/duration/extend: widget=${id} +${duration}s`);
      try {
        if (icHandler.handleExtend) await icHandler.handleExtend(id, parseInt(duration));
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/duration/set', async (req, res) => {
      const { id, duration } = req.body || {};
      logIc.info(`/duration/set: widget=${id} duration=${duration}s`);
      try {
        if (icHandler.handleSetDuration) await icHandler.handleSetDuration(id, parseInt(duration));
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/fault', async (req, res) => {
      const { code, reason, key, ttl } = req.body || {};
      logIc.warn(`/fault: code=${code} reason=${reason}`);
      try {
        if (icHandler.handleFault) await icHandler.handleFault(code, reason, key, ttl);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/realtime', async (req, res) => {
      const dataKey = req.query.dataKey;
      if (!dataKey) return res.status(400).json({ error: 'Missing dataKey' });
      try {
        if (!icHandler.getRealtimeData) return res.status(503).json({ error: 'No realtime handler' });
        const data = await icHandler.getRealtimeData(dataKey);
        if (data === null || data === undefined) {
          return res.status(404).json({ error: `No data for key: ${dataKey}` });
        }
        res.json(typeof data === 'string' ? JSON.parse(data) : data);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    logIc.info('IC HTTP API routes registered');
  }

  // ─── Cache-through helper ─────────────────────────────────────────
  // Serve from store on hit. On miss, fetch from CMS and tee-stream to
  // disk + client simultaneously — zero buffering.
  //
  // Chunk metadata is passed via custom X-Store-* headers from DownloadTask:
  //   X-Store-Chunk-Index, X-Store-Num-Chunks, X-Store-Chunk-Size, X-Store-MD5
  async function cacheThrough(req, res, storeKey, cmsPath, { ttl = Infinity } = {}) {
    // 1. Store hit → serve from disk (with optional TTL check)
    if (store) {
      let info;
      try { info = store.has(storeKey); } catch (_) {}
      if (info?.exists) {
        // Incomplete chunked files: fall through to CMS for the missing bytes
        const incomplete = info.chunked && store.missingChunks(storeKey).length > 0;
        if (incomplete) {
          logFile.info(`Incomplete chunked file: ${storeKey} — fetching from CMS`);
        } else if (ttl !== Infinity && info.metadata?.createdAt) {
          const ageMs = Date.now() - info.metadata.createdAt;
          if (ageMs > ttl * 1000) {
            logFile.info(`TTL expired: ${storeKey} (${Math.round(ageMs / 1000)}s > ${ttl}s)`);
            // Fall through to CMS fetch (will overwrite stored file)
          } else {
            return serveFromStore(req, res, storeKey);
          }
        } else {
          return serveFromStore(req, res, storeKey);
        }
      }
    }

    // 2. Store miss → fetch from CMS
    const cmsUrl = currentPwaConfig?.cmsUrl;
    if (!cmsUrl) return res.status(502).json({ error: 'CMS URL not configured' });

    // Use direct CMS download URL if provided (XMDS signed URLs)
    const directUrl = req.headers['x-cms-download-url'];
    const fullUrl = directUrl || `${cmsUrl}${cmsPath}`;
    logFile.info(`Cache miss: ${storeKey} → GET ${redactUrl(fullUrl)}`);

    const headers = { 'User-Agent': `XiboPlayer/${appVersion}` };
    if (_bearerToken) headers['Authorization'] = `Bearer ${_bearerToken}`;
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
      logFile.info(`Range: ${req.headers.range}`);
    }

    try {
      const response = await fetch(fullUrl, { headers, signal: AbortSignal.timeout(30000) });

      if (!response.ok && response.status !== 206) {
        logFile.warn(`CMS ${response.status} for ${storeKey}`);
        // Serve stale cached data if CMS is unavailable
        if (store) {
          const staleInfo = store.getMetadata(storeKey);
          if (staleInfo) {
            const ageMin = Math.round((Date.now() - (staleInfo.metadata?.createdAt || 0)) / 60000);
            logFile.warn(`Serving stale cache for ${storeKey} (${ageMin}min old, CMS returned ${response.status})`);
            res.setHeader('X-Stale-Cache', `${ageMin}min`);
            return serveFromStore(req, res, storeKey);
          }
        }
        return res.status(response.status).end();
      }

      // Forward response headers
      res.status(response.status);
      response.headers.forEach((value, key) => {
        if (!SKIP_HEADERS.includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      const upstreamLength = response.headers.get('content-length');
      const wasCompressed = response.headers.get('content-encoding');
      if (upstreamLength && !wasCompressed) res.setHeader('Content-Length', upstreamLength);
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (!response.body) { res.end(); return; }

      const fetchStream = Readable.fromWeb(response.body);

      if (store) {
        // Read chunk metadata from custom headers (set by DownloadTask)
        const chunkIndexStr = req.headers['x-store-chunk-index'];
        const chunkIndex = chunkIndexStr !== undefined ? parseInt(chunkIndexStr) : undefined;
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const meta = { contentType, md5: req.headers['x-store-md5'] || null };

        if (chunkIndex !== undefined) {
          meta.chunked = true;
          if (req.headers['x-store-num-chunks']) meta.numChunks = parseInt(req.headers['x-store-num-chunks']);
          if (req.headers['x-store-chunk-size']) meta.chunkSize = parseInt(req.headers['x-store-chunk-size']);
          const contentRange = response.headers.get('content-range');
          if (contentRange) {
            const totalMatch = contentRange.match(/\/(\d+)/);
            if (totalMatch) meta.size = parseInt(totalMatch[1]);
          }
        }

        const { writeStream, commit, abort } = store.createTempWrite(
          storeKey, chunkIndex !== undefined ? chunkIndex : null
        );

        let bytesWritten = 0;
        let aborted = false;

        writeStream.on('error', (err) => {
          if (!aborted) logStore.error('Write stream error:', err.message);
          aborted = true;
          abort();
        });

        req.on('close', () => {
          if (!res.writableFinished) {
            aborted = true;
            fetchStream.destroy();
            writeStream.destroy();
            abort();
          }
        });

        fetchStream.on('data', (chunk) => {
          if (aborted) return;
          bytesWritten += chunk.length;
          writeStream.write(chunk);
          res.write(chunk);
        });

        fetchStream.on('end', () => {
          if (aborted) return;
          writeStream.end(() => {
            if (aborted) return;
            try {
              if (chunkIndex === undefined) meta.size = bytesWritten;
              commit(meta);
              logStore.info(`Stored${chunkIndex !== undefined ? ` chunk ${chunkIndex}` : ''}: ${storeKey} (${bytesWritten} bytes)`);
            } catch (err) {
              logStore.error('Commit error (non-fatal):', err.message);
            }
          });
          res.end();
          logFile.info(`${response.status} (${bytesWritten} bytes)`);
        });

        fetchStream.on('error', (err) => {
          logFile.error('Stream error:', err.message);
          writeStream.destroy();
          abort();
          if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
          else res.end();
        });
      } else {
        // No store — stream directly to client
        fetchStream.pipe(res);
        fetchStream.on('error', (err) => {
          logFile.error('Stream error:', err.message);
          if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
          else res.end();
        });
        logFile.info(`${response.status} streaming (no store)`);
      }
    } catch (error) {
      const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      if (isTimeout) {
        logFile.warn(`CMS timeout (30s): ${storeKey}`);
      } else {
        logFile.warn(`CMS fetch failed: ${storeKey} — ${error.message}`);
      }
      // Serve stale cached data if CMS is unreachable
      if (store && !res.headersSent) {
        const staleInfo = store.getMetadata(storeKey);
        if (staleInfo) {
          const ageMin = Math.round((Date.now() - (staleInfo.metadata?.createdAt || 0)) / 60000);
          logFile.warn(`Serving stale cache for ${storeKey} (${ageMin}min old, CMS unreachable)`);
          res.setHeader('X-Stale-Cache', `${ageMin}min`);
          return serveFromStore(req, res, storeKey);
        }
      }
      if (!res.headersSent) {
        const status = isTimeout ? 504 : 502;
        const msg = isTimeout ? 'CMS did not respond within 30s' : error.message;
        res.status(status).json({ error: isTimeout ? 'Gateway Timeout' : 'CMS fetch failed', message: msg });
      }
    }
  }

  // ─── serveFromStore — shared serving logic ──────────────────────────
  /**
   * Serve a file from ContentStore with Range support, CORS headers, and
   * chunked file assembly. Used by mirror routes and /store/* routes.
   */
  function serveFromStore(req, res, storeKey) {
    if (!store) return res.status(501).json({ error: 'ContentStore not configured' });

    let info;
    try {
      info = store.has(storeKey);
    } catch (err) {
      logStore.error(`GET lookup error for ${storeKey}:`, err.message);
      return res.status(500).end();
    }
    if (!info.exists) return res.status(404).end();

    const meta = info.metadata || {};
    const contentType = meta.contentType || 'application/octet-stream';

    if (info.chunked) {
      return serveChunkedFile(req, res, store, storeKey, meta, contentType);
    }

    const filePath = store.getPath(storeKey);
    if (!filePath) return res.status(404).end();

    const fileSize = meta.size || fs.statSync(filePath).size;
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkLen = end - start + 1;

      res.status(206);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', chunkLen);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const stream = store.getReadStream(storeKey, { start, end });
      pipeline(stream, res, (err) => {
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          logStore.error(`Stream error serving ${storeKey}: ${err.message}`);
        }
      });
    } else {
      res.status(200);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const stream = store.getReadStream(storeKey);
      pipeline(stream, res, (err) => {
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          logStore.error(`Stream error serving ${storeKey}: ${err.message}`);
        }
      });
    }
  }

  // ─── Cache-through Mirror Routes ────────────────────────────────────
  // Serve from store on hit, fetch from CMS on miss. Same URL paths as CMS.

  // Strip leading slash for store key: ${PLAYER_API} → STORE_PREFIX
  const STORE_PREFIX = PLAYER_API.slice(1);

  // HEAD helper — check store existence (used for all mirror routes)
  function headFromStore(req, res, storeKey, defaultContentType) {
    if (!store) return res.status(501).end();
    try {
      const info = store.has(storeKey);
      if (!info.exists) return res.status(404).end();
      // Incomplete chunked files → 404 so download pipeline re-fetches them
      if (info.chunked && store.missingChunks(storeKey).length > 0) {
        return res.status(404).end();
      }
      const meta = info.metadata || {};
      res.setHeader('Content-Length', meta.size || 0);
      res.setHeader('Content-Type', meta.contentType || defaultContentType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(200).end();
    } catch (err) {
      logStore.error(`HEAD error for ${storeKey}:`, err.message);
      res.status(500).end();
    }
  }

  // Media by storedAs filename: {PLAYER_API}/media/file/{storedAs}
  // Primary route — widget HTML references media by storedAs (e.g. 42_abc123.jpg)
  app.get(`${PLAYER_API}/media/file/{*storedAs}`, (req, res) => {
    const storedAs = [req.params.storedAs].flat().pop();
    const key = `${STORE_PREFIX}/media/file/${storedAs}`;
    cacheThrough(req, res, key, `${PLAYER_API}/media/file/${storedAs}`);
  });
  app.head(`${PLAYER_API}/media/file/{*storedAs}`, (req, res) => {
    const storedAs = [req.params.storedAs].flat().pop();
    headFromStore(req, res, `${STORE_PREFIX}/media/file/${storedAs}`, 'application/octet-stream');
  });

  // Media by numeric ID (legacy): {PLAYER_API}/media/:id
  app.get(`${PLAYER_API}/media/:id`, (req, res) => {
    const key = `${STORE_PREFIX}/media/${req.params.id}`;
    cacheThrough(req, res, key, `${PLAYER_API}/media/${req.params.id}`);
  });
  app.head(`${PLAYER_API}/media/:id`, (req, res) => {
    headFromStore(req, res, `${STORE_PREFIX}/media/${req.params.id}`, 'application/octet-stream');
  });

  // Layouts: {PLAYER_API}/layouts/:id
  app.get(`${PLAYER_API}/layouts/:id`, (req, res) => {
    const key = `${STORE_PREFIX}/layouts/${req.params.id}`;
    cacheThrough(req, res, key, `${PLAYER_API}/layouts/${req.params.id}`);
  });
  app.head(`${PLAYER_API}/layouts/:id`, (req, res) => {
    headFromStore(req, res, `${STORE_PREFIX}/layouts/${req.params.id}`, 'application/xml');
  });

  // Widgets: {PLAYER_API}/widgets/:layoutId/:regionId/:mediaId
  app.get(`${PLAYER_API}/widgets/:layoutId/:regionId/:mediaId`, (req, res) => {
    const { layoutId, regionId, mediaId } = req.params;
    const key = `${STORE_PREFIX}/widgets/${layoutId}/${regionId}/${mediaId}`;
    cacheThrough(req, res, key, `${PLAYER_API}/widgets/${layoutId}/${regionId}/${mediaId}`);
  });
  app.head(`${PLAYER_API}/widgets/:layoutId/:regionId/:mediaId`, (req, res) => {
    const key = `${STORE_PREFIX}/widgets/${req.params.layoutId}/${req.params.regionId}/${req.params.mediaId}`;
    headFromStore(req, res, key, 'text/html');
  });

  // Dependencies: {PLAYER_API}/dependencies/*
  // XMDS downloads store dependencies as media (type=M) under media/file/.
  // Fall back to media/file/{filename} when dependencies/{filename} is missing.
  app.get(`${PLAYER_API}/dependencies/{*splat}`, (req, res) => {
    const filename = decodeURIComponent([req.params.splat].flat().pop());
    const key = `${STORE_PREFIX}/dependencies/${filename}`;
    const mediaKey = `${STORE_PREFIX}/media/file/${filename}`;
    // Try dependencies/ first; if not in store, try media/file/ (XMDS path)
    if (store) {
      try {
        const info = store.has(key);
        if (!info?.exists) {
          const mediaInfo = store.has(mediaKey);
          if (mediaInfo?.exists) {
            logFile.info(`Dependencies fallback: ${key} → ${mediaKey}`);
            return serveFromStore(req, res, mediaKey);
          }
        }
      } catch (_) {}
    }
    cacheThrough(req, res, key, `${PLAYER_API}/dependencies/${filename}`);
  });
  app.head(`${PLAYER_API}/dependencies/{*splat}`, (req, res) => {
    const filename = decodeURIComponent([req.params.splat].flat().pop());
    const depKey = `${STORE_PREFIX}/dependencies/${filename}`;
    const mediaKey = `${STORE_PREFIX}/media/file/${filename}`;
    // Fall back to media/file/ for HEAD too
    if (store) {
      try {
        const info = store.has(depKey);
        if (!info?.exists && store.has(mediaKey)?.exists) {
          return headFromStore(req, res, mediaKey, 'application/octet-stream');
        }
      } catch (_) {}
    }
    headFromStore(req, res, depKey, 'application/octet-stream');
  });

  // Datasets (widget data): {PLAYER_API}/datasets/:widgetId/data
  // Cached with TTL — data changes on XTR runs, but short-lived caching avoids
  // repeated CMS hits during the same layout cycle. Auth injected by cacheThrough.
  app.get(`${PLAYER_API}/datasets/:widgetId/data`, (req, res) => {
    const widgetId = req.params.widgetId;
    const key = `${STORE_PREFIX}/datasets/${widgetId}/data`;
    const ttl = parseInt(req.headers['x-cache-ttl']) || 300;
    cacheThrough(req, res, key, `${PLAYER_API}/datasets/${widgetId}/data`, { ttl });
  });

  // ─── Stream Proxy (CORS bypass for HLS/external streams) ──────────
  // Electron injects CORS headers at the session level, but Chromium
  // has no such mechanism. Proxy external stream URLs server-side so
  // HLS.js inside CMS widget iframes can fetch m3u8/ts without CORS.
  const logStream = createLogger('StreamProxy', 'INFO');
  app.get('/stream-proxy', async (req, res) => {
    const url = req.query.url;
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return res.status(400).json({ error: 'Missing or invalid url parameter' });
    }
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': req.headers['user-agent'] || 'XiboPlayer/1.0' },
      });
      if (!response.ok) {
        logStream.warn(`${response.status} ${url}`);
        return res.status(response.status).end();
      }
      const contentType = response.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');

      // For m3u8 manifests, rewrite segment URLs to also go through the proxy
      if (contentType?.includes('mpegurl') || url.endsWith('.m3u8')) {
        const text = await response.text();
        const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
        const rewritten = text.replace(/^(?!#)(\S+)/gm, (line) => {
          if (line.startsWith('http://') || line.startsWith('https://')) {
            return '/stream-proxy?url=' + encodeURIComponent(line);
          }
          return '/stream-proxy?url=' + encodeURIComponent(baseUrl + line);
        });
        return res.send(rewritten);
      }

      // Binary segments — pipe directly
      pipeline(Readable.fromWeb(response.body), res, (err) => {
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          logStream.error(`Stream error: ${err.message}`);
        }
      });
    } catch (err) {
      logStream.error(`Fetch failed: ${url} — ${err.message}`);
      res.status(502).json({ error: err.message });
    }
  });

  // ─── CMS API Forward Proxy ─────────────────────────────────────────
  // Forward unmatched /api/* and /player/api/* requests to the CMS.
  // Specific mirror routes (media, widgets, dependencies) match first;
  // this catch-all handles health, auth, display mgmt, and CMS API (OAuth2).
  const logApi = createLogger('API-Proxy');
  app.all(['/api/{*splat}', `${PLAYER_API}/{*splat}`], async (req, res) => {
    const cmsUrl = currentPwaConfig?.cmsUrl;
    if (!cmsUrl) return res.status(502).json({ error: 'CMS URL not configured' });

    const targetUrl = `${cmsUrl}${req.originalUrl}`;
    const t0 = Date.now();
    logApi.info(`${req.method} ${req.originalUrl} → ${targetUrl}`);

    try {
      const fetchOptions = {
        method: req.method,
        headers: { ...req.headers, host: new URL(cmsUrl).host },
      };
      // Forward request body for POST/PUT
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
        const ct = req.headers['content-type'] || '';
        if (ct.includes('urlencoded')) {
          fetchOptions.body = new URLSearchParams(req.body).toString();
        } else {
          fetchOptions.body = JSON.stringify(req.body);
        }
        fetchOptions.headers['content-type'] = ct || 'application/json';
      }
      delete fetchOptions.headers['content-length'];

      fetchOptions.signal = AbortSignal.timeout(30000);
      const response = await fetch(targetUrl, fetchOptions);
      logApi.info(`${req.method} ${req.originalUrl} ← ${response.status} (${Date.now() - t0}ms)`);

      // Forward response headers
      for (const [key, value] of response.headers) {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }

      res.status(response.status);
      if (response.body) {
        const { Readable } = await import('stream');
        Readable.fromWeb(response.body).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        logApi.error(`API forward timeout (30s): ${req.originalUrl}`);
        return res.status(504).json({ error: 'Gateway Timeout', message: 'CMS did not respond within 30s' });
      }
      logApi.error(`Forward failed: ${err.message}`);
      res.status(502).json({ error: err.message });
    }
  });

  // ─── ContentStore — Missing chunks check ────────────────────────────
  // GET /store/missing-chunks/:type/* — return missing chunk indices for a file
  app.get('/store/missing-chunks/:type/{*splat}', (req, res) => {
    if (!store) return res.status(501).json({ error: 'ContentStore not configured' });
    const key = `${req.params.type}/${[req.params.splat].flat().join('/')}`;
    const info = store.has(key);
    if (!info.exists || !info.chunked) return res.json({ missing: [], numChunks: 0 });
    const meta = info.metadata || {};
    res.json({ missing: store.missingChunks(key), numChunks: meta.numChunks || 0 });
  });

  // ─── ContentStore — Serve files (legacy + internal) ──────────────────
  // HEAD must be registered before GET (Express GET also matches HEAD requests)
  // HEAD /store/:type/* — existence + size check
  app.head('/store/:type/{*splat}', (req, res) => {
    if (!store) return res.status(501).end();

    try {
      const key = `${req.params.type}/${[req.params.splat].flat().join('/')}`;
      const info = store.has(key);
      if (!info.exists) return res.status(404).end();
      // Incomplete chunked files → 404 so download pipeline re-fetches them
      if (info.chunked && store.missingChunks(key).length > 0) {
        return res.status(404).end();
      }

      const meta = info.metadata || {};
      res.setHeader('Content-Length', meta.size || 0);
      res.setHeader('Content-Type', meta.contentType || 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(200).end();
    } catch (err) {
      logStore.error(`HEAD error for ${req.params.type}/${[req.params.splat].flat().join('/')}:`, err.message);
      res.status(500).end();
    }
  });

  // GET /store/:type/* — serve stored file with Range support
  app.get('/store/:type/{*splat}', (req, res) => {
    const key = `${req.params.type}/${[req.params.splat].flat().join('/')}`;
    serveFromStore(req, res, key);
  });

  // PUT /store/:type/* — store arbitrary content
  app.put('/store/:type/{*splat}', express.raw({ limit: '50mb', type: '*/*' }), (req, res) => {
    if (!store) return res.status(501).json({ error: 'ContentStore not configured' });

    const key = `${req.params.type}/${[req.params.splat].flat().join('/')}`;
    const contentType = req.headers['content-type'] || 'application/octet-stream';
    store.put(key, req.body, { contentType, size: req.body.length });
    logStore.info(`PUT: ${key} (${req.body.length} bytes)`);
    res.json({ ok: true });
  });

  // POST /store/delete — delete files from store
  app.post('/store/delete', express.json(), (req, res) => {
    if (!store) return res.status(501).json({ error: 'ContentStore not configured' });

    const { files } = req.body;
    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ error: 'files array required' });
    }

    let deleted = 0;
    for (const file of files) {
      const key = file.key || `${file.type}/${file.id}`;
      if (store.delete(key)) {
        deleted++;
        logStore.info(`Deleted: ${key}`);
      }
    }

    res.json({ success: true, deleted, total: files.length });
  });

  // POST /store/mark-complete — mark chunked download as complete
  app.post('/store/mark-complete', express.json(), (req, res) => {
    if (!store) return res.status(501).json({ error: 'ContentStore not configured' });

    const { storeKey } = req.body;
    if (!storeKey) return res.status(400).json({ error: 'storeKey required' });

    store.markComplete(storeKey);
    logStore.info(`Marked complete: ${storeKey}`);
    res.json({ success: true });
  });

  // POST /store/unmark-complete — unmark chunked file (keeps chunks, allows partial re-download)
  app.post('/store/unmark-complete', express.json(), (req, res) => {
    if (!store) return res.status(501).json({ error: 'ContentStore not configured' });

    const { storeKey } = req.body;
    if (!storeKey) return res.status(400).json({ error: 'storeKey required' });

    const unmarked = store.unmarkComplete(storeKey);
    if (unmarked) {
      logStore.info(`Unmarked complete: ${storeKey}`);
    }
    res.json({ success: true, unmarked });
  });

  // GET /store/list — list all stored files
  app.get('/store/list', (req, res) => {
    if (!store) return res.status(501).json({ error: 'ContentStore not configured' });
    res.json({ files: store.list() });
  });

  // ─── CMS config injection helper ──────────────────────────────────
  // Build a <script> tag that pre-seeds localStorage with CMS connection
  // params from the config file, so the PWA skips the setup screen.
  // Uses currentCmsConfig (mutable ref) so POST /config changes take effect.
  function buildConfigScript() {
    if (!currentPwaConfig || !Object.keys(currentPwaConfig).length) return '';

    const configJson = JSON.stringify(currentPwaConfig);
    return `<script>
(function(){
  try {
    var injected = ${configJson};
    var GLOBAL_KEYS = { hardwareKey: 1, xmrPubKey: 1, xmrPrivKey: 1 };
    var globalData = {};
    try { globalData = JSON.parse(localStorage.getItem('xibo_global') || '{}'); } catch(e) {}
    var cmsData = {};
    for (var k in injected) {
      if (GLOBAL_KEYS[k]) globalData[k] = injected[k];
      else cmsData[k] = injected[k];
    }
    localStorage.setItem('xibo_global', JSON.stringify(globalData));
    if (injected.cmsId) {
      var cmsKey = 'xibo_cms:' + injected.cmsId;
      var existingCms = {};
      try { existingCms = JSON.parse(localStorage.getItem(cmsKey) || '{}'); } catch(e) {}
      localStorage.setItem(cmsKey, JSON.stringify(Object.assign({}, existingCms, cmsData)));
      localStorage.setItem('xibo_active_cms', injected.cmsId);
    }
  } catch(e) { console.warn('ConfigInject failed:', e); }
})();
</script>`;
  }

  if (currentPwaConfig && Object.keys(currentPwaConfig).length > 0) {
    logProxy.info('PWA config injection enabled:', JSON.stringify(currentPwaConfig));
  }

  /**
   * Send index.html, optionally injecting the CMS config script.
   * The script is inserted right before the first <script> tag so it runs
   * before the PWA's own config check.  Rebuilt on every request so that
   * POST /config changes are picked up without restarting the server.
   */
  function sendIndexHtml(res) {
    const indexPath = path.join(pwaPath, 'index.html');
    const cmsConfigScript = buildConfigScript();
    if (!cmsConfigScript) {
      return res.sendFile(indexPath);
    }
    const html = fs.readFileSync(indexPath, 'utf8');
    // Insert before the first <script> tag, or before </head> if no scripts
    let injected;
    if (html.includes('<script')) {
      injected = html.replace('<script', cmsConfigScript + '<script');
    } else {
      injected = html.replace('</head>', cmsConfigScript + '</head>');
    }
    res.type('html').send(injected);
  }

  // Always serve index.html through sendIndexHtml so config injection
  // works dynamically (POST /config can enable it at runtime).
  app.get('/player/', (req, res) => sendIndexHtml(res));
  app.get('/player/index.html', (req, res) => sendIndexHtml(res));

  // ─── Serve PWA static files ────────────────────────────────────────
  app.use('/player', express.static(pwaPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('sw-pwa.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/player/');
      }
    },
    index: false,
  }));

  app.get('/', (req, res) => res.redirect('/player/'));

  // SPA fallback: serve index.html for navigation requests only.
  // Asset requests (.js, .css, .wasm, etc.) that didn't match express.static
  // must return 404 — otherwise the browser gets HTML with the wrong MIME type,
  // causing "Failed to load module script" errors and a black screen.
  app.get('/player/{*splat}', (req, res, next) => {
    const segments = req.params.splat;
    const last = segments[segments.length - 1] || '';
    if (path.extname(last)) return next();
    sendIndexHtml(res);
  });

  return app;
}

/**
 * Create the proxy app and start listening.
 *
 * @param {object} options
 * @param {number} [options.port=8765]
 * @param {string} options.pwaPath
 * @param {string} [options.appVersion='0.0.0']
 * @returns {Promise<{ server: import('http').Server, port: number }>}
 */
export function startServer({ port = 8765, listenAddress = 'localhost', pwaPath, appVersion = '0.0.0', pwaConfig, configFilePath, dataDir, onLog, icHandler, allowShellCommands = false, relaxSslCerts = true } = {}) {
  if (relaxSslCerts) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const app = createProxyApp({ pwaPath, appVersion, pwaConfig, configFilePath, dataDir, onLog, icHandler, allowShellCommands });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, listenAddress, () => {
      logServer.info(`Running on http://${listenAddress}:${port}`);
      logServer.info('READY');

      // Attach WebSocket sync relay (lightweight — no cost when unused)
      attachSyncRelay(server);

      resolve({ server, port });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logServer.error(`Port ${port} already in use. Try --port=XXXX`);
      }
      reject(err);
    });

    // Graceful shutdown
    process.on('SIGINT', () => { server.close(); process.exit(0); });
    process.on('SIGTERM', () => { server.close(); process.exit(0); });
  });
}
