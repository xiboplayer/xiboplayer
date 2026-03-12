// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
export const VERSION: string;

export interface DisplaySettingsData {
  collectInterval: number;
  displayName: string;
  sizeX: number;
  sizeY: number;
  statsEnabled: boolean;
  aggregationLevel: 'Individual' | 'Aggregate';
  logLevel: string;
  xmrNetworkAddress: string | null;
  xmrWebSocketAddress: string | null;
  xmrCmsKey: string | null;
  preventSleep: boolean;
  screenshotInterval: number;
}

export class DisplaySettings {
  settings: DisplaySettingsData;
  on(event: string, callback: (...args: any[]) => void): void;
  applySettings(settings: Record<string, any>): { changed: string[]; settings: DisplaySettingsData };
  getCollectInterval(): number;
  getDisplayName(): string;
  getDisplaySize(): { width: number; height: number };
  isStatsEnabled(): boolean;
  isInDownloadWindow(): boolean;
  shouldTakeScreenshot(lastScreenshot: Date | null): boolean;
  getAllSettings(): DisplaySettingsData;
  getSetting(key: string, defaultValue?: any): any;
}
