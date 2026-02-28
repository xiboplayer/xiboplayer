/**
 * @xiboplayer/proxy — CORS proxy + static server for Xibo Player
 *
 * Provides Express middleware that:
 * - Proxies XMDS SOAP requests (/xmds-proxy)
 * - Proxies REST API requests (/rest-proxy)
 * - Proxies file downloads with Range support (/file-proxy)
 * - Serves the PWA player as static files (/player/pwa/)
 */

import fs from 'fs';
import path from 'path';
import { Readable } from 'node:stream';
import express from 'express';
import cors from 'cors';
import { createLogger, registerLogSink } from '@xiboplayer/utils';
import { ContentStore } from './content-store.js';

const SKIP_HEADERS = ['transfer-encoding', 'connection', 'content-encoding', 'content-length'];

/** Redact sensitive query params (serverKey, hardwareKey, X-Amz-*) from URLs for logging */
function redactUrl(url) {
  return url.replace(/(?<=[?&])(serverKey|hardwareKey|X-Amz-[^=]*)=[^&]*/gi, '$1=***');
}

// Module-level loggers — one per subsystem, following @xiboplayer/utils conventions.
// In Node (no window/localStorage), default level is WARNING. Pass 'INFO' explicitly
// so proxy logs are always visible (these are server-side operational logs).
const logProxy = createLogger('Proxy', 'INFO');
const logRest  = createLogger('REST Proxy', 'INFO');
const logFile  = createLogger('FileProxy', 'INFO');
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

  // Clean up on client disconnect
  req.on('close', () => {
    destroyed = true;
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
    stream.on('end', writeNextChunk);
    stream.on('error', (err) => {
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
 * @param {object} [options.cmsConfig] — optional CMS connection params to pre-seed in localStorage
 * @param {string} [options.cmsConfig.cmsUrl] — CMS server URL
 * @param {string} [options.cmsConfig.cmsKey] — CMS server key
 * @param {string} [options.cmsConfig.displayName] — display name for registration
 * @param {string} [options.configFilePath] — absolute path to config.json (for POST /config writeback)
 * @param {string} [options.dataDir] — absolute path to data directory (for ContentStore storage)
 * @param {object} [options.playerConfig] — extra config fields to inject into localStorage (e.g. controls)
 * @param {function} [options.onLog] — log sink for cross-process forwarding; receives ({ level, name, args })
 * @returns {import('express').Express}
 */
export function createProxyApp({ pwaPath, appVersion = '0.0.0', cmsConfig, configFilePath, dataDir, playerConfig, onLog } = {}) {
  const app = express();

  // Register cross-process log sink (e.g. Electron main → renderer DevTools)
  if (onLog) registerLogSink(onLog);

  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'SOAPAction'],
    credentials: true,
  }));

  app.use(express.text({ type: 'text/xml', limit: '50mb' }));
  app.use(express.text({ type: 'application/xml', limit: '50mb' }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Make cmsConfig updatable (POST /config can change it at runtime)
  let currentCmsConfig = cmsConfig ? { ...cmsConfig } : null;

  // ─── POST /config — write config.json and update in-memory config ────
  app.post('/config', (req, res) => {
    logConfig.info('POST /config received:', JSON.stringify(req.body));
    const { cmsUrl, cmsKey, displayName, hardwareKey, xmrChannel } = req.body;
    if (!cmsUrl) return res.status(400).json({ error: 'cmsUrl is required' });

    // Update in-memory config (takes effect on next page load injection)
    currentCmsConfig = { cmsUrl, cmsKey: cmsKey || '', displayName: displayName || '' };

    // Write config.json (host-specific path passed as option)
    if (configFilePath) {
      const configData = { cmsUrl, cmsKey, displayName };
      if (hardwareKey) configData.hardwareKey = hardwareKey;
      if (xmrChannel) configData.xmrChannel = xmrChannel;
      fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
      fs.writeFileSync(configFilePath, JSON.stringify(configData, null, 2));
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
      });

      const contentType = response.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      const responseText = await response.text();
      res.status(response.status).send(responseText);
      logProxy.info(`${response.status} (${responseText.length} bytes)`);
    } catch (error) {
      logProxy.error('Error:', error.message);
      res.status(500).json({ error: 'Proxy error', message: error.message });
    }
  });

  // ─── REST API Proxy ────────────────────────────────────────────────
  app.all('/rest-proxy', async (req, res) => {
    try {
      const cmsUrl = req.query.cms;
      const apiPath = req.query.path;
      if (!cmsUrl) return res.status(400).json({ error: 'Missing cms parameter' });

      const queryParams = new URLSearchParams(req.query);
      queryParams.delete('cms');
      queryParams.delete('path');
      const queryString = queryParams.toString();
      const fullUrl = `${cmsUrl}${apiPath || ''}${queryString ? '?' + queryString : ''}`;

      logRest.info(`${req.method} ${redactUrl(fullUrl)}`);

      const headers = { 'User-Agent': `XiboPlayer/${appVersion}` };
      if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
      if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
      if (req.headers['accept']) headers['Accept'] = req.headers['accept'];
      if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];

      const fetchOptions = { method: req.method, headers };
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
        if (req.headers['content-type']?.includes('x-www-form-urlencoded') && typeof req.body === 'object') {
          fetchOptions.body = new URLSearchParams(req.body).toString();
        } else {
          fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        }
      }

      const response = await fetch(fullUrl, fetchOptions);
      response.headers.forEach((value, key) => {
        if (!SKIP_HEADERS.includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      res.setHeader('Access-Control-Allow-Origin', '*');
      const buffer = await response.arrayBuffer();
      res.status(response.status).send(Buffer.from(buffer));
      logRest.info(`${response.status} (${buffer.byteLength} bytes)`);
    } catch (error) {
      logRest.error('Error:', error.message);
      res.status(500).json({ error: 'REST proxy error', message: error.message });
    }
  });

  // ─── ContentStore initialization ──────────────────────────────────
  let store = null;
  if (dataDir) {
    store = new ContentStore(path.join(dataDir, 'media'));
    store.init();
    logProxy.info(`ContentStore enabled: ${path.join(dataDir, 'media')}`);
  }

  // ─── File Download Proxy ───────────────────────────────────────────
  // Streams CMS responses to disk + client simultaneously — zero buffering.
  // Previous version used response.arrayBuffer() which held entire chunks
  // in memory, causing ~3 GB heap growth on large media downloads.
  app.get('/file-proxy', async (req, res) => {
    try {
      const cmsUrl = req.query.cms;
      const fileUrl = req.query.url;
      if (!cmsUrl || !fileUrl) return res.status(400).json({ error: 'Missing cms or url parameter' });

      const fullUrl = `${cmsUrl}${fileUrl}`;
      logFile.info(`GET ${redactUrl(fullUrl)}`);

      const headers = { 'User-Agent': `XiboPlayer/${appVersion}` };
      if (req.headers.range) {
        headers['Range'] = req.headers.range;
        logFile.info(`Range: ${req.headers.range}`);
      }

      const response = await fetch(fullUrl, { headers });
      res.status(response.status);
      response.headers.forEach((value, key) => {
        if (!SKIP_HEADERS.includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      // Forward Content-Length only when the upstream didn't use compression.
      // Node's fetch() auto-decompresses gzip/br but reports the *compressed*
      // Content-Length — forwarding it truncates the decompressed response.
      const upstreamLength = response.headers.get('content-length');
      const wasCompressed = response.headers.get('content-encoding');
      if (upstreamLength && !wasCompressed) res.setHeader('Content-Length', upstreamLength);
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (!response.body) {
        res.end();
        return;
      }

      // ── CSS font URL rewriting ──────────────────────────────────────
      // CSS files are tiny (~1KB) — buffer, rewrite CMS font URLs to local
      // /player/cache/static/ paths, fetch+store the font files, then
      // send rewritten CSS.  This fixes CORS errors when fonts.css contains
      // absolute CMS URLs that the browser can't fetch cross-origin.
      const upstreamContentType = response.headers.get('content-type') || '';
      // Detect CSS: check Content-Type, file extension, or ?file=*.css query parameter
      // The CMS serves files via /pwa/file?file=fonts.css&... so fileUrl.endsWith('.css')
      // fails due to trailing query params (e.g. &X-Amz-Signature=...).
      const fileParam = new URLSearchParams(fileUrl.split('?')[1] || '').get('file') || '';
      const isCss = upstreamContentType.includes('text/css')
        || fileUrl.endsWith('.css')
        || fileParam.endsWith('.css');

      if (isCss) {
        const cssBuffer = Buffer.from(await response.arrayBuffer());
        let cssText = cssBuffer.toString('utf-8');

        // Match any CMS signed URL with a file= query param. Handles both normal
        // url('...') and truncated CSS (where closing '); is cut off by CMS).
        const CMS_SIGNED_URL_RE = /https?:\/\/[^\s'")\]]+\?[^\s'")\]]*file=([^&\s'")\]]+)[^\s'")\]]*/g;
        const fontJobs = [];
        const FONT_EXTS = /\.(?:woff2?|ttf|otf|eot|svg)$/i;

        cssText = cssText.replace(CMS_SIGNED_URL_RE, (fullUrl, filename) => {
          if (!FONT_EXTS.test(filename) && !fullUrl.includes('fileType=font')) return fullUrl;
          fontJobs.push({ filename, url: fullUrl });
          logFile.info(`Rewrote font URL: ${filename}`);
          return `/player/cache/static/${encodeURIComponent(filename)}`;
        });

        // Fetch and store font files BEFORE sending CSS — the iframe renders
        // immediately after CSS is stored, so fonts must already be available.
        if (store) {
          await Promise.all(fontJobs.map(async ({ filename: fontFile, url: fontUrl }) => {
            const fontStoreKey = `static/${encodeURIComponent(fontFile)}`;
            if (store.has(fontStoreKey).exists) return; // already stored
            try {
              const r = await fetch(fontUrl, { headers: { 'User-Agent': `XiboPlayer/${appVersion}` } });
              if (!r.ok) return;
              const buf = await r.arrayBuffer();
              const fontExt = fontFile.split('.').pop().toLowerCase();
              const fontContentType = {
                otf: 'font/otf', ttf: 'font/ttf',
                woff: 'font/woff', woff2: 'font/woff2',
                eot: 'application/vnd.ms-fontobject', svg: 'image/svg+xml',
              }[fontExt] || 'application/octet-stream';
              store.put(fontStoreKey, Buffer.from(buf), {
                contentType: fontContentType, size: buf.byteLength,
              });
              logFile.info(`Stored font: ${fontFile} (${buf.byteLength} bytes)`);
            } catch (e) {
              logFile.warn(`Font fetch failed: ${fontFile}`, e.message);
            }
          }));
        }

        // Store rewritten CSS if storeKey provided
        const rewrittenBuf = Buffer.from(cssText, 'utf-8');
        if (store && req.query.storeKey) {
          store.put(req.query.storeKey, rewrittenBuf, {
            contentType: 'text/css', size: rewrittenBuf.length,
          });
          logFile.info(`Stored rewritten CSS: ${req.query.storeKey} (${rewrittenBuf.length} bytes)`);
        }

        res.setHeader('Content-Type', 'text/css');
        res.setHeader('Content-Length', rewrittenBuf.length);
        res.send(rewrittenBuf);
        logFile.info(`${response.status} CSS rewritten (${fontJobs.length} font URLs, ${rewrittenBuf.length} bytes)`);
        return;
      }

      const fetchStream = Readable.fromWeb(response.body);

      if (store && req.query.storeKey) {
        // Stream to disk AND client simultaneously
        const storeKey = req.query.storeKey;
        const chunkIndex = req.query.chunkIndex;
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const meta = { contentType, md5: req.query.md5 || null };

        if (chunkIndex !== undefined) {
          meta.chunked = true;
          if (req.query.numChunks) meta.numChunks = parseInt(req.query.numChunks);
          if (req.query.chunkSize) meta.chunkSize = parseInt(req.query.chunkSize);
          const contentRange = response.headers.get('content-range');
          if (contentRange) {
            const totalMatch = contentRange.match(/\/(\d+)/);
            if (totalMatch) meta.size = parseInt(totalMatch[1]);
          }
        }

        const { writeStream, commit, abort } = store.createTempWrite(
          storeKey, chunkIndex !== undefined ? parseInt(chunkIndex) : null
        );

        let bytesWritten = 0;
        let aborted = false;

        // Prevent unhandled stream errors from crashing the process
        writeStream.on('error', (err) => {
          if (!aborted) logStore.error('Write stream error:', err.message);
          aborted = true;
          abort();
        });

        // Clean up on client disconnect
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
        // No store needed — stream directly to client (zero memory)
        fetchStream.pipe(res);
        fetchStream.on('error', (err) => {
          logFile.error('Stream error:', err.message);
          if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
          else res.end();
        });
        logFile.info(`${response.status} streaming`);
      }
    } catch (error) {
      logFile.error('Error:', error.message);
      if (!res.headersSent) res.status(500).json({ error: 'File proxy error', message: error.message });
    }
  });

  // ─── ContentStore — Serve files ────────────────────────────────────
  // GET /store/:type/* — serve stored file with Range support
  app.get('/store/:type/{*splat}', (req, res) => {
    if (!store) return res.status(501).json({ error: 'ContentStore not configured' });

    let key, info;
    try {
      key = `${req.params.type}/${[req.params.splat].flat().join('/')}`;
      info = store.has(key);
    } catch (err) {
      logStore.error(`GET lookup error for ${req.params.type}/${[req.params.splat].flat().join('/')}:`, err.message);
      return res.status(500).end();
    }
    if (!info.exists) return res.status(404).end();

    const meta = info.metadata || {};
    const contentType = meta.contentType || 'application/octet-stream';

    if (info.chunked) {
      // Chunked file — serve via assembled chunk reads
      return serveChunkedFile(req, res, store, key, meta, contentType);
    }

    // Whole file — serve with Range support via fs.createReadStream
    const filePath = store.getPath(key);
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

      const stream = store.getReadStream(key, { start, end });
      stream.pipe(res);
    } else {
      res.status(200);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const stream = store.getReadStream(key);
      stream.pipe(res);
    }
  });

  // HEAD /store/:type/* — existence + size check
  app.head('/store/:type/{*splat}', (req, res) => {
    if (!store) return res.status(501).end();

    try {
      const key = `${req.params.type}/${[req.params.splat].flat().join('/')}`;
      const info = store.has(key);
      if (!info.exists) return res.status(404).end();

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
      const key = `${file.type}/${file.id}`;
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
    const hasCms = currentCmsConfig && currentCmsConfig.cmsUrl;
    const hasPlayerConfig = playerConfig && Object.keys(playerConfig).length > 0;
    if (!hasCms && !hasPlayerConfig) return '';

    const configObj = {
      ...(hasCms ? {
        cmsUrl: currentCmsConfig.cmsUrl,
        cmsKey: currentCmsConfig.cmsKey || '',
        displayName: currentCmsConfig.displayName || '',
      } : {}),
      ...(playerConfig || {}),
    };
    const configJson = JSON.stringify(configObj);
    return `<script>
(function(){
  try {
    var existing = {};
    try { existing = JSON.parse(localStorage.getItem('xibo_config') || '{}'); } catch(e) {}
    var injected = ${configJson};
    var merged = Object.assign({}, existing, injected);
    localStorage.setItem('xibo_config', JSON.stringify(merged));
  } catch(e) { logConfig.warn('ConfigInject failed:', e); }
})();
</script>`;
  }

  if (currentCmsConfig && currentCmsConfig.cmsUrl) {
    logProxy.info(`CMS config injection enabled for ${currentCmsConfig.cmsUrl}`);
  }
  if (playerConfig && Object.keys(playerConfig).length > 0) {
    logProxy.info('Player config injection enabled:', JSON.stringify(playerConfig));
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

  // ─── Serve cached static resources via Express (bypasses SW) ──────
  // html2canvas and other non-SW contexts request /player/cache/static/*
  // directly from Express. Route these to ContentStore so they don't 404.
  app.get('/player/cache/static/{*splat}', (req, res) => {
    if (!store) return res.status(404).end();
    const filename = [req.params.splat].flat().pop();
    const key = `static/${filename}`;
    const info = store.has(key);
    if (!info.exists) return res.status(404).type('text').send('Not found');
    const meta = info.metadata || {};
    const contentType = meta.contentType || 'application/octet-stream';
    const filePath = store.getPath(key);
    if (!filePath) return res.status(404).type('text').send('Not found');
    const fileSize = meta.size || fs.statSync(filePath).size;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Access-Control-Allow-Origin', '*');
    store.getReadStream(key).pipe(res);
  });

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
export function startServer({ port = 8765, pwaPath, appVersion = '0.0.0', cmsConfig, configFilePath, dataDir, playerConfig, onLog } = {}) {
  const app = createProxyApp({ pwaPath, appVersion, cmsConfig, configFilePath, dataDir, playerConfig, onLog });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, 'localhost', () => {
      logServer.info(`Running on http://localhost:${port}`);
      logServer.info('READY');
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
