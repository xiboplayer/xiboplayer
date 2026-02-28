/**
 * Layout translator - XLF to HTML
 * Based on arexibo layout.rs
 */

import { cacheWidgetHtml } from '@xiboplayer/cache';
import { createLogger } from '@xiboplayer/utils';

const log = createLogger('Layout');

export class LayoutTranslator {
  constructor(xmds) {
    this.xmds = xmds;
  }

  /**
   * Translate XLF XML to playable HTML
   */
  async translateXLF(layoutId, xlfXml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xlfXml, 'text/xml');

    const layoutEl = doc.querySelector('layout');
    if (!layoutEl) {
      throw new Error('Invalid XLF: no <layout> element');
    }

    const width = parseInt(layoutEl.getAttribute('width') || '1920');
    const height = parseInt(layoutEl.getAttribute('height') || '1080');
    const bgcolor = layoutEl.getAttribute('bgcolor') || '#000000';

    const regions = [];
    for (const regionEl of doc.querySelectorAll('region')) {
      regions.push(await this.translateRegion(layoutId, regionEl));
    }

    return this.generateHTML(width, height, bgcolor, regions);
  }

  /**
   * Translate a single region
   */
  async translateRegion(layoutId, regionEl) {
    const id = regionEl.getAttribute('id');
    const width = parseInt(regionEl.getAttribute('width'));
    const height = parseInt(regionEl.getAttribute('height'));
    const top = parseInt(regionEl.getAttribute('top'));
    const left = parseInt(regionEl.getAttribute('left'));
    const zindex = parseInt(regionEl.getAttribute('zindex') || '0');

    const media = [];
    for (const mediaEl of regionEl.querySelectorAll('media')) {
      media.push(await this.translateMedia(layoutId, id, mediaEl));
    }

    return {
      id,
      width,
      height,
      top,
      left,
      zindex,
      media
    };
  }

  /**
   * Translate a single media item
   */
  async translateMedia(layoutId, regionId, mediaEl) {
    const type = mediaEl.getAttribute('type');
    const duration = parseInt(mediaEl.getAttribute('duration') || '10');
    const id = mediaEl.getAttribute('id');

    const optionsEl = mediaEl.querySelector('options');
    const rawEl = mediaEl.querySelector('raw');

    const options = {};
    if (optionsEl) {
      for (const child of optionsEl.children) {
        options[child.tagName] = child.textContent;
      }
    }

    // Parse transition information
    const transitions = {
      in: null,
      out: null
    };

    const transInEl = mediaEl.querySelector('options > transIn');
    const transOutEl = mediaEl.querySelector('options > transOut');
    const transInDurationEl = mediaEl.querySelector('options > transInDuration');
    const transOutDurationEl = mediaEl.querySelector('options > transOutDuration');
    const transInDirectionEl = mediaEl.querySelector('options > transInDirection');
    const transOutDirectionEl = mediaEl.querySelector('options > transOutDirection');

    if (transInEl && transInEl.textContent) {
      transitions.in = {
        type: transInEl.textContent,
        duration: parseInt(transInDurationEl?.textContent || '1000'),
        direction: transInDirectionEl?.textContent || 'N'
      };
    }

    if (transOutEl && transOutEl.textContent) {
      transitions.out = {
        type: transOutEl.textContent,
        duration: parseInt(transOutDurationEl?.textContent || '1000'),
        direction: transOutDirectionEl?.textContent || 'N'
      };
    }

    // All videos use cache URL pattern
    // Large videos download in background, small videos are already cached
    // Service Worker handles both cases appropriately

    let raw = rawEl ? rawEl.textContent : '';

    // For widgets (clock, calendar, etc.), fetch rendered HTML from CMS
    const widgetTypes = ['clock', 'clock-digital', 'clock-analogue', 'calendar', 'weather',
                         'currencies', 'stocks', 'twitter', 'global', 'embedded', 'text', 'ticker'];
    if (widgetTypes.some(w => type.includes(w))) {
      // Try to get widget HTML with retry logic for kiosk reliability
      let retries = 3;
      let lastError = null;

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          log.info(`Fetching resource for ${type} widget (layout=${layoutId}, region=${regionId}, media=${id}) - attempt ${attempt}/${retries}`);
          raw = await this.xmds.getResource(layoutId, regionId, id);
          log.info(`Got resource HTML (${raw.length} chars)`);

          // Store widget HTML in cache and save cache key for iframe src generation
          const widgetCacheKey = await cacheWidgetHtml(layoutId, regionId, id, raw);
          options.widgetCacheKey = widgetCacheKey;

          // Success - break retry loop
          break;

        } catch (error) {
          lastError = error;
          log.warn(`Failed to get resource (attempt ${attempt}/${retries}):`, error.message);

          // If not last attempt, wait before retry
          if (attempt < retries) {
            const delay = attempt * 2000; // 2s, 4s backoff
            log.info(`Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      // If all retries failed, try to use cached version as fallback
      if (!raw && lastError) {
        log.warn('All retries failed, checking for cached widget HTML...');

        // Try to get cached widget HTML from ContentStore via proxy
        try {
          const resp = await fetch(`/store/widget/${layoutId}/${regionId}/${id}`);
          if (resp.ok) {
            raw = await resp.text();
            options.widgetCacheKey = `/cache/widget/${layoutId}/${regionId}/${id}`;
            log.info(`Using stored widget HTML (${raw.length} chars) - CMS update pending`);
          } else {
            log.error(`No stored version available for widget ${id}`);
            raw = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#999;font-size:18px;">Content updating...</div>`;
          }
        } catch (storeError) {
          log.error('Store fallback failed:', storeError);
          raw = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#999;font-size:18px;">Content updating...</div>`;
        }
      }
    }

    return {
      type,
      duration,
      id,
      options,
      raw,
      transitions
    };
  }

  /**
   * Generate HTML from parsed layout
   */
  generateHTML(width, height, bgcolor, regions) {
    const regionHTML = regions.map(r => this.generateRegionHTML(r)).join('\n');
    const regionJS = regions.map(r => this.generateRegionJS(r)).join(',\n');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${width}, height=${height}">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    body { background-color: ${bgcolor}; }
    .region {
      position: absolute;
      overflow: hidden;
    }
    .media {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    iframe {
      border: none;
      width: 100%;
      height: 100%;
    }
  </style>
</head>
<body>
${regionHTML}
<script>
// Transition utilities
window.Transitions = {
  fadeIn(element, duration) {
    const keyframes = [
      { opacity: 0 },
      { opacity: 1 }
    ];
    const timing = {
      duration: duration,
      easing: 'linear',
      fill: 'forwards'
    };
    return element.animate(keyframes, timing);
  },

  fadeOut(element, duration) {
    const keyframes = [
      { opacity: 1 },
      { opacity: 0 }
    ];
    const timing = {
      duration: duration,
      easing: 'linear',
      fill: 'forwards'
    };
    return element.animate(keyframes, timing);
  },

  getFlyKeyframes(direction, width, height, isIn) {
    const dirMap = {
      'N': { x: 0, y: isIn ? -height : height },
      'NE': { x: isIn ? width : -width, y: isIn ? -height : height },
      'E': { x: isIn ? width : -width, y: 0 },
      'SE': { x: isIn ? width : -width, y: isIn ? height : -height },
      'S': { x: 0, y: isIn ? height : -height },
      'SW': { x: isIn ? -width : width, y: isIn ? height : -height },
      'W': { x: isIn ? -width : width, y: 0 },
      'NW': { x: isIn ? -width : width, y: isIn ? -height : height }
    };

    const offset = dirMap[direction] || dirMap['N'];

    if (isIn) {
      return [
        { transform: \`translate(\${offset.x}px, \${offset.y}px)\`, opacity: 0 },
        { transform: 'translate(0, 0)', opacity: 1 }
      ];
    } else {
      return [
        { transform: 'translate(0, 0)', opacity: 1 },
        { transform: \`translate(\${offset.x}px, \${offset.y}px)\`, opacity: 0 }
      ];
    }
  },

  flyIn(element, duration, direction, regionWidth, regionHeight) {
    const keyframes = this.getFlyKeyframes(direction, regionWidth, regionHeight, true);
    const timing = {
      duration: duration,
      easing: 'ease-out',
      fill: 'forwards'
    };
    return element.animate(keyframes, timing);
  },

  flyOut(element, duration, direction, regionWidth, regionHeight) {
    const keyframes = this.getFlyKeyframes(direction, regionWidth, regionHeight, false);
    const timing = {
      duration: duration,
      easing: 'ease-in',
      fill: 'forwards'
    };
    return element.animate(keyframes, timing);
  },

  apply(element, transitionConfig, isIn, regionWidth, regionHeight) {
    if (!transitionConfig || !transitionConfig.type) {
      return null;
    }

    const type = transitionConfig.type.toLowerCase();
    const duration = transitionConfig.duration || 1000;
    const direction = transitionConfig.direction || 'N';

    switch (type) {
      case 'fadein':
        return isIn ? this.fadeIn(element, duration) : null;
      case 'fadeout':
        return isIn ? null : this.fadeOut(element, duration);
      case 'flyin':
        return isIn ? this.flyIn(element, duration, direction, regionWidth, regionHeight) : null;
      case 'flyout':
        return isIn ? null : this.flyOut(element, duration, direction, regionWidth, regionHeight);
      default:
        return null;
    }
  }
};

const regions = {
${regionJS}
};

// Auto-start all regions
Object.keys(regions).forEach(id => {
  playRegion(id);
});

// Track active timers per region so layout teardown can cancel them
const regionTimers = {};

function playRegion(id) {
  const region = regions[id];
  if (!region || region.media.length === 0) return;

  regionTimers[id] = [];

  // If only one media item, just show it and don't cycle (arexibo behavior)
  if (region.media.length === 1) {
    const media = region.media[0];
    if (media.start) media.start();
    return; // Don't schedule stop/restart
  }

  // Multiple media items - cycle normally
  let currentIndex = 0;

  function playNext() {
    const media = region.media[currentIndex];
    if (media.start) media.start();

    const duration = media.duration || 10;
    const timerId = setTimeout(() => {
      if (media.stop) media.stop();
      currentIndex = (currentIndex + 1) % region.media.length;
      playNext();
    }, duration * 1000);
    regionTimers[id].push(timerId);
  }

  playNext();
}

// Cleanup function — called before layout teardown
window._stopAllRegions = function() {
  Object.values(regionTimers).forEach(timers => timers.forEach(t => clearTimeout(t)));
};
</script>
</body>
</html>`;
  }

  /**
   * Generate HTML for a region container
   */
  generateRegionHTML(region) {
    return `  <div id="region_${region.id}" class="region" style="
    left: ${region.left}px;
    top: ${region.top}px;
    width: ${region.width}px;
    height: ${region.height}px;
    z-index: ${region.zindex};
  "></div>`;
  }

  /**
   * Generate JavaScript for region media control
   */
  generateRegionJS(region) {
    const mediaJS = region.media.map(m => this.generateMediaJS(m, region.id)).join(',\n    ');

    return `  '${region.id}': {
    media: [
${mediaJS}
    ]
  }`;
  }

  /**
   * Generate iframe widget JS for text/ticker and generic widget types.
   * Returns { startFn, stopFn } strings for the media item.
   */
  _generateIframeWidgetJS(regionId, mediaId, widgetUrl, transIn, transOut) {
    const iframeId = `widget_${regionId}_${mediaId}`;
    const startFn = `() => {
        const region = document.getElementById('region_${regionId}');
        let iframe = document.getElementById('${iframeId}');
        if (!iframe) {
          iframe = document.createElement('iframe');
          iframe.id = '${iframeId}';
          iframe.src = '${widgetUrl}';
          iframe.style.width = '100%';
          iframe.style.height = '100%';
          iframe.style.border = 'none';
          iframe.scrolling = 'no';
          iframe.style.opacity = '0';
          region.innerHTML = '';
          region.appendChild(iframe);

          // Apply transition after iframe loads
          iframe.onload = () => {
            const transIn = ${transIn};
            if (transIn && window.Transitions) {
              const regionRect = region.getBoundingClientRect();
              window.Transitions.apply(iframe, transIn, true, regionRect.width, regionRect.height);
            } else {
              iframe.style.opacity = '1';
            }
          };
        } else {
          iframe.style.display = 'block';
          iframe.style.opacity = '1';
        }
      }`;
    const stopFn = `() => {
        const region = document.getElementById('region_${regionId}');
        const iframe = document.getElementById('${iframeId}');
        if (iframe) {
          const transOut = ${transOut};
          if (transOut && window.Transitions) {
            const regionRect = region.getBoundingClientRect();
            const animation = window.Transitions.apply(iframe, transOut, false, regionRect.width, regionRect.height);
            if (animation) {
              animation.onfinish = () => {
                iframe.style.display = 'none';
              };
              return;
            }
          }
          iframe.style.display = 'none';
        }
      }`;
    return { startFn, stopFn };
  }

  /**
   * Generate JavaScript for a single media item
   */
  generateMediaJS(media, regionId) {
    const duration = media.duration || 10;
    const transIn = media.transitions?.in ? JSON.stringify(media.transitions.in) : 'null';
    const transOut = media.transitions?.out ? JSON.stringify(media.transitions.out) : 'null';
    let startFn = 'null';
    let stopFn = 'null';

    switch (media.type) {
      case 'image':
        // Use absolute URL within service worker scope
        const imageSrc = `${window.location.origin}/player/cache/media/${media.options.uri}`;
        startFn = `() => {
        const region = document.getElementById('region_${regionId}');
        const img = document.createElement('img');
        img.className = 'media';
        img.src = '${imageSrc}';
        img.style.opacity = '0';
        region.innerHTML = '';
        region.appendChild(img);

        // Apply transition
        const transIn = ${transIn};
        if (transIn && window.Transitions) {
          const regionRect = region.getBoundingClientRect();
          window.Transitions.apply(img, transIn, true, regionRect.width, regionRect.height);
        } else {
          img.style.opacity = '1';
        }
      }`;
        break;

      case 'video':
        // All videos use cache URL pattern
        // Background-downloaded videos will auto-reload when cache completes
        const videoSrc = `${window.location.origin}/player/cache/media/${media.options.uri}`;
        const videoFilename = media.options.uri;

        startFn = `() => {
        const region = document.getElementById('region_${regionId}');
        const video = document.createElement('video');
        video.className = 'media';
        video.src = '${videoSrc}';
        video.dataset.filename = '${videoFilename}';
        video.autoplay = true;
        video.muted = ${media.options.mute === '1' ? 'true' : 'false'};
        video.loop = false;
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'contain';
        video.style.opacity = '0';

        // Retry loading if cache completes while video is playing
        const retryOnCache = (event) => {
          if (event.detail.filename === '${videoFilename}' && video.error) {
            console.log('[Video] Cache complete, reloading:', '${videoFilename}');
            video.load();
            video.play();
          }
        };
        window.addEventListener('media-cached', retryOnCache);
        video.dataset.cacheListener = 'attached';

        region.innerHTML = '';
        region.appendChild(video);

        // Apply transition
        const transIn = ${transIn};
        if (transIn && window.Transitions) {
          const regionRect = region.getBoundingClientRect();
          window.Transitions.apply(video, transIn, true, regionRect.width, regionRect.height);
        } else {
          video.style.opacity = '1';
        }

        console.log('[Video] Playing:', '${media.options.uri}');
      }`;
        stopFn = `() => {
        const region = document.getElementById('region_${regionId}');
        const video = document.querySelector('#region_${regionId} video');
        if (video) {
          const transOut = ${transOut};
          if (transOut && window.Transitions) {
            const regionRect = region.getBoundingClientRect();
            const animation = window.Transitions.apply(video, transOut, false, regionRect.width, regionRect.height);
            if (animation) {
              animation.onfinish = () => {
                video.pause();
                video.remove();
              };
              return;
            }
          }
          video.pause();
          video.remove();
        }
      }`;
        break;

      case 'text':
      case 'ticker':
        // Text/ticker widgets use the same iframe pattern as default widgets.
        // If no widgetCacheKey, fall through to the default case which handles unsupported types.
        if (media.options.widgetCacheKey) {
          const textUrl = `${window.location.origin}/player${media.options.widgetCacheKey}`;
          const iframe = this._generateIframeWidgetJS(regionId, media.id, textUrl, transIn, transOut);
          startFn = iframe.startFn;
          stopFn = iframe.stopFn;
          break;
        }
        // Fall through to default (handles missing widgetCacheKey as unsupported)

      case 'audio':
        const audioSrc = `${window.location.origin}/player/cache/media/${media.options.uri}`;
        const audioId = `audio_${regionId}_${media.id}`;
        const audioLoop = media.options.loop === '1';
        const audioVolume = (parseInt(media.options.volume || '100') / 100).toFixed(2);

        startFn = `() => {
        const region = document.getElementById('region_${regionId}');

        // Create audio element
        const audio = document.createElement('audio');
        audio.id = '${audioId}';
        audio.className = 'media';
        audio.src = '${audioSrc}';
        audio.autoplay = true;
        audio.loop = ${audioLoop};
        audio.volume = ${audioVolume};

        // Create visual feedback container
        const visualContainer = document.createElement('div');
        visualContainer.className = 'audio-visual';
        visualContainer.style.cssText = \`
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          opacity: 0;
        \`;

        // Audio icon
        const icon = document.createElement('div');
        icon.innerHTML = '♪';
        icon.style.cssText = \`
          font-size: 120px;
          color: white;
          margin-bottom: 20px;
          animation: pulse 2s ease-in-out infinite;
        \`;

        // Audio info
        const info = document.createElement('div');
        info.style.cssText = \`
          color: white;
          font-size: 24px;
          text-align: center;
          padding: 0 20px;
        \`;
        info.textContent = 'Playing Audio';

        // Filename
        const filename = document.createElement('div');
        filename.style.cssText = \`
          color: rgba(255,255,255,0.7);
          font-size: 16px;
          margin-top: 10px;
        \`;
        filename.textContent = '${media.options.uri}';

        visualContainer.appendChild(icon);
        visualContainer.appendChild(info);
        visualContainer.appendChild(filename);

        region.innerHTML = '';
        region.appendChild(audio);
        region.appendChild(visualContainer);

        // Add pulse animation
        const style = document.createElement('style');
        style.textContent = \`
          @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.1); opacity: 0.8; }
          }
        \`;
        document.head.appendChild(style);

        // Apply transition
        const transIn = ${transIn};
        if (transIn && window.Transitions) {
          const regionRect = region.getBoundingClientRect();
          window.Transitions.apply(visualContainer, transIn, true, regionRect.width, regionRect.height);
        } else {
          visualContainer.style.opacity = '1';
        }

        console.log('[Audio] Playing:', '${audioSrc}', 'Volume:', ${audioVolume}, 'Loop:', ${audioLoop});
      }`;

        stopFn = `() => {
        const audio = document.getElementById('${audioId}');
        if (audio) {
          audio.pause();
          audio.remove();
        }
        const region = document.getElementById('region_${regionId}');
        if (region) {
          const visualContainer = region.querySelector('.audio-visual');
          if (visualContainer) {
            const transOut = ${transOut};
            if (transOut && window.Transitions) {
              const regionRect = region.getBoundingClientRect();
              const animation = window.Transitions.apply(visualContainer, transOut, false, regionRect.width, regionRect.height);
              if (animation) {
                animation.onfinish = () => visualContainer.remove();
                return;
              }
            }
            visualContainer.remove();
          }
        }
      }`;
        break;

      case 'pdf':
        const pdfSrc = `${window.location.origin}/player/cache/media/${media.options.uri}`;
        const pdfContainerId = `pdf_${regionId}_${media.id}`;
        const pdfDuration = duration; // Total duration for entire PDF

        startFn = `async () => {
        const container = document.createElement('div');
        container.className = 'media pdf-container';
        container.id = '${pdfContainerId}';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.overflow = 'hidden';
        container.style.backgroundColor = '#525659';
        container.style.opacity = '0';
        container.style.position = 'relative';

        const region = document.getElementById('region_${regionId}');
        region.innerHTML = '';
        region.appendChild(container);

        // Load PDF.js if not already loaded
        if (typeof pdfjsLib === 'undefined') {
          try {
            const pdfjsModule = await import('pdfjs-dist');
            window.pdfjsLib = pdfjsModule;
            pdfjsLib.GlobalWorkerOptions.workerSrc = '${window.location.origin}/player/pdf.worker.min.mjs';
          } catch (error) {
            console.error('[PDF] Failed to load PDF.js:', error);
            container.innerHTML = '<div style="color:white;padding:20px;text-align:center;">PDF viewer unavailable</div>';
            return;
          }
        }

        // Render PDF with multi-page support
        try {
          const loadingTask = pdfjsLib.getDocument('${pdfSrc}');
          const pdf = await loadingTask.promise;
          const totalPages = pdf.numPages;

          // Calculate time per page (distribute total duration across all pages)
          const timePerPage = (${pdfDuration} * 1000) / totalPages; // milliseconds per page

          console.log(\`[PDF] Loading: \${totalPages} pages, \${timePerPage}ms per page\`);

          const containerWidth = container.offsetWidth || ${width};
          const containerHeight = container.offsetHeight || ${height};

          // Create page indicator
          const pageIndicator = document.createElement('div');
          pageIndicator.className = 'pdf-page-indicator';
          pageIndicator.style.cssText = \`
            position: absolute;
            bottom: 10px;
            right: 10px;
            background: rgba(0,0,0,0.7);
            color: white;
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 14px;
            z-index: 10;
          \`;
          container.appendChild(pageIndicator);

          let currentPage = 1;
          let pageTimers = [];

          // Function to render a single page
          async function renderPage(pageNum) {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1 });

            // Calculate scale to fit page within container
            const scaleX = containerWidth / viewport.width;
            const scaleY = containerHeight / viewport.height;
            const scale = Math.min(scaleX, scaleY);

            const scaledViewport = page.getViewport({ scale });

            const canvas = document.createElement('canvas');
            canvas.className = 'pdf-page';
            const context = canvas.getContext('2d');
            canvas.width = scaledViewport.width;
            canvas.height = scaledViewport.height;

            // Center canvas in container
            canvas.style.cssText = \`
              display: block;
              margin: auto;
              margin-top: \${Math.max(0, (containerHeight - scaledViewport.height) / 2)}px;
              position: absolute;
              top: 0;
              left: 50%;
              transform: translateX(-50%);
              opacity: 0;
              transition: opacity 0.5s ease-in-out;
            \`;

            container.appendChild(canvas);

            await page.render({
              canvasContext: context,
              viewport: scaledViewport
            }).promise;

            // Fade in new page
            setTimeout(() => canvas.style.opacity = '1', 50);

            return canvas;
          }

          // Function to cycle through pages
          async function cyclePage() {
            // Update page indicator
            pageIndicator.textContent = \`Page \${currentPage} / \${totalPages}\`;

            // Remove old pages
            const oldPages = container.querySelectorAll('.pdf-page');
            oldPages.forEach(oldPage => {
              if (oldPage !== container.lastChild) {
                oldPage.style.opacity = '0';
                setTimeout(() => oldPage.remove(), 500);
              }
            });

            // Render current page
            await renderPage(currentPage);

            console.log(\`[PDF] Showing page \${currentPage}/\${totalPages}\`);

            // Schedule next page
            if (totalPages > 1) {
              const timer = setTimeout(() => {
                currentPage = currentPage >= totalPages ? 1 : currentPage + 1;
                cyclePage();
              }, timePerPage);
              pageTimers.push(timer);
            }
          }

          // Store live timer array on element for cleanup (not JSON — stays current)
          container._pageTimers = pageTimers;

          // Start cycling
          await cyclePage();

          // Apply transition to container
          const transIn = ${transIn};
          if (transIn && window.Transitions) {
            const regionRect = region.getBoundingClientRect();
            window.Transitions.apply(container, transIn, true, regionRect.width, regionRect.height);
          } else {
            container.style.opacity = '1';
          }

        } catch (error) {
          console.error('[PDF] Render failed:', error);
          container.innerHTML = '<div style="color:white;padding:20px;text-align:center;">Failed to load PDF</div>';
          container.style.opacity = '1';
        }
      }`;

        stopFn = `() => {
        const region = document.getElementById('region_${regionId}');
        const container = document.getElementById('${pdfContainerId}');
        if (container) {
          // Clear page cycling timers (live array, always current)
          if (container._pageTimers) {
            container._pageTimers.forEach(t => clearTimeout(t));
            container._pageTimers.length = 0;
          }

          const transOut = ${transOut};
          if (transOut && window.Transitions) {
            const regionRect = region.getBoundingClientRect();
            const animation = window.Transitions.apply(container, transOut, false, regionRect.width, regionRect.height);
            if (animation) {
              animation.onfinish = () => {
                container.remove();
              };
              return;
            }
          }
          container.remove();
        }
      }`;
        break;

      case 'webpage':
        const url = decodeURIComponent(media.options.uri || '');
        startFn = `() => {
        const region = document.getElementById('region_${regionId}');
        const iframe = document.createElement('iframe');
        iframe.src = '${url}';
        iframe.style.opacity = '0';
        region.innerHTML = '';
        region.appendChild(iframe);

        // Apply transition after iframe loads
        iframe.onload = () => {
          const transIn = ${transIn};
          if (transIn && window.Transitions) {
            const regionRect = region.getBoundingClientRect();
            window.Transitions.apply(iframe, transIn, true, regionRect.width, regionRect.height);
          } else {
            iframe.style.opacity = '1';
          }
        };
      }`;
        break;

      default:
        // Widgets (clock, calendar, weather, etc.) - use cache URL pattern in /player/ scope for SW
        // Keep widget iframes alive across duration cycles (arexibo behavior)
        if (media.options.widgetCacheKey) {
          const widgetUrl = `${window.location.origin}/player${media.options.widgetCacheKey}`;
          const iframe = this._generateIframeWidgetJS(regionId, media.id, widgetUrl, transIn, transOut);
          startFn = iframe.startFn;
          stopFn = iframe.stopFn;
        } else {
          log.warn(`Unsupported media type: ${media.type}`);
          startFn = `() => console.log('Unsupported media type: ${media.type}')`;
        }
    }

    return `      {
        start: ${startFn},
        stop: ${stopFn},
        duration: ${duration}
      }`;
  }
}

