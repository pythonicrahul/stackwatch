import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger';

const NOW_ISO = '2026-07-01T12:00:00.000Z';

describe('logger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes info as a single JSON line to stdout (console.log)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('hello', { foo: 'bar' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toEqual({
      level: 'info',
      message: 'hello',
      timestamp: NOW_ISO,
      foo: 'bar',
    });
  });

  it('writes warn to stdout (console.log), not stderr', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.warn('careful');

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({ level: 'warn', message: 'careful' });
  });

  it('writes error to stderr (console.error), not stdout', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('broken', { code: 500 });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(JSON.parse(errorSpy.mock.calls[0]?.[0] as string)).toEqual({
      level: 'error',
      message: 'broken',
      timestamp: NOW_ISO,
      code: 500,
    });
  });

  it('omits extra fields entirely when none are given, rather than an empty object', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('no fields here');

    expect(Object.keys(JSON.parse(spy.mock.calls[0]?.[0] as string)).sort()).toEqual(['level', 'message', 'timestamp']);
  });
});
