// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Tests for criteria evaluation and geo-fencing
 */
import { describe, it, expect } from 'vitest';
import { evaluateCriteria } from './criteria.js';
import { ScheduleManager } from './schedule.js';

describe('Criteria Evaluator', () => {
  describe('evaluateCriteria()', () => {
    it('should return true for empty criteria', () => {
      expect(evaluateCriteria([])).toBe(true);
      expect(evaluateCriteria(null)).toBe(true);
      expect(evaluateCriteria(undefined)).toBe(true);
    });

    it('should evaluate dayOfWeek equals', () => {
      const monday = new Date('2026-02-16T10:00:00'); // Monday
      const tuesday = new Date('2026-02-17T10:00:00'); // Tuesday

      const criteria = [{ metric: 'dayOfWeek', condition: 'equals', type: 'string', value: 'Monday' }];

      expect(evaluateCriteria(criteria, { now: monday })).toBe(true);
      expect(evaluateCriteria(criteria, { now: tuesday })).toBe(false);
    });

    it('should evaluate dayOfWeek case-insensitively', () => {
      const monday = new Date('2026-02-16T10:00:00'); // Monday
      const criteria = [{ metric: 'dayOfWeek', condition: 'equals', type: 'string', value: 'monday' }];

      expect(evaluateCriteria(criteria, { now: monday })).toBe(true);
    });

    it('should evaluate hour as number', () => {
      const morning = new Date('2026-02-16T09:30:00');
      const evening = new Date('2026-02-16T18:30:00');

      const criteria = [{ metric: 'hour', condition: 'lessThan', type: 'number', value: '12' }];

      expect(evaluateCriteria(criteria, { now: morning })).toBe(true);
      expect(evaluateCriteria(criteria, { now: evening })).toBe(false);
    });

    it('should evaluate month', () => {
      const feb = new Date('2026-02-16T10:00:00');
      const criteria = [{ metric: 'month', condition: 'equals', type: 'number', value: '2' }];

      expect(evaluateCriteria(criteria, { now: feb })).toBe(true);
    });

    it('should evaluate dayOfMonth', () => {
      const day16 = new Date('2026-02-16T10:00:00');
      const criteria = [{ metric: 'dayOfMonth', condition: 'greaterThan', type: 'number', value: '15' }];

      expect(evaluateCriteria(criteria, { now: day16 })).toBe(true);
    });

    it('should evaluate isoDay (1=Monday, 7=Sunday)', () => {
      const monday = new Date('2026-02-16T10:00:00'); // Monday
      const sunday = new Date('2026-02-15T10:00:00'); // Sunday

      expect(evaluateCriteria(
        [{ metric: 'isoDay', condition: 'equals', type: 'number', value: '1' }],
        { now: monday }
      )).toBe(true);

      expect(evaluateCriteria(
        [{ metric: 'isoDay', condition: 'equals', type: 'number', value: '7' }],
        { now: sunday }
      )).toBe(true);
    });

    it('should require ALL criteria to match (AND logic)', () => {
      const mondayMorning = new Date('2026-02-16T09:00:00'); // Monday 9am
      const mondayEvening = new Date('2026-02-16T18:00:00'); // Monday 6pm

      const criteria = [
        { metric: 'dayOfWeek', condition: 'equals', type: 'string', value: 'Monday' },
        { metric: 'hour', condition: 'lessThan', type: 'number', value: '12' }
      ];

      expect(evaluateCriteria(criteria, { now: mondayMorning })).toBe(true);
      expect(evaluateCriteria(criteria, { now: mondayEvening })).toBe(false);
    });

    it('should evaluate display properties', () => {
      const criteria = [{ metric: 'building', condition: 'equals', type: 'string', value: 'A' }];

      expect(evaluateCriteria(criteria, {
        displayProperties: { building: 'A' }
      })).toBe(true);

      expect(evaluateCriteria(criteria, {
        displayProperties: { building: 'B' }
      })).toBe(false);
    });

    it('should evaluate "in" condition with comma-separated list', () => {
      const criteria = [{ metric: 'dayOfWeek', condition: 'in', type: 'string', value: 'Monday,Tuesday,Wednesday' }];
      const monday = new Date('2026-02-16T10:00:00'); // Monday
      const saturday = new Date('2026-02-21T10:00:00'); // Saturday

      expect(evaluateCriteria(criteria, { now: monday })).toBe(true);
      expect(evaluateCriteria(criteria, { now: saturday })).toBe(false);
    });

    it('should evaluate contains condition', () => {
      const criteria = [{ metric: 'location', condition: 'contains', type: 'string', value: 'floor' }];

      expect(evaluateCriteria(criteria, {
        displayProperties: { location: '3rd floor lobby' }
      })).toBe(true);

      expect(evaluateCriteria(criteria, {
        displayProperties: { location: 'rooftop' }
      })).toBe(false);
    });

    it('should evaluate notEquals condition', () => {
      const criteria = [{ metric: 'dayOfWeek', condition: 'notEquals', type: 'string', value: 'Sunday' }];
      const monday = new Date('2026-02-16T10:00:00'); // Monday
      const sunday = new Date('2026-02-15T10:00:00'); // Sunday

      expect(evaluateCriteria(criteria, { now: monday })).toBe(true);
      expect(evaluateCriteria(criteria, { now: sunday })).toBe(false);
    });

    it('should return false for unknown metric without display property', () => {
      const criteria = [{ metric: 'unknownMetric', condition: 'equals', type: 'string', value: 'test' }];
      expect(evaluateCriteria(criteria)).toBe(false);
    });
  });
});

describe('Geo-fencing', () => {
  describe('haversineDistance()', () => {
    it('should calculate distance between two points', () => {
      const sm = new ScheduleManager();
      // Barcelona to Tarragona: ~83km
      const distance = sm.haversineDistance(41.3851, 2.1734, 41.1189, 1.2445);
      expect(distance).toBeGreaterThan(80000);
      expect(distance).toBeLessThan(90000);
    });

    it('should return 0 for same point', () => {
      const sm = new ScheduleManager();
      expect(sm.haversineDistance(41.3851, 2.1734, 41.3851, 2.1734)).toBe(0);
    });
  });

  describe('isWithinGeoFence()', () => {
    it('should return true when no location set (permissive)', () => {
      const sm = new ScheduleManager();
      expect(sm.isWithinGeoFence('41.3851,2.1734')).toBe(true);
    });

    it('should return true when within radius', () => {
      const sm = new ScheduleManager();
      // Set location to Barcelona center
      sm.setLocation(41.3851, 2.1734);
      // Check geofence at Barcelona center (0 meters away)
      expect(sm.isWithinGeoFence('41.3851,2.1734')).toBe(true);
    });

    it('should return false when outside radius', () => {
      const sm = new ScheduleManager();
      // Set location to Barcelona
      sm.setLocation(41.3851, 2.1734);
      // Check geofence at Tarragona (~98km away, default radius 500m)
      expect(sm.isWithinGeoFence('41.1189,1.2445')).toBe(false);
    });

    it('should respect custom radius in geoLocation string', () => {
      const sm = new ScheduleManager();
      sm.setLocation(41.3851, 2.1734);
      // 200km radius should include Tarragona
      expect(sm.isWithinGeoFence('41.1189,1.2445,200000')).toBe(true);
    });

    it('should handle invalid geoLocation format gracefully', () => {
      const sm = new ScheduleManager();
      sm.setLocation(41.3851, 2.1734);
      expect(sm.isWithinGeoFence('')).toBe(true);
      expect(sm.isWithinGeoFence('invalid')).toBe(true);
    });
  });

  describe('getCurrentLayouts() with geo-fencing', () => {
    it('should filter layouts by geofence', () => {
      const sm = new ScheduleManager();
      sm.setLocation(41.3851, 2.1734); // Barcelona

      const now = new Date('2026-02-16T10:00:00');
      sm.setSchedule({
        default: '0',
        layouts: [
          {
            id: '100', file: '100', fromdt: '2026-01-01 00:00:00', todt: '2027-01-01 00:00:00',
            priority: 5, scheduleid: '1', maxPlaysPerHour: 0,
            isGeoAware: true, geoLocation: '41.3851,2.1734,1000', criteria: []
          },
          {
            id: '200', file: '200', fromdt: '2026-01-01 00:00:00', todt: '2027-01-01 00:00:00',
            priority: 5, scheduleid: '2', maxPlaysPerHour: 0,
            isGeoAware: true, geoLocation: '40.4168,-3.7038,500', criteria: [] // Madrid
          }
        ],
        campaigns: []
      });

      // Mock Date
      const origDate = global.Date;
      global.Date = class extends origDate {
        constructor(...args) {
          if (args.length === 0) return now;
          return new origDate(...args);
        }
      };

      const layouts = sm.getCurrentLayouts();
      global.Date = origDate;

      // Only Barcelona layout should be included
      expect(layouts).toContain('100');
      expect(layouts).not.toContain('200');
    });

    it('should filter layouts by criteria', () => {
      const sm = new ScheduleManager();
      const monday = new Date('2026-02-16T10:00:00'); // Monday

      sm.setSchedule({
        default: '0',
        layouts: [
          {
            id: '100', file: '100', fromdt: '2026-01-01 00:00:00', todt: '2027-01-01 00:00:00',
            priority: 5, scheduleid: '1', maxPlaysPerHour: 0,
            isGeoAware: false, geoLocation: '',
            criteria: [{ metric: 'dayOfWeek', condition: 'equals', type: 'string', value: 'Monday' }]
          },
          {
            id: '200', file: '200', fromdt: '2026-01-01 00:00:00', todt: '2027-01-01 00:00:00',
            priority: 5, scheduleid: '2', maxPlaysPerHour: 0,
            isGeoAware: false, geoLocation: '',
            criteria: [{ metric: 'dayOfWeek', condition: 'equals', type: 'string', value: 'Tuesday' }]
          }
        ],
        campaigns: []
      });

      // Mock Date
      const origDate = global.Date;
      global.Date = class extends origDate {
        constructor(...args) {
          if (args.length === 0) return monday;
          return new origDate(...args);
        }
      };

      const layouts = sm.getCurrentLayouts();
      global.Date = origDate;

      expect(layouts).toContain('100');
      expect(layouts).not.toContain('200');
    });
  });
});

describe('Sync Event Metadata', () => {
  it('should track syncEvent in layout metadata', () => {
    const sm = new ScheduleManager();
    const now = new Date('2026-02-16T10:00:00');

    sm.setSchedule({
      default: '0',
      layouts: [
        {
          id: '100', file: '100', fromdt: '2026-01-01 00:00:00', todt: '2027-01-01 00:00:00',
          priority: 5, scheduleid: '1', maxPlaysPerHour: 0,
          isGeoAware: false, geoLocation: '', syncEvent: true, shareOfVoice: 0, criteria: []
        },
        {
          id: '200', file: '200', fromdt: '2026-01-01 00:00:00', todt: '2027-01-01 00:00:00',
          priority: 5, scheduleid: '2', maxPlaysPerHour: 0,
          isGeoAware: false, geoLocation: '', syncEvent: false, shareOfVoice: 0, criteria: []
        }
      ],
      campaigns: []
    });

    const origDate = global.Date;
    global.Date = class extends origDate {
      constructor(...args) {
        if (args.length === 0) return now;
        return new origDate(...args);
      }
    };

    const layouts = sm.getCurrentLayouts();
    global.Date = origDate;

    expect(layouts).toContain('100');
    expect(layouts).toContain('200');

    // Check sync metadata
    expect(sm.isSyncEvent('100')).toBe(true);
    expect(sm.isSyncEvent('200')).toBe(false);
    expect(sm.hasSyncEvents()).toBe(true);
  });

  it('should return false for hasSyncEvents when no sync events', () => {
    const sm = new ScheduleManager();
    const now = new Date('2026-02-16T10:00:00');

    sm.setSchedule({
      default: '0',
      layouts: [
        {
          id: '100', file: '100', fromdt: '2026-01-01 00:00:00', todt: '2027-01-01 00:00:00',
          priority: 5, scheduleid: '1', maxPlaysPerHour: 0,
          isGeoAware: false, geoLocation: '', syncEvent: false, shareOfVoice: 0, criteria: []
        }
      ],
      campaigns: []
    });

    const origDate = global.Date;
    global.Date = class extends origDate {
      constructor(...args) {
        if (args.length === 0) return now;
        return new origDate(...args);
      }
    };

    sm.getCurrentLayouts();
    global.Date = origDate;

    expect(sm.hasSyncEvents()).toBe(false);
  });

  it('should expose layout metadata with getLayoutMetadata', () => {
    const sm = new ScheduleManager();
    const now = new Date('2026-02-16T10:00:00');

    sm.setSchedule({
      default: '0',
      layouts: [
        {
          id: '100', file: '100', fromdt: '2026-01-01 00:00:00', todt: '2027-01-01 00:00:00',
          priority: 5, scheduleid: '1', maxPlaysPerHour: 0,
          isGeoAware: false, geoLocation: '', syncEvent: true, shareOfVoice: 30, criteria: []
        }
      ],
      campaigns: []
    });

    const origDate = global.Date;
    global.Date = class extends origDate {
      constructor(...args) {
        if (args.length === 0) return now;
        return new origDate(...args);
      }
    };

    sm.getCurrentLayouts();
    global.Date = origDate;

    const meta = sm.getLayoutMetadata('100');
    expect(meta).not.toBeNull();
    expect(meta.syncEvent).toBe(true);
    expect(meta.shareOfVoice).toBe(30);
    expect(meta.priority).toBe(5);

    // Unknown layout returns null
    expect(sm.getLayoutMetadata('999')).toBeNull();
  });
});
