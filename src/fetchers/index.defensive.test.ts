import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchEnabledServices } from './index';

// These mocks replace the real adapters with ones that reject directly,
// bypassing withUnknownFallback entirely. This exercises index.ts's own
// Promise.allSettled handling (its "defense-in-depth" comment) rather than
// relying on each adapter's own try/catch, which is covered elsewhere.
// vi.mock calls are hoisted above these imports by vitest's transform, so
// `fetchEnabledServices` above is built from the mocked factories already.
vi.mock('./statuspage', () => ({
  createStatuspageFetcher: () => () => Promise.reject(new Error('adapter bug')),
}));
vi.mock('./clickhouse', () => ({
  createClickHouseFetcher: () => () => Promise.reject(new Error('adapter bug')),
}));

const NOW_ISO = '2026-07-01T12:00:00.000Z';

describe('fetchEnabledServices — defense in depth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('converts an adapter that rejects outside its own try/catch into an unknown result, keyed by vendor id', async () => {
    const results = await fetchEnabledServices(['github', 'clickhouse']);

    expect(results).toEqual([
      { name: 'github', status: 'unknown', description: 'Fetcher threw unexpectedly.', fetchedAt: NOW_ISO },
      { name: 'clickhouse', status: 'unknown', description: 'Fetcher threw unexpectedly.', fetchedAt: NOW_ISO },
    ]);
  });
});
