import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeBytesAtomicDurable } from '@nullius/shared';
import type { ProjectLocalNulliusLauncherHealth } from './project-local-nullius.js';
import { pythonExecutable } from './python-runtime.js';

const MANAGED_ARGV_PREFIX = '@rem nullius-managed-node-argv ';
const POWERSHELL_ARGV_PREFIX = '# nullius-managed-node-argv ';
const BOOTSTRAP_PREFIX = '# nullius-launcher-bootstrap ';
type WindowsLauncherBootstrap = {python:string; helper:string};

const POWERSHELL_DISPATCH = String.raw`$nulliusStart = New-Object System.Diagnostics.ProcessStartInfo
$nulliusStart.FileName = $nulliusArgv[0]
$nulliusStart.UseShellExecute = $false
$nulliusStart.CreateNoWindow = $true
$nulliusStart.RedirectStandardOutput = $true
$nulliusStart.RedirectStandardError = $true
$nulliusStart.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
$nulliusStart.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
$nulliusArguments = @($nulliusArgv | Select-Object -Skip 1) + @($args)
$nulliusQuoted = foreach ($nulliusArgument in $nulliusArguments) {
  $nulliusValue = [string]$nulliusArgument
  '"' + [regex]::Replace([regex]::Replace($nulliusValue, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
$nulliusStart.Arguments = $nulliusQuoted -join ' '
$nulliusProcess = [System.Diagnostics.Process]::Start($nulliusStart)
$nulliusPreviousEncoding = [Console]::OutputEncoding
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $nulliusOutput = $nulliusProcess.StandardOutput.ReadLineAsync()
  $nulliusError = $nulliusProcess.StandardError.ReadLineAsync()
  $nulliusOutputDone = $false
  $nulliusErrorDone = $false
  while (-not $nulliusOutputDone -or -not $nulliusErrorDone -or -not $nulliusProcess.HasExited) {
    if (-not $nulliusOutputDone -and $nulliusOutput.IsCompleted) {
      $nulliusLine = $nulliusOutput.GetAwaiter().GetResult()
      if ($null -eq $nulliusLine) { $nulliusOutputDone = $true }
      else {
        Write-Output -NoEnumerate $nulliusLine
        $nulliusOutput = $nulliusProcess.StandardOutput.ReadLineAsync()
      }
    }
    if (-not $nulliusErrorDone -and $nulliusError.IsCompleted) {
      $nulliusLine = $nulliusError.GetAwaiter().GetResult()
      if ($null -eq $nulliusLine) { $nulliusErrorDone = $true }
      else {
        [Console]::Error.WriteLine($nulliusLine)
        $nulliusError = $nulliusProcess.StandardError.ReadLineAsync()
      }
    }
    if ($nulliusProcess.HasExited) { Start-Sleep -Milliseconds 10 }
    else { $null = $nulliusProcess.WaitForExit(50) }
  }
  $nulliusExit = $nulliusProcess.ExitCode
} finally {
  if (-not $nulliusProcess.HasExited) {
    $nulliusProcess.Kill()
    $nulliusProcess.WaitForExit()
  }
  $nulliusProcess.Dispose()
  [Console]::OutputEncoding = $nulliusPreviousEncoding
}
exit $nulliusExit
`;

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function launcherBootstrap(): WindowsLauncherBootstrap {
  const configured = pythonExecutable();
  const python = path.isAbsolute(configured) ? configured
    : (process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute).map(directory => path.join(directory, configured))
      .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/dist/python/nullius_windows/process.py');
  if (!python || !fs.existsSync(helper)) throw new Error('Windows launcher requires the installed Python process runtime');
  return {python, helper};
}

function bootstrapInvocation(targets: string[], bootstrap: WindowsLauncherBootstrap): string {
  return `${BOOTSTRAP_PREFIX}${JSON.stringify(bootstrap)}\n$nulliusArgv = @(${[bootstrap.python, '-I', bootstrap.helper, '--cli'].map(powerShellQuote).join(', ')}, [string]$PID, [string]([System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc()), '--', ${targets.join(', ')})\n`;
}

/** A readable Windows shim. PATH dispatch reads this exact shape and calls
 * Node directly, so arguments never pass through an interpolated cmd command. */
export function renderManagedWindowsCommand(argv: string[]): string {
  if (argv.length < 2 || argv.some(arg => /["\r\n\0]/u.test(arg) || !path.isAbsolute(arg))) {
    throw new Error('managed Windows launcher requires absolute Node and entrypoint paths');
  }
  return ['@echo off', `${MANAGED_ARGV_PREFIX}${JSON.stringify(argv)}`,
    'setlocal DisableDelayedExpansion',
    `${argv.map(arg => `"${arg.replaceAll('%', '%%')}"`).join(' ')} %*`, ''].join('\r\n');
}

/** Bypass PowerShell 5.1's legacy native argument marshalling, including
 * empty arguments, embedded quotes, and trailing backslashes. */
export function renderManagedWindowsPowerShell(argv: string[], bootstrap = launcherBootstrap()): string {
  renderManagedWindowsCommand(argv); // shared absolute-argv validation
  return `\ufeff${POWERSHELL_ARGV_PREFIX}${JSON.stringify(argv)}\n${bootstrapInvocation(argv.map(powerShellQuote), bootstrap)}${POWERSHELL_DISPATCH}`;
}

function renderProjectPowerShell(node: string, bootstrap: WindowsLauncherBootstrap): string {
  return `\ufeff# Nullius project-local PowerShell launcher.\n${bootstrapInvocation([powerShellQuote(node), "(Join-Path $PSScriptRoot 'nullius.cjs')"], bootstrap)}${POWERSHELL_DISPATCH}`;
}

// The same resolver is used by dispatch and by the read-only health probe.
// Keep it self-contained: a copied project must not import the old project.
const WINDOWS_LAUNCHER_SOURCE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const GENERATION = '--launcher-generation=2';
const PROTOCOL = '--launcher-protocol';
const BANNER = 'nullius-launcher-protocol 2';
const CMD_PREFIX = '@rem nullius-managed-node-argv ';
const PS_PREFIX = '# nullius-managed-node-argv ';
const BOOTSTRAP_PREFIX = '# nullius-launcher-bootstrap ';
const PS_DISPATCH = POWERSHELL_BODY;
function managedCommand(argv) {
  if (!Array.isArray(argv) || argv.length < 2 || argv.some(arg => typeof arg !== 'string' || /["\r\n\0]/u.test(arg) || !path.isAbsolute(arg))) return null;
  return ['@echo off', CMD_PREFIX + JSON.stringify(argv), 'setlocal DisableDelayedExpansion',
    argv.map(arg => '"' + arg.replaceAll('%', '%%') + '"').join(' ') + ' %*', ''].join('\r\n');
}
function sameFile(left, right) {
  try {
    const a = fs.statSync(left, {bigint:true}), b = fs.statSync(right, {bigint:true});
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}
function commandArgv(candidate) {
  const extension = path.extname(candidate).toLowerCase();
  if (extension === '.cmd' || extension === '.bat' || extension === '.ps1') {
    try {
      const source = fs.readFileSync(candidate, 'utf8');
      const prefix = extension === '.ps1' ? PS_PREFIX : CMD_PREFIX;
      const marker = source.replace(/^\ufeff/u, '').split(/\r?\n/u).find(line => line.startsWith(prefix));
      if (!marker) return null;
      const argv = JSON.parse(marker.slice(prefix.length));
      const command = managedCommand(argv);
      if (!command) return null;
      const bootstrapLine = source.split(/\r?\n/u).find(line => line.startsWith(BOOTSTRAP_PREFIX));
      const bootstrap = extension === '.ps1' && bootstrapLine ? JSON.parse(bootstrapLine.slice(BOOTSTRAP_PREFIX.length)) : null;
      if (extension === '.ps1' && (!bootstrap || Object.keys(bootstrap).sort().join(',') !== 'helper,python'
          || ![bootstrap.python, bootstrap.helper].every(value => typeof value === 'string' && path.isAbsolute(value) && fs.existsSync(value) && fs.statSync(value).isFile()))) return null;
      const quote = arg => "'" + arg.replaceAll("'", "''") + "'";
      const expected = extension === '.ps1'
        ? '\ufeff' + PS_PREFIX + JSON.stringify(argv) + '\n' + BOOTSTRAP_PREFIX + JSON.stringify(bootstrap)
          + '\n$nulliusArgv = @(' + [bootstrap.python, '-I', bootstrap.helper, '--cli'].map(quote).join(', ')
          + ", [string]$PID, [string]([System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc()), '--', " + argv.map(quote).join(', ') + ')\n' + PS_DISPATCH
        : command;
      return expected === source ? argv : null;
    } catch { return null; }
  }
  return extension === '.exe' || extension === '.com' ? [candidate] : null;
}
function firstPathCandidate() {
  const extensions = ['.ps1', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')]
    .filter(extension => /^\.[a-z0-9]+$/iu.test(extension));
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = directory + path.sep + 'nullius' + extension.toLowerCase();
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  return null;
}
function answers(argv) {
  if (!argv || argv.some(arg => path.isAbsolute(arg) && (!fs.existsSync(arg)
      || sameFile(arg, __filename) || sameFile(arg, path.join(__dirname, 'nullius.cmd'))))) return false;
  const probe = spawnSync(argv[0], [...argv.slice(1), GENERATION, PROTOCOL],
    {encoding:'utf8', timeout:5000, stdio:['ignore','pipe','ignore'], windowsHide:true});
  return !probe.error && probe.status === 0 && probe.stdout.replace(/\n+$/u, '') === BANNER;
}
function resolveLauncher() {
  const checked_paths = BAKED_ARGV.filter(arg => path.isAbsolute(arg));
  const missing_paths = checked_paths.filter(arg => !fs.existsSync(arg));
  if (missing_paths.length === 0 && answers(BAKED_ARGV)) return {argv:BAKED_ARGV, checked_paths, missing_paths};
  const candidate = firstPathCandidate();
  // Stop at the FIRST PATH candidate, including an incompatible or self entry.
  // Never scan past it and disagree with normal command resolution.
  if (candidate && !sameFile(candidate, __filename) && !sameFile(candidate, path.join(__dirname, 'nullius.cmd'))) {
    const argv = commandArgv(candidate);
    if (answers(argv)) return {argv, checked_paths, missing_paths};
  }
  return {argv:null, checked_paths, missing_paths};
}
const resolution = resolveLauncher();
if (process.argv.length === 3 && process.argv[2] === '--nullius-launcher-health') {
  process.stdout.write(JSON.stringify({...resolution, argv:undefined, healthy:resolution.argv !== null}) + '\n');
} else if (resolution.argv) {
  const root = path.resolve(__dirname, '../..');
  const argv = resolution.argv;
  const child = spawnSync(argv[0], [...argv.slice(1), GENERATION, '--project-root', root, ...process.argv.slice(2)],
    {stdio:'inherit', windowsHide:true});
  process.exitCode = child.error ? 127 : child.status === null ? 1 : child.status;
} else {
  process.stderr.write('[error] no nullius answered the launcher-protocol handshake; run nullius init --runtime-only on this machine.\n');
  process.exitCode = 127;
}
`;

export function renderWindowsProjectLocalLauncher(argv: string[]): string {
  renderManagedWindowsCommand(argv);
  return `const BAKED_ARGV = ${JSON.stringify(argv)};\n${WINDOWS_LAUNCHER_SOURCE.replace('POWERSHELL_BODY', () => JSON.stringify(POWERSHELL_DISPATCH))}`;
}

export function ensureWindowsProjectLocalNulliusLauncher(projectRoot: string, argv: string[]): string {
  const entrypoint = path.join(projectRoot, '.nullius', 'bin', 'nullius.cjs');
  writeBytesAtomicDurable(entrypoint, renderWindowsProjectLocalLauncher(argv), 0o755);
  const command = path.join(projectRoot, '.nullius', 'bin', 'nullius.cmd');
  // %~dp0 follows the shim when its project is moved, unlike a baked root.
  const script = ['@echo off', 'setlocal DisableDelayedExpansion',
    `"${argv[0]!.replaceAll('%', '%%')}" "%~dp0nullius.cjs" %*`, ''].join('\r\n');
  writeBytesAtomicDurable(command, script, 0o755);
  const powershell = path.join(projectRoot, '.nullius', 'bin', 'nullius.ps1');
  writeBytesAtomicDurable(powershell, renderProjectPowerShell(argv[0]!, launcherBootstrap()), 0o755);
  return powershell;
}

export function readWindowsProjectLocalNulliusLauncherHealth(projectRoot: string): ProjectLocalNulliusLauncherHealth {
  const command = path.join(projectRoot, '.nullius', 'bin', 'nullius.cmd');
  const powershell = path.join(projectRoot, '.nullius', 'bin', 'nullius.ps1');
  const entrypoint = path.join(projectRoot, '.nullius', 'bin', 'nullius.cjs');
  const base = { path: '.nullius/bin/nullius.ps1', repair_command: 'nullius init --runtime-only',
    exists: fs.existsSync(powershell), executable: false, healthy: false,
    checked_paths: [] as string[], missing_paths: [] as string[], issue_code: null as string | null, message: null as string | null };
  const failed = (code: string, message: string) => ({...base, issue_code: code,
    message: `${message}; run ${base.repair_command} from the project root to refresh it.`});
  if (!base.exists || !fs.existsSync(command) || !fs.existsSync(entrypoint)) return failed('PROJECT_LOCAL_LAUNCHER_MISSING', 'Project-local Windows launcher is missing');
  try {
    base.executable = fs.statSync(powershell).isFile() && fs.statSync(command).isFile() && fs.statSync(entrypoint).isFile();
    const source = fs.readFileSync(entrypoint, 'utf8');
    const line = source.split('\n', 1)[0]!;
    const argv: unknown = JSON.parse(line.slice('const BAKED_ARGV = '.length, -1));
    if (!line.startsWith('const BAKED_ARGV = ') || !Array.isArray(argv) || argv.length < 2
        || !argv.every(arg => typeof arg === 'string' && path.isAbsolute(arg))
        || source !== renderWindowsProjectLocalLauncher(argv)) {
      return failed('PROJECT_LOCAL_LAUNCHER_UNPARSEABLE', 'Project-local Windows launcher format is unrecognized');
    }
    const expected = ['@echo off', 'setlocal DisableDelayedExpansion',
      `"${argv[0]!.replaceAll('%', '%%')}" "%~dp0nullius.cjs" %*`, ''].join('\r\n');
    if (fs.readFileSync(command, 'utf8') !== expected) return failed('PROJECT_LOCAL_LAUNCHER_UNPARSEABLE', 'Project-local Windows command format is unrecognized');
    const psSource = fs.readFileSync(powershell, 'utf8');
    const bootstrapLine = psSource.split('\n').find(line => line.startsWith(BOOTSTRAP_PREFIX));
    const bootstrap = bootstrapLine && JSON.parse(bootstrapLine.slice(BOOTSTRAP_PREFIX.length)) as WindowsLauncherBootstrap;
    if (!bootstrap || Object.keys(bootstrap).sort().join(',') !== 'helper,python'
        || ![bootstrap.python, bootstrap.helper].every(value => typeof value === 'string' && path.isAbsolute(value))
        || psSource !== renderProjectPowerShell(argv[0]!, bootstrap)) return failed('PROJECT_LOCAL_LAUNCHER_UNPARSEABLE', 'Project-local PowerShell command format is unrecognized');
    const isFile = (value: string): boolean => fs.existsSync(value) && fs.statSync(value).isFile();
    if (![argv[0]!, bootstrap.python, bootstrap.helper].every(isFile)) {
      base.checked_paths = [...argv.filter(arg => path.isAbsolute(arg)), bootstrap.python, bootstrap.helper];
      base.missing_paths = base.checked_paths.filter(arg => !isFile(arg));
      return failed('PROJECT_LOCAL_LAUNCHER_TARGET_MISSING', 'Project-local Windows launcher Node executable is missing');
    }
    const probe = spawnSync(argv[0]!, [entrypoint, '--nullius-launcher-health'],
      {encoding:'utf8', timeout:15000, stdio:['ignore','pipe','ignore'], windowsHide:true});
    if (probe.error || probe.status !== 0) return failed('PROJECT_LOCAL_LAUNCHER_TARGET_INCOMPATIBLE', 'Project-local Windows launcher health probe failed');
    const health = JSON.parse(probe.stdout) as {healthy:boolean; checked_paths:string[]; missing_paths:string[]};
    base.checked_paths = [...health.checked_paths, bootstrap.python, bootstrap.helper];
    base.missing_paths = health.missing_paths;
    if (!health.healthy) return failed(health.missing_paths.length ? 'PROJECT_LOCAL_LAUNCHER_TARGET_MISSING' : 'PROJECT_LOCAL_LAUNCHER_TARGET_INCOMPATIBLE', 'No protocol-compatible baked target or managed PATH command is available');
    return {...base, healthy:true};
  } catch {
    return failed('PROJECT_LOCAL_LAUNCHER_UNPARSEABLE', 'Project-local Windows launcher format is unrecognized');
  }
}
