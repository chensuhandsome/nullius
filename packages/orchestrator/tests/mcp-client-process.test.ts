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

const realKill = process.kill.bind(process);

// Signal 0 reaches a zombie too, so this is false only once the pid is reaped.
function processExists(pid: number): boolean {
  try {
    realKill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function processAlive(pid: number): boolean {
  return processExists(pid) && !isZombie(pid);
}

// A signal for `groupNumber` is late once no process holds that pid: the
// process that led the group has been reaped, and only descendants, which the
// client cannot observe, could still keep the number from being reissued. Each
// late signal is recorded and delivered to `standIn`, an unrelated group
// leader, as it would be if that leader had been given the number. A reissued
// pid could hide a late signal, but reissuing takes the kernel a full cycle of
// its pid space, far longer than these tests run.
function redirectSignalsAfterReap(groupNumber: number, standIn: ChildProcess): string[] {
  const late: string[] = [];
  vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
    if (target === -groupNumber && !processExists(groupNumber)) {
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

// The writer creates the file before it writes the number, so wait for the number.
async function waitForPid(filePath: string, timeoutMs = 4_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    if (/^[1-9][0-9]*$/.test(text)) return Number(text);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for a pid in ${filePath}`);
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

  it('rejects start instead of failing the host when the anchor dies before reading its environment', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    writeServer(scriptPath, INITIALIZE_REPLY);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
    const uncaught: unknown[] = [];
    const recordUncaught = (error: unknown) => { uncaught.push(error); };
    process.on('uncaughtException', recordUncaught);
    try {
      // Larger than a pipe buffer, so most of the line is still queued when
      // the anchor dies and the rest of the write fails with EPIPE.
      const starting = client.start(process.execPath, [scriptPath], {
        configEnv: { LARGE_SETTING: 'x'.repeat(1 << 20) },
        cwd: tmpDir,
      });
      realKill(serverProcess(client).pid!, 'SIGKILL');
      await expect(starting).rejects.toThrow('MCP process exited');
      await new Promise(resolve => setImmediate(resolve));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', recordUncaught);
    }
  });

  it('fails pending and later requests with the pipe failure, and keeps the host alive, when the server side dies under a large write', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const pidPath = path.join(tmpDir, 'server-pid');
    writeServer(scriptPath, `${INITIALIZE_REPLY}
      if (msg.method === 'initialize') fs.writeFileSync(process.env.PID_PATH, String(process.pid));
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
    const uncaught: unknown[] = [];
    const recordUncaught = (error: unknown) => { uncaught.push(error); };
    process.on('uncaughtException', recordUncaught);
    try {
      await client.start(process.execPath, [scriptPath], { configEnv: { PID_PATH: pidPath }, cwd: tmpDir });
      const serverPid = await waitForPid(pidPath);
      const groupNumber = serverProcess(client).pid!;
      // Kill the whole server-side tree, hold the event loop until nothing can
      // read the server's stdin, then send about 1 MiB: the write fails with
      // EPIPE before this process has reaped or read anything about the deaths.
      const { pending } = await new Promise<{ pending: Promise<unknown> }>((resolve, reject) => setImmediate(() => {
        try {
          realKill(-groupNumber, 'SIGKILL');
          const deadline = Date.now() + 10_000;
          while (!(isZombie(groupNumber) && !processAlive(serverPid))) {
            if (Date.now() > deadline) throw new Error('server side did not exit');
            holdEventLoop(5);
          }
          const pending = client.request('test/large', { blob: 'x'.repeat(1 << 20) }, 5_000);
          pending.catch(() => undefined);
          resolve({ pending });
        } catch (error) {
          reject(error);
        }
      }));
      const outcome = await pending.then(() => null, (error: Error) => error);
      expect(uncaught).toEqual([]);
      expect(outcome?.message).toMatch(/^MCP transport failed on stdin: /);
      expect(['EPIPE', 'ECONNRESET']).toContain((outcome?.cause as NodeJS.ErrnoException | undefined)?.code);
      await expect(client.request('test/again', {}, 5_000)).rejects.toThrow(/^MCP transport failed on stdin: /);
    } finally {
      process.off('uncaughtException', recordUncaught);
      await client.close();
    }
  });

  it('fails pending and later requests with a read failure on the server stdout', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    writeServer(scriptPath, INITIALIZE_REPLY);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
    const uncaught: unknown[] = [];
    const recordUncaught = (error: unknown) => { uncaught.push(error); };
    process.on('uncaughtException', recordUncaught);
    try {
      await client.start(process.execPath, [scriptPath], { cwd: tmpDir });
      const pending = client.request('test/unanswered', {}, 5_000);
      pending.catch(() => undefined);
      serverProcess(client).stdout!.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      const outcome = await pending.then(() => null, (error: Error) => error);
      expect(uncaught).toEqual([]);
      expect(outcome?.message).toBe('MCP transport failed on stdout: read ECONNRESET; client is unusable');
      await expect(client.request('test/again', {}, 5_000)).rejects.toThrow(/^MCP transport failed on stdout: /);
    } finally {
      process.off('uncaughtException', recordUncaught);
      await client.close();
    }
  });

  it('closes cleanly when the server has exited but nothing is reaped yet as its grace period ends', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const pidPath = path.join(tmpDir, 'server-pid');
    writeServer(scriptPath, `${INITIALIZE_REPLY}
      if (msg.method === 'initialize') fs.writeFileSync(process.env.PID_PATH, String(process.pid));
      if (msg.method === 'test/exit') process.exit(0);
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20, maxReconnects: 0 });
    await client.start(process.execPath, [scriptPath], { configEnv: { PID_PATH: pidPath }, cwd: tmpDir });
    const serverPid = await waitForPid(pidPath);
    const groupNumber = serverProcess(client).pid!;
    let groupSignalsAfterServerExit = 0;
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === -groupNumber) {
        if (!processAlive(serverPid)) groupSignalsAfterServerExit += 1;
        // macOS refuses a signal to a group whose members have all exited
        // (EPERM); Linux accepts it. The members here are the spawned process
        // and the server, so give other kernels the macOS answer when the
        // spawned process is a zombie.
        if (process.platform !== 'darwin' && isZombie(groupNumber)) throw killError('EPERM');
      }
      return realKill(target, signal);
    });
    // Inside one held callback the server exits, close() arms its 20 ms grace
    // timer, and the timer falls due. libuv serves due timers before it polls
    // again, so the grace period ends before this process can reap anything
    // or read anything about the exit.
    const { closing } = await new Promise<{ closing: Promise<void> }>((resolve, reject) => setImmediate(() => {
      try {
        void client.request('test/exit', {}, 5_000).catch(() => undefined);
        const deadline = Date.now() + 10_000;
        while (processAlive(serverPid)) {
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
    expect(groupSignalsAfterServerExit).toBeGreaterThan(0);
  });

  it('does not signal the group number after its leader is reaped while draining before a reconnect', async () => {
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
      const lateSignals = redirectSignalsAfterReap(first.pid!, unrelated);
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

  it('does not signal the group number after its leader is killed from outside and reaped', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    writeServer(scriptPath, INITIALIZE_REPLY);
    const unrelated = spawnUnrelatedGroupLeader();
    const client = new McpClient({
      shutdownGraceMs: 20,
      killGraceMs: 20,
      maxReconnects: 1,
      reconnectPolicy: { baseDelayMs: 1_000, maxDelayMs: 1_000 },
    });
    try {
      await client.start(process.execPath, [scriptPath], { cwd: tmpDir });
      const leader = serverProcess(client);
      const lateSignals = redirectSignalsAfterReap(leader.pid!, unrelated);
      realKill(leader.pid!, 'SIGKILL');
      const deadline = Date.now() + 5_000;
      while (isUnreaped(leader) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(isUnreaped(leader)).toBe(false);
      await client.close();
      expect(lateSignals).toEqual([]);
      expect(isUnreaped(unrelated)).toBe(true);
    } finally {
      unrelated.kill('SIGKILL');
    }
  });

  it('does not signal from inside a reaping pass that has already reaped the group leader', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    writeServer(scriptPath, INITIALIZE_REPLY);
    const unrelated = spawnUnrelatedGroupLeader();
    // Spawned before the client's process, so when both exit libuv reaps both
    // in one pass and runs this one's exit callback first.
    const neighbour = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20, maxReconnects: 0 });
    try {
      await client.start(process.execPath, [scriptPath], { cwd: tmpDir });
      const leader = serverProcess(client);
      const groupNumber = leader.pid!;
      const lateSignals = redirectSignalsAfterReap(groupNumber, unrelated);
      let leaderReapedWithCallbackPending = false;
      const closed = new Promise<void>((resolve, reject) => {
        neighbour.once('exit', () => {
          leaderReapedWithCallbackPending = isUnreaped(leader) && !processExists(groupNumber);
          client.close().then(resolve, reject);
        });
      });
      await new Promise<void>((resolve, reject) => setImmediate(() => {
        try {
          realKill(neighbour.pid!, 'SIGKILL');
          realKill(groupNumber, 'SIGKILL');
          const deadline = Date.now() + 10_000;
          while (!(isZombie(neighbour.pid!) && isZombie(groupNumber))) {
            if (Date.now() > deadline) throw new Error('processes did not exit');
            holdEventLoop(5);
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      }));
      await closed;
      expect(leaderReapedWithCallbackPending).toBe(true);
      expect(lateSignals).toEqual([]);
      expect(isUnreaped(unrelated)).toBe(true);
    } finally {
      unrelated.kill('SIGKILL');
      neighbour.kill('SIGKILL');
    }
  });

  it('does not signal from inside a reaping pass when the server exit was already handled', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    writeServer(scriptPath, `${INITIALIZE_REPLY}
      if (msg.method === 'test/exit') process.exit(0);
    `);
    const unrelated = spawnUnrelatedGroupLeader();
    // Spawned before the client's process, so when both exit libuv reaps both
    // in one pass and runs this one's exit callback first.
    const neighbour = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });
    // A long backoff keeps the exited server's group waiting for the drain.
    const client = new McpClient({
      shutdownGraceMs: 20,
      killGraceMs: 20,
      maxReconnects: 1,
      reconnectPolicy: { baseDelayMs: 10_000, maxDelayMs: 10_000 },
    });
    try {
      await client.start(process.execPath, [scriptPath], { cwd: tmpDir });
      const leader = serverProcess(client);
      const groupNumber = leader.pid!;
      const lateSignals = redirectSignalsAfterReap(groupNumber, unrelated);
      await expect(client.request('test/exit', {}, 5_000)).rejects.toThrow('MCP process exited');
      let leaderReapedWithCallbackPending = false;
      const closed = new Promise<void>((resolve, reject) => {
        neighbour.once('exit', () => {
          leaderReapedWithCallbackPending = isUnreaped(leader) && !processExists(groupNumber);
          client.close().then(resolve, reject);
        });
      });
      await new Promise<void>((resolve, reject) => setImmediate(() => {
        try {
          realKill(neighbour.pid!, 'SIGKILL');
          realKill(groupNumber, 'SIGKILL');
          const deadline = Date.now() + 10_000;
          while (!(isZombie(neighbour.pid!) && isZombie(groupNumber))) {
            if (Date.now() > deadline) throw new Error('processes did not exit');
            holdEventLoop(5);
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      }));
      await closed;
      expect(leaderReapedWithCallbackPending).toBe(true);
      expect(lateSignals).toEqual([]);
      expect(isUnreaped(unrelated)).toBe(true);
    } finally {
      unrelated.kill('SIGKILL');
      neighbour.kill('SIGKILL');
    }
  });

  it('stops descendants that ignore SIGTERM, after SIGTERM, when the server exits on its own', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const readyPath = path.join(tmpDir, 'descendant-pid');
    const termPath = path.join(tmpDir, 'descendant-got-sigterm');
    writeServer(scriptPath, `${INITIALIZE_REPLY}
      if (msg.method === 'notifications/initialized') {
        spawn(process.execPath, ['-e', \`
          const fs = require('fs');
          process.on('SIGTERM', () => fs.writeFileSync(\${JSON.stringify(process.env.TERM_PATH)}, 'term'));
          fs.writeFileSync(\${JSON.stringify(process.env.READY_PATH)}, String(process.pid));
          setInterval(() => {}, 1_000);
        \`], { stdio: 'ignore' }).unref();
      }
      if (msg.method === 'test/exit') process.exit(0);
    `);
    // A wide grace gives the descendant time to record the SIGTERM before the SIGKILL.
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 1_000, maxReconnects: 0 });
    let descendantPid: number | undefined;
    try {
      await client.start(process.execPath, [scriptPath], {
        configEnv: { READY_PATH: readyPath, TERM_PATH: termPath },
        cwd: tmpDir,
      });
      descendantPid = await waitForPid(readyPath);
      await expect(client.request('test/exit', {}, 5_000)).rejects.toThrow('MCP process exited');
      const deadline = Date.now() + 5_000;
      while (processAlive(descendantPid) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(processAlive(descendantPid)).toBe(false);
      expect(fs.existsSync(termPath)).toBe(true);
      await client.close();
    } finally {
      if (descendantPid !== undefined && processAlive(descendantPid)) realKill(descendantPid, 'SIGKILL');
    }
  });
});
