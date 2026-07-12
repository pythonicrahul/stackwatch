import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, parseState } from './statePersistence';
import { SCHEMA_VERSION, StackState } from './types';

const NOW_ISO = '2026-07-01T12:00:00.000Z';

describe('emptyState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a fresh state stamped with the current schema version and time', () => {
    expect(emptyState()).toEqual({ schemaVersion: SCHEMA_VERSION, updatedAt: NOW_ISO, services: {} });
  });
});

describe('parseState', () => {
  it('returns ok:true with the parsed state on valid JSON matching the current schema', () => {
    const stored: StackState = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: NOW_ISO,
      services: { GitHub: { status: 'operational', since: NOW_ISO, alertedAt: null } },
    };

    expect(parseState(JSON.stringify(stored))).toEqual({ ok: true, state: stored });
  });

  it('returns a schema_mismatch result (not a thrown error or silent discard) on a version mismatch', () => {
    const stored = { schemaVersion: 999, updatedAt: NOW_ISO, services: {} };

    expect(parseState(JSON.stringify(stored))).toEqual({ ok: false, reason: 'schema_mismatch', found: 999 });
  });

  it('returns a corrupt result (not a thrown error) on invalid JSON, so callers can log it instead of it being silent', () => {
    expect(parseState('not json')).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('never logs anything itself — purely a data transform, logging is each caller\'s responsibility', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    parseState('not json');
    parseState(JSON.stringify({ schemaVersion: 999, updatedAt: NOW_ISO, services: {} }));

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
