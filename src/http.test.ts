import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJsonWithRetry } from './http';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe('fetchJsonWithRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed JSON on the first successful attempt without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hello: 'world' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJsonWithRetry<{ hello: string }>('https://example.test/summary.json');

    expect(result).toEqual({ hello: 'world' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once after a non-2xx response, then succeeds (FR-8)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(null, false, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJsonWithRetry<{ ok: boolean }>('https://example.test/summary.json');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries exactly once after a JSON parse error, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJsonWithRetry<{ ok: boolean }>('https://example.test/summary.json');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects when both the initial attempt and the single retry fail', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null, false, 500));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchJsonWithRetry('https://example.test/summary.json')).rejects.toThrow('500');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts a hung request after the given timeout and retries, eventually rejecting (FR-7)', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchJsonWithRetry('https://example.test/summary.json', 20)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
