import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GATED_ENV = ['VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID', 'NODE_ENV', 'ARXIV_DATA_DIR'] as const;

describe('shared rate-limit state files', () => {
  const fetchSpy = vi.fn();
  const saved: Partial<Record<(typeof GATED_ENV)[number], string>> = {};
  let dataDir: string;
  let outside: string;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    for (const key of GATED_ENV) saved[key] = process.env[key];
    // Leave the test-environment shortcut, so the shared gate really runs.
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    delete process.env.VITEST_POOL_ID;
    process.env.NODE_ENV = 'production';
    dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-state-writes-')));
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-state-outside-')));
    process.env.ARXIV_DATA_DIR = dataDir;
  });

  afterEach(() => {
    for (const key of GATED_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('replaces links at the state file names instead of writing through them', async () => {
    // The default state dir lies under the shared system temp dir, where
    // another account could have left a link at these fixed names.
    const stateDir = path.join(dataDir, 'rate-limit');
    fs.mkdirSync(stateDir, { recursive: true });
    const victims = ['last-acquire', 'backoff'].map(name => path.join(outside, name));
    for (const victim of victims) fs.writeFileSync(victim, 'ORIGINAL');
    const timestampFile = path.join(stateDir, 'api-query.last-acquire-ms');
    const backoffFile = path.join(stateDir, 'api-query.backoff-until-ms');
    const plantLink = process.platform === 'win32' ? fs.linkSync : fs.symlinkSync;
    plantLink(victims[0], timestampFile);
    plantLink(victims[1], backoffFile);
    fetchSpy.mockImplementation(async () => new Response('{}', { status: 200 }));

    const { arxivFetch, __testing__ } = await import('../src/api/rateLimiter.js');
    await arxivFetch('https://export.arxiv.org/api/query?max_results=1');
    await __testing__.recordSharedBackoff(5000);

    for (const victim of victims) expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    for (const stateFile of [timestampFile, backoffFile]) {
      expect(fs.lstatSync(stateFile).isFile()).toBe(true);
      expect(Number(fs.readFileSync(stateFile, 'utf-8'))).toBeGreaterThan(0);
    }
    expect(fs.readdirSync(stateDir).filter(name => name.includes('.tmp.'))).toEqual([]);
  });
});
