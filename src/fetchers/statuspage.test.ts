import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStatuspageFetcher } from './statuspage';

const NOW_ISO = '2026-07-01T12:00:00.000Z';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe('createStatuspageFetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ['none', 'operational'],
    ['minor', 'degraded_performance'],
    ['major', 'partial_outage'],
    ['critical', 'major_outage'],
    ['something-unrecognised', 'unknown'],
  ])('normalises indicator "%s" to "%s" (FR-11)', async (indicator, expectedStatus) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ status: { indicator, description: 'All Systems Operational' } }))
    );

    const result = await createStatuspageFetcher('GitHub', 'https://status.example/api/v2/summary.json')();

    expect(result).toEqual({
      name: 'GitHub',
      status: expectedStatus,
      description: 'All Systems Operational',
      fetchedAt: NOW_ISO,
    });
  });

  it('detects scheduled maintenance from components even when the page indicator reads healthy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          status: { indicator: 'none', description: 'All Systems Operational' },
          components: [
            { status: 'operational' },
            { status: 'under_maintenance' },
          ],
        })
      )
    );

    const result = await createStatuspageFetcher('GitHub', 'https://status.example/api/v2/summary.json')();

    expect(result.status).toBe('maintenance');
  });

  it('does not require a components field at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ status: { indicator: 'none', description: 'All Systems Operational' } }))
    );

    const result = await createStatuspageFetcher('GitHub', 'https://status.example/api/v2/summary.json')();

    expect(result.status).toBe('operational');
  });

  it('falls back to `unknown` when the status API is unreachable after retry (P-6)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await createStatuspageFetcher('GitHub', 'https://status.example/api/v2/summary.json')();

    expect(result).toEqual({
      name: 'GitHub',
      status: 'unknown',
      description: 'Unable to reach status API after retry.',
      fetchedAt: NOW_ISO,
    });
  });
});
