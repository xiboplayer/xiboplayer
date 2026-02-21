/**
 * Schedule Manager Tests
 *
 * Tests for campaign support in schedule manager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ScheduleManager } from './schedule.js';

// Helper to create date strings
function dateStr(hoursOffset = 0) {
  const d = new Date();
  d.setHours(d.getHours() + hoursOffset);
  return d.toISOString();
}

describe('ScheduleManager - Campaigns', () => {
  let manager;

  beforeEach(() => {
    manager = new ScheduleManager();
  });

  describe('Campaign Priority', () => {
    it('should prioritize campaign over standalone layout when priority is higher', () => {
      manager.setSchedule({
        default: '0',
        layouts: [
          { file: '100', priority: 5, fromdt: dateStr(-1), todt: dateStr(1) }
        ],
        campaigns: [
          {
            id: '1',
            priority: 10,
            fromdt: dateStr(-1),
            todt: dateStr(1),
            layouts: [
              { file: '200' },
              { file: '201' },
              { file: '202' }
            ]
          }
        ]
      });

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(3);
      expect(layouts[0]).toBe('200');
      expect(layouts[1]).toBe('201');
      expect(layouts[2]).toBe('202');
    });

    it('should include all layouts from multiple campaigns at same priority', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: [
          {
            id: '1',
            priority: 10,
            fromdt: dateStr(-1),
            todt: dateStr(1),
            layouts: [
              { file: '100' },
              { file: '101' }
            ]
          },
          {
            id: '2',
            priority: 10,
            fromdt: dateStr(-1),
            todt: dateStr(1),
            layouts: [
              { file: '200' },
              { file: '201' }
            ]
          }
        ]
      });

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(4);
      expect(layouts).toContain('100');
      expect(layouts).toContain('101');
      expect(layouts).toContain('200');
      expect(layouts).toContain('201');
    });

    it('should include both campaign and standalone layouts at same priority', () => {
      manager.setSchedule({
        default: '0',
        layouts: [
          { file: '100', priority: 10, fromdt: dateStr(-1), todt: dateStr(1) },
          { file: '101', priority: 10, fromdt: dateStr(-1), todt: dateStr(1) }
        ],
        campaigns: [
          {
            id: '1',
            priority: 10,
            fromdt: dateStr(-1),
            todt: dateStr(1),
            layouts: [
              { file: '200' },
              { file: '201' }
            ]
          }
        ]
      });

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(4);
      expect(layouts).toContain('100');
      expect(layouts).toContain('101');
      expect(layouts).toContain('200');
      expect(layouts).toContain('201');
    });
  });

  describe('Campaign Time Windows', () => {
    it('should ignore campaign outside time window', () => {
      manager.setSchedule({
        default: '0',
        layouts: [
          { file: '100', priority: 5, fromdt: dateStr(-1), todt: dateStr(1) }
        ],
        campaigns: [
          {
            id: '1',
            priority: 10,
            fromdt: dateStr(-10), // Started 10 hours ago
            todt: dateStr(-5),    // Ended 5 hours ago
            layouts: [
              { file: '200' },
              { file: '201' }
            ]
          }
        ]
      });

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('100');
    });
  });

  describe('Default Layout', () => {
    it('should return default layout when no schedules active', () => {
      manager.setSchedule({
        default: '999',
        layouts: [],
        campaigns: []
      });

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(1);
      expect(layouts[0]).toBe('999');
    });
  });

  describe('Campaign Layout Order', () => {
    it('should preserve layout order within campaign', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: [
          {
            id: '1',
            priority: 10,
            fromdt: dateStr(-1),
            todt: dateStr(1),
            layouts: [
              { file: '205' },
              { file: '203' },
              { file: '204' },
              { file: '201' },
              { file: '202' }
            ]
          }
        ]
      });

      const layouts = manager.getCurrentLayouts();

      expect(layouts).toHaveLength(5);
      expect(layouts[0]).toBe('205');
      expect(layouts[1]).toBe('203');
      expect(layouts[2]).toBe('204');
      expect(layouts[3]).toBe('201');
      expect(layouts[4]).toBe('202');
    });
  });
});

describe('ScheduleManager - Default Layout Interleaving', () => {
  let manager;

  beforeEach(() => {
    manager = new ScheduleManager();
  });

  it('should interleave default layout between multiple scheduled layouts', () => {
    manager.setSchedule({
      default: '999',
      layouts: [
        { file: '100', priority: 10, fromdt: dateStr(-1), todt: dateStr(1) },
        { file: '200', priority: 10, fromdt: dateStr(-1), todt: dateStr(1) },
        { file: '300', priority: 10, fromdt: dateStr(-1), todt: dateStr(1) }
      ],
      campaigns: []
    });

    const layouts = manager.getInterleavedLayouts();

    expect(layouts).toEqual(['100', '999', '200', '999', '300', '999']);
  });

  it('should not interleave when only default layout is active', () => {
    manager.setSchedule({
      default: '999',
      layouts: [],
      campaigns: []
    });

    const layouts = manager.getInterleavedLayouts();

    expect(layouts).toEqual(['999']);
  });

  it('should not interleave when only one scheduled layout', () => {
    manager.setSchedule({
      default: '999',
      layouts: [
        { file: '100', priority: 10, fromdt: dateStr(-1), todt: dateStr(1) }
      ],
      campaigns: []
    });

    const layouts = manager.getInterleavedLayouts();

    expect(layouts).toEqual(['100']);
  });

  it('should preserve layout order when interleaving', () => {
    manager.setSchedule({
      default: '999',
      layouts: [],
      campaigns: [
        {
          id: '1',
          priority: 10,
          fromdt: dateStr(-1),
          todt: dateStr(1),
          layouts: [
            { file: '205' },
            { file: '203' },
            { file: '204' }
          ]
        }
      ]
    });

    const layouts = manager.getInterleavedLayouts();

    // Order must be preserved: 205, default, 203, default, 204, default
    expect(layouts).toEqual(['205', '999', '203', '999', '204', '999']);
  });

  it('should return empty array when no schedule is set', () => {
    const layouts = manager.getInterleavedLayouts();

    expect(layouts).toEqual([]);
  });

  it('should not interleave when no default layout is configured', () => {
    manager.setSchedule({
      layouts: [
        { file: '100', priority: 10, fromdt: dateStr(-1), todt: dateStr(1) },
        { file: '200', priority: 10, fromdt: dateStr(-1), todt: dateStr(1) }
      ],
      campaigns: []
    });

    const layouts = manager.getInterleavedLayouts();

    // No default, so no interleaving — just the scheduled layouts
    expect(layouts).toEqual(['100', '200']);
  });

  it('should interleave with campaign and standalone layouts at same priority', () => {
    manager.setSchedule({
      default: '999',
      layouts: [
        { file: '100', priority: 10, fromdt: dateStr(-1), todt: dateStr(1) }
      ],
      campaigns: [
        {
          id: '1',
          priority: 10,
          fromdt: dateStr(-1),
          todt: dateStr(1),
          layouts: [
            { file: '200' },
            { file: '201' }
          ]
        }
      ]
    });

    const layouts = manager.getInterleavedLayouts();

    // 3 scheduled layouts + 3 default insertions = 6
    expect(layouts).toHaveLength(6);
    // Every odd-indexed element should be the default
    expect(layouts[1]).toBe('999');
    expect(layouts[3]).toBe('999');
    expect(layouts[5]).toBe('999');
  });
});

describe('ScheduleManager - Actions and Commands', () => {
  let manager;

  beforeEach(() => {
    manager = new ScheduleManager();
  });

  describe('getActiveActions()', () => {
    it('should return actions within time window', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: [],
        actions: [
          {
            actionType: 'navLayout',
            triggerCode: 'trigger1',
            layoutCode: '123',
            fromdt: dateStr(-1),
            todt: dateStr(1),
            priority: 1,
            scheduleId: '1'
          }
        ],
        commands: []
      });

      const actions = manager.getActiveActions();

      expect(actions).toHaveLength(1);
      expect(actions[0].triggerCode).toBe('trigger1');
      expect(actions[0].actionType).toBe('navLayout');
    });

    it('should exclude actions outside time window', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: [],
        actions: [
          {
            actionType: 'navLayout',
            triggerCode: 'expired',
            layoutCode: '123',
            fromdt: dateStr(-10),
            todt: dateStr(-5),
            priority: 1,
            scheduleId: '2'
          }
        ],
        commands: []
      });

      const actions = manager.getActiveActions();

      expect(actions).toHaveLength(0);
    });

    it('should return multiple active actions', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: [],
        actions: [
          {
            actionType: 'navLayout',
            triggerCode: 'trigger1',
            layoutCode: '100',
            fromdt: dateStr(-1),
            todt: dateStr(1),
            priority: 1,
            scheduleId: '1'
          },
          {
            actionType: 'command',
            triggerCode: 'trigger2',
            commandCode: 'restart',
            fromdt: dateStr(-2),
            todt: dateStr(2),
            priority: 5,
            scheduleId: '2'
          }
        ],
        commands: []
      });

      const actions = manager.getActiveActions();

      expect(actions).toHaveLength(2);
    });

    it('should return empty array when no actions exist', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: []
      });

      const actions = manager.getActiveActions();

      expect(actions).toEqual([]);
    });

    it('should return empty array when schedule is null', () => {
      const actions = manager.getActiveActions();

      expect(actions).toEqual([]);
    });

    it('should filter mixed active and expired actions', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: [],
        actions: [
          {
            actionType: 'navLayout',
            triggerCode: 'active1',
            layoutCode: '100',
            fromdt: dateStr(-1),
            todt: dateStr(1),
            priority: 1,
            scheduleId: '1'
          },
          {
            actionType: 'navLayout',
            triggerCode: 'expired1',
            layoutCode: '200',
            fromdt: dateStr(-10),
            todt: dateStr(-5),
            priority: 1,
            scheduleId: '2'
          },
          {
            actionType: 'command',
            triggerCode: 'active2',
            commandCode: 'collectNow',
            fromdt: dateStr(-2),
            todt: dateStr(2),
            priority: 1,
            scheduleId: '3'
          }
        ],
        commands: []
      });

      const actions = manager.getActiveActions();

      expect(actions).toHaveLength(2);
      expect(actions.map(a => a.triggerCode)).toContain('active1');
      expect(actions.map(a => a.triggerCode)).toContain('active2');
      expect(actions.map(a => a.triggerCode)).not.toContain('expired1');
    });
  });

  describe('findActionByTrigger()', () => {
    it('should find matching action by trigger code', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: [],
        actions: [
          {
            actionType: 'navLayout',
            triggerCode: 'trigger1',
            layoutCode: '123',
            fromdt: dateStr(-1),
            todt: dateStr(1),
            priority: 1,
            scheduleId: '1'
          },
          {
            actionType: 'command',
            triggerCode: 'trigger2',
            commandCode: 'restart',
            fromdt: dateStr(-1),
            todt: dateStr(1),
            priority: 2,
            scheduleId: '2'
          }
        ],
        commands: []
      });

      const action = manager.findActionByTrigger('trigger2');

      expect(action).not.toBeNull();
      expect(action.triggerCode).toBe('trigger2');
      expect(action.actionType).toBe('command');
    });

    it('should return null when no matching action found', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: [],
        actions: [
          {
            actionType: 'navLayout',
            triggerCode: 'trigger1',
            layoutCode: '123',
            fromdt: dateStr(-1),
            todt: dateStr(1),
            priority: 1,
            scheduleId: '1'
          }
        ],
        commands: []
      });

      const action = manager.findActionByTrigger('nonexistent');

      expect(action).toBeNull();
    });

    it('should not find expired action even if trigger matches', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: [],
        actions: [
          {
            actionType: 'navLayout',
            triggerCode: 'trigger1',
            layoutCode: '123',
            fromdt: dateStr(-10),
            todt: dateStr(-5),
            priority: 1,
            scheduleId: '1'
          }
        ],
        commands: []
      });

      const action = manager.findActionByTrigger('trigger1');

      expect(action).toBeNull();
    });

    it('should return null when schedule has no actions', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: []
      });

      const action = manager.findActionByTrigger('trigger1');

      expect(action).toBeNull();
    });
  });

  describe('getCommands()', () => {
    it('should return command list', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: [],
        actions: [],
        commands: [
          { code: 'collectNow', date: '2026-02-11' },
          { code: 'reboot', date: '2026-02-12' }
        ]
      });

      const commands = manager.getCommands();

      expect(commands).toHaveLength(2);
      expect(commands[0].code).toBe('collectNow');
      expect(commands[0].date).toBe('2026-02-11');
      expect(commands[1].code).toBe('reboot');
      expect(commands[1].date).toBe('2026-02-12');
    });

    it('should return empty array when no commands', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: [],
        actions: [],
        commands: []
      });

      const commands = manager.getCommands();

      expect(commands).toEqual([]);
    });

    it('should return empty array when commands property is missing', () => {
      manager.setSchedule({
        default: '0',
        layouts: [],
        campaigns: []
      });

      const commands = manager.getCommands();

      expect(commands).toEqual([]);
    });

    it('should return empty array when schedule is null', () => {
      const commands = manager.getCommands();

      expect(commands).toEqual([]);
    });
  });

  describe('Conflict Detection', () => {
    it('should detect no conflicts when all layouts share the same priority', () => {
      manager.setSchedule({
        default: '0',
        layouts: [
          { file: '100', priority: 5, fromdt: dateStr(-1), todt: dateStr(1) },
          { file: '101', priority: 5, fromdt: dateStr(-1), todt: dateStr(1) },
        ],
        campaigns: [],
      });

      const conflicts = manager.detectConflicts({ hours: 2 });
      expect(conflicts).toEqual([]);
    });

    it('should detect conflict when higher-priority layout hides lower-priority', () => {
      manager.setSchedule({
        default: '0',
        layouts: [
          { file: '100', priority: 5, fromdt: dateStr(-1), todt: dateStr(1) },
          { file: '101', priority: 10, fromdt: dateStr(-1), todt: dateStr(1) },
        ],
        campaigns: [],
      });

      const conflicts = manager.detectConflicts({ hours: 2 });
      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts[0].winner.file).toBe('101');
      expect(conflicts[0].winner.priority).toBe(10);
      expect(conflicts[0].hidden).toEqual([{ file: '100', priority: 5 }]);
    });

    it('should detect conflict between campaign and standalone layout', () => {
      manager.setSchedule({
        default: '0',
        layouts: [
          { file: '100', priority: 3, fromdt: dateStr(-1), todt: dateStr(1) },
        ],
        campaigns: [
          {
            id: '1',
            priority: 8,
            fromdt: dateStr(-1),
            todt: dateStr(1),
            layouts: [{ file: '200' }],
          },
        ],
      });

      const conflicts = manager.detectConflicts({ hours: 2 });
      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts[0].winner.priority).toBe(8);
      expect(conflicts[0].hidden[0].file).toBe('100');
    });

    it('should return empty array when no schedule is set', () => {
      const conflicts = manager.detectConflicts();
      expect(conflicts).toEqual([]);
    });

    it('should merge consecutive minutes into a single conflict window', () => {
      manager.setSchedule({
        default: '0',
        layouts: [
          { file: '100', priority: 5, fromdt: dateStr(-1), todt: dateStr(1) },
          { file: '101', priority: 10, fromdt: dateStr(-1), todt: dateStr(1) },
        ],
        campaigns: [],
      });

      const conflicts = manager.detectConflicts({ hours: 2 });
      // Should be 1 merged window, not 120 individual minutes
      expect(conflicts.length).toBe(1);
      const windowMs = conflicts[0].endTime.getTime() - conflicts[0].startTime.getTime();
      // Window should span most of the 2-hour scan (overlap runs for ~2h)
      expect(windowMs).toBeGreaterThan(60 * 60 * 1000); // at least 1 hour
    });
  });
});
