/**
 * Widget HTML processing — preprocesses widget HTML and stores via REST
 *
 * Handles:
 * - <base> tag injection for relative path resolution (CMS mirror paths)
 * - Interactive Control hostAddress rewriting
 * - CSS object-position fix for CMS template alignment
 *
 * URL rewriting is no longer needed — the CMS serves CSS with relative paths
 * (/api/v2/player/dependencies/font.otf), and the <base> tag resolves widget
 * media references via mirror routes. Zero translation, zero regex.
 *
 * Runs on the main thread (needs window.location for URL construction).
 * Stores content via PUT /store/... — no Cache API needed.
 */

import { createLogger, PLAYER_API } from '@xiboplayer/utils';

const log = createLogger('Cache');

// Dynamic base path for multi-variant deployment (pwa, pwa-xmds, pwa-xlr)
const BASE = (typeof window !== 'undefined')
  ? window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '') || '/player/pwa'
  : '/player/pwa';

/**
 * Store widget HTML in ContentStore for iframe loading.
 * Stored at mirror path /api/v2/player/widgets/{L}/{R}/{M} — same URL the
 * CMS serves from, so iframes load directly from Express mirror routes.
 *
 * @param {string} layoutId - Layout ID
 * @param {string} regionId - Region ID
 * @param {string} mediaId - Media ID
 * @param {string} html - Widget HTML content
 * @returns {Promise<string>} Cache key URL (absolute path for iframe src)
 */
export async function cacheWidgetHtml(layoutId, regionId, mediaId, html) {
  const cacheKey = `${PLAYER_API}/widgets/${layoutId}/${regionId}/${mediaId}`;

  // Inject <base> tag — resolves relative media refs (e.g. "42") to mirror route
  const baseTag = `<base href="${PLAYER_API}/media/">`;
  let modifiedHtml = html;

  // Insert base tag after <head> opening tag (skip if already present)
  if (!html.includes('<base ')) {
    if (html.includes('<head>')) {
      modifiedHtml = html.replace('<head>', '<head>' + baseTag);
    } else if (html.includes('<HEAD>')) {
      modifiedHtml = html.replace('<HEAD>', '<HEAD>' + baseTag);
    } else {
      modifiedHtml = baseTag + html;
    }
  }

  // Inject CSS default for object-position to suppress CMS template warning
  const cssFixTag = '<style>img,video{object-position:center center}</style>';
  if (!modifiedHtml.includes('object-position:center center')) {
    if (modifiedHtml.includes('</head>')) {
      modifiedHtml = modifiedHtml.replace('</head>', cssFixTag + '</head>');
    } else if (modifiedHtml.includes('</HEAD>')) {
      modifiedHtml = modifiedHtml.replace('</HEAD>', cssFixTag + '</HEAD>');
    }
  }

  // Rewrite dependency URLs to local mirror paths. CMS sends absolute URLs
  // like https://cms.example.com/api/v2/player/dependencies/bundle.min.js
  // which fail due to CORS/auth. Replace with local /api/v2/player/dependencies/...
  modifiedHtml = modifiedHtml.replace(
    /https?:\/\/[^"'\s]+?(\/api\/v2\/player\/dependencies\/[^"'\s?]+)(\?[^"'\s]*)?/g,
    (_, path) => path
  );

  // Rewrite Interactive Control hostAddress to SW-interceptable path
  modifiedHtml = modifiedHtml.replace(
    /hostAddress\s*:\s*["']https?:\/\/[^"']+["']/g,
    `hostAddress: "${BASE}/ic"`
  );

  log.info('Injected base tag in widget HTML');

  // Store widget HTML — deps are already downloaded by the pipeline
  const putResp = await fetch(`/store${PLAYER_API}/widgets/${layoutId}/${regionId}/${mediaId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: modifiedHtml,
  });
  putResp.body?.cancel();
  log.info(`Stored widget HTML at ${cacheKey} (${modifiedHtml.length} bytes)`);

  return cacheKey;
}
