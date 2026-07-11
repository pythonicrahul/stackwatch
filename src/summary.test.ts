import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeRunSummary } from './summary';
import { DiffResult, ServiceResult } from './types';

const { addHeading, addTable, addRaw, write, warningMock } = vi.hoisted(() => ({
  addHeading: vi.fn(),
  addTable: vi.fn(),
  addRaw: vi.fn(),
  write: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock('@actions/core', () => {
  const summary = {
    addHeading: (...args: unknown[]) => {
      addHeading(...args);
      return summary;
    },
    addTable: (...args: unknown[]) => {
      addTable(...args);
      return summary;
    },
    addRaw: (...args: unknown[]) => {
      addRaw(...args);
      return summary;
    },
    write: (...args: unknown[]) => write(...args),
  };
  return { summary, warning: warningMock };
});

const NOW_ISO = '2026-07-01T12:00:00.000Z';

function result(name: string, status: ServiceResult['status']): ServiceResult {
  return { name, status, description: 'd', fetchedAt: NOW_ISO };
}

const noChanges: DiffResult = { hasChanges: false, newIncidents: [], recovered: [] };

describe('writeRunSummary', () => {
  beforeEach(() => {
    addHeading.mockReset();
    addTable.mockReset();
    addRaw.mockReset();
    warningMock.mockReset();
    write.mockReset().mockResolvedValue(undefined);
  });

  it('includes every fetched vendor with its current status', async () => {
    const results = [result('GitHub', 'operational'), result('Datadog', 'major_outage')];

    await writeRunSummary(results, noChanges, 'silent');

    const [rows] = addTable.mock.calls[0] as [unknown[]];
    expect(rows[1]).toEqual(['GitHub', '🟢 Operational', '—']);
    expect(rows[2]).toEqual(['Datadog', '🔴 Major Outage', '—']);
  });

  it('marks a new-incident vendor distinctly from a steady one', async () => {
    const results = [result('GitHub', 'major_outage')];
    const diffResult: DiffResult = { hasChanges: true, newIncidents: [result('GitHub', 'major_outage')], recovered: [] };

    await writeRunSummary(results, diffResult, 'alert_sent');

    const [rows] = addTable.mock.calls[0] as [unknown[]];
    expect(rows[1]).toEqual(['GitHub', '🔴 Major Outage', '🔔 New incident']);
  });

  it('marks a recovered vendor distinctly', async () => {
    const results = [result('GitHub', 'operational')];
    const diffResult: DiffResult = { hasChanges: true, newIncidents: [], recovered: [result('GitHub', 'operational')] };

    await writeRunSummary(results, diffResult, 'alert_sent');

    const [rows] = addTable.mock.calls[0] as [unknown[]];
    expect(rows[1]).toEqual(['GitHub', '🟢 Operational', '✅ Recovered']);
  });

  it.each([
    ['silent', 'staying silent'],
    ['alert_sent', 'Alert sent'],
    ['alert_failed', 'not persisted'],
  ] as const)('includes outcome text for %s', async (outcome, expectedSubstring) => {
    await writeRunSummary([], noChanges, outcome);
    expect(addRaw).toHaveBeenCalledWith(expect.stringContaining(expectedSubstring), true);
  });

  it('does not throw when writing the summary fails — purely additive, never blocks the run', async () => {
    write.mockRejectedValue(new Error('no GITHUB_STEP_SUMMARY'));

    await expect(writeRunSummary([], noChanges, 'silent')).resolves.toBeUndefined();
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('failed to write job summary'));
  });
});
