import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDaemonState, writeDaemonState } from './state';
import { Logger } from './logger';
import { SCHEMA_VERSION, StackState } from '../types';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

function fakeLogger(): Logger & { calls: { level: string; message: string; fields?: unknown }[] } {
  const calls: { level: string; message: string; fields?: unknown }[] = [];
  return {
    calls,
    info: (message, fields) => calls.push({ level: 'info', message, fields }),
    warn: (message, fields) => calls.push({ level: 'warn', message, fields }),
    error: (message, fields) => calls.push({ level: 'error', message, fields }),
  };
}

function sampleState(): StackState {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: '2026-07-01T10:00:00.000Z',
    services: { GitHub: { status: 'operational', since: '2026-07-01T09:00:00.000Z', alertedAt: null } },
  };
}

describe('daemon state (flat file)', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackwatch-daemon-state-'));
    statePath = path.join(dir, 'state.json');
    vi.mocked(fs.writeFileSync).mockClear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('readDaemonState', () => {
    it('returns empty state when the file does not exist yet (first run)', () => {
      const logger = fakeLogger();

      const state = readDaemonState(statePath, logger);

      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
      expect(state.services).toEqual({});
      expect(logger.calls).toEqual([]);
    });

    it('returns the parsed state on a successful read', () => {
      const stored = sampleState();
      fs.writeFileSync(statePath, JSON.stringify(stored));

      expect(readDaemonState(statePath, fakeLogger())).toEqual(stored);
    });

    it('warns and reinitialises on corrupt JSON', () => {
      fs.writeFileSync(statePath, 'not json');
      const logger = fakeLogger();

      const state = readDaemonState(statePath, logger);

      expect(state.services).toEqual({});
      expect(logger.calls).toEqual([{ level: 'warn', message: 'stored state was corrupt JSON; reinitialising', fields: undefined }]);
    });

    it('warns and reinitialises on a schemaVersion mismatch', () => {
      fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 999, updatedAt: '2026-07-01T10:00:00.000Z', services: {} }));
      const logger = fakeLogger();

      const state = readDaemonState(statePath, logger);

      expect(state.services).toEqual({});
      expect(logger.calls[0]).toMatchObject({ level: 'warn', message: 'state schemaVersion mismatch; reinitialising' });
    });
  });

  describe('writeDaemonState', () => {
    it('writes the state such that it can be read back identically', () => {
      const state = sampleState();

      writeDaemonState(statePath, state, fakeLogger());

      expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual(state);
    });

    it('writes the temp file in the same directory as the target, not a system tmpdir, so rename stays atomic', () => {
      writeDaemonState(statePath, sampleState(), fakeLogger());

      const [writtenPath] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, string];
      expect(path.dirname(writtenPath)).toBe(dir);
    });

    it('does not leave a stray temp file behind after a successful write', () => {
      writeDaemonState(statePath, sampleState(), fakeLogger());

      const remaining = fs.readdirSync(dir);
      expect(remaining).toEqual(['state.json']);
    });

    it('creates the target directory if it does not exist yet', () => {
      const nestedPath = path.join(dir, 'nested', 'deep', 'state.json');

      writeDaemonState(nestedPath, sampleState(), fakeLogger());

      expect(fs.existsSync(nestedPath)).toBe(true);
    });

    it('logs a warning (does not throw) when the write fails', () => {
      const logger = fakeLogger();
      const badPath = '/this/path/does/not/exist/and/cannot/be/created\0invalid';

      expect(() => writeDaemonState(badPath, sampleState(), logger)).not.toThrow();
      expect(logger.calls[0]).toMatchObject({ level: 'warn', message: 'state file write failed; next cycle will not see this update' });
    });
  });
});
