const DEFAULT_TIMEOUT_MS = 5000;

/** Fetches `url` and parses it as JSON, aborting after `timeoutMs`. Throws on
 * timeout, non-2xx response, or JSON parse error — callers decide retry policy. */
async function fetchJsonOnce<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request to ${url} failed with status ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches JSON with a 5000ms timeout (FR-7), retrying exactly once on any
 * failure (FR-8). Rejects if both attempts fail — callers map that to `unknown`. */
export async function fetchJsonWithRetry<T>(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  try {
    return await fetchJsonOnce<T>(url, timeoutMs);
  } catch {
    return await fetchJsonOnce<T>(url, timeoutMs);
  }
}
