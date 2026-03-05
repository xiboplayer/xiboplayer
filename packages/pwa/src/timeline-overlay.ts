/**
 * Timeline Overlay
 *
 * Toggleable debug overlay showing upcoming schedule timeline.
 * Displays: layout IDs, time ranges, durations, current layout highlight.
 * Positioned bottom-left (download overlay is top-left).
 */

interface HiddenLayout {
  file: string;
  priority: number;
}

interface TimelineEntry {
  layoutFile: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  isDefault: boolean;
  hidden?: HiddenLayout[];
  missingMedia?: string[];
}

export class TimelineOverlay {
  private overlay: HTMLElement | null = null;
  private visible: boolean;
  private timeline: TimelineEntry[] = [];
  private currentLayoutId: number | null = null;
  private layoutStartedAt: number | null = null;    // wall-clock ms when layout began
  private currentDuration: number | null = null;
  private currentIsDefault: boolean = false;
  private previousLayout: { id: number; duration: number; startedAt: number } | null = null;
  private offline: boolean = false;
  private onLayoutClick: ((layoutId: number) => void) | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(visible = false, onLayoutClick?: (layoutId: number) => void) {
    this.visible = visible;
    this.onLayoutClick = onLayoutClick || null;
    this.createOverlay();
    if (!this.visible) {
      this.overlay!.style.display = 'none';
    }
    // Re-render every 5s to update the remaining-time countdown on the current layout
    this.refreshTimer = setInterval(() => this.render(), 5000);
  }

  private createOverlay() {
    this.overlay = document.createElement('div');
    this.overlay.id = 'timeline-overlay';
    this.overlay.style.cssText = `
      position: fixed;
      bottom: 1.5vh;
      left: 1.5vw;
      background: rgba(0, 0, 0, 0.88);
      color: #fff;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 1.4vw;
      padding: 1vh 1.2vw;
      border-radius: 0.4vw;
      border: 1px solid rgba(255, 255, 255, 0.25);
      z-index: 999999;
      max-width: 35vw;
      box-shadow: 0 0.3vh 1.2vw rgba(0, 0, 0, 0.5);
      pointer-events: auto;
    `;
    // Click-to-skip: delegate click events on layout entries
    this.overlay.addEventListener('click', (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('[data-layout-id]') as HTMLElement | null;
      if (!target || !this.onLayoutClick) return;
      const layoutId = parseInt(target.dataset.layoutId!, 10);
      if (isNaN(layoutId) || layoutId === this.currentLayoutId) return;
      this.onLayoutClick(layoutId);
    });

    document.body.appendChild(this.overlay);
  }

  toggle() {
    this.visible = !this.visible;
    if (this.overlay) {
      this.overlay.style.display = this.visible ? 'block' : 'none';
    }
    // Re-render when becoming visible (render() skips while hidden)
    if (this.visible) {
      this.render();
    }
    // Persist preference
    localStorage.setItem('xibo_show_timeline_overlay', String(this.visible));
  }

  /**
   * Update the overlay with new timeline data and/or current layout highlight.
   * Pass timeline=null to keep existing timeline and only update the highlight.
   */
  setOffline(offline: boolean) {
    this.offline = offline;
    this.render();
  }

  update(timeline: TimelineEntry[] | null, currentLayoutId: number | null) {
    // Detect layout change — save previous, record wall-clock start
    if (currentLayoutId !== null && currentLayoutId !== this.currentLayoutId) {
      if (this.currentLayoutId !== null && this.currentDuration !== null && this.layoutStartedAt !== null) {
        this.previousLayout = { id: this.currentLayoutId, duration: this.currentDuration, startedAt: this.layoutStartedAt };
      }
      this.currentLayoutId = currentLayoutId;
      this.layoutStartedAt = Date.now();
      this.currentDuration = null;
      this.currentIsDefault = false;
    }

    if (timeline !== null) {
      this.timeline = timeline;
      // Lock currentDuration from matching entry's .duration (only once per layout)
      if (this.currentDuration === null && this.currentLayoutId !== null) {
        const match = timeline.find(e =>
          parseInt(e.layoutFile.replace('.xlf', ''), 10) === this.currentLayoutId
        );
        if (match) {
          this.currentDuration = match.duration;
          this.currentIsDefault = match.isDefault;
        }
      }
    }

    this.render();
  }

  private render() {
    if (!this.overlay || !this.visible) return;

    if (this.timeline.length === 0 && !this.previousLayout && !this.currentLayoutId) {
      this.overlay.innerHTML = '<div style="color: #999;">Timeline — no upcoming layouts</div>';
      return;
    }

    const now = Date.now();
    const clickable = this.onLayoutClick !== null;

    // Build upcoming list: timeline entries minus the first occurrence of the current layout
    let skippedCurrent = false;
    const upcoming: TimelineEntry[] = [];
    for (const entry of this.timeline) {
      const layoutId = parseInt(entry.layoutFile.replace('.xlf', ''), 10);
      if (!skippedCurrent && layoutId === this.currentLayoutId) {
        skippedCurrent = true;
        continue;
      }
      upcoming.push(entry);
    }

    // Count: previous (if any) + current (if any) + upcoming
    const totalCount = (this.previousLayout ? 1 : 0) + (this.currentLayoutId ? 1 : 0) + upcoming.length;
    const offlineBadge = this.offline ? ' <span style="color: #ff4444; font-size: 1.1vw;">OFFLINE</span>' : '';
    let html = `<div style="font-weight: 600; margin-bottom: 0.8vh; font-size: 1.4vw; color: #ccc;">Timeline (${totalCount} scheduled)${offlineBadge}</div>`;

    const maxVisible = 8;
    let rendered = 0;

    // 1. Previous layout (dimmed, strikethrough)
    if (this.previousLayout && rendered < maxVisible) {
      const prev = this.previousLayout;
      const durStr = this.formatDuration(prev.duration);
      const durPad = durStr.padStart(7).replace(/ /g, '&nbsp;');
      const idCol = `#${prev.id}`.padEnd(6).replace(/ /g, '&nbsp;');
      const startDate = new Date(prev.startedAt);
      const endDate = new Date(prev.startedAt + prev.duration * 1000);
      const timeRange = `${this.formatTime(startDate)}–${this.formatTime(endDate)} `;
      const cursor = clickable ? 'cursor: pointer;' : '';
      const hover = clickable ? 'onmouseover="this.style.background=\'rgba(255,255,255,0.1)\'" onmouseout="this.style.background=\'none\'"' : '';
      html += `<div data-layout-id="${prev.id}" style="border-left: 0.25vw solid #555; padding-left: 0.6vw; color: #666; text-decoration: line-through; ${cursor} margin-bottom: 0.3vh; font-family: monospace; font-size: 1.3vw; line-height: 1.5; white-space: nowrap;" ${hover}>`;
      html += `${timeRange}${idCol}${durPad}`;
      html += '</div>';
      rendered++;
    }

    // 2. Current layout (blue highlight, countdown from wall-clock start, with time range)
    if (this.currentLayoutId !== null && rendered < maxVisible) {
      let durStr: string;
      let timeRange = '';
      if (this.currentDuration !== null && this.layoutStartedAt !== null) {
        const elapsed = (now - this.layoutStartedAt) / 1000;
        const remainingSec = Math.max(0, Math.round(this.currentDuration - elapsed));
        durStr = this.formatDuration(remainingSec);
        const startDate = new Date(this.layoutStartedAt);
        const endDate = new Date(this.layoutStartedAt + this.currentDuration * 1000);
        timeRange = `${this.formatTime(startDate)}–${this.formatTime(endDate)} `;
      } else {
        durStr = '---';
      }
      const durPad = durStr.padStart(7).replace(/ /g, '&nbsp;');
      const idCol = `#${this.currentLayoutId}`.padEnd(6).replace(/ /g, '&nbsp;');
      html += `<div data-layout-id="${this.currentLayoutId}" style="border-left: 0.25vw solid #4a9eff; padding-left: 0.6vw; color: #fff; font-weight: 600; margin-bottom: 0.3vh; font-family: monospace; font-size: 1.3vw; line-height: 1.5; white-space: nowrap;">`;
      html += `${timeRange}${idCol}${durPad}`;
      if (this.currentIsDefault) html += ' <span style="color: #888;">[def]</span>';
      html += '</div>';
      rendered++;
    }

    // 3. Upcoming layouts — compute times by chaining from current layout end
    let nextStartMs = (this.layoutStartedAt !== null && this.currentDuration !== null)
      ? this.layoutStartedAt + this.currentDuration * 1000
      : now;
    for (const entry of upcoming) {
      if (rendered >= maxVisible) break;
      const layoutId = parseInt(entry.layoutFile.replace('.xlf', ''), 10);
      const hasMissing = entry.missingMedia && entry.missingMedia.length > 0;
      const durStr = this.formatDuration(entry.duration);
      const entryEndMs = nextStartMs + entry.duration * 1000;
      const startStr = this.formatTime(new Date(nextStartMs));
      const endStr = this.formatTime(new Date(entryEndMs));

      let borderLeft: string;
      let color: string;
      if (hasMissing) {
        borderLeft = 'border-left: 0.25vw solid #ff4444; padding-left: 0.6vw;';
        color = 'color: #ff6666;';
      } else {
        borderLeft = 'padding-left: 0.85vw;';
        color = 'color: #aaa;';
      }
      const cursor = clickable ? 'cursor: pointer;' : '';
      const hover = clickable ? 'onmouseover="this.style.background=\'rgba(255,255,255,0.1)\'" onmouseout="this.style.background=\'none\'"' : '';

      html += `<div data-layout-id="${layoutId}" style="${borderLeft} ${color} ${cursor} margin-bottom: 0.3vh; font-family: monospace; font-size: 1.3vw; line-height: 1.5; white-space: nowrap;" ${hover}>`;
      const idCol = `#${layoutId}`.padEnd(6).replace(/ /g, '&nbsp;');
      const durPad = durStr.padStart(7).replace(/ /g, '&nbsp;');
      html += `${startStr}–${endStr} ${idCol}${durPad}`;
      if (entry.isDefault) html += ' <span style="color: #888;">[def]</span>';
      if (hasMissing) {
        const missingList = entry.missingMedia!.join(', ');
        html += ` <span style="color: #ff4444; font-size: 1.1vw;" title="Missing: ${missingList}">⚠ ${entry.missingMedia!.length}</span>`;
      }
      if (entry.hidden && entry.hidden.length > 0) {
        const hiddenIds = entry.hidden.map(h => `#${h.file.replace('.xlf', '')} (p${h.priority})`).join(', ');
        html += ` <span style="color: #8899aa; font-size: 1.1vw;" title="Also scheduled: ${hiddenIds}">+${entry.hidden.length}</span>`;
      }
      html += '</div>';
      nextStartMs = entryEndMs;
      rendered++;
    }

    if (totalCount > maxVisible) {
      html += `<div style="padding-left: 0.85vw; color: #888; font-size: 1.1vw; margin-top: 0.3vh;">+${totalCount - maxVisible} more</div>`;
    }

    this.overlay.innerHTML = html;
  }

  private formatTime(date: Date): string {
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  private formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
  }

  destroy() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }
}

/**
 * Determine initial visibility from URL param or localStorage.
 */
export function isTimelineVisible(): boolean {
  const urlParams = new URLSearchParams(window.location.search);
  const showTimeline = urlParams.get('showTimeline');
  if (showTimeline !== null) {
    return showTimeline !== '0' && showTimeline !== 'false';
  }

  const saved = localStorage.getItem('xibo_show_timeline_overlay');
  if (saved !== null) {
    return saved === 'true';
  }

  return false;
}
