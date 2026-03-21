// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
export const VERSION: string;

export interface SyncTransport {
  send(msg: any): void;
  onMessage(callback: (msg: any) => void): void;
  close(): void;
  readonly connected: boolean;
}

export type Choreography =
  | 'simultaneous'
  | 'wave-right' | 'wave-left'
  | 'wave-down' | 'wave-up'
  | 'diagonal-tl' | 'diagonal-tr' | 'diagonal-bl' | 'diagonal-br'
  | 'center-out' | 'outside-in'
  | 'random';

/** Display topology — position and orientation in the physical grid */
export interface DisplayTopology {
  /** X coordinate in the grid (0-indexed, left to right) */
  x: number;
  /** Y coordinate in the grid (0-indexed, top to bottom) */
  y: number;
  /** Screen orientation in degrees clockwise (0=landscape, 90=portrait-right, 270=portrait-left) */
  orientation?: number;
}

export interface SyncConfig {
  syncGroup: string;
  syncPublisherPort: number;
  syncSwitchDelay: number;
  syncVideoPauseDelay: number;
  isLead: boolean;
  relayUrl?: string;
  /** Auth token for relay join validation (typically CMS server key) */
  syncToken?: string;
  /** Wall mode: map lead layoutId → this display's position-specific layoutId */
  layoutMap?: Record<string, string | number>;

  // ── Choreography (1D mode) ─────────────────────────────────────
  /** This display's 0-indexed position in a row (1D choreography) */
  position?: number;
  /** Total displays in the group (auto-detected from relay if omitted) */
  totalDisplays?: number;

  // ── Choreography (2D mode) ─────────────────────────────────────
  /** This display's topology { x, y, orientation } (enables 2D choreography) */
  topology?: DisplayTopology;
  /** Grid width in columns (required for 2D choreography) */
  gridCols?: number;
  /** Grid height in rows (required for 2D choreography) */
  gridRows?: number;

  // ── Choreography (common) ──────────────────────────────────────
  /** Transition choreography pattern */
  choreography?: Choreography;
  /** Base delay between consecutive displays in ms (default: 150) */
  staggerMs?: number;
}

export class BroadcastChannelTransport implements SyncTransport {
  constructor(channelName?: string);
  send(msg: any): void;
  onMessage(callback: (msg: any) => void): void;
  close(): void;
  readonly connected: boolean;
}

export class WebSocketTransport implements SyncTransport {
  constructor(url: string, options?: {
    syncGroup?: string;
    displayId?: string;
    topology?: DisplayTopology;
    token?: string;
  });
  send(msg: any): void;
  onMessage(callback: (msg: any) => void): void;
  close(): void;
  readonly connected: boolean;
}

export function computeStagger(options: {
  choreography: string;
  staggerMs: number;
  // 1D mode
  position?: number;
  totalDisplays?: number;
  // 2D mode
  topology?: DisplayTopology;
  gridCols?: number;
  gridRows?: number;
}): number;

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
    onGroupUpdate?: (totalDisplays: number, topology: Record<string, DisplayTopology>) => void;
  });

  displayId: string;
  syncConfig: SyncConfig;
  isLead: boolean;
  transport: SyncTransport | null;
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
