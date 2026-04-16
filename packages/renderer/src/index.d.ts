// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
export const VERSION: string;

export interface RendererConfig {
  cmsUrl: string;
  hardwareKey: string;
}

export interface RendererOptions {
  fileIdToSaveAs?: Map<string, string>;
  getWidgetHtml?: (widget: any) => Promise<string | { url: string; fallback?: string }>;
  logLevel?: string;
}

export class LayoutPool {
  layouts: Map<number, any>;
  maxSize: number;
  hotLayoutId: number | null;
  has(layoutId: number): boolean;
  get(layoutId: number): any | undefined;
  add(layoutId: number, entry: any): void;
  clearWarmNotIn(keepIds: Set<number>): number;
  setHot(layoutId: number): void;
  evict(layoutId: number): void;
  clear(): void;
}

export class RendererLite {
  constructor(config: RendererConfig, container: HTMLElement, options?: RendererOptions);

  config: RendererConfig;
  container: HTMLElement;
  options: RendererOptions;
  currentLayout: any;
  currentLayoutId: number | null;
  regions: Map<string, any>;
  layoutPool: LayoutPool;
  activeOverlays: Map<number, any>;
  scaleFactor: number;
  offsetX: number;
  offsetY: number;
  _resizeSuppressed: boolean;

  on(event: string, callback: (...args: any[]) => void): () => void;
  emit(event: string, ...args: any[]): void;

  renderLayout(xlfXml: string, layoutId: number): Promise<void>;
  stopCurrentLayout(): void;
  preloadLayout(xlfXml: string, layoutId: number): Promise<boolean>;
  hasPreloadedLayout(layoutId: number): boolean;

  // SMIL State Track B — runtime xp:state wiring (plan 240).
  setStateStore(store: {
    get(path: string): unknown;
    has?(path: string): boolean;
    on?(event: string, handler: (...args: unknown[]) => void): () => void;
  } | null): void;
  getStateStore(): unknown | null;
  reevaluateXpIf(): void;

  renderOverlay(xlfXml: string, layoutId: number, priority?: number): Promise<void>;
  stopOverlay(layoutId: number): void;
  stopAllOverlays(): void;
  getActiveOverlays(): number[];

  navigateToWidget(targetWidgetId: string): void;
  nextWidget(regionId?: string): void;
  previousWidget(regionId?: string): void;

  resumeRegionMedia(regionId: string): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  showLayout(layoutId?: number): void;
  getCurrentLayoutId(): number | null;
  getCurrentLayoutTags(): string[];

  parseXlf(xlfXml: string): any;
  parseWidget(mediaEl: Element): any;

  calculateScale(layout: any): void;
  rescaleRegions(): void;

  updateLayoutDuration(): void;
  checkLayoutComplete(): void;
  hasActiveLayoutTimer(): boolean;

  cleanup(): void;
}
