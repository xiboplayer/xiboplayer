// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
export const VERSION: string;

export interface StatEntry {
  id?: number;
  type: 'layout' | 'media' | 'event';
  layoutId: number;
  scheduleId: number;
  start: Date;
  end: Date | null;
  duration: number;
  count: number;
  submitted: 0 | 1;
  mediaId?: number;
  widgetId?: string | number | null;
  tag?: string;
}

export class StatsCollector {
  db: IDBDatabase | null;
  init(): Promise<void>;
  startLayout(layoutId: number, scheduleId: number, options?: { enableStat?: boolean }): Promise<void>;
  endLayout(layoutId: number, scheduleId: number): Promise<void>;
  startWidget(mediaId: number, layoutId: number, scheduleId: number, widgetId?: string | number, options?: { enableStat?: boolean }): Promise<void>;
  endWidget(mediaId: number, layoutId: number, scheduleId: number): Promise<void>;
  recordEvent(tag: string, layoutId: number, widgetId: number, scheduleId: number): Promise<void>;
  getStatsForSubmission(limit?: number): Promise<StatEntry[]>;
  getAggregatedStatsForSubmission(limit?: number): Promise<StatEntry[]>;
  clearSubmittedStats(stats: StatEntry[]): Promise<void>;
  getAllStats(): Promise<StatEntry[]>;
  clearAllStats(): Promise<void>;
}

export function formatStats(stats: StatEntry[]): string;

export interface LogEntry {
  id?: number;
  level: string;
  message: string;
  category: string;
  timestamp: Date;
  submitted: 0 | 1;
}

export class LogReporter {
  db: IDBDatabase | null;
  init(): Promise<void>;
  log(level: string, message: string, category?: string, extra?: any): Promise<void>;
  reportFault(code: string, reason: string, cooldownMs?: number): Promise<void>;
  getFaultsForSubmission(limit?: number): Promise<LogEntry[]>;
  error(message: string, category?: string): Promise<void>;
  audit(message: string, category?: string): Promise<void>;
  info(message: string, category?: string): Promise<void>;
  debug(message: string, category?: string): Promise<void>;
  getLogsForSubmission(limit?: number): Promise<LogEntry[]>;
  clearSubmittedLogs(logs: LogEntry[]): Promise<void>;
  getAllLogs(): Promise<LogEntry[]>;
  clearAllLogs(): Promise<void>;
}

export function formatLogs(logs: LogEntry[]): string;
export function formatFaults(faults: LogEntry[]): string;
