/**
 * Schedule Manager Dayparting Tests
 *
 * Tests for dayparting (recurring schedule) support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ScheduleManager } from './schedule.js';

// Helper to create date strings
function dateStr(hoursOffset = 0) {
  const d = new Date();
  d.setHours(d.getHours() + hoursOffset);
  return d.toISOString();
}

// Helper to create time string for today at specific hour
function timeStr(hour, minute = 0) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// Helper to get current ISO day of week (1=Monday, 7=Sunday)
function getCurrentIsoDayOfWeek() {
  const day = new Date().getDay();
  return day === 0 ? 7 : day;
}

// Helper to get a different day than today
function getDifferentDay() {
  const today = getCurrentIsoDayOfWeek();
  return today === 1 ? 2 : 1;
}

// Helper to mock Date at specific time
function mockTimeAt(targetDate) {
  const RealDate = Date;
  vi.spyOn(global, 'Date').mockImplementation((...args) => {
    if (args.length === 0) {
      return new RealDate(targetDate);
    }
    return new RealDate(...args);
  });
}

describe('ScheduleManager - Dayparting', () => {
  let manager;
  let originalDate;

  beforeEach(() => {
    manager = new ScheduleManager();
    originalDate = global.Date;
  });

  afterEach(() => {
    // Restore Date
    if (vi.isMockFunction(global.Date)) {
      global.Date = originalDate;
    }
  });

  describe('Weekday Schedules', () => {
    it('should activate weekday schedule during business hours on weekday', () => {
      const currentDay = getCurrentIsoDayOfWeek();

      if (currentDay > 5) {
        // Skip on weekends
        return;
      }

      manager.setSchedule({
        default: '0',
        layouts: [
          {
            file: '100',
            priority: 10,
            fromdt: timeStr(9, 0),
            todt: timeStr(17, 0),
            recurrenceType: 'Week',
            recurrenceRepeatsOn: '1,2,3,4,5'
          }
        ],
        campaigns: []
      });

      // Mock noon on weekday
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      mockTimeAt(noon);

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('100');
    });

    it('should not activate weekday schedule outside time window', () => {
      const currentDay = getCurrentIsoDayOfWeek();

      if (currentDay > 5) {
        return; // Skip on weekends
      }

      manager.setSchedule({
        default: '999',
        layouts: [
          {
            file: '100',
            priority: 10,
            fromdt: timeStr(9, 0),
            todt: timeStr(17, 0),
            recurrenceType: 'Week',
            recurrenceRepeatsOn: '1,2,3,4,5'
          }
        ],
        campaigns: []
      });

      // Mock 8:00 AM (before schedule)
      const earlyMorning = new Date();
      earlyMorning.setHours(8, 0, 0, 0);
      mockTimeAt(earlyMorning);

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('999');
    });
  });

  describe('Weekend Schedules', () => {
    it('should activate weekend schedule on weekend', () => {
      const currentDay = getCurrentIsoDayOfWeek();

      if (currentDay < 6) {
        return; // Skip on weekdays
      }

      manager.setSchedule({
        default: '0',
        layouts: [
          {
            file: '200',
            priority: 10,
            fromdt: timeStr(10, 0),
            todt: timeStr(18, 0),
            recurrenceType: 'Week',
            recurrenceRepeatsOn: '6,7'
          }
        ],
        campaigns: []
      });

      // Mock 2:00 PM on weekend
      const afternoon = new Date();
      afternoon.setHours(14, 0, 0, 0);
      mockTimeAt(afternoon);

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('200');
    });
  });

  describe('Day of Week Filtering', () => {
    it('should not activate schedule on wrong day of week', () => {
      const differentDay = getDifferentDay();

      manager.setSchedule({
        default: '999',
        layouts: [
          {
            file: '300',
            priority: 10,
            fromdt: timeStr(9, 0),
            todt: timeStr(17, 0),
            recurrenceType: 'Week',
            recurrenceRepeatsOn: differentDay.toString()
          }
        ],
        campaigns: []
      });

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('999');
    });
  });

  describe('Priority with Dayparting', () => {
    it('should respect priority in overlapping daypart schedules', () => {
      const currentDay = getCurrentIsoDayOfWeek();

      manager.setSchedule({
        default: '0',
        layouts: [
          {
            file: '100',
            priority: 5,
            fromdt: timeStr(9, 0),
            todt: timeStr(17, 0),
            recurrenceType: 'Week',
            recurrenceRepeatsOn: '1,2,3,4,5,6,7'
          },
          {
            file: '200',
            priority: 10,
            fromdt: timeStr(12, 0),
            todt: timeStr(14, 0),
            recurrenceType: 'Week',
            recurrenceRepeatsOn: currentDay.toString()
          }
        ],
        campaigns: []
      });

      // Mock 1:00 PM (lunch time)
      const lunchTime = new Date();
      lunchTime.setHours(13, 0, 0, 0);
      mockTimeAt(lunchTime);

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('200');
    });
  });

  describe('Dayparting Campaigns', () => {
    it('should support campaigns with dayparting', () => {
      const currentDay = getCurrentIsoDayOfWeek();

      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: [
          {
            id: '1',
            priority: 10,
            fromdt: timeStr(9, 0),
            todt: timeStr(17, 0),
            recurrenceType: 'Week',
            recurrenceRepeatsOn: currentDay.toString(),
            layouts: [
              { file: '100' },
              { file: '101' },
              { file: '102' }
            ]
          }
        ]
      });

      // Mock noon
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      mockTimeAt(noon);

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(3);
      expect(layouts[0]).toBe('100');
      expect(layouts[1]).toBe('101');
      expect(layouts[2]).toBe('102');
    });
  });

  describe('Midnight Crossing', () => {
    it('should handle schedules that cross midnight', () => {
      const currentDay = getCurrentIsoDayOfWeek();

      manager.setSchedule({
        default: '999',
        layouts: [
          {
            file: '400',
            priority: 10,
            fromdt: timeStr(22, 0),
            todt: timeStr(2, 0),
            recurrenceType: 'Week',
            recurrenceRepeatsOn: currentDay.toString()
          }
        ],
        campaigns: []
      });

      // Mock 11:00 PM
      const lateNight = new Date();
      lateNight.setHours(23, 0, 0, 0);
      mockTimeAt(lateNight);

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('400');
    });
  });

  describe('Backward Compatibility', () => {
    it('should still support non-recurring schedules', () => {
      manager.setSchedule({
        default: '0',
        layouts: [
          {
            file: '500',
            priority: 10,
            fromdt: dateStr(-1),
            todt: dateStr(1)
          }
        ],
        campaigns: []
      });

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('500');
    });
  });

  describe('Specific Days Schedule', () => {
    it('should handle specific days (Mon, Wed, Fri)', () => {
      const currentDay = getCurrentIsoDayOfWeek();
      const scheduledDays = [1, 3, 5];
      const isScheduledDay = scheduledDays.includes(currentDay);

      manager.setSchedule({
        default: '999',
        layouts: [
          {
            file: '600',
            priority: 10,
            fromdt: timeStr(9, 0),
            todt: timeStr(17, 0),
            recurrenceType: 'Week',
            recurrenceRepeatsOn: '1,3,5'
          }
        ],
        campaigns: []
      });

      // Mock noon
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      mockTimeAt(noon);

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(1);
      if (isScheduledDay) {
        expect(layouts[0]).toBe('600');
      } else {
        expect(layouts[0]).toBe('999');
      }
    });
  });

  describe('Recurrence Range', () => {
    it('should respect recurrenceRange end date', () => {
      const currentDay = getCurrentIsoDayOfWeek();

      // Create recurrence that ended yesterday
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      manager.setSchedule({
        default: '999',
        layouts: [
          {
            file: '700',
            priority: 10,
            fromdt: timeStr(9, 0),
            todt: timeStr(17, 0),
            recurrenceType: 'Week',
            recurrenceRepeatsOn: currentDay.toString(),
            recurrenceRange: yesterday.toISOString()
          }
        ],
        campaigns: []
      });

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('999');
    });
  });

  describe('Daily Recurrence', () => {
    it('should activate daily schedule during time window', () => {
      manager.setSchedule({
        default: '0',
        layouts: [
          {
            file: '800',
            priority: 10,
            fromdt: timeStr(9, 0),
            todt: timeStr(17, 0),
            recurrenceType: 'Day',
          }
        ],
        campaigns: []
      });

      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      mockTimeAt(noon);

      const layouts = manager.getCurrentLayouts();
      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('800');
    });

    it('should not activate daily schedule outside time window', () => {
      manager.setSchedule({
        default: '999',
        layouts: [
          {
            file: '800',
            priority: 10,
            fromdt: timeStr(9, 0),
            todt: timeStr(17, 0),
            recurrenceType: 'Day',
          }
        ],
        campaigns: []
      });

      const earlyMorning = new Date();
      earlyMorning.setHours(7, 0, 0, 0);
      mockTimeAt(earlyMorning);

      const layouts = manager.getCurrentLayouts();
      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('999');
    });

    it('should respect recurrenceDetail interval (every N days)', () => {
      // Create a schedule that started 2 days ago with interval=2
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 2);
      startDate.setHours(9, 0, 0, 0);

      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 30);
      endDate.setHours(17, 0, 0, 0);

      manager.setSchedule({
        default: '999',
        layouts: [
          {
            file: '801',
            priority: 10,
            fromdt: startDate.toISOString(),
            todt: endDate.toISOString(),
            recurrenceType: 'Day',
            recurrenceDetail: 2,
          }
        ],
        campaigns: []
      });

      // 2 days later = day 2, 2 % 2 = 0, should be active
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      mockTimeAt(noon);

      const layouts = manager.getCurrentLayouts();
      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('801');
    });

    it('should skip days not matching interval', () => {
      // Create a schedule that started 3 days ago with interval=2
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 3);
      startDate.setHours(9, 0, 0, 0);

      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 30);
      endDate.setHours(17, 0, 0, 0);

      manager.setSchedule({
        default: '999',
        layouts: [
          {
            file: '802',
            priority: 10,
            fromdt: startDate.toISOString(),
            todt: endDate.toISOString(),
            recurrenceType: 'Day',
            recurrenceDetail: 2,
          }
        ],
        campaigns: []
      });

      // 3 days later = day 3, 3 % 2 = 1, should NOT be active
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      mockTimeAt(noon);

      const layouts = manager.getCurrentLayouts();
      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('999');
    });
  });

  describe('Monthly Recurrence', () => {
    it('should activate on matching day of month', () => {
      const today = new Date();
      const dayOfMonth = today.getDate();

      manager.setSchedule({
        default: '0',
        layouts: [
          {
            file: '900',
            priority: 10,
            fromdt: timeStr(9, 0),
            todt: timeStr(17, 0),
            recurrenceType: 'Month',
            recurrenceRepeatsOn: dayOfMonth.toString(),
          }
        ],
        campaigns: []
      });

      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      mockTimeAt(noon);

      const layouts = manager.getCurrentLayouts();
      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('900');
    });

    it('should not activate on wrong day of month', () => {
      const today = new Date();
      // Pick a day that isn't today (and is valid 1-28)
      const otherDay = today.getDate() === 15 ? 16 : 15;

      manager.setSchedule({
        default: '999',
        layouts: [
          {
            file: '901',
            priority: 10,
            fromdt: timeStr(9, 0),
            todt: timeStr(17, 0),
            recurrenceType: 'Month',
            recurrenceRepeatsOn: otherDay.toString(),
          }
        ],
        campaigns: []
      });

      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      mockTimeAt(noon);

      const layouts = manager.getCurrentLayouts();
      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('999');
    });

    it('should support multiple days of month', () => {
      const today = new Date();
      const dayOfMonth = today.getDate();

      manager.setSchedule({
        default: '0',
        layouts: [
          {
            file: '902',
            priority: 10,
            fromdt: timeStr(9, 0),
            todt: timeStr(17, 0),
            recurrenceType: 'Month',
            recurrenceRepeatsOn: `1,${dayOfMonth},28`,
          }
        ],
        campaigns: []
      });

      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      mockTimeAt(noon);

      const layouts = manager.getCurrentLayouts();
      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('902');
    });

    it('should respect recurrenceDetail interval (every N months)', () => {
      // Start date 2 months ago, interval=2 → should be active
      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 2);
      startDate.setHours(9, 0, 0, 0);

      const endDate = new Date();
      endDate.setFullYear(endDate.getFullYear() + 1);
      endDate.setHours(17, 0, 0, 0);

      const dayOfMonth = new Date().getDate();

      manager.setSchedule({
        default: '999',
        layouts: [
          {
            file: '903',
            priority: 10,
            fromdt: startDate.toISOString(),
            todt: endDate.toISOString(),
            recurrenceType: 'Month',
            recurrenceDetail: 2,
            recurrenceRepeatsOn: dayOfMonth.toString(),
          }
        ],
        campaigns: []
      });

      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      mockTimeAt(noon);

      const layouts = manager.getCurrentLayouts();
      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('903');
    });
  });
});
