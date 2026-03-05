export const VERSION: string;

export class RestClient {
  constructor(config: any);
  config: any;
  schemaVersion: number;

  registerDisplay(): Promise<any>;
  requiredFiles(): Promise<any>;
  schedule(): Promise<any>;
  getResource(layoutId: number, regionId: string, mediaId: string): Promise<string>;
  notifyStatus(status: any): Promise<any>;
  mediaInventory(inventoryXml: string | any[]): Promise<any>;
  blackList(mediaId: string | number, type: string, reason: string): Promise<boolean>;
  submitLog(logXml: string | any[], hardwareKey?: string): Promise<boolean>;
  submitScreenShot(base64Image: string): Promise<boolean>;
  submitStats(statsXml: string | any[], hardwareKey?: string): Promise<boolean>;
  reportFaults(faultsJson: string): Promise<boolean>;
  getWeather(): Promise<any>;

  static isAvailable(cmsUrl: string, retryOptions?: any): Promise<boolean>;
}

export class XmdsClient {
  constructor(config: any);
  config: any;

  registerDisplay(): Promise<any>;
  getSchedule(): Promise<any>;
  getRequiredFiles(): Promise<any>;
  getFile(fileId: number, fileType: string): Promise<any>;
  notifyStatus(status: any): Promise<any>;
  submitStats(statsXml: string, hardwareKey?: string): Promise<boolean>;
  submitLog(logsXml: string, hardwareKey?: string): Promise<boolean>;
  reportFaults(faultsJson: string): Promise<boolean>;
  mediaInventory(inventoryXml: string): Promise<boolean>;
}

export class ProtocolDetector {
  constructor(
    cmsUrl: string,
    RestClientClass: typeof RestClient,
    XmdsClientClass: typeof XmdsClient,
    options?: { probeTimeoutMs?: number }
  );

  protocol: 'rest' | 'xmds' | null;
  lastProbeTime: number;

  probe(): Promise<boolean>;
  detect(config: any, forceProtocol?: 'rest' | 'xmds'): Promise<{ client: any; protocol: 'rest' | 'xmds' }>;
  reprobe(config: any): Promise<{ client: any; protocol: 'rest' | 'xmds'; changed: boolean }>;
  getProtocol(): 'rest' | 'xmds' | null;
}

export function parseScheduleResponse(data: any): any;
