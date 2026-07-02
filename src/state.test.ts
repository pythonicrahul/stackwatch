import * as cache from '@actions/cache';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readState, writeState } from './state';
import { SCHEMA_VERSION, StackState } from './types';

vi.mock('@actions/cache', () => ({
  restoreCache: vi.fn(),
  saveCache: vi.fn(),
}));

const REPO_VAR_URL = 'https://api.github.com/repos/acme/widgets/actions/variables/STACKWATCH_STATE';
const REPO_VAR_CREATE_URL = 'https://api.github.com/repos/acme/widgets/actions/variables';
const CACHE_KEY = 'stackwatch-state-v1';

const originalEnv = { ...process.env };

function sampleState(schemaVersion: number = SCHEMA_VERSION): StackState {
  return {
    schemaVersion: schemaVersion as typeof SCHEMA_VERSION,
    updatedAt: '2026-07-01T10:00:00.000Z',
    services: { GitHub: { status: 'operational', since: '2026-07-01T09:00:00.000Z', alertedAt: null } },
  };
}

function withRepoContext() {
  process.env.GITHUB_REPOSITORY = 'acme/widgets';
  process.env.GITHUB_TOKEN = 'test-token';
}

describe('state.ts', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.mocked(cache.restoreCache).mockReset();
    vi.mocked(cache.saveCache).mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('readState', () => {
    it('falls back to cache when GITHUB_REPOSITORY/GITHUB_TOKEN are not set, returning empty state on a cache miss', async () => {
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_TOKEN;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      vi.mocked(cache.restoreCache).mockResolvedValue(undefined);

      const state = await readState();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(cache.restoreCache).toHaveBeenCalledWith(expect.any(Array), CACHE_KEY);
      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
      expect(state.services).toEqual({});
    });

    it('returns empty state on a 404 (first run) without touching the cache layer', async () => {
      withRepoContext();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404, ok: false }));

      const state = await readState();

      expect(state.services).toEqual({});
      expect(cache.restoreCache).not.toHaveBeenCalled();
    });

    it('returns the parsed repo variable state on success (FR-12)', async () => {
      withRepoContext();
      const stored = sampleState();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ value: JSON.stringify(stored) }) })
      );

      const state = await readState();

      expect(state).toEqual(stored);
    });

    it('discards state and reinitialises on schemaVersion mismatch, without falling back to cache (FR-15)', async () => {
      withRepoContext();
      const stored = sampleState(999);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ value: JSON.stringify(stored) }) })
      );

      const state = await readState();

      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
      expect(state.services).toEqual({});
      expect(cache.restoreCache).not.toHaveBeenCalled();
    });

    it('falls back to cache when the repo variable read errors (e.g. missing permissions) (FR-13)', async () => {
      withRepoContext();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
      const cached = sampleState();
      vi.mocked(cache.restoreCache).mockImplementation(async (paths) => {
        fs.writeFileSync((paths as string[])[0] as string, JSON.stringify(cached));
        return CACHE_KEY;
      });

      const state = await readState();

      expect(state).toEqual(cached);
    });

    it('returns empty state when both layers are unavailable (FR-14)', async () => {
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_TOKEN;
      vi.stubGlobal('fetch', vi.fn());
      vi.mocked(cache.restoreCache).mockRejectedValue(new Error('cache service unavailable'));

      const state = await readState();

      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
      expect(state.services).toEqual({});
    });
  });

  describe('writeState', () => {
    it('writes via PATCH when the repo variable already exists, and never touches the cache', async () => {
      withRepoContext();
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      await writeState(sampleState());

      expect(fetchMock).toHaveBeenCalledWith(REPO_VAR_URL, expect.objectContaining({ method: 'PATCH' }));
      expect(cache.saveCache).not.toHaveBeenCalled();
    });

    it('creates the repo variable via POST when PATCH reports it does not exist yet', async () => {
      withRepoContext();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockResolvedValueOnce({ ok: true, status: 201 });
      vi.stubGlobal('fetch', fetchMock);

      await writeState(sampleState());

      expect(fetchMock).toHaveBeenNthCalledWith(1, REPO_VAR_URL, expect.objectContaining({ method: 'PATCH' }));
      expect(fetchMock).toHaveBeenNthCalledWith(2, REPO_VAR_CREATE_URL, expect.objectContaining({ method: 'POST' }));
      expect(cache.saveCache).not.toHaveBeenCalled();
    });

    it('falls back to the cache layer when the repo variable write fails entirely (FR-13)', async () => {
      withRepoContext();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      vi.mocked(cache.saveCache).mockResolvedValue(1);

      await writeState(sampleState());

      expect(cache.saveCache).toHaveBeenCalledWith(expect.any(Array), CACHE_KEY);
    });

    it('goes straight to the cache layer when GITHUB_REPOSITORY/GITHUB_TOKEN are missing', async () => {
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_TOKEN;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      vi.mocked(cache.saveCache).mockResolvedValue(1);

      await writeState(sampleState());

      expect(fetchMock).not.toHaveBeenCalled();
      expect(cache.saveCache).toHaveBeenCalled();
    });

    it('does not throw even when both the repo variable and cache writes fail', async () => {
      withRepoContext();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      vi.mocked(cache.saveCache).mockRejectedValue(new Error('cache reserve failed'));

      await expect(writeState(sampleState())).resolves.toBeUndefined();
    });
  });
});
