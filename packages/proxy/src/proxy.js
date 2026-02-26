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
import express from 'express';
import cors from 'cors';
import { ContentStore } from './content-store.js';

const SKIP_HEADERS = ['transfer-encoding', 'connection', 'content-encoding', 'content-length'];

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

  // Stream chunks sequentially
  let bytesWritten = 0;
  let currentChunk = startChunk;

  const writeNextChunk = () => {
    if (currentChunk > endChunk || bytesWritten >= responseLen) {
      res.end();
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
      res.status(404).end();
      return;
    }

    currentChunk++;
    stream.on('data', (chunk) => {
      bytesWritten += chunk.length;
      res.write(chunk);
    });
    stream.on('end', writeNextChunk);
    stream.on('error', (err) => {
      console.error(`[ContentStore] Chunk stream error: ${err.message}`);
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
 * @returns {import('express').Express}
 */
export function createProxyApp({ pwaPath, appVersion = '0.0.0', cmsConfig, configFilePath, dataDir } = {}) {
  const app = express();

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
    console.log('[Config] POST /config received:', JSON.stringify(req.body));
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
      console.log(`[Config] Wrote config.json: ${configFilePath}`);
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

      console.log(`[Proxy] ${req.method} ${xmdsUrl}`);

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
      console.log(`[Proxy] ${response.status} (${responseText.length} bytes)`);
    } catch (error) {
      console.error('[Proxy] Error:', error.message);
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

      console.log(`[REST Proxy] ${req.method} ${fullUrl}`);

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
      console.log(`[REST Proxy] ${response.status} (${buffer.byteLength} bytes)`);
    } catch (error) {
      console.error('[REST Proxy] Error:', error.message);
      res.status(500).json({ error: 'REST proxy error', message: error.message });
    }
  });

  // ─── ContentStore initialization ──────────────────────────────────
  let store = null;
  if (dataDir) {
    store = new ContentStore(path.join(dataDir, 'media'));
    store.init();
    console.log(`[Proxy] ContentStore enabled: ${path.join(dataDir, 'media')}`);
  }

  // ─── File Download Proxy ───────────────────────────────────────────
  app.get('/file-proxy', async (req, res) => {
    try {
      const cmsUrl = req.query.cms;
      const fileUrl = req.query.url;
      if (!cmsUrl || !fileUrl) return res.status(400).json({ error: 'Missing cms or url parameter' });

      const fullUrl = `${cmsUrl}${fileUrl}`;
      console.log(`[FileProxy] GET ${fullUrl}`);

      const headers = { 'User-Agent': `XiboPlayer/${appVersion}` };
      if (req.headers.range) {
        headers['Range'] = req.headers.range;
        console.log(`[FileProxy] Range: ${req.headers.range}`);
      }

      const response = await fetch(fullUrl, { headers });
      res.status(response.status);
      response.headers.forEach((value, key) => {
        if (!SKIP_HEADERS.includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      res.setHeader('Access-Control-Allow-Origin', '*');
      const buffer = await response.arrayBuffer();

      // Save to store if storeKey is provided
      if (store && req.query.storeKey) {
        try {
          const storeKey = req.query.storeKey;
          const chunkIndex = req.query.chunkIndex;
          const contentType = response.headers.get('content-type') || 'application/octet-stream';

          if (chunkIndex !== undefined) {
            const meta = {
              contentType,
              md5: req.query.md5 || null,
              chunked: true,
            };
            // Add chunk geometry from query params
            if (req.query.numChunks) meta.numChunks = parseInt(req.query.numChunks);
            if (req.query.chunkSize) meta.chunkSize = parseInt(req.query.chunkSize);
            // Add size info if available from Content-Range header
            const contentRange = response.headers.get('content-range');
            if (contentRange) {
              const totalMatch = contentRange.match(/\/(\d+)/);
              if (totalMatch) meta.size = parseInt(totalMatch[1]);
            }
            store.putChunk(storeKey, parseInt(chunkIndex), Buffer.from(buffer), meta);
            console.log(`[ContentStore] Stored chunk ${chunkIndex}: ${storeKey} (${buffer.byteLength} bytes)`);
          } else {
            store.put(storeKey, Buffer.from(buffer), {
              contentType, size: buffer.byteLength, md5: req.query.md5 || null,
            });
            console.log(`[ContentStore] Stored: ${storeKey} (${buffer.byteLength} bytes)`);
          }
        } catch (storeErr) {
          console.error('[ContentStore] Write error (non-fatal):', storeErr.message);
        }
      }

      res.send(Buffer.from(buffer));
      console.log(`[FileProxy] ${response.status} (${buffer.byteLength} bytes)`);
    } catch (error) {
      console.error('[FileProxy] Error:', error.message);
      res.status(500).json({ error: 'File proxy error', message: error.message });
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
      console.error(`[ContentStore] GET lookup error for ${req.params.type}/${[req.params.splat].flat().join('/')}:`, err.message);
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
      console.error(`[ContentStore] HEAD error for ${req.params.type}/${[req.params.splat].flat().join('/')}:`, err.message);
      res.status(500).end();
    }
  });

  // PUT /store/:type/* — store arbitrary content
  app.put('/store/:type/{*splat}', express.raw({ limit: '50mb', type: '*/*' }), (req, res) => {
    if (!store) return res.status(501).json({ error: 'ContentStore not configured' });

    const key = `${req.params.type}/${[req.params.splat].flat().join('/')}`;
    const contentType = req.headers['content-type'] || 'application/octet-stream';
    store.put(key, req.body, { contentType, size: req.body.length });
    console.log(`[ContentStore] PUT: ${key} (${req.body.length} bytes)`);
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
        console.log(`[ContentStore] Deleted: ${key}`);
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
    console.log(`[ContentStore] Marked complete: ${storeKey}`);
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
    if (!currentCmsConfig || !currentCmsConfig.cmsUrl) return '';
    const configJson = JSON.stringify({
      cmsUrl: currentCmsConfig.cmsUrl,
      cmsKey: currentCmsConfig.cmsKey || '',
      displayName: currentCmsConfig.displayName || '',
    });
    return `<script>
(function(){
  try {
    var existing = {};
    try { existing = JSON.parse(localStorage.getItem('xibo_config') || '{}'); } catch(e) {}
    var injected = ${configJson};
    if (existing.cmsUrl !== injected.cmsUrl || existing.cmsKey !== injected.cmsKey || existing.displayName !== injected.displayName) {
      var merged = Object.assign({}, existing, injected);
      localStorage.setItem('xibo_config', JSON.stringify(merged));
    }
  } catch(e) { console.warn('[ConfigInject] Failed:', e); }
})();
</script>`;
  }

  if (currentCmsConfig && currentCmsConfig.cmsUrl) {
    console.log(`[Proxy] CMS config injection enabled for ${currentCmsConfig.cmsUrl}`);
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
export function startServer({ port = 8765, pwaPath, appVersion = '0.0.0', cmsConfig, configFilePath, dataDir } = {}) {
  const app = createProxyApp({ pwaPath, appVersion, cmsConfig, configFilePath, dataDir });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, 'localhost', () => {
      console.log(`[Server] Running on http://localhost:${port}`);
      console.log(`[Server] READY`);
      resolve({ server, port });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[Server] Port ${port} already in use. Try --port=XXXX`);
      }
      reject(err);
    });

    // Graceful shutdown
    process.on('SIGINT', () => { server.close(); process.exit(0); });
    process.on('SIGTERM', () => { server.close(); process.exit(0); });
  });
}
