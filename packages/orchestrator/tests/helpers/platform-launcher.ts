import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ensureWindowsProjectLocalNulliusLauncher,
  renderManagedWindowsCommand,
  renderWindowsProjectLocalLauncher,
} from '../../src/project-local-nullius-windows.js';

export const PROJECT_STATUS_COMMAND = `.nullius/bin/nullius${process.platform === 'win32' ? '.ps1' : ''} status --json`;
export const PROJECT_LAUNCHER = process.platform === 'win32' ? 'nullius.cjs' : 'nullius';
export const EMPTY_COMMAND_PATH = process.platform === 'win32' ? 'C:\\nullius-test-no-commands' : '/usr/bin:/bin';

export function execProjectLauncher(file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding): string {
  return process.platform === 'win32'
    ? execFileSync(process.execPath, [file, ...args], options)
    : execFileSync(file, args, options);
}

export function replaceBakedCli(file: string, replacement?: string): void {
  const source = fs.readFileSync(file, 'utf8');
  if (process.platform === 'win32') {
    const argv = JSON.parse(source.split('\n', 1)[0]!.slice('const BAKED_ARGV = '.length, -1)) as string[];
    argv[1] = replacement ?? `${argv[1]}.gone`;
    fs.writeFileSync(file, renderWindowsProjectLocalLauncher(argv));
  } else {
    const match = source.match(/'(\/[^']*dist\/cli\.js)'/u);
    if (!match) throw new Error('fixture did not contain its baked CLI');
    fs.writeFileSync(file, source.replaceAll(match[1]!, replacement ?? `${match[1]}.gone`));
  }
}

export function writePathCandidate(directory: string, shellSource: string, javascript: string): string {
  fs.mkdirSync(directory, {recursive:true});
  const file = path.join(directory, process.platform === 'win32' ? 'nullius.cmd' : 'nullius');
  if (process.platform === 'win32') {
    const entry = path.join(directory, 'candidate.cjs');
    fs.writeFileSync(entry, javascript);
    fs.writeFileSync(file, renderManagedWindowsCommand([process.execPath, entry]));
  } else {
    fs.writeFileSync(file, shellSource);
    fs.chmodSync(file, 0o755);
  }
  return file;
}

export function writeHealthFixture(file: string, shellSource: string, _encoding?: BufferEncoding): void {
  if (process.platform !== 'win32') {
    fs.writeFileSync(file, shellSource);
    return;
  }
  const root = path.resolve(path.dirname(file), '../..');
  ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, path.join(root, 'deleted-checkout/dist/cli.js')]);
  if (!shellSource.includes('case "$_nullius_dir" in /*) ;; *) continue;; esac')) {
    // Preserve the malformed/unguarded fixture's health refusal on the native
    // exact-source validator; never turn a bad fixture into a valid launcher.
    fs.appendFileSync(file, '\nthrow new Error("unrecognized fixture resolver");\n');
  } else if (shellSource.indexOf('if [ -n "$RESOLVED_NULLIUS" ]') < shellSource.indexOf('RESOLVED_NULLIUS=')) {
    fs.appendFileSync(file, '\nthrow new Error("relocated fixture resolver");\n');
  }
}
