import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClickHouseFetcher } from './clickhouse';

const NOW_ISO = '2026-07-01T12:00:00.000Z';
const CLICKHOUSE_STATUS_URL = 'https://status.clickhouse.com/api/v2/summary.json';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe('createClickHouseFetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetches the ClickHouse-specific status endpoint (FR-10)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: { indicator: 'none', description: 'All Systems Operational' } }));
    vi.stubGlobal('fetch', fetchMock);

    await createClickHouseFetcher()();

    expect(fetchMock).toHaveBeenCalledWith(CLICKHOUSE_STATUS_URL, expect.anything());
  });

  it.each([
    ['none', 'operational'],
    ['minor', 'degraded_performance'],
    ['major', 'partial_outage'],
    ['critical', 'major_outage'],
    ['maintenance', 'maintenance'],
    ['unrecognised', 'unknown'],
  ])('normalises indicator "%s" to "%s" (FR-11)', async (indicator, expectedStatus) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ status: { indicator, description: 'desc' } }))
    );

    const result = await createClickHouseFetcher()();

    expect(result).toEqual({
      name: 'ClickHouse Cloud',
      status: expectedStatus,
      description: 'desc',
      fetchedAt: NOW_ISO,
    });
  });

  it('falls back to `unknown` when unreachable after retry (P-6)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    const result = await createClickHouseFetcher()();

    expect(result.status).toBe('unknown');
    expect(result.name).toBe('ClickHouse Cloud');
  });
});
