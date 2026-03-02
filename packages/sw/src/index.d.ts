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
