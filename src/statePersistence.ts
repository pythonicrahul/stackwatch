import { SCHEMA_VERSION, StackState } from './types';

/** Pure result of trying to parse stored state — no logging side effect, so
 * every caller (the Action's Actions-cache backend, the daemon's flat-file
 * backend) decides for itself how/whether to log the two failure cases,
 * using its own logging mechanism. */
export type ParsedState =
  | { ok: true; state: StackState }
  | { ok: false; reason: 'schema_mismatch'; found: unknown }
  | { ok: false; reason: 'corrupt' };

export function emptyState(): StackState {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), services: {} };
}

/** Parses stored state. Schema-version mismatch and corrupt JSON are both
 * reported (not silently swallowed) so callers can log whichever is useful
 * to them — discarding either way and letting the caller fall back to
 * `emptyState()` re-initialises cleanly (FR-15). */
export function parseState(raw: string): ParsedState {
  let parsed: StackState;
  try {
    parsed = JSON.parse(raw) as StackState;
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: 'schema_mismatch', found: parsed.schemaVersion };
  }
  return { ok: true, state: parsed };
}
