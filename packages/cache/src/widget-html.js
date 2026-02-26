/**
 * Widget HTML processing — preprocesses widget HTML and stores via REST
 *
 * Handles:
 * - <base> tag injection for relative path resolution
 * - CMS signed URL → local store path rewriting
 * - CSS font URL rewriting and font file caching
 * - Interactive Control hostAddress rewriting
 * - CSS object-position fix for CMS template alignment
 *
 * Runs on the main thread (needs window.location for URL construction).
 * Stores content via PUT /store/... — no Cache API needed.
 */

import { createLogger } from '@xiboplayer/utils';
import { toProxyUrl } from './download-manager.js';

const log = createLogger('Cache');

// Dynamic base path for multi-variant deployment (pwa, pwa-xmds, pwa-xlr)
const BASE = (typeof window !== 'undefined')
  ? window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '') || '/player/pwa'
  : '/player/pwa';

// Dedup concurrent static resource fetches (two widgets both need bundle.min.js)
const _pendingStatic = new Map(); // filename → Promise<void>

/**
 * Store widget HTML in ContentStore for iframe loading
 * @param {string} layoutId - Layout ID
 * @param {string} regionId - Region ID
 * @param {string} mediaId - Media ID
 * @param {string} html - Widget HTML content
 * @returns {Promise<string>} Cache key URL
 */
export async function cacheWidgetHtml(layoutId, regionId, mediaId, html) {
  const cacheKey = `${BASE}/cache/widget/${layoutId}/${regionId}/${mediaId}`;

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

  // Rewrite absolute CMS signed URLs to local store paths
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
  const cssFixTag = '<style>img,video{object-position:center center}</style>';
  if (!modifiedHtml.includes('object-position:center center')) {
    if (modifiedHtml.includes('</head>')) {
      modifiedHtml = modifiedHtml.replace('</head>', cssFixTag + '</head>');
    } else if (modifiedHtml.includes('</HEAD>')) {
      modifiedHtml = modifiedHtml.replace('</HEAD>', cssFixTag + '</HEAD>');
    }
  }

  // Rewrite Interactive Control hostAddress to SW-interceptable path
  modifiedHtml = modifiedHtml.replace(
    /hostAddress\s*:\s*["']https?:\/\/[^"']+["']/g,
    `hostAddress: "${BASE}/ic"`
  );

  log.info('Injected base tag and rewrote CMS/data URLs in widget HTML');

  // Store static resources FIRST — widget iframe loads immediately after HTML is stored,
  // and its <script>/<link> tags will 404 if deps aren't ready yet
  if (staticResources.length > 0) {
    await Promise.all(staticResources.map(({ filename, originalUrl }) => {
      // Dedup: if another widget is already fetching the same resource, wait for it
      if (_pendingStatic.has(filename)) {
        return _pendingStatic.get(filename);
      }

      const work = (async () => {
      // Check if already stored
      try {
        const headResp = await fetch(`/store/static/${filename}`, { method: 'HEAD' });
        if (headResp.ok) return; // Already stored
      } catch { /* proceed to fetch */ }

      try {
        const resp = await fetch(toProxyUrl(originalUrl));
        if (!resp.ok) {
          resp.body?.cancel();
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

        // For CSS files, rewrite font URLs and store referenced font files
        if (ext === 'css') {
          let cssText = await resp.text();
          const fontResources = [];
          const fontUrlRegex = /url\((['"]?)(https?:\/\/[^'")\s]+\?[^'")\s]*file=([^&'")\s]+\.(?:woff2?|ttf|otf|eot|svg))[^'")\s]*)\1\)/gi;
          cssText = cssText.replace(fontUrlRegex, (_match, quote, fullUrl, fontFilename) => {
            fontResources.push({ filename: fontFilename, originalUrl: fullUrl });
            log.info(`Rewrote font URL in CSS: ${fontFilename}`);
            return `url(${quote}${BASE}/cache/static/${encodeURIComponent(fontFilename)}${quote})`;
          });

          const cssResp = await fetch(`/store/static/${filename}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/css' },
            body: cssText,
          });
          cssResp.body?.cancel();
          log.info(`Stored CSS with ${fontResources.length} rewritten font URLs: ${filename}`);

          // Fetch and store referenced font files
          await Promise.all(fontResources.map(async ({ filename: fontFile, originalUrl: fontUrl }) => {
            // Check if already stored
            try {
              const headResp = await fetch(`/store/static/${encodeURIComponent(fontFile)}`, { method: 'HEAD' });
              if (headResp.ok) return;
            } catch { /* proceed */ }

            try {
              const fontResp = await fetch(toProxyUrl(fontUrl));
              if (!fontResp.ok) {
                fontResp.body?.cancel();
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

              const fontPutResp = await fetch(`/store/static/${encodeURIComponent(fontFile)}`, {
                method: 'PUT',
                headers: { 'Content-Type': fontContentType },
                body: fontBlob,
              });
              fontPutResp.body?.cancel();
              log.info(`Stored font: ${fontFile} (${fontContentType}, ${fontBlob.size} bytes)`);
            } catch (fontErr) {
              log.warn(`Failed to store font: ${fontFile}`, fontErr);
            }
          }));
        } else {
          const blob = await resp.blob();
          const staticResp = await fetch(`/store/static/${filename}`, {
            method: 'PUT',
            headers: { 'Content-Type': contentType },
            body: blob,
          });
          staticResp.body?.cancel();
          log.info(`Stored static resource: ${filename} (${contentType}, ${blob.size} bytes)`);
        }
      } catch (error) {
        log.warn(`Failed to store static resource: ${filename}`, error);
      }
      })();

      _pendingStatic.set(filename, work);
      return work.finally(() => _pendingStatic.delete(filename));
    }));
  }

  // Store widget HTML AFTER all static deps are ready — iframe loads instantly on store,
  // so bundle.min.js/fonts.css/fonts must already be in the ContentStore
  const putResp = await fetch(`/store/widget/${layoutId}/${regionId}/${mediaId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: modifiedHtml,
  });
  putResp.body?.cancel();
  log.info(`Stored widget HTML at ${cacheKey} (${modifiedHtml.length} bytes)`);

  return cacheKey;
}
