/**
 * Tests for LogReporter and formatLogs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LogReporter, formatLogs } from './log-reporter.js';

describe('LogReporter', () => {
  let reporter;

  beforeEach(async () => {
    reporter = new LogReporter();
    await reporter.init();
    await reporter.clearAllLogs();
  });

  afterEach(async () => {
    if (reporter && reporter.db) {
      await reporter.clearAllLogs();
      reporter.db.close();
    }
  });

  describe('constructor and initialization', () => {
    it('should create a new reporter', () => {
      const r = new LogReporter();
      expect(r).toBeDefined();
      expect(r.db).toBeNull();
    });

    it('should initialize IndexedDB', async () => {
      const r = new LogReporter();
      await r.init();
      expect(r.db).toBeDefined();
      expect(r.db.name).toBe('xibo-player-logs');
      r.db.close();
    });

    it('should be idempotent', async () => {
      await reporter.init();
      await reporter.init();
      expect(reporter.db).toBeDefined();
    });

    it('should handle missing IndexedDB gracefully', async () => {
      const originalIndexedDB = global.indexedDB;
      global.indexedDB = undefined;

      const r = new LogReporter();
      await expect(r.init()).rejects.toThrow('IndexedDB not available');

      global.indexedDB = originalIndexedDB;
    });
  });

  describe('log entry creation', () => {
    it('should log an error message', async () => {
      await reporter.log('error', 'Test error', 'PLAYER');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].level).toBe('error');
      expect(logs[0].message).toBe('Test error');
      expect(logs[0].category).toBe('PLAYER');
      expect(logs[0].timestamp).toBeInstanceOf(Date);
      expect(logs[0].submitted).toBe(0);
    });

    it('should log an audit message', async () => {
      await reporter.log('audit', 'User logged in', 'AUTH');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].level).toBe('audit');
      expect(logs[0].category).toBe('AUTH');
    });

    it('should log an info message', async () => {
      await reporter.log('info', 'Layout loaded', 'RENDERER');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].level).toBe('info');
    });

    it('should log a debug message', async () => {
      await reporter.log('debug', 'Debug info', 'CACHE');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].level).toBe('debug');
    });

    it('should use default category', async () => {
      await reporter.log('info', 'Test message');

      const logs = await reporter.getAllLogs();
      expect(logs[0].category).toBe('PLAYER');
    });

    it('should handle invalid log level', async () => {
      await reporter.log('invalid', 'Test message', 'PLAYER');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].level).toBe('info'); // Should default to 'info'
    });

    it('should log multiple messages', async () => {
      await reporter.log('error', 'Error 1', 'PLAYER');
      await reporter.log('info', 'Info 1', 'PLAYER');
      await reporter.log('debug', 'Debug 1', 'PLAYER');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(3);
    });
  });

  describe('shorthand methods', () => {
    it('should use error() shorthand', async () => {
      await reporter.error('Test error', 'PLAYER');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].level).toBe('error');
      expect(logs[0].message).toBe('Test error');
    });

    it('should use audit() shorthand', async () => {
      await reporter.audit('User action', 'AUTH');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].level).toBe('audit');
    });

    it('should use info() shorthand', async () => {
      await reporter.info('Info message', 'PLAYER');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].level).toBe('info');
    });

    it('should use debug() shorthand', async () => {
      await reporter.debug('Debug message', 'CACHE');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].level).toBe('debug');
    });

    it('should use default category in shorthand', async () => {
      await reporter.error('Test error');

      const logs = await reporter.getAllLogs();
      expect(logs[0].category).toBe('PLAYER');
    });
  });

  describe('log submission flow', () => {
    it('should get unsubmitted logs', async () => {
      await reporter.error('Error 1', 'PLAYER');
      await reporter.info('Info 1', 'PLAYER');

      const logs = await reporter.getLogsForSubmission();
      expect(logs.length).toBe(2);
      expect(logs.every(l => l.submitted === 0)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await reporter.info(`Message ${i}`, 'PLAYER');
      }

      const logs = await reporter.getLogsForSubmission(5);
      expect(logs.length).toBe(5);
    });

    it('should return empty array when no unsubmitted logs', async () => {
      const logs = await reporter.getLogsForSubmission();
      expect(logs).toEqual([]);
    });

    it('should clear submitted logs', async () => {
      await reporter.error('Error 1', 'PLAYER');
      await reporter.info('Info 1', 'PLAYER');

      const logs = await reporter.getLogsForSubmission();
      expect(logs.length).toBe(2);

      await reporter.clearSubmittedLogs(logs);

      const remaining = await reporter.getAllLogs();
      expect(remaining.length).toBe(0);
    });

    it('should handle clearing empty array', async () => {
      await reporter.clearSubmittedLogs([]);
      // Should not throw
    });

    it('should handle clearing null', async () => {
      await reporter.clearSubmittedLogs(null);
      // Should not throw
    });

    it('should handle invalid log IDs in clearSubmittedLogs', async () => {
      const invalidLogs = [
        { id: null, message: 'Test' },
        { id: undefined, message: 'Test' },
        { message: 'Test' } // No id property
      ];

      // Should not throw
      await reporter.clearSubmittedLogs(invalidLogs);
    });
  });

  describe('edge cases', () => {
    it('should handle operations without initialization', async () => {
      const r = new LogReporter();

      // Should not throw, but should log warnings
      await r.log('error', 'Test', 'PLAYER');
      await r.error('Test');
      await r.info('Test');

      const logs = await r.getLogsForSubmission();
      expect(logs).toEqual([]);
    });
  });

  describe('fault reporting', () => {
    it('should report a fault with alertType and eventType', async () => {
      await reporter.reportFault('LAYOUT_LOAD_FAILED', 'Failed to load layout 123');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].level).toBe('error');
      expect(logs[0].message).toBe('Failed to load layout 123');
      expect(logs[0].alertType).toBe('Player Fault');
      expect(logs[0].eventType).toBe('LAYOUT_LOAD_FAILED');
    });

    it('should deduplicate same fault code within cooldown', async () => {
      await reporter.reportFault('LAYOUT_LOAD_FAILED', 'First failure', 60000);
      await reporter.reportFault('LAYOUT_LOAD_FAILED', 'Second failure', 60000);
      await reporter.reportFault('LAYOUT_LOAD_FAILED', 'Third failure', 60000);

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(1); // Only first one logged
      expect(logs[0].message).toBe('First failure');
    });

    it('should allow different fault codes independently', async () => {
      await reporter.reportFault('LAYOUT_LOAD_FAILED', 'Layout error', 60000);
      await reporter.reportFault('MEDIA_DOWNLOAD_FAILED', 'Media error', 60000);

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(2);
      expect(logs[0].eventType).toBe('LAYOUT_LOAD_FAILED');
      expect(logs[1].eventType).toBe('MEDIA_DOWNLOAD_FAILED');
    });

    it('should allow same fault after cooldown expires', async () => {
      // Report first fault
      await reporter.reportFault('TEST_FAULT', 'First', 1); // 1ms cooldown

      // Wait for cooldown to expire
      await new Promise(resolve => setTimeout(resolve, 10));

      await reporter.reportFault('TEST_FAULT', 'Second', 1);

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(2);
    });

    it('should use default 5-minute cooldown', async () => {
      // Just verify reportFault works with default cooldown (don't wait 5 min)
      await reporter.reportFault('TEST_FAULT', 'Test reason');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].alertType).toBe('Player Fault');
    });
  });

  describe('database operations', () => {
    it('should get all logs', async () => {
      await reporter.error('Error 1', 'PLAYER');
      await reporter.info('Info 1', 'CACHE');
      await reporter.debug('Debug 1', 'RENDERER');

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(3);
      expect(logs.some(l => l.level === 'error')).toBe(true);
      expect(logs.some(l => l.level === 'info')).toBe(true);
      expect(logs.some(l => l.level === 'debug')).toBe(true);
    });

    it('should clear all logs', async () => {
      await reporter.error('Error 1', 'PLAYER');
      await reporter.info('Info 1', 'PLAYER');

      await reporter.clearAllLogs();

      const logs = await reporter.getAllLogs();
      expect(logs.length).toBe(0);
    });
  });
});

describe('formatLogs', () => {
  it('should format empty logs', () => {
    const xml = formatLogs([]);
    expect(xml).toBe('<logs></logs>');
  });

  it('should format null logs', () => {
    const xml = formatLogs(null);
    expect(xml).toBe('<logs></logs>');
  });

  it('should format a single log entry', () => {
    const logs = [{
      level: 'error',
      message: 'Test error',
      category: 'PLAYER',
      timestamp: new Date('2026-02-10T12:00:00Z')
    }];

    const xml = formatLogs(logs);
    expect(xml).toContain('<logs>');
    expect(xml).toContain('</logs>');
    expect(xml).toContain('category="error"');
    expect(xml).toContain('<message>Test error</message>');
    expect(xml).toContain('<method>PLAYER</method>');
    expect(xml).toContain('<thread>main</thread>');
    expect(xml).toContain('<scheduleID>0</scheduleID>');
    expect(xml).toContain('date=');
  });

  it('should format multiple log entries', () => {
    const logs = [
      {
        level: 'error',
        message: 'Error 1',
        category: 'PLAYER',
        timestamp: new Date('2026-02-10T12:00:00Z')
      },
      {
        level: 'info',
        message: 'Info 1',
        category: 'CACHE',
        timestamp: new Date('2026-02-10T12:01:00Z')
      }
    ];

    const xml = formatLogs(logs);
    const logCount = (xml.match(/<log /g) || []).length;
    expect(logCount).toBe(2);
  });

  it('should escape XML special characters in message', () => {
    const logs = [{
      level: 'error',
      message: 'Error: <tag> & "quote" & \'apostrophe\'',
      category: 'PLAYER',
      timestamp: new Date('2026-02-10T12:00:00Z')
    }];

    const xml = formatLogs(logs);
    expect(xml).toContain('&lt;tag&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');
    expect(xml).toContain('&apos;');
  });

  it('should escape XML special characters in method', () => {
    const logs = [{
      level: 'error',
      message: 'Test',
      category: 'PLAYER<>',
      timestamp: new Date('2026-02-10T12:00:00Z')
    }];

    const xml = formatLogs(logs);
    // category field from log entry becomes <method> child element
    expect(xml).toContain('<method>PLAYER&lt;&gt;</method>');
  });

  it('should format dates correctly', () => {
    const logs = [{
      level: 'info',
      message: 'Test',
      category: 'PLAYER',
      timestamp: new Date('2026-02-10T12:34:56Z')
    }];

    const xml = formatLogs(logs);
    // Should contain date in YYYY-MM-DD HH:MM:SS format
    expect(xml).toMatch(/date="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"/);
  });

  it('should map log levels to spec categories (error/audit only)', () => {
    const logs = [
      { level: 'error', message: 'Error', category: 'PLAYER', timestamp: new Date() },
      { level: 'audit', message: 'Audit', category: 'PLAYER', timestamp: new Date() },
      { level: 'info', message: 'Info', category: 'PLAYER', timestamp: new Date() },
      { level: 'debug', message: 'Debug', category: 'PLAYER', timestamp: new Date() }
    ];

    const xml = formatLogs(logs);
    // Spec only allows "error" and "audit" as categories
    expect(xml).toContain('category="error"');
    expect(xml).toContain('category="audit"');
    // info and debug should be mapped to "audit"
    const auditCount = (xml.match(/category="audit"/g) || []).length;
    expect(auditCount).toBe(3); // audit + info + debug
  });

  it('should include alertType and eventType in XML output for faults', () => {
    const logs = [{
      level: 'error',
      message: 'Layout failed to load',
      category: 'PLAYER',
      timestamp: new Date('2026-02-10T12:00:00Z'),
      alertType: 'Player Fault',
      eventType: 'LAYOUT_LOAD_FAILED'
    }];

    const xml = formatLogs(logs);
    expect(xml).toContain('alertType="Player Fault"');
    expect(xml).toContain('eventType="LAYOUT_LOAD_FAILED"');
  });

  it('should not include alertType/eventType when not present', () => {
    const logs = [{
      level: 'info',
      message: 'Normal log',
      category: 'PLAYER',
      timestamp: new Date('2026-02-10T12:00:00Z')
    }];

    const xml = formatLogs(logs);
    expect(xml).not.toContain('alertType');
    expect(xml).not.toContain('eventType');
  });

  it('should handle mixed logs with and without fault fields', () => {
    const logs = [
      {
        level: 'error',
        message: 'Fault log',
        category: 'PLAYER',
        timestamp: new Date('2026-02-10T12:00:00Z'),
        alertType: 'Player Fault',
        eventType: 'TEST_FAULT'
      },
      {
        level: 'info',
        message: 'Normal log',
        category: 'PLAYER',
        timestamp: new Date('2026-02-10T12:01:00Z')
      }
    ];

    const xml = formatLogs(logs);
    const logCount = (xml.match(/<log /g) || []).length;
    expect(logCount).toBe(2);
    // First log has fault fields
    expect(xml).toContain('alertType="Player Fault"');
    expect(xml).toContain('eventType="TEST_FAULT"');
  });

  it('should handle long messages', () => {
    const longMessage = 'A'.repeat(1000);
    const logs = [{
      level: 'error',
      message: longMessage,
      category: 'PLAYER',
      timestamp: new Date()
    }];

    const xml = formatLogs(logs);
    expect(xml).toContain(longMessage);
  });

  it('should use custom thread, method, and scheduleId when provided', () => {
    const logs = [{
      level: 'error',
      message: 'Widget failed',
      category: 'RENDERER',
      thread: 'worker-2',
      method: 'renderWidget',
      scheduleId: 42,
      timestamp: new Date('2026-02-10T12:00:00Z')
    }];

    const xml = formatLogs(logs);
    expect(xml).toContain('<thread>worker-2</thread>');
    expect(xml).toContain('<method>renderWidget</method>');
    expect(xml).toContain('<scheduleID>42</scheduleID>');
  });

  it('should produce spec-compliant XML structure with child elements', () => {
    const logs = [{
      level: 'error',
      message: 'Test',
      category: 'PLAYER',
      timestamp: new Date('2026-02-10T12:00:00Z')
    }];

    const xml = formatLogs(logs);
    // Should NOT have message as attribute (old format)
    expect(xml).not.toMatch(/message="/);
    // Should have message as child element (spec format)
    expect(xml).toMatch(/<message>Test<\/message>/);
    // Should have closing </log> tag (not self-closing)
    expect(xml).toContain('</log>');
  });
});
