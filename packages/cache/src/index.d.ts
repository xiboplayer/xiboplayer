// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
export const VERSION: string;

export class StoreClient {
  has(type: string, id: string | number): Promise<boolean>;
  get(type: string, id: string | number): Promise<Blob | null>;
  put(type: string, id: string | number, body: Blob | ArrayBuffer | string, contentType?: string): Promise<boolean>;
  remove(files: Array<{ type: string; id: string | number }>): Promise<{ deleted: number; total: number }>;
  list(): Promise<Array<{ id: string; type: string; size: number }>>;
}

export class DownloadManager {
  constructor(options?: { concurrency?: number; chunkSize?: number; chunksPerFile?: number });
  enqueue(fileInfo: any): any;
  getTask(key: string): any;
  getProgress(): Record<string, any>;
  prioritizeLayoutFiles(mediaIds: string[]): void;
  createTaskBuilder(): LayoutTaskBuilder;
  enqueueOrderedTasks(tasks: any[]): void;
  removeCompleted(key: string): void;
  readonly running: number;
  readonly queued: number;
  clear(): void;
  queue: any;
}

export class FileDownload {
  state: string;
  wait(): Promise<Blob>;
}
export class LayoutTaskBuilder {
  constructor(queue: any);
  addFile(fileInfo: any): FileDownload;
  build(): Promise<any[]>;
}
export const BARRIER: symbol;
export class CacheManager {}
export class CacheAnalyzer {
  constructor(store: StoreClient);
}

export const cacheManager: CacheManager;

export function isUrlExpired(url: string): boolean;
export function cacheWidgetHtml(...args: any[]): any;
