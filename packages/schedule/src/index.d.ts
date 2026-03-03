export const VERSION: string;

export class ScheduleManager {
  schedule: any;
  setSchedule(schedule: any): void;
  getCurrentLayouts(): string[];
  getLayoutsAtTime?(date: Date): any[];
  setLocation(lat: number, lng: number): void;
  setDisplayProperties(settings: any): void;
  recordPlay(layoutId: string | number): void;
  isSyncEvent(layoutFile: string): boolean;
  getCommands?(): any[];
}

export const scheduleManager: ScheduleManager;

export function calculateTimeline(layouts: any[], durations: Map<string, number>, options?: any): any[];
export function parseLayoutDuration(xlf: string, videoDurations?: Map<string, number> | null): { duration: number; isDynamic: boolean };
export function buildScheduleQueue(schedule: any, durations: Map<string, number>): any[];
