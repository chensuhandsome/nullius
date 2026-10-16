import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeExecutableCandidates, pythonExecutable } from './python-runtime.js';

function runtimeRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

function helper(): string {
  const filename = path.join(runtimeRoot(), 'packages/shared/dist/python/nullius_windows/process.py');
  if (!fs.statSync(filename).isFile()) throw new Error('Windows process support is missing from the installed runtime');
  return filename;
}

/** Only the canonical project MCP can deliberately hand durable work off. */
export function isProjectMcpProcess(command: string, args: string[]): boolean {
  const candidates = path.isAbsolute(command) ? [command]
    : nativeExecutableCandidates(command, (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute));
  const executable = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!executable || fs.realpathSync.native(executable).toLowerCase() !== fs.realpathSync.native(process.execPath).toLowerCase()) return false;
  const root = runtimeRoot();
  const same = (value: string | undefined, relative: string) => value !== undefined
    && path.resolve(value).toLowerCase() === path.join(root, relative).toLowerCase();
  return (args.length === 1 && same(args[0], 'packages/project-mcp/dist/index.js'))
    || (args.length === 4 && same(args[0], 'packages/orchestrator/dist/cli.js')
      && args.slice(1).join(' ') === 'runtime mcp project-mcp');
}

export function spawnWindowsJobProcess(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; mode?: 'mcp' | 'run'; shutdownGraceMs?: number;
  allowDeliveryBreakaway?: boolean;
}): ChildProcess {
  if (process.platform !== 'win32') throw new Error('Windows process support requires Windows');
  const proc = spawn(pythonExecutable(), ['-I', helper(), '--stdio'], {
    cwd: options.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    // Credentials belong only to the target environment sent through stdin.
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  proc.stdin!.on('error', () => {});
  proc.stdin!.write(`${JSON.stringify({
    argv: [command, ...args], cwd: options.cwd, env: options.env,
    parent_pid: process.pid,
    mode: options.mode ?? 'mcp', shutdown_grace_ms: options.shutdownGraceMs ?? 250,
    allow_delivery_breakaway: options.allowDeliveryBreakaway === true && isProjectMcpProcess(command, args),
  })}\n`);
  return proc;
}

/** Its detached bootstrap creates a fresh owned Job and its own deadline. */
export function launchDetachedWindowsDelivery(supervisor: string, requestFile: string, cwd: string): void {
  const result = spawnSync(pythonExecutable(), ['-I', helper(), '--launch-delivery', process.execPath, supervisor, requestFile], {
    cwd, stdio: 'ignore', windowsHide: true, env: process.env, timeout: 10_000,
  });
  // Return the accepted response only after independent ownership exists. A
  // later disconnect must never kill a not-yet-detached handoff bootstrap.
  if (result.error || result.status !== 0) throw new Error('Could not establish the independent Windows delivery supervisor');
}
