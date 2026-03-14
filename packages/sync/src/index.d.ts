// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
export const VERSION: string;

export interface SyncTransport {
  send(msg: any): void;
  onMessage(callback: (msg: any) => void): void;
  close(): void;
  readonly connected: boolean;
}

export interface SyncConfig {
  syncGroup: string;
  syncPublisherPort: number;
  syncSwitchDelay: number;
  syncVideoPauseDelay: number;
  isLead: boolean;
  relayUrl?: string;
  /** Wall mode: map lead layoutId → this display's position-specific layoutId */
  layoutMap?: Record<string, string | number>;
}

export class BroadcastChannelTransport implements SyncTransport {
  constructor(channelName?: string);
  send(msg: any): void;
  onMessage(callback: (msg: any) => void): void;
  close(): void;
  readonly connected: boolean;
}

export class WebSocketTransport implements SyncTransport {
  constructor(url: string, options?: { syncGroup?: string });
  send(msg: any): void;
  onMessage(callback: (msg: any) => void): void;
  close(): void;
  readonly connected: boolean;
}

export class SyncManager {
  constructor(options: {
    displayId: string;
    syncConfig: SyncConfig;
    transport?: SyncTransport;
    onLayoutChange?: (layoutId: string, showAt: number) => void;
    onLayoutShow?: (layoutId: string) => void;
    onVideoStart?: (layoutId: string, regionId: string) => void;
    onStatsReport?: (followerId: string, statsXml: string, ack: () => void) => void;
    onLogsReport?: (followerId: string, logsXml: string, ack: () => void) => void;
    onStatsAck?: (targetDisplayId: string) => void;
    onLogsAck?: (targetDisplayId: string) => void;
  });

  displayId: string;
  syncConfig: SyncConfig;
  isLead: boolean;
  transport: SyncTransport | null;
  /** Backward-compatible alias for transport */
  channel: SyncTransport | null;
  followers: Map<string, any>;

  start(): void;
  stop(): void;
  requestLayoutChange(layoutId: string | number): Promise<void>;
  requestVideoStart(layoutId: string | number, regionId: string): Promise<void>;
  reportReady(layoutId: string | number): void;
  reportStats(statsXml: string): void;
  reportLogs(logsXml: string): void;
  getStatus(): {
    started: boolean;
    isLead: boolean;
    displayId: string;
    followers: number;
    pendingLayoutId: string | null;
    transport: 'websocket' | 'broadcast-channel';
    followerDetails: Array<{
      displayId: string;
      lastSeen: number;
      ready: boolean;
      readyLayoutId: string | null;
      stale: boolean;
    }>;
  };
}
