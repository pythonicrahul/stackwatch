import { ServiceResult } from '../types';

export type Fetcher = () => Promise<ServiceResult>;

function unknownResult(name: string): ServiceResult {
  return {
    name,
    status: 'unknown',
    description: 'Unable to reach status API after retry.',
    fetchedAt: new Date().toISOString(),
  };
}

/** Wraps a raw fetch implementation so any failure (timeout, non-2xx, JSON
 * parse error — already retried once inside `run`) surfaces as an `unknown`
 * ServiceResult instead of throwing. Per P-6, unreachable MUST alert as
 * `unknown`, not be silently swallowed. */
export function withUnknownFallback(name: string, run: () => Promise<ServiceResult>): Fetcher {
  return async () => {
    try {
      return await run();
    } catch {
      return unknownResult(name);
    }
  };
}
