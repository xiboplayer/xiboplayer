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

const SKIP_HEADERS = ['transfer-encoding', 'connection', 'content-encoding', 'content-length'];

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
 * @returns {import('express').Express}
 */
export function createProxyApp({ pwaPath, appVersion = '0.0.0', cmsConfig, configFilePath } = {}) {
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
      res.send(Buffer.from(buffer));
      console.log(`[FileProxy] ${response.status} (${buffer.byteLength} bytes)`);
    } catch (error) {
      console.error('[FileProxy] Error:', error.message);
      res.status(500).json({ error: 'File proxy error', message: error.message });
    }
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
export function startServer({ port = 8765, pwaPath, appVersion = '0.0.0', cmsConfig, configFilePath } = {}) {
  const app = createProxyApp({ pwaPath, appVersion, cmsConfig, configFilePath });

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
