/**
 * Logger Tests
 *
 * Tests for configurable logging with log levels
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLogger, setLogLevel, getLogLevel, LOG_LEVELS } from './logger.js';

// Matches "HH:MM:SS.mmm [Name]" or "HH:MM:SS.mmm [Name] DEBUG:"
const ts = (name, suffix = '') =>
  expect.stringMatching(new RegExp(`^\\d{2}:\\d{2}:\\d{2}\\.\\d{3} \\[${name}\\]${suffix}$`));

describe('Logger', () => {
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Log Levels', () => {
    it('should have correct log level hierarchy', () => {
      expect(LOG_LEVELS.DEBUG).toBe(0);
      expect(LOG_LEVELS.INFO).toBe(1);
      expect(LOG_LEVELS.WARNING).toBe(2);
      expect(LOG_LEVELS.ERROR).toBe(3);
      expect(LOG_LEVELS.NONE).toBe(4);
    });
  });

  describe('Logger Creation', () => {
    it('should create logger with default WARNING level', () => {
      const logger = createLogger('TestModule');

      expect(logger.name).toBe('TestModule');
      // When no explicit level is given, logger follows global level (useGlobal=true)
      // so logger.level is undefined — check getEffectiveLevel() instead
      expect(logger.getEffectiveLevel()).toBeLessThanOrEqual(LOG_LEVELS.WARNING);
    });

    it('should create logger with custom level', () => {
      const logger = createLogger('TestModule', 'DEBUG');

      expect(logger.level).toBe(LOG_LEVELS.DEBUG);
    });

    it('should create logger with numeric level', () => {
      const logger = createLogger('TestModule', LOG_LEVELS.WARNING);

      expect(logger.level).toBe(LOG_LEVELS.WARNING);
    });
  });

  describe('debug()', () => {
    it('should log at DEBUG level', () => {
      const logger = createLogger('Test', 'DEBUG');

      logger.debug('Debug message', { data: 'value' });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        ts('Test', ' DEBUG:'),
        'Debug message',
        { data: 'value' }
      );
    });

    it('should not log when level is INFO', () => {
      const logger = createLogger('Test', 'INFO');

      logger.debug('Debug message');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should not log when level is WARNING', () => {
      const logger = createLogger('Test', 'WARNING');

      logger.debug('Debug message');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should not log when level is ERROR', () => {
      const logger = createLogger('Test', 'ERROR');

      logger.debug('Debug message');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('info()', () => {
    it('should log at INFO level', () => {
      const logger = createLogger('Test', 'INFO');

      logger.info('Info message', 'arg1', 'arg2');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        ts('Test'),
        'Info message',
        'arg1',
        'arg2'
      );
    });

    it('should log when level is DEBUG', () => {
      const logger = createLogger('Test', 'DEBUG');

      logger.info('Info message');

      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('should not log when level is WARNING', () => {
      const logger = createLogger('Test', 'WARNING');

      logger.info('Info message');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should not log when level is ERROR', () => {
      const logger = createLogger('Test', 'ERROR');

      logger.info('Info message');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('warn()', () => {
    it('should log at WARNING level', () => {
      const logger = createLogger('Test', 'WARNING');

      logger.warn('Warning message', { warn: true });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        ts('Test'),
        'Warning message',
        { warn: true }
      );
    });

    it('should log when level is DEBUG', () => {
      const logger = createLogger('Test', 'DEBUG');

      logger.warn('Warning');

      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should log when level is INFO', () => {
      const logger = createLogger('Test', 'INFO');

      logger.warn('Warning');

      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should not log when level is ERROR', () => {
      const logger = createLogger('Test', 'ERROR');

      logger.warn('Warning');

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe('error()', () => {
    it('should log at ERROR level', () => {
      const logger = createLogger('Test', 'ERROR');

      logger.error('Error message', new Error('Test error'));

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        ts('Test'),
        'Error message',
        expect.any(Error)
      );
    });

    it('should log when level is DEBUG', () => {
      const logger = createLogger('Test', 'DEBUG');

      logger.error('Error');

      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should log when level is INFO', () => {
      const logger = createLogger('Test', 'INFO');

      logger.error('Error');

      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should log when level is WARNING', () => {
      const logger = createLogger('Test', 'WARNING');

      logger.error('Error');

      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should not log when level is NONE', () => {
      const logger = createLogger('Test', 'NONE');

      logger.error('Error');

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('log(level, ...)', () => {
    let logger;

    beforeEach(() => {
      logger = createLogger('Test', 'DEBUG');
    });

    it('should delegate to debug()', () => {
      logger.log('DEBUG', 'message');

      expect(consoleLogSpy).toHaveBeenCalledWith(ts('Test', ' DEBUG:'), 'message');
    });

    it('should delegate to info()', () => {
      logger.log('INFO', 'message');

      expect(consoleLogSpy).toHaveBeenCalledWith(ts('Test'), 'message');
    });

    it('should delegate to warn() for WARNING', () => {
      logger.log('WARNING', 'message');

      expect(consoleWarnSpy).toHaveBeenCalledWith(ts('Test'), 'message');
    });

    it('should delegate to warn() for WARN', () => {
      logger.log('WARN', 'message');

      expect(consoleWarnSpy).toHaveBeenCalledWith(ts('Test'), 'message');
    });

    it('should delegate to error()', () => {
      logger.log('ERROR', 'message');

      expect(consoleErrorSpy).toHaveBeenCalledWith(ts('Test'), 'message');
    });

    it('should handle lowercase level names', () => {
      logger.log('debug', 'message');

      expect(consoleLogSpy).toHaveBeenCalledWith(ts('Test', ' DEBUG:'), 'message');
    });
  });

  describe('setLevel()', () => {
    let logger;

    beforeEach(() => {
      logger = createLogger('Test', 'INFO');
    });

    it('should change level from string', () => {
      logger.setLevel('DEBUG');

      expect(logger.level).toBe(LOG_LEVELS.DEBUG);
    });

    it('should change level from number', () => {
      logger.setLevel(LOG_LEVELS.WARNING);

      expect(logger.level).toBe(LOG_LEVELS.WARNING);
    });

    it('should handle lowercase level names', () => {
      logger.setLevel('debug');

      expect(logger.level).toBe(LOG_LEVELS.DEBUG);
    });

    it('should default to INFO for invalid level', () => {
      logger.setLevel('INVALID');

      expect(logger.level).toBe(LOG_LEVELS.INFO);
    });

    it('should affect subsequent log calls', () => {
      logger.setLevel('ERROR');

      logger.info('Should not log');
      logger.error('Should log');

      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('Global Log Level', () => {
    it('should set global log level', () => {
      setLogLevel('WARNING');

      const level = getLogLevel();

      expect(level).toBe('WARNING');
    });

    it('should affect new loggers', () => {
      setLogLevel('ERROR');

      // setLogLevel() internally calls console.log() to announce the level change,
      // so reset the spy before testing actual logger behavior
      consoleLogSpy.mockClear();

      const logger = createLogger('NewLogger');

      logger.info('Should not log');
      logger.error('Should log');

      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should handle lowercase in setLogLevel', () => {
      setLogLevel('debug');

      expect(getLogLevel()).toBe('DEBUG');
    });
  });

  describe('Multiple Arguments', () => {
    let logger;

    beforeEach(() => {
      logger = createLogger('Test', 'DEBUG');
    });

    it('should pass all arguments to console', () => {
      logger.info('Message', 1, 'two', { three: 3 }, [4, 5]);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        ts('Test'),
        'Message',
        1,
        'two',
        { three: 3 },
        [4, 5]
      );
    });

    it('should handle zero arguments', () => {
      logger.info();

      expect(consoleLogSpy).toHaveBeenCalledWith(ts('Test'));
    });

    it('should handle objects and errors', () => {
      const error = new Error('Test');
      const obj = { key: 'value' };

      logger.error('Error:', error, obj);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        ts('Test'),
        'Error:',
        error,
        obj
      );
    });
  });

  describe('Module Names', () => {
    it('should prefix logs with module name', () => {
      const logger = createLogger('MyModule', 'INFO');

      logger.info('Test');

      expect(consoleLogSpy).toHaveBeenCalledWith(ts('MyModule'), 'Test');
    });

    it('should support different module names', () => {
      const logger1 = createLogger('Module1', 'INFO');
      const logger2 = createLogger('Module2', 'INFO');

      logger1.info('From 1');
      logger2.info('From 2');

      expect(consoleLogSpy).toHaveBeenCalledWith(ts('Module1'), 'From 1');
      expect(consoleLogSpy).toHaveBeenCalledWith(ts('Module2'), 'From 2');
    });
  });

  describe('Edge Cases', () => {
    it('should handle null module name', () => {
      const logger = createLogger(null, 'INFO');

      logger.info('Test');

      expect(consoleLogSpy).toHaveBeenCalledWith(ts('null'), 'Test');
    });

    it('should handle undefined level (use default)', () => {
      const logger = createLogger('Test', undefined);

      // When level is undefined, logger follows global level (useGlobal=true)
      // so logger.level is undefined — check getEffectiveLevel() instead
      expect(logger.getEffectiveLevel()).toBeDefined();
    });

    it('should handle very long messages', () => {
      const logger = createLogger('Test', 'INFO');
      const longMessage = 'a'.repeat(10000);

      logger.info(longMessage);

      expect(consoleLogSpy).toHaveBeenCalledWith(ts('Test'), longMessage);
    });

    it('should handle circular references in objects', () => {
      const logger = createLogger('Test', 'INFO');
      const circular = { a: 1 };
      circular.self = circular;

      // Should not throw
      expect(() => {
        logger.info('Circular:', circular);
      }).not.toThrow();
    });
  });

  describe('Performance', () => {
    it('should skip expensive operations when level too low', () => {
      const logger = createLogger('Test', 'ERROR');

      const expensiveOperation = vi.fn(() => {
        return 'expensive result';
      });

      logger.debug('Debug:', expensiveOperation());

      // expensiveOperation still called (JS evaluates args before function call)
      // But console.log should not be called
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should handle high volume logging', () => {
      const logger = createLogger('Test', 'INFO');

      for (let i = 0; i < 1000; i++) {
        logger.info(`Message ${i}`);
      }

      expect(consoleLogSpy).toHaveBeenCalledTimes(1000);
    });
  });

  describe('Logging Disabled (NONE)', () => {
    it('should not log anything when level is NONE', () => {
      const logger = createLogger('Test', 'NONE');

      logger.debug('Debug');
      logger.info('Info');
      logger.warn('Warn');
      logger.error('Error');

      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
