import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAlertBlocks, sendSlackAlert } from './alert';
import { DiffResult, SCHEMA_VERSION, StackState } from './types';

const NOW_ISO = '2026-07-01T12:00:00.000Z';

function emptyPrevious(): StackState {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: NOW_ISO, services: {} };
}

describe('buildAlertBlocks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a brand-new incident with elapsed time "0m ago" and the vendor description', () => {
    const diffResult: DiffResult = {
      hasChanges: true,
      newIncidents: [{ name: 'Datadog', status: 'degraded_performance', description: 'Elevated error rates.', fetchedAt: NOW_ISO }],
      recovered: [],
    };
    const blocks = buildAlertBlocks(diffResult, emptyPrevious());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text?.text).toBe('🟡 *Datadog* — Degraded Performance, since 0m ago\nElevated error rates.');
  });

  it.each([
    ['degraded_performance', '🟡'],
    ['partial_outage', '🟠'],
    ['major_outage', '🔴'],
    ['unknown', '⚪'],
  ] as const)('uses %s severity emoji %s', (status, emoji) => {
    const diffResult: DiffResult = {
      hasChanges: true,
      newIncidents: [{ name: 'svc', status, description: 'd', fetchedAt: NOW_ISO }],
      recovered: [],
    };
    const blocks = buildAlertBlocks(diffResult, emptyPrevious());
    expect(blocks[0]?.text?.text.startsWith(emoji)).toBe(true);
  });

  it('uses the original incident start time (not "now") for a retry-alert incident', () => {
    const since = '2026-07-01T10:30:00.000Z'; // 90 minutes before NOW_ISO
    const previous: StackState = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: since,
      services: { GitHub: { status: 'major_outage', since, alertedAt: null } },
    };
    const diffResult: DiffResult = {
      hasChanges: true,
      newIncidents: [{ name: 'GitHub', status: 'major_outage', description: 'Major outage.', fetchedAt: NOW_ISO }],
      recovered: [],
    };
    const blocks = buildAlertBlocks(diffResult, previous);
    expect(blocks[0]?.text?.text).toContain('since 1h 30m ago');
  });

  it('renders a recovery with a green circle and total downtime duration', () => {
    const since = '2026-07-01T10:30:00.000Z';
    const previous: StackState = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: since,
      services: { GitHub: { status: 'major_outage', since, alertedAt: since } },
    };
    const diffResult: DiffResult = {
      hasChanges: true,
      newIncidents: [],
      recovered: [{ name: 'GitHub', status: 'operational', description: 'All Systems Operational', fetchedAt: NOW_ISO }],
    };
    const blocks = buildAlertBlocks(diffResult, previous);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text?.text).toBe('🟢 *GitHub* — Recovered after 1h 30m of downtime');
  });

  it('batches multiple incidents and recoveries into one block list (FR-25)', () => {
    const diffResult: DiffResult = {
      hasChanges: true,
      newIncidents: [
        { name: 'Datadog', status: 'degraded_performance', description: 'd1', fetchedAt: NOW_ISO },
        { name: 'ClickHouse Cloud', status: 'unknown', description: 'd2', fetchedAt: NOW_ISO },
      ],
      recovered: [{ name: 'GitHub', status: 'operational', description: 'ok', fetchedAt: NOW_ISO }],
    };
    const previous: StackState = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: NOW_ISO,
      services: { GitHub: { status: 'major_outage', since: NOW_ISO, alertedAt: NOW_ISO } },
    };
    const blocks = buildAlertBlocks(diffResult, previous);
    expect(blocks).toHaveLength(3);
  });

  it.each([
    [0, '0m'],
    [45, '45m'],
    [90, '1h 30m'],
    [60, '1h'],
    [1440, '1d'],
    [1530, '1d 1h 30m'],
  ])('formats a %i-minute gap as "%s"', (minutesAgo, expected) => {
    const since = new Date(new Date(NOW_ISO).getTime() - minutesAgo * 60_000).toISOString();
    const previous: StackState = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: since,
      services: { svc: { status: 'major_outage', since, alertedAt: since } },
    };
    const diffResult: DiffResult = {
      hasChanges: true,
      newIncidents: [],
      recovered: [{ name: 'svc', status: 'operational', description: 'ok', fetchedAt: NOW_ISO }],
    };
    const blocks = buildAlertBlocks(diffResult, previous);
    expect(blocks[0]?.text?.text).toBe(`🟢 *svc* — Recovered after ${expected} of downtime`);
  });
});

describe('sendSlackAlert', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the blocks as a single Block Kit JSON payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const blocks = [{ type: 'section', text: { type: 'mrkdwn' as const, text: 'hi' } }];
    await sendSlackAlert('https://hooks.slack.example/T000/B000/xyz', blocks);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.example/T000/B000/xyz');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ blocks });
  });

  it('throws (without leaking the webhook URL) when Slack responds non-2xx (FR-26, NFR-4)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const secretUrl = 'https://hooks.slack.example/T000/B000/super-secret';
    await expect(sendSlackAlert(secretUrl, [])).rejects.toThrow('500');
    try {
      await sendSlackAlert(secretUrl, []);
    } catch (error) {
      expect((error as Error).message).not.toContain(secretUrl);
    }
  });
});
