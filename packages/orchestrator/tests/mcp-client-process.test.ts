import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { McpClient } from '../src/mcp-client.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-process-'));
}

const INITIALIZE_REPLY = `
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
    } }) + '\\n');
  }
`;

// The exact process the client spawned, so a test can observe the turn that reaps it.
function spawnedServer(client: McpClient): ChildProcess | null {
  return (client as unknown as { proc: ChildProcess | null }).proc;
}

function serverProcess(client: McpClient): ChildProcess {
  const proc = spawnedServer(client);
  if (!proc?.pid) throw new Error('McpClient has no spawned server process');
  return proc;
}

// Once `server` is reaped its group number can be reissued. Any later signal for
// that number is recorded and delivered to `standIn`, an unrelated group leader,
// as it would be if that leader now held the number. The listener is registered
// after the client's own, so work the client does inside its exit listener is
// not counted; anything after it is.
function redirectSignalsAfterReap(server: ChildProcess, standIn: ChildProcess): string[] {
  const groupNumber = server.pid!;
  const late: string[] = [];
  let reaped = false;
  server.on('exit', () => { reaped = true; });
  const realKill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
    if (target === -groupNumber && reaped) {
      late.push(String(signal));
      return realKill(-standIn.pid!, signal);
    }
    return realKill(target, signal);
  });
  return late;
}

function spawnUnrelatedGroupLeader(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { detached: true, stdio: 'ignore' });
}

function isZombie(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat[stat.lastIndexOf(')') + 2] === 'Z';
    } catch {
      return false;
    }
  }
  return spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().startsWith('Z');
}

// Holds the event loop: an exited child stays unreaped until the loop polls again.
function holdEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killError(code: 'EPERM'): NodeJS.ErrnoException {
  return Object.assign(new Error(`kill ${code}`), { code, errno: -1, syscall: 'kill' });
}

function isUnreaped(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

async function waitForFile(filePath: string, timeoutMs = 4_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function writeServer(filePath: string, body: string): void {
  fs.writeFileSync(filePath, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    import { spawn } from 'node:child_process';
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      ${body}
    });
  `);
}

describe('McpClient subprocess containment', () => {
  const tmpDirs: string[] = [];
  const originalCanary = process.env.NULLIUS_AMBIENT_CANARY;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCanary === undefined) delete process.env.NULLIUS_AMBIENT_CANARY;
    else process.env.NULLIUS_AMBIENT_CANARY = originalCanary;
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('validates maxReconnects as a non-negative safe integer at construction', () => {
    expect(() => new McpClient({ maxReconnects: 0 })).not.toThrow();
    expect(() => new McpClient({ maxReconnects: Number.MAX_SAFE_INTEGER })).not.toThrow();

    for (const maxReconnects of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new McpClient({ maxReconnects })).toThrow(
        new RangeError('McpClient maxReconnects must be a non-negative safe integer'),
      );
    }
  });

  it('passes only the controlled baseline plus declared config and credentials', async () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const resultPath = path.join(tmpDir, 'environment.json');
    process.env.NULLIUS_AMBIENT_CANARY = 'must-not-cross';
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({
          ambient: process.env.NULLIUS_AMBIENT_CANARY ?? null,
          config: process.env.SERVER_MODE ?? null,
          credential: process.env.TEST_API_KEY ?? null,
          home: process.env.HOME ?? null,
          cwd: process.cwd(),
        }));
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
    await client.start(process.execPath, [scriptPath], {
      configEnv: { RESULT_PATH: resultPath, SERVER_MODE: 'isolated' },
      credentials: { TEST_API_KEY: 'declared-secret' },
      cwd: fs.realpathSync(tmpDir),
    });
    const result = JSON.parse(await waitForFile(resultPath)) as Record<string, unknown>;
    await client.close();

    expect(result).toMatchObject({
      ambient: null,
      config: 'isolated',
      credential: 'declared-secret',
      cwd: fs.realpathSync(tmpDir),
    });
    expect(result.home).not.toBe(os.homedir());
  });

  it('rejects loader injection and credential/config channel confusion without echoing values', async () => {
    const client = new McpClient();
    await expect(client.start(process.execPath, ['unused'], {
      configEnv: { NODE_OPTIONS: 'secret-loader-value' },
    })).rejects.toThrow('MCP config environment rejects dangerous key: NODE_OPTIONS');
    await expect(client.close()).resolves.toBeUndefined();

    const second = new McpClient();
    await expect(second.start(process.execPath, ['unused'], {
      configEnv: { TEST_API_KEY: 'secret-api-value' },
    })).rejects.toThrow('MCP credential-like key must be supplied through credentials: TEST_API_KEY');
    await expect(second.close()).resolves.toBeUndefined();
  });

  it('accepts explicitly declared credentials whose names are not heuristic secret names', async () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const resultPath = path.join(tmpDir, 'credential.json');
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({ databaseUrl: process.env.DATABASE_URL }));
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
    await client.start(process.execPath, [scriptPath], {
      configEnv: { RESULT_PATH: resultPath },
      credentials: { DATABASE_URL: 'postgres://declared-only' },
      requiredCredentialNames: ['DATABASE_URL'],
      cwd: tmpDir,
    });
    expect(JSON.parse(await waitForFile(resultPath))).toEqual({ databaseUrl: 'postgres://declared-only' });
    await client.close();
  });

  it('does not inherit proxy URLs containing credentials', async () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const resultPath = path.join(tmpDir, 'proxy.json');
    const originalProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://proxy-user:proxy-password@127.0.0.1:7890';
    try {
      writeServer(scriptPath, `
        if (msg.method === 'initialize') {
          fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({ proxy: process.env.HTTPS_PROXY ?? null }));
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
            protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
          } }) + '\\n');
        }
      `);
      const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
      await client.start(process.execPath, [scriptPath], {
        configEnv: { RESULT_PATH: resultPath },
        cwd: tmpDir,
      });
      expect(JSON.parse(await waitForFile(resultPath))).toEqual({ proxy: null });
      await client.close();
    } finally {
      if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = originalProxy;
    }
  });

  it('fails before spawn when a declared server credential is missing or empty', async () => {
    const client = new McpClient();
    await expect(client.start(process.execPath, ['must-not-run'], {
      credentials: {},
      requiredCredentialNames: ['OPENALEX_API_KEY'],
    })).rejects.toThrow('MCP required credential is missing: OPENALEX_API_KEY');
    await client.close();

    const second = new McpClient();
    await expect(second.start(process.execPath, ['must-not-run'], {
      credentials: { OPENALEX_API_KEY: '' },
      requiredCredentialNames: ['OPENALEX_API_KEY'],
    })).rejects.toThrow('MCP required credential is missing: OPENALEX_API_KEY');
    await second.close();
  });

  it('cleans the process group when initialization fails', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const sentinelPath = path.join(tmpDir, 'late-init-sentinel');
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        spawn(process.execPath, ['-e', \`setTimeout(() => require('fs').writeFileSync(\${JSON.stringify(process.env.SENTINEL_PATH)}, 'late'), 350)\`]);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '1999-01-01', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
    await expect(client.start(process.execPath, [scriptPath], {
      configEnv: { SENTINEL_PATH: sentinelPath },
      cwd: tmpDir,
    })).rejects.toThrow('unsupported protocol version');
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it('makes a timed-out client unusable and kills child and grandchild work', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const sentinelPath = path.join(tmpDir, 'late-call-sentinel');
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
      if (msg.method === 'tools/call') {
        spawn(process.execPath, ['-e', \`setTimeout(() => require('fs').writeFileSync(\${JSON.stringify(process.env.SENTINEL_PATH)}, 'late'), 350)\`]);
      }
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20, maxReconnects: 3 });
    await client.start(process.execPath, [scriptPath], {
      configEnv: { SENTINEL_PATH: sentinelPath },
      cwd: tmpDir,
    });
    await expect(client.callTool('hang', {}, 30)).rejects.toThrow('client is unusable');
    expect(client.isConnected).toBe(false);
    await expect(client.callTool('retry', {})).rejects.toThrow('not initialized');
    await client.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it('cleans the exited server process group before reconnecting', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const generationPath = path.join(tmpDir, 'generation');
    const sentinelPath = path.join(tmpDir, 'orphan-sentinel');
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
      if (msg.method === 'notifications/initialized' && !fs.existsSync(process.env.GENERATION_PATH)) {
        fs.writeFileSync(process.env.GENERATION_PATH, 'first');
        spawn(process.execPath, ['-e', \`setTimeout(() => require('fs').writeFileSync(\${JSON.stringify(process.env.SENTINEL_PATH)}, 'orphan'), 500)\`]);
        process.exit(0);
      }
    `);
    const client = new McpClient({
      shutdownGraceMs: 20,
      killGraceMs: 20,
      maxReconnects: 1,
      reconnectPolicy: { baseDelayMs: 10, maxDelayMs: 10 },
    });
    await client.start(process.execPath, [scriptPath], {
      configEnv: { GENERATION_PATH: generationPath, SENTINEL_PATH: sentinelPath },
      cwd: tmpDir,
    });
    await waitForFile(generationPath);
    const reconnectDeadline = Date.now() + 2_000;
    while (!client.isConnected && Date.now() < reconnectDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(client.isConnected).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(fs.existsSync(sentinelPath)).toBe(false);
    await client.close();
  });

  it('bounds repeated post-initialize crashes across successful reconnects', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const countPath = path.join(tmpDir, 'starts');
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
      if (msg.method === 'notifications/initialized') {
        const count = fs.existsSync(process.env.COUNT_PATH)
          ? Number(fs.readFileSync(process.env.COUNT_PATH, 'utf8'))
          : 0;
        fs.writeFileSync(process.env.COUNT_PATH, String(count + 1));
        process.exit(0);
      }
    `);
    const client = new McpClient({
      shutdownGraceMs: 20,
      killGraceMs: 20,
      maxReconnects: 2,
      reconnectPolicy: { baseDelayMs: 10, maxDelayMs: 10 },
    });
    await client.start(process.execPath, [scriptPath], {
      configEnv: { COUNT_PATH: countPath },
      cwd: tmpDir,
    });
    const deadline = Date.now() + 2_000;
    while ((!fs.existsSync(countPath) || fs.readFileSync(countPath, 'utf8') !== '3') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(fs.readFileSync(countPath, 'utf8')).toBe('3');
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(fs.readFileSync(countPath, 'utf8')).toBe('3');
    expect(client.isConnected).toBe(false);
    await expect(client.callTool('retry', {})).rejects.toThrow('not initialized');
    await client.close();
  });

  it('closes idempotently', async () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
    await client.start(process.execPath, [scriptPath], { cwd: tmpDir });
    await Promise.all([client.close(), client.close()]);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('closes cleanly when the server has exited but is not yet reaped as its grace period ends', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    writeServer(scriptPath, `${INITIALIZE_REPLY}
      if (msg.method === 'test/exit') process.exit(0);
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20, maxReconnects: 0 });
    await client.start(process.execPath, [scriptPath], { cwd: tmpDir });
    const server = serverProcess(client);
    const pid = server.pid!;
    const realKill = process.kill.bind(process);
    let signalsToExitedUnreapedGroup = 0;
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === -pid && isUnreaped(server) && isZombie(pid)) {
        signalsToExitedUnreapedGroup += 1;
        // macOS refuses a signal to a group whose members have all exited
        // (EPERM); Linux accepts it. Give other kernels the macOS answer.
        if (process.platform !== 'darwin') throw killError('EPERM');
      }
      return realKill(target, signal);
    });
    // Inside one held callback the server exits, close() arms its 20 ms grace
    // timer, and the timer falls due. libuv serves due timers before it polls
    // again, so the grace period ends before the exit can be reaped.
    const { closing } = await new Promise<{ closing: Promise<void> }>((resolve, reject) => setImmediate(() => {
      try {
        void client.request('test/exit', {}, 5_000).catch(() => undefined);
        const deadline = Date.now() + 10_000;
        while (!isZombie(pid)) {
          if (Date.now() > deadline) throw new Error('server did not exit');
          holdEventLoop(5);
        }
        const closing = client.close();
        holdEventLoop(60);
        resolve({ closing });
      } catch (error) {
        reject(error);
      }
    }));
    await expect(closing).resolves.toBeUndefined();
    expect(signalsToExitedUnreapedGroup).toBeGreaterThan(0);
    expect(isUnreaped(server)).toBe(false);
  });

  it('does not signal a reaped server group number while draining before a reconnect', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const generationPath = path.join(tmpDir, 'generation');
    writeServer(scriptPath, `${INITIALIZE_REPLY}
      if (msg.method === 'notifications/initialized' && !fs.existsSync(process.env.GENERATION_PATH)) {
        fs.writeFileSync(process.env.GENERATION_PATH, 'first');
        process.exit(0);
      }
    `);
    const unrelated = spawnUnrelatedGroupLeader();
    const client = new McpClient({
      shutdownGraceMs: 20,
      killGraceMs: 20,
      maxReconnects: 1,
      reconnectPolicy: { baseDelayMs: 50, maxDelayMs: 50 },
    });
    try {
      await client.start(process.execPath, [scriptPath], {
        configEnv: { GENERATION_PATH: generationPath },
        cwd: tmpDir,
      });
      const first = serverProcess(client);
      const lateSignals = redirectSignalsAfterReap(first, unrelated);
      const deadline = Date.now() + 5_000;
      while (!(client.isConnected && spawnedServer(client) !== first) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(client.isConnected).toBe(true);
      await client.close();
      expect(lateSignals).toEqual([]);
      expect(isUnreaped(unrelated)).toBe(true);
    } finally {
      unrelated.kill('SIGKILL');
    }
  });

  it('does not signal a reaped server group number when closed before reconnecting', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    writeServer(scriptPath, `${INITIALIZE_REPLY}
      if (msg.method === 'notifications/initialized') process.exit(0);
    `);
    const unrelated = spawnUnrelatedGroupLeader();
    const client = new McpClient({
      shutdownGraceMs: 20,
      killGraceMs: 20,
      maxReconnects: 1,
      reconnectPolicy: { baseDelayMs: 1_000, maxDelayMs: 1_000 },
    });
    try {
      await client.start(process.execPath, [scriptPath], { cwd: tmpDir });
      const first = serverProcess(client);
      const lateSignals = redirectSignalsAfterReap(first, unrelated);
      const deadline = Date.now() + 5_000;
      while (isUnreaped(first) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(isUnreaped(first)).toBe(false);
      await client.close();
      expect(lateSignals).toEqual([]);
      expect(isUnreaped(unrelated)).toBe(true);
    } finally {
      unrelated.kill('SIGKILL');
    }
  });

  it('kills descendants that ignore SIGTERM when the server exits on its own', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const readyPath = path.join(tmpDir, 'descendant-ready');
    const sentinelPath = path.join(tmpDir, 'descendant-sentinel');
    writeServer(scriptPath, `${INITIALIZE_REPLY}
      if (msg.method === 'notifications/initialized') {
        spawn(process.execPath, ['-e', \`
          const fs = require('fs');
          process.on('SIGTERM', () => {});
          fs.writeFileSync(\${JSON.stringify(process.env.READY_PATH)}, 'ready');
          setTimeout(() => fs.writeFileSync(\${JSON.stringify(process.env.SENTINEL_PATH)}, 'survived'), 800);
        \`], { stdio: 'ignore' }).unref();
      }
      if (msg.method === 'test/exit') process.exit(0);
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20, maxReconnects: 0 });
    await client.start(process.execPath, [scriptPath], {
      configEnv: { READY_PATH: readyPath, SENTINEL_PATH: sentinelPath },
      cwd: tmpDir,
    });
    await waitForFile(readyPath);
    await expect(client.request('test/exit', {}, 5_000)).rejects.toThrow('MCP process exited');
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(fs.existsSync(sentinelPath)).toBe(false);
    await client.close();
  });

  it('reports a running server whose process group refuses its signals', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    writeServer(scriptPath, `${INITIALIZE_REPLY}
      if (msg.method === 'initialize') setInterval(() => {}, 1_000);
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20, maxReconnects: 0 });
    await client.start(process.execPath, [scriptPath], { cwd: tmpDir });
    const server = serverProcess(client);
    const pid = server.pid!;
    const realKill = process.kill.bind(process);
    // As if the server ran under credentials this process may not signal.
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === -pid || target === pid) throw killError('EPERM');
      return realKill(target, signal);
    });
    try {
      await expect(client.close()).rejects.toMatchObject({ code: 'EPERM' });
      expect(isUnreaped(server)).toBe(true);
    } finally {
      vi.restoreAllMocks();
      if (isUnreaped(server)) {
        const exited = new Promise(resolve => server.once('exit', resolve));
        // Still unreaped, so the number is this server's group.
        process.kill(-pid, 'SIGKILL');
        await exited;
      }
    }
  });
});
