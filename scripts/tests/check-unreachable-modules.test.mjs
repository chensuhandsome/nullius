import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ENFORCED_PACKAGES, runCheck, scanPackage } from '../check-unreachable-modules.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function workspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-unreachable-modules-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (rel, content) => {
    const target = path.join(base, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  return { base, write };
}

function packageFixture(t) {
  const ws = workspace(t);
  ws.write('pkg/package.json', JSON.stringify({
    name: 'fixture',
    main: './dist/index.js',
    bin: { fixture: './bin/fixture.js' },
    exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
  }));
  ws.write('pkg/tsconfig.json', JSON.stringify({ compilerOptions: { rootDir: './src', outDir: './dist' } }));
  ws.write('pkg/bin/fixture.js', "import '../dist/cli.js';\n");
  ws.write('pkg/src/cli.ts', 'export const cli = 1;\n');
  ws.write('pkg/src/index.ts', [
    "import { a } from './a.js';",
    "// import './commented.js';",
    "const text = \"import './quoted.js'\";",
    'export { a, text };',
    '',
  ].join('\n'));
  ws.write('pkg/src/a.ts', "export const a = async () => (await import('./b.js')).b;\n");
  ws.write('pkg/src/b.ts', "export type { C } from './nested/c.js';\nexport const b = 1;\n");
  ws.write('pkg/src/nested/c.ts', 'export type C = number;\n');
  ws.write('pkg/src/commented.ts', 'export const x = 1;\n');
  ws.write('pkg/src/quoted.ts', 'export const y = 1;\n');
  ws.write('pkg/src/orphan.ts', 'export const z = 1;\n');
  ws.write('pkg/src/orphan.test.ts', "import './orphan.js';\n");
  ws.write('pkg/src/types.d.ts', 'declare const g: number;\n');
  ws.write('pkg/src/__tests__/helper.ts', 'export const h = 1;\n');
  return { ...ws, packageDir: path.join(ws.base, 'pkg') };
}

test('follows static, dynamic, type-only and launcher imports; comments, strings and test files do not count', t => {
  const { packageDir } = packageFixture(t);
  const result = scanPackage(packageDir);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.unreachable, ['src/commented.ts', 'src/orphan.ts', 'src/quoted.ts']);
  assert.equal(result.modules, 8);
});

test('allowlist entries are single-file roots; a directory or a missing file names no module', t => {
  const { packageDir, write } = packageFixture(t);
  write('pkg/src/admin/tool.ts', "import '../orphan.js';\n");
  write('pkg/src/admin/unused.ts', 'export const u = 1;\n');
  const result = scanPackage(packageDir, {
    allow: [
      { path: 'src/admin/tool.ts', reason: 'started by a shell script' },
      { path: 'src/admin/', reason: 'a directory is not a root' },
      { path: 'src/gone.ts', reason: 'stale' },
    ],
  });
  assert.deepEqual(result.unreachable, ['src/admin/unused.ts', 'src/commented.ts', 'src/quoted.ts']);
  assert.deepEqual(result.problems, [
    'allowlist entry src/admin/ names no source module',
    'allowlist entry src/gone.ts names no source module',
  ]);
});

test('a call to a function named require is no import, even with a literal path', t => {
  const { packageDir, write } = packageFixture(t);
  write('pkg/src/cli.ts', [
    'const require = (_: string) => 0;',
    "require('./orphan.js');",
    "export const cli = require('some-package');",
    '',
  ].join('\n'));
  const result = scanPackage(packageDir);
  assert.ok(result.unreachable.includes('src/orphan.ts'));
  assert.deepEqual(result.problems, [
    'src/cli.ts:2 has a require() call with a relative or non-literal argument, which is not followed as an import (use import or import())',
  ]);
});

test('tsconfig is read as TypeScript reads it: extends, comments, declaration-file targets', t => {
  const ws = workspace(t);
  ws.write('pkg/package.json', JSON.stringify({ name: 'fixture', main: './build/index.js' }));
  ws.write('pkg/tsconfig.base.json', JSON.stringify({ compilerOptions: { rootDir: './source', outDir: './build' } }));
  ws.write('pkg/tsconfig.json', '// layout comes from the base\n{ "extends": "./tsconfig.base.json" }\n');
  ws.write('pkg/source/index.ts', "import type { T } from './types.js';\nexport const t: T = 1;\n");
  ws.write('pkg/source/types.d.ts', 'export type T = number;\n');
  ws.write('pkg/source/orphan.ts', 'export const z = 1;\n');
  const result = scanPackage(path.join(ws.base, 'pkg'));
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.unreachable, ['source/orphan.ts']);

  ws.write('pkg/tsconfig.json', '{ "extends": "./missing-base.json" }\n');
  const broken = scanPackage(path.join(ws.base, 'pkg'));
  assert.ok(broken.problems.some(problem => problem.startsWith('tsconfig.json: Cannot read file')), broken.problems.join('\n'));
});

test('a non-literal import() and an unresolved relative import are reported, not trusted', t => {
  const { packageDir, write } = packageFixture(t);
  write('pkg/src/cli.ts', "const name = './orphan.js';\nexport const cli = () => import(name);\nimport './missing.js';\n");
  const { problems } = scanPackage(packageDir);
  assert.deepEqual(problems.sort(), [
    'src/cli.ts imports ./missing.js, which does not resolve to a file',
    'src/cli.ts:2 has an import() with a non-literal argument; its target cannot be followed',
  ]);
});

test('an entry that does not resolve to a source file is reported', t => {
  const { packageDir, write } = packageFixture(t);
  write('pkg/package.json', JSON.stringify({ name: 'fixture', main: './dist/absent.js' }));
  const { problems } = scanPackage(packageDir);
  assert.deepEqual(problems, [
    'package.json entry ./dist/absent.js does not resolve to a source file',
    'package.json declares no entry that resolves to a source file',
  ]);
});

test('negative control: an orphan planted in a copy of each enforced package fails the check, also beside an allowlisted root', t => {
  for (const [pkg, config] of Object.entries(ENFORCED_PACKAGES)) {
    const ws = workspace(t);
    const source = path.join(repoRoot, pkg);
    const copy = path.join(ws.base, pkg);
    for (const entry of ['package.json', 'tsconfig.json', 'src', 'bin']) {
      if (fs.existsSync(path.join(source, entry))) fs.cpSync(path.join(source, entry), path.join(copy, entry), { recursive: true });
    }
    // The packages' tsconfig files extend the repository's root one.
    fs.cpSync(path.join(repoRoot, 'tsconfig.json'), path.join(ws.base, 'tsconfig.json'));
    const enforced = { [pkg]: config };

    const clean = runCheck({ repoRoot: ws.base, enforced });
    assert.equal(clean.failed, false, clean.lines.join('\n'));

    const plantDirs = new Set(['src', ...config.allow.map(item => path.posix.dirname(item.path))]);
    for (const dir of plantDirs) {
      const planted = `${dir}/planted-orphan.ts`;
      ws.write(`${pkg}/${planted}`, 'export const planted = 1;\n');
      const result = runCheck({ repoRoot: ws.base, enforced });
      assert.equal(result.failed, true, planted);
      assert.ok(result.lines.includes(`    ${planted}`), result.lines.join('\n'));
      assert.ok(result.lines.some(line => line.includes('1 source module(s) reached by no declared entry')), result.lines.join('\n'));
      fs.rmSync(path.join(copy, planted));
    }
    assert.equal(runCheck({ repoRoot: ws.base, enforced }).failed, false);
  }
});
