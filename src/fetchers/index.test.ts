import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchEnabledServices } from './index';

const GITHUB_STATUS_URL = 'https://www.githubstatus.com/api/v2/summary.json';
const DATADOG_STATUS_URL = 'https://status.datadoghq.com/api/v2/summary.json';
const CLAUDE_STATUS_URL = 'https://status.claude.com/api/v2/summary.json';
const CLICKHOUSE_STATUS_URL = 'https://status.clickhouse.com/api/v2/summary.json';

const NOW_ISO = '2026-07-01T12:00:00.000Z';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe('fetchEnabledServices', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('only fetches enabled vendors, dispatching each to its own vendor URL (FR-5)', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === GITHUB_STATUS_URL) {
        return Promise.resolve(jsonResponse({ status: { indicator: 'none', description: 'GitHub OK' } }));
      }
      if (url === CLICKHOUSE_STATUS_URL) {
        return Promise.resolve(jsonResponse({ status: { indicator: 'critical', description: 'CH down' } }));
      }
      return Promise.reject(new Error(`unexpected fetch to ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await fetchEnabledServices(['github', 'clickhouse']);

    expect(results).toEqual(
      expect.arrayContaining([
        { name: 'GitHub', status: 'operational', description: 'GitHub OK', fetchedAt: NOW_ISO },
        { name: 'ClickHouse Cloud', status: 'major_outage', description: 'CH down', fetchedAt: NOW_ISO },
      ])
    );
    expect(fetchMock).not.toHaveBeenCalledWith(DATADOG_STATUS_URL, expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(CLAUDE_STATUS_URL, expect.anything());
  });

  it('fetches nothing when no vendors are enabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const results = await fetchEnabledServices([]);

    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs fetches concurrently via Promise.allSettled — one vendor failing does not block another (FR-6)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === DATADOG_STATUS_URL) return Promise.reject(new Error('down'));
        return Promise.resolve(jsonResponse({ status: { indicator: 'none', description: 'OK' } }));
      })
    );

    const results = await fetchEnabledServices(['github', 'datadog', 'claude']);

    expect(results).toHaveLength(3);
    expect(results.find((r) => r.name === 'Datadog')?.status).toBe('unknown');
    expect(results.find((r) => r.name === 'GitHub')?.status).toBe('operational');
    expect(results.find((r) => r.name === 'Claude')?.status).toBe('operational');
  });
});
