import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { pythonExecutable } from '../src/python-runtime.js';
import { readRunDirectoryInventory, readRunDirFor } from '../src/run-directories.js';

describe.runIf(process.platform === 'win32')('native Unicode evidence export', () => {
  let root: string;
  const io = { cwd: () => root, stdout: (_: string) => {}, stderr: (_: string) => {} };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-export-中文 ')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('exports every Unicode and binary file byte-for-byte from current and historical read roots', async () => {
    expect(await runCli(['init', '--project-root', root, '--no-git'], io)).toBe(0);
    for (const [relative, runId] of [['artifacts/runs', 'current'], ['team/runs', 'historical']]) {
      const run = path.join(root, relative!, runId!);
      fs.mkdirSync(run, { recursive: true });
      const bytes = Buffer.from([0, 1, 128, 255, 13, 10]);
      fs.writeFileSync(path.join(run, '研究.txt'), '完整 Unicode evidence');
      fs.writeFileSync(path.join(run, 'binary.bin'), bytes);
      const archive = path.join(root, `${runId}.zip`);
      expect(await runCli(['export', '--project-root', root, '--run-root', relative!, '--run-id', runId!, '--out', archive], io)).toBe(0);
      const checked = spawnSync(pythonExecutable(), ['-I', '-c',
        'import base64,json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:base64.b64encode(z.read(n)).decode("ascii") for n in z.namelist()}))', archive],
        { encoding: 'utf8' });
      expect(checked.status, checked.stderr).toBe(0);
      const contents = JSON.parse(checked.stdout);
      expect(contents[`${relative}/${runId}/研究.txt`]).toBe(Buffer.from('完整 Unicode evidence').toString('base64'));
      expect(contents[`${relative}/${runId}/binary.bin`]).toBe(bytes.toString('base64'));
      expect(readRunDirFor(root, runId!, relative)).toBe(run);
      expect(fs.readFileSync(path.join(run, 'binary.bin'))).toEqual(bytes);
    }
    const inventory = readRunDirectoryInventory(root).runs;
    expect(inventory.find(run => run.run_id === 'current')).toMatchObject({ historical: false, relative_path: 'artifacts/runs/current' });
    expect(inventory.find(run => run.run_id === 'historical')).toMatchObject({ historical: true, relative_path: 'team/runs/historical' });
  });
});
