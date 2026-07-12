import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { emptyState, parseState } from '../statePersistence';
import { StackState } from '../types';
import { Logger } from './logger';

/** Reads state from a flat JSON file. Missing file (first run) or corrupt/
 * schema-mismatched content both fall back to a fresh empty state — the
 * daemon has no fallback tier beyond this (unlike the Action's cache
 * fallback), so failures here are logged and treated as "start clean"
 * rather than crashing the process. */
export function readDaemonState(filePath: string, logger: Logger): StackState {
  if (!fs.existsSync(filePath)) return emptyState();

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logger.warn('state file read failed; treating as first run', { error: (error as Error).message });
    return emptyState();
  }

  const result = parseState(raw);
  if (result.ok) return result.state;
  if (result.reason === 'schema_mismatch') {
    logger.warn('state schemaVersion mismatch; reinitialising', { found: result.found });
  } else {
    logger.warn('stored state was corrupt JSON; reinitialising');
  }
  return emptyState();
}

/** Writes state atomically: write to a temp file in the *same directory* as
 * the target, then rename over it. Rename is only atomic when source and
 * destination share a filesystem — writing the temp file to `os.tmpdir()`
 * (as the Action's Actions-cache-backed state.ts does, for an unrelated
 * reason: the cache round-trip needs a fixed path) would risk `EXDEV` or a
 * non-atomic rename here, since a mounted volume is very often a different
 * filesystem than the container's own tmp directory. */
export function writeDaemonState(filePath: string, state: StackState, logger: Logger): void {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(state));
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    logger.warn('state file write failed; next cycle will not see this update', { error: (error as Error).message });
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // temp file was never created, or already gone — nothing to clean up
    }
  }
}
