import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readState, writeState } from './state';
import { SCHEMA_VERSION, StackState } from './types';

vi.mock('@actions/cache', () => ({
  restoreCache: vi.fn(),
  saveCache: vi.fn(),
}));

const CACHE_KEY_PREFIX = 'stackwatch-state-v1';

function sampleState(schemaVersion: number = SCHEMA_VERSION): StackState {
  return {
    schemaVersion: schemaVersion as typeof SCHEMA_VERSION,
    updatedAt: '2026-07-01T10:00:00.000Z',
    services: { GitHub: { status: 'operational', since: '2026-07-01T09:00:00.000Z', alertedAt: null } },
  };
}

describe('state.ts', () => {
  beforeEach(() => {
    vi.mocked(cache.restoreCache).mockReset();
    vi.mocked(cache.saveCache).mockReset();
    vi.spyOn(core, 'warning').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readState', () => {
    it('returns empty state on a cache miss (first run, FR-14)', async () => {
      vi.mocked(cache.restoreCache).mockResolvedValue(undefined);

      const state = await readState();

      expect(cache.restoreCache).toHaveBeenCalledWith(expect.any(Array), expect.any(String), [CACHE_KEY_PREFIX]);
      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
      expect(state.services).toEqual({});
    });

    it('returns the parsed state on a cache hit', async () => {
      const stored = sampleState();
      vi.mocked(cache.restoreCache).mockImplementation(async (paths) => {
        fs.writeFileSync((paths as string[])[0] as string, JSON.stringify(stored));
        return `${CACHE_KEY_PREFIX}-1234567890`;
      });

      const state = await readState();

      expect(state).toEqual(stored);
    });

    it('discards state and reinitialises on schemaVersion mismatch (FR-15)', async () => {
      const stored = sampleState(999);
      vi.mocked(cache.restoreCache).mockImplementation(async (paths) => {
        fs.writeFileSync((paths as string[])[0] as string, JSON.stringify(stored));
        return `${CACHE_KEY_PREFIX}-1234567890`;
      });

      const state = await readState();

      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
      expect(state.services).toEqual({});
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('schemaVersion mismatch'));
    });

    it('discards state, warns, and reinitialises on corrupt JSON (previously silent — fixed alongside the statePersistence.ts extraction)', async () => {
      vi.mocked(cache.restoreCache).mockImplementation(async (paths) => {
        fs.writeFileSync((paths as string[])[0] as string, 'not json');
        return `${CACHE_KEY_PREFIX}-1234567890`;
      });

      const state = await readState();

      expect(state.services).toEqual({});
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('corrupt JSON'));
    });

    it('returns empty state (never throws) when the cache service itself is unavailable', async () => {
      vi.mocked(cache.restoreCache).mockRejectedValue(new Error('cache service unavailable'));

      const state = await readState();

      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
      expect(state.services).toEqual({});
    });
  });

  describe('writeState', () => {
    it('saves the state to cache under a prefixed key', async () => {
      vi.mocked(cache.saveCache).mockResolvedValue(1);

      await writeState(sampleState());

      expect(cache.saveCache).toHaveBeenCalledWith(expect.any(Array), expect.stringMatching(new RegExp(`^${CACHE_KEY_PREFIX}-`)));
    });

    it('does not throw when the cache write fails (FR-16: caller retries next run)', async () => {
      vi.mocked(cache.saveCache).mockRejectedValue(new Error('cache reserve failed'));

      await expect(writeState(sampleState())).resolves.toBeUndefined();
    });

    it('uses a fresh key on every write, never colliding with the immutable key from a prior write', async () => {
      // Confirmed via real E2E testing: Actions cache keys are immutable, so
      // reusing a fixed key on a second write fails with "unable to reserve
      // cache" — which would leave every later run reading the *first*
      // stale write forever and re-alerting on it every time (breaking
      // P-3/G-3). Each write must therefore get its own unique key.
      vi.mocked(cache.saveCache).mockResolvedValue(1);

      await writeState(sampleState());
      await writeState(sampleState());

      const [, firstKey] = vi.mocked(cache.saveCache).mock.calls[0] as [string[], string];
      const [, secondKey] = vi.mocked(cache.saveCache).mock.calls[1] as [string[], string];
      expect(firstKey).not.toBe(secondKey);
      expect(firstKey.startsWith(CACHE_KEY_PREFIX)).toBe(true);
      expect(secondKey.startsWith(CACHE_KEY_PREFIX)).toBe(true);
    });
  });
});
