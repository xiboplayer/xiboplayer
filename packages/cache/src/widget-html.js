/**
 * Widget HTML caching — preprocesses widget HTML and stores in Cache API
 *
 * Handles:
 * - <base> tag injection for relative path resolution
 * - CMS signed URL → local cache path rewriting
 * - CSS font URL rewriting and font file caching
 * - Interactive Control hostAddress rewriting
 * - CSS object-position fix for CMS template alignment
 *
 * Runs on the main thread (needs window.location for URL construction).
 * Uses Cache API directly — the SW also serves from the same cache.
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('Cache');
const CACHE_NAME = 'xibo-media-v1';

// Dynamic base path for multi-variant deployment (pwa, pwa-xmds, pwa-xlr)
const BASE = (typeof window !== 'undefined')
  ? window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '') || '/player/pwa'
  : '/player/pwa';

/**
 * Store widget HTML in cache for iframe loading
 * @param {string} layoutId - Layout ID
 * @param {string} regionId - Region ID
 * @param {string} mediaId - Media ID
 * @param {string} html - Widget HTML content
 * @returns {Promise<string>} Cache key URL
 */
export async function cacheWidgetHtml(layoutId, regionId, mediaId, html) {
  const cacheKey = `${BASE}/cache/widget/${layoutId}/${regionId}/${mediaId}`;
  const cache = await caches.open(CACHE_NAME);

  // Inject <base> tag to fix relative paths for widget dependencies
  // Widget HTML has relative paths like "bundle.min.js" that should resolve to cache/media/
  const baseTag = `<base href="${BASE}/cache/media/">`;
  let modifiedHtml = html;

  // Insert base tag after <head> opening tag (skip if already present)
  if (!html.includes('<base ')) {
    if (html.includes('<head>')) {
      modifiedHtml = html.replace('<head>', '<head>' + baseTag);
    } else if (html.includes('<HEAD>')) {
      modifiedHtml = html.replace('<HEAD>', '<HEAD>' + baseTag);
    } else {
      // No head tag, prepend base tag
      modifiedHtml = baseTag + html;
    }
  }

  // Rewrite absolute CMS signed URLs to local cache paths
  // Matches: https://cms/xmds.php?file=... or https://cms/pwa/file?file=...
  // These absolute URLs bypass the <base> tag entirely, causing slow CMS fetches
  const cmsUrlRegex = /https?:\/\/[^"'\s)]+(?:xmds\.php|pwa\/file)\?[^"'\s)]*file=([^&"'\s)]+)[^"'\s)]*/g;
  const staticResources = [];
  modifiedHtml = modifiedHtml.replace(cmsUrlRegex, (match, filename) => {
    const localPath = `${BASE}/cache/static/${filename}`;
    staticResources.push({ filename, originalUrl: match });
    log.info(`Rewrote widget URL: ${filename} → ${localPath}`);
    return localPath;
  });

  // Inject CSS default for object-position to suppress CMS template warning
  // CMS global-elements.xml uses {{alignId}} {{valignId}} which produces
  // invalid CSS (empty value) when alignment is not configured
  const cssFixTag = '<style>img,video{object-position:center center}</style>';
  if (!modifiedHtml.includes('object-position:center center')) {
    if (modifiedHtml.includes('</head>')) {
      modifiedHtml = modifiedHtml.replace('</head>', cssFixTag + '</head>');
    } else if (modifiedHtml.includes('</HEAD>')) {
      modifiedHtml = modifiedHtml.replace('</HEAD>', cssFixTag + '</HEAD>');
    }
  }

  // Rewrite Interactive Control hostAddress to SW-interceptable path
  // The IC library uses hostAddress + '/info', '/trigger', etc.
  // Original: hostAddress: "https://cms.example.com" → XHR to /info goes to CMS (fails)
  // Rewritten: hostAddress: "/player/pwa/ic" → XHR to /player/pwa/ic/info (intercepted by SW)
  modifiedHtml = modifiedHtml.replace(
    /hostAddress\s*:\s*["']https?:\/\/[^"']+["']/g,
    `hostAddress: "${BASE}/ic"`
  );

  log.info('Injected base tag and rewrote CMS/data URLs in widget HTML');

  // Construct full URL for cache storage
  const cacheUrl = new URL(cacheKey, window.location.origin);

  const response = new Response(modifiedHtml, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });

  await cache.put(cacheUrl, response);
  log.info(`Stored widget HTML at ${cacheKey} (${modifiedHtml.length} bytes)`);

  // Fetch and cache static resources (shared Cache API - accessible from main thread and SW)
  if (staticResources.length > 0) {
    const STATIC_CACHE_NAME = 'xibo-static-v1';
    const staticCache = await caches.open(STATIC_CACHE_NAME);

    await Promise.all(staticResources.map(async ({ filename, originalUrl }) => {
      const staticKey = `${BASE}/cache/static/${filename}`;
      const existing = await staticCache.match(staticKey);
      if (existing) return; // Already cached

      try {
        const resp = await fetch(originalUrl);
        if (!resp.ok) {
          log.warn(`Failed to fetch static resource: ${filename} (HTTP ${resp.status})`);
          return;
        }

        const ext = filename.split('.').pop().toLowerCase();
        const contentType = {
          'js': 'application/javascript',
          'css': 'text/css',
          'otf': 'font/otf', 'ttf': 'font/ttf',
          'woff': 'font/woff', 'woff2': 'font/woff2',
          'eot': 'application/vnd.ms-fontobject',
          'svg': 'image/svg+xml'
        }[ext] || 'application/octet-stream';

        // For CSS files, rewrite font URLs and cache referenced font files
        if (ext === 'css') {
          let cssText = await resp.text();
          const fontResources = [];
          const fontUrlRegex = /url\((['"]?)(https?:\/\/[^'")\s]+\?[^'")\s]*file=([^&'")\s]+\.(?:woff2?|ttf|otf|eot|svg))[^'")\s]*)\1\)/gi;
          cssText = cssText.replace(fontUrlRegex, (_match, quote, fullUrl, fontFilename) => {
            fontResources.push({ filename: fontFilename, originalUrl: fullUrl });
            log.info(`Rewrote font URL in CSS: ${fontFilename}`);
            return `url(${quote}${BASE}/cache/static/${encodeURIComponent(fontFilename)}${quote})`;
          });

          await staticCache.put(staticKey, new Response(cssText, {
            headers: { 'Content-Type': 'text/css' }
          }));
          log.info(`Cached CSS with ${fontResources.length} rewritten font URLs: ${filename}`);

          // Fetch and cache referenced font files
          await Promise.all(fontResources.map(async ({ filename: fontFile, originalUrl: fontUrl }) => {
            const fontKey = `${BASE}/cache/static/${encodeURIComponent(fontFile)}`;
            const existingFont = await staticCache.match(fontKey);
            if (existingFont) return; // Already cached (by SW or previous widget)

            try {
              const fontResp = await fetch(fontUrl);
              if (!fontResp.ok) {
                log.warn(`Failed to fetch font: ${fontFile} (HTTP ${fontResp.status})`);
                return;
              }
              const fontBlob = await fontResp.blob();
              const fontExt = fontFile.split('.').pop().toLowerCase();
              const fontContentType = {
                'otf': 'font/otf', 'ttf': 'font/ttf',
                'woff': 'font/woff', 'woff2': 'font/woff2',
                'eot': 'application/vnd.ms-fontobject',
                'svg': 'image/svg+xml'
              }[fontExt] || 'application/octet-stream';

              await staticCache.put(fontKey, new Response(fontBlob, {
                headers: { 'Content-Type': fontContentType }
              }));
              log.info(`Cached font: ${fontFile} (${fontContentType}, ${fontBlob.size} bytes)`);
            } catch (fontErr) {
              log.warn(`Failed to cache font: ${fontFile}`, fontErr);
            }
          }));
        } else {
          const blob = await resp.blob();
          await staticCache.put(staticKey, new Response(blob, {
            headers: { 'Content-Type': contentType }
          }));
          log.info(`Cached static resource: ${filename} (${contentType}, ${blob.size} bytes)`);
        }
      } catch (error) {
        log.warn(`Failed to cache static resource: ${filename}`, error);
      }
    }));
  }

  return cacheKey;
}
