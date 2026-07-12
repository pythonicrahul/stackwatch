import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const DAEMON_ENTRY = path.resolve(process.cwd(), 'lib/daemon/index.js');

/** Polls the accumulated stdout/stderr for the daemon's own
 * `{"message":"health server listening","port":N}` log line, so the test
 * never has to guess/hardcode a port (HEALTH_PORT=0 lets the OS assign a
 * free one) and can't collide with anything else running on the host. */
async function waitForBoundPort(getLogs: () => string, deadlineMs: number): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    for (const line of getLogs().split('\n')) {
      try {
        const parsed = JSON.parse(line) as { message?: string; port?: number };
        if (parsed.message === 'health server listening' && typeof parsed.port === 'number') {
          return parsed.port;
        }
      } catch {
        // partial or non-JSON line — ignore and keep polling
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`daemon never reported a bound health port within ${deadlineMs}ms.\nLogs so far:\n${getLogs()}`);
}

async function waitForHealthy(port: number, deadlineMs: number): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  let lastStatus = -1;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      lastStatus = response.status;
      if (response.status === 200) return lastStatus;
    } catch {
      // server not accepting connections yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return lastStatus;
}

describe('daemon (real child process — slow, not part of the fast suite)', () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let stateDir: string | undefined;

  afterEach(() => {
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    child = undefined;
    stateDir = undefined;
  });

  it('starts, serves a healthy /healthz, and exits 0 promptly on SIGTERM', async () => {
    if (!fs.existsSync(DAEMON_ENTRY)) {
      throw new Error(`${DAEMON_ENTRY} not found. Run "npm run build:daemon" first (this is what "pretest:integration" does).`);
    }

    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackwatch-daemon-it-'));
    const logChunks: string[] = [];

    child = spawn('node', [DAEMON_ENTRY], {
      env: {
        ...process.env,
        SLACK_WEBHOOK: 'https://hooks.slack.com/services/T000/B000/integration-test-placeholder',
        VENDORS: 'clickhouse',
        STATE_FILE_PATH: path.join(stateDir, 'state.json'),
        HEALTH_PORT: '0',
      },
      stdio: 'pipe',
    });
    child.stdout.on('data', (chunk: Buffer) => logChunks.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => logChunks.push(chunk.toString()));
    const getLogs = () => logChunks.join('');

    const port = await waitForBoundPort(getLogs, 10_000);
    const status = await waitForHealthy(port, 10_000);
    expect(status, `daemon logs:\n${getLogs()}`).toBe(200);

    const exitCodePromise = new Promise<number | null>((resolve) => child?.once('exit', (code) => resolve(code)));
    const killedAt = Date.now();
    child.kill('SIGTERM');
    const exitCode = await exitCodePromise;

    expect(exitCode, `daemon logs:\n${getLogs()}`).toBe(0);
    expect(Date.now() - killedAt).toBeLessThan(10_000);
  }, 25_000);
});
