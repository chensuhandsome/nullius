import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureWindowsProjectLocalNulliusLauncher,
  readWindowsProjectLocalNulliusLauncherHealth,
  renderManagedWindowsCommand,
  renderManagedWindowsPowerShell,
} from '../src/project-local-nullius-windows.js';

const roots: string[] = [];
function fixture(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-launcher-中文 space-')));
  roots.push(root);
  return root;
}
function fakeCli(root: string, name = 'cli.cjs', generation = 2): string {
  const filename = path.join(root, name);
  fs.writeFileSync(filename, [
    `if (process.argv.includes('--launcher-generation=2') && ${generation} !== 2) process.exit(2);`,
    `if (process.argv.includes('--launcher-protocol')) { console.log('nullius-launcher-protocol ${generation}'); process.exit(0); }`,
    'console.log(JSON.stringify(process.argv.slice(2)));',
  ].join('\n'));
  return filename;
}
function launch(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [path.join(root, '.nullius/bin/nullius.cjs'), ...args],
    {encoding:'utf8', timeout:15_000, windowsHide:true});
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true, force:true});
});

describe('Windows project-local launcher', () => {
  it('does not advertise a primary PowerShell launcher whose bootstrap executable is a directory', () => {
    const root = fixture();
    const python = path.join(root, 'python.exe');
    fs.mkdirSync(python);
    vi.stubEnv('NULLIUS_PYTHON', python);
    ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, fakeCli(root)]);
    const health = readWindowsProjectLocalNulliusLauncherHealth(root);
    expect(health).toMatchObject({healthy:false, executable:true, issue_code:'PROJECT_LOCAL_LAUNCHER_TARGET_MISSING'});
    expect(health.missing_paths).toContain(python);
  });

  it('prepends its trusted root and preserves literal arguments through the baked Node command', () => {
    const root = fixture();
    ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, fakeCli(root)]);
    const args = ['status', '--', '中文 space', 'percent%PATH%', 'bang!literal!', '&echo injected', 'quote"literal', 'trailing\\'];
    const result = launch(root, args);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['--launcher-generation=2', '--project-root', root, ...args]);
    expect(readWindowsProjectLocalNulliusLauncherHealth(root)).toMatchObject({healthy:true, executable:true, path:'.nullius/bin/nullius.ps1'});
  });

  it('derives the root again after the project moves and keeps preferring its baked runtime', () => {
    const runtime = fixture();
    const root = fixture();
    ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, fakeCli(runtime)]);
    const moved = `${root}-moved 中文`;
    roots.push(moved);
    fs.renameSync(root, moved);
    const alternate = fixture();
    fs.writeFileSync(path.join(alternate, 'nullius.cmd'), '@echo off\r\nexit /b 99\r\n');
    vi.stubEnv('PATH', alternate);
    const result = launch(moved, ['status']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)[2]).toBe(moved);
    expect(readWindowsProjectLocalNulliusLauncherHealth(moved).healthy).toBe(true);
  });

  it('uses the canonical parser to refuse root overrides and retain arguments after the terminator', () => {
    const root = fixture();
    const parser = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli-args.js')).href;
    const cli = path.join(root, 'parser.cjs');
    fs.writeFileSync(cli, [
      `if (process.argv.includes('--launcher-generation=2') && process.argv.includes('--launcher-protocol')) { console.log('nullius-launcher-protocol 2'); process.exit(0); }`,
      `import(${JSON.stringify(parser)}).then(({parseCliArgs}) => {`,
      '  try { console.log(JSON.stringify(parseCliArgs(process.argv.slice(2)))); }',
      '  catch(error) { console.error(error.message); process.exitCode = 2; }',
      '});',
    ].join('\n'));
    ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, cli]);
    const other = fixture();
    const override = launch(root, ['status', '--json', `--project-root=${other}`]);
    expect(override.status).toBe(2);
    expect(override.stderr).toContain('duplicate --project-root');
    const literal = launch(root, ['decision', 'record', '--', `--project-root=${other}`]);
    expect(literal.status, literal.stderr).toBe(0);
    expect(JSON.parse(literal.stdout)).toMatchObject({projectRoot:root, action:'record', text:`--project-root=${other}`});
  });

  it('uses the first managed PATH command directly without evaluating cmd metacharacters', () => {
    const root = fixture();
    ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, path.join(root, 'missing.cjs')]);
    const fallback = fixture();
    const cli = fakeCli(fallback);
    fs.writeFileSync(path.join(fallback, 'nullius.cmd'), renderManagedWindowsCommand([process.execPath, cli]));
    vi.stubEnv('PATH', fallback);
    vi.stubEnv('PATHEXT', '.CMD');
    const marker = path.join(root, 'unexpected.txt');
    const args = ['--', `%PATH% !name! & echo unexpected > "${marker}"`, '中文'];
    const result = launch(root, args);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['--launcher-generation=2', '--project-root', root, ...args]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(readWindowsProjectLocalNulliusLauncherHealth(root).healthy).toBe(true);
  });

  it('never skips an incompatible first PATH command and refuses self recursion', () => {
    const root = fixture();
    ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, path.join(root, 'missing.cjs')]);
    const first = fixture();
    const next = fixture();
    fs.writeFileSync(path.join(first, 'nullius.cmd'), '@echo off\r\necho nullius-launcher-protocol 2\r\n');
    fs.writeFileSync(path.join(next, 'nullius.cmd'), renderManagedWindowsCommand([process.execPath, fakeCli(next)]));
    vi.stubEnv('PATHEXT', '.CMD');
    vi.stubEnv('PATH', [first, next].join(path.delimiter));
    expect(launch(root).status).toBe(127);
    expect(readWindowsProjectLocalNulliusLauncherHealth(root).healthy).toBe(false);
    vi.stubEnv('PATH', [path.join(root, '.nullius/bin'), next].join(path.delimiter));
    expect(launch(root).status).toBe(127);
    expect(readWindowsProjectLocalNulliusLauncherHealth(root).healthy).toBe(false);
  });

  it('requires the exact protocol and validates both companion bodies before declaring health', () => {
    const root = fixture();
    vi.stubEnv('PATH', '');
    ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, fakeCli(root, 'old.cjs', 1)]);
    expect(launch(root).status).toBe(127);
    expect(readWindowsProjectLocalNulliusLauncherHealth(root).issue_code).toBe('PROJECT_LOCAL_LAUNCHER_TARGET_INCOMPATIBLE');
    ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, fakeCli(root)]);
    fs.appendFileSync(path.join(root, '.nullius/bin/nullius.cjs'), '\nprocess.exit(0);\n');
    expect(readWindowsProjectLocalNulliusLauncherHealth(root).issue_code).toBe('PROJECT_LOCAL_LAUNCHER_UNPARSEABLE');
    ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, fakeCli(root)]);
    fs.appendFileSync(path.join(root, '.nullius/bin/nullius.cmd'), 'echo altered\r\n');
    expect(readWindowsProjectLocalNulliusLauncherHealth(root).issue_code).toBe('PROJECT_LOCAL_LAUNCHER_UNPARSEABLE');
  });

  it('runs the native command companion with Unicode and quoted metacharacters', () => {
    const root = fixture();
    ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, fakeCli(root)]);
    const cmd = path.join(root, '.nullius/bin/nullius.cmd');
    if (process.platform === 'win32') {
      const result = spawnSync(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/s', '/c', `""${cmd}" "中文 space" "percent%missing_value%" "bang!literal!" "amp&literal""`],
        {encoding:'utf8', timeout:15_000, windowsVerbatimArguments:true, windowsHide:true});
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(['--launcher-generation=2', '--project-root', root,
        '中文 space', 'percent%missing_value%', 'bang!literal!', 'amp&literal']);
    } else {
      expect(fs.readFileSync(cmd, 'utf8')).toContain('"%~dp0nullius.cjs" %*');
    }
  });

  it('preserves empty arguments and embedded quotes through native PowerShell 5.1', () => {
    const root = fixture();
    const powershell = ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, fakeCli(root)]);
    const args = ['', 'a"b', '{"key":"value"}', 'trailing\\', 'amp&literal', '%PATH%', '!literal!', '中文 space'];
    if (process.platform === 'win32') {
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& ${quote(powershell)} ${args.map(quote).join(' ')}`],
        {encoding:'utf8', timeout:15_000, windowsHide:true});
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(['--launcher-generation=2', '--project-root', root, ...args]);
    } else {
      expect(fs.readFileSync(powershell, 'utf8')).toContain('System.Diagnostics.ProcessStartInfo');
    }
  });

  it('recognizes managed PowerShell PATH commands without using their shell', () => {
    const root = fixture();
    const fallback = fixture();
    ensureWindowsProjectLocalNulliusLauncher(root, [process.execPath, path.join(root, 'missing.cjs')]);
    fs.writeFileSync(path.join(fallback, 'nullius.ps1'), renderManagedWindowsPowerShell([process.execPath, fakeCli(fallback)]));
    vi.stubEnv('PATH', fallback);
    const result = launch(root, ['', 'a"b']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['--launcher-generation=2', '--project-root', root, '', 'a"b']);
    expect(readWindowsProjectLocalNulliusLauncherHealth(root).healthy).toBe(true);
  });

  it('forwards Unicode text, JSON capture, stdin, stderr and exit status through the PowerShell pipeline', () => {
    const root = fixture();
    const cli = path.join(root, 'wire.cjs');
    fs.writeFileSync(cli, "process.stdin.pipe(process.stdout);process.stderr.write('diagnostic\\n');process.stdin.on('end',()=>{process.exitCode=7;});");
    const entry = path.join(root, 'nullius.ps1');
    fs.writeFileSync(entry, renderManagedWindowsPowerShell([process.execPath, cli]));
    if (process.platform === 'win32') {
      const input = Buffer.from(JSON.stringify({title:'中文', answer:42}) + '\n');
      const code = `$receipt = & '${entry.replaceAll("'", "''")}' | ConvertFrom-Json; $result = $LASTEXITCODE; if ($receipt.title -ne '中文' -or $receipt.answer -ne 42) { exit 9 }; Write-Output 'CAPTURE_OK'; exit $result`;
      const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', code],
        {input, timeout:15_000, windowsHide:true});
      expect(result.status, result.stderr.toString()).toBe(7);
      expect(result.stdout.toString().trim()).toBe('CAPTURE_OK');
      expect(result.stderr.toString().trim()).toBe('diagnostic');
    } else {
      expect(fs.readFileSync(entry, 'utf8').startsWith('\ufeff')).toBe(true);
    }
  });

  it('stops the owned CLI tree when its PowerShell host is terminated', async () => {
    const root = fixture();
    const marker = path.join(root, 'orphan-effect.txt');
    const cli = path.join(root, 'long-running.cjs');
    const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),900);setTimeout(()=>{},30000);`;
    fs.writeFileSync(cli, [
      `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});`,
      "console.log(JSON.stringify({root:process.pid,child:child.pid}));setTimeout(()=>{},30000);",
    ].join('\n'));
    const entry = path.join(root, 'nullius.ps1');
    fs.writeFileSync(entry, renderManagedWindowsPowerShell([process.execPath, cli]));
    if (process.platform !== 'win32') {
      expect(fs.readFileSync(entry, 'utf8')).toContain("'--cli'");
      return;
    }
    const host = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry], {stdio:['pipe','pipe','pipe'], windowsHide:true});
    try {
      const pids = await new Promise<{root:number; child:number}>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('PowerShell CLI did not start')), 5000);
        host.stdout.on('data', chunk => {
          output += chunk.toString();
          if (output.includes('\n')) {
            clearTimeout(timer);
            resolve(JSON.parse(output.trim()));
          }
        });
        host.once('error', error => { clearTimeout(timer); reject(error); });
        host.once('exit', code => { clearTimeout(timer); reject(new Error(`PowerShell exited before target startup: ${code}`)); });
      });
      host.kill();
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect(fs.existsSync(marker)).toBe(false);
      for (const pid of [pids.root, pids.child]) {
        let live = false;
        try { process.kill(pid, 0); live = true; } catch { /* process exited */ }
        expect(live, `orphaned CLI process ${pid}`).toBe(false);
      }
    } finally {
      host.kill();
      host.stdin.end();
    }
  });
});
