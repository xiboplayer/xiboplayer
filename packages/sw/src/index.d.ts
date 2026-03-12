// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
export function calculateChunkConfig(log?: any): {
  chunkSize: number;
  threshold: number;
  concurrency: number;
};
export function extractMediaIdsFromXlf(xlfText: string, log?: any): string[];
export class RequestHandler {
  constructor(downloadManager: any);
  handleRequest(event: any): Promise<Response>;
}
export class MessageHandler {
  constructor(downloadManager: any, config: any);
  handleMessage(event: any): Promise<any>;
}
