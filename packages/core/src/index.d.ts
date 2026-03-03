export const VERSION: string;

export interface PlayerCoreOptions {
  config: any;
  xmds: any;
  cache: any;
  schedule: any;
  renderer: any;
  xmrWrapper: any;
  statsCollector?: any;
  displaySettings?: any;
}

export class PlayerCore {
  constructor(options: PlayerCoreOptions);

  config: any;
  xmds: any;
  cache: any;
  schedule: any;
  renderer: any;
  statsCollector: any;
  displaySettings: any;
  xmr: any;
  currentLayoutId: number | null;
  collecting: boolean;
  offlineMode: boolean;
  syncConfig: any;
  syncManager: any;
  displayCommands: Record<string, string> | null;
  dataConnectorManager: any;

  on(event: string, callback: (...args: any[]) => void): void;
  once(event: string, callback: (...args: any[]) => void): void;
  off(event: string, callback: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): void;

  collect(): Promise<void>;
  collectNow(): Promise<void>;
  collectOffline(): void;

  getNextLayout(): { layoutId: number; layoutFile: string } | null;
  peekNextLayout(): { layoutId: number; layoutFile: string } | null;
  advanceToNextLayout(): void;
  advanceToPreviousLayout(): void;
  setCurrentLayout(layoutId: number): void;
  clearCurrentLayout(): void;
  getCurrentLayoutId(): number | null;
  getPendingLayouts(): number[];
  setPendingLayout(layoutId: number, requiredMediaIds: number[]): void;
  isLayoutOverridden(): boolean;
  changeLayout(layoutId: number | string, options?: { duration?: number; changeMode?: string }): Promise<void>;
  overlayLayout(layoutId: number | string, options?: { duration?: number }): Promise<void>;
  revertToSchedule(): Promise<void>;
  requestLayoutChange(layoutId: number): Promise<void>;

  notifyMediaReady(fileId: number, fileType?: string): void;
  notifyLayoutStatus(layoutId: number): Promise<void>;
  checkSchedule(): void;
  isCollecting(): boolean;
  hasCachedData(): boolean;
  isOffline(): boolean;
  isInOfflineMode(): boolean;

  executeCommand(commandCode: string, commands?: Record<string, string>): Promise<void>;
  handleTrigger(triggerCode: string): void;
  purgeAll(): Promise<void>;
  captureScreenshot(): Promise<void>;

  requestGeoLocation(): Promise<{ latitude: number; longitude: number } | null>;
  reportGeoLocation(data: { latitude: number | string; longitude: number | string }): void;

  submitMediaInventory(files: any[]): Promise<void>;
  blackList(mediaId: number, type: string, reason: string): Promise<void>;

  reportLayoutFailure(layoutId: number, reason: string): void;
  reportLayoutSuccess(layoutId: number): void;
  isLayoutBlacklisted(layoutId: number): boolean;
  getBlacklistedLayouts(): number[];
  resetBlacklist(): void;

  getDataConnectorManager(): any;
  updateDataConnectors(): void;
  refreshDataConnectors(): void;

  setSyncManager(syncManager: any): void;
  isInSyncGroup(): boolean;
  isSyncLead(): boolean;
  getSyncConfig(): any;

  setLayoutMediaStatus(layoutFile: string, ready: boolean, missing?: string[]): void;
  recordLayoutDuration(file: string, duration: number): void;
  setupCollectionInterval(settings: any): void;
  updateCollectionInterval(newIntervalSeconds: number): void;

  cleanup(): void;
}
