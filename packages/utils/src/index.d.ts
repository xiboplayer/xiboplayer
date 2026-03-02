export const VERSION: string;
export let PLAYER_API: string;

export interface Logger {
  debug(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  setLevel(level: string): void;
  getEffectiveLevel(): number;
}

export interface LogSinkEntry {
  level: string;
  name: string;
  args: any[];
}

export function createLogger(name: string, level?: string | null): Logger;
export function setLogLevel(level: string): void;
export function getLogLevel(): string;
export function isDebug(): boolean;
export function applyCmsLogLevel(cmsLevel: string): boolean;
export function registerLogSink(fn: (entry: LogSinkEntry) => void): void;
export function unregisterLogSink(fn: (entry: LogSinkEntry) => void): void;

export class EventEmitter {
  on(event: string, callback: (...args: any[]) => void): void;
  once(event: string, callback: (...args: any[]) => void): void;
  off(event: string, callback: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): void;
  removeAllListeners(event?: string): void;
}

export class Config {
  load(): Record<string, string>;
  save(): void;
  isConfigured(): boolean;
  generateStableHardwareKey(): string;
  generateXmrChannel(): string;
  ensureXmrKeyPair(): Promise<void>;
  hash(str: string): string;
  get cmsUrl(): string;
  set cmsUrl(val: string);
  get cmsKey(): string;
  set cmsKey(val: string);
  get displayName(): string;
  set displayName(val: string);
  get hardwareKey(): string;
  get xmrChannel(): string;
  get xmrPubKey(): string;
  get xmrPrivKey(): string;
  get googleGeoApiKey(): string;
  set googleGeoApiKey(val: string);
  macAddress?: string;
}

export const config: Config;

export function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retryOptions?: { maxRetries?: number; baseDelayMs?: number }
): Promise<Response>;

export class CmsApiClient {
  constructor(baseUrl: string, apiKey?: string);
  get(path: string, params?: Record<string, string>): Promise<any>;
  post(path: string, body?: any): Promise<any>;
  put(path: string, body?: any): Promise<any>;
  delete(path: string): Promise<any>;
}
