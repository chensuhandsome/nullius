import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('artifact bootstrap preserves a Unicode workspace path and invokes the package-manager entry without a shell', () => {
  const original = fileURLToPath(new URL('../', import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace with spaces 中文 '));
  try {
    fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
    for (const name of ['ensure-workspace-package-artifacts.mjs', 'lib/workspace-package-freshness.mjs']) {
      fs.copyFileSync(path.join(original, name), path.join(root, 'scripts', name));
    }
    fs.mkdirSync(path.join(root, 'packages/fixture'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/fixture/package.json'), JSON.stringify({ name: '@fixture/package', main: 'dist/index.js' }));
    const manager = path.join(root, 'manager with spaces.mjs');
    fs.writeFileSync(manager, `import fs from 'node:fs';fs.writeFileSync('observed.json', JSON.stringify(process.argv.slice(2)));`);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/ensure-workspace-package-artifacts.mjs'), '@fixture/package'],
      { env: { ...process.env, npm_execpath: manager }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'observed.json'), 'utf8')), ['--filter', '@fixture/package', 'build']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
