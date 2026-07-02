import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withUnknownFallback } from './base';

const NOW_ISO = '2026-07-01T12:00:00.000Z';

describe('withUnknownFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes through a successful result unchanged', async () => {
    const fetcher = withUnknownFallback('GitHub', async () => ({
      name: 'GitHub',
      status: 'operational',
      description: 'All Systems Operational',
      fetchedAt: NOW_ISO,
    }));

    await expect(fetcher()).resolves.toEqual({
      name: 'GitHub',
      status: 'operational',
      description: 'All Systems Operational',
      fetchedAt: NOW_ISO,
    });
  });

  it('converts any thrown error into an `unknown` ServiceResult instead of rejecting (P-6)', async () => {
    const fetcher = withUnknownFallback('GitHub', async () => {
      throw new Error('network error');
    });

    await expect(fetcher()).resolves.toEqual({
      name: 'GitHub',
      status: 'unknown',
      description: 'Unable to reach status API after retry.',
      fetchedAt: NOW_ISO,
    });
  });
});
