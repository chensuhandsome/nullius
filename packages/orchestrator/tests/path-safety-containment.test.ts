import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoSymlinkComponents, escapesBase, realLocationWithin, resolveUnderRoot } from '../src/computation/path-safety.js';

/** The one containment rule the front doors share: the project root is
 *  admitted in canonical form, an absolute path may reach it through an
 *  alias above it, components below it are kept verbatim for the symlink
 *  check, and a "must stay outside" guard judges where a path really lands.
 *  The alias is an explicit symlink, so this discriminates on every platform. */

const parents: string[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) fs.rmSync(parent, { recursive: true, force: true });
});

function aliasedProject(): { parent: string; root: string; alias: string; via: (canonical: string) => string } {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-path-safety-')));
  parents.push(parent);
  const root = path.join(parent, 'real');
  const alias = path.join(parent, 'alias');
  fs.mkdirSync(root);
  fs.symlinkSync(root, alias, 'dir');
  return { parent, root, alias, via: canonical => path.join(alias, path.relative(root, canonical)) };
}

describe('the shared containment checks', () => {
  it('treat only the parent itself, paths through it, and other roots as leaving the base', () => {
    for (const relative of ['..', `..${path.sep}x`, path.resolve('/elsewhere')]) expect(escapesBase(relative)).toBe(true);
    for (const relative of ['', 'x', '..x', `..x${path.sep}y`, `a${path.sep}..b`]) expect(escapesBase(relative)).toBe(false);
  });

  it('respell an absolute path reached through an alias above the root, and nothing else', () => {
    const { parent, root, alias, via } = aliasedProject();
    fs.mkdirSync(path.join(root, 'sub'));
    expect(resolveUnderRoot(root, path.join(alias, 'sub', 'f.txt'))).toBe(path.join(root, 'sub', 'f.txt'));
    expect(resolveUnderRoot(via(path.join(root, 'sub')), path.join(root, 'sub', 'f.txt'))).toBe(path.join(alias, 'sub', 'f.txt'));
    expect(resolveUnderRoot(root, '..notes.md')).toBe(path.join(root, '..notes.md'));
    expect(resolveUnderRoot(root, '../sibling/x')).toBeNull();
    expect(resolveUnderRoot(root, '../alias/x')).toBeNull();
    fs.mkdirSync(path.join(parent, 'sibling'));
    expect(resolveUnderRoot(root, path.join(parent, 'sibling', 'x'))).toBeNull();
    expect(resolveUnderRoot(root, path.join(alias, '..', 'sibling', 'x'))).toBeNull();
  });

  it('keep components below the root verbatim, so a symlink below it is still refused', () => {
    const { parent, root, alias } = aliasedProject();
    fs.mkdirSync(path.join(root, 'plain'));
    fs.mkdirSync(path.join(parent, 'target'));
    fs.symlinkSync(path.join(parent, 'target'), path.join(root, 'linked'), 'dir');
    expect(() => assertNoSymlinkComponents(root, path.join(alias, 'plain', 'f.txt'), 'probe', { allowMissingLeaf: true })).not.toThrow();
    expect(() => assertNoSymlinkComponents(root, path.join(alias, 'linked', 'f.txt'), 'probe', { allowMissingLeaf: true })).toThrow(/symbolic link/);
    expect(() => assertNoSymlinkComponents(root, path.join(parent, 'target', 'f.txt'), 'probe', { allowMissingLeaf: true })).toThrow(/must stay within/);
    fs.symlinkSync(path.join(parent, 'missing'), path.join(root, 'dangling'), 'dir');
    expect(() => assertNoSymlinkComponents(root, path.join(alias, 'dangling', 'f.txt'), 'probe', { allowMissingLeaf: true })).toThrow(/symbolic link/);
    expect(() => assertNoSymlinkComponents(root, path.join(root, 'dangling'), 'probe', { allowMissingLeaf: true })).toThrow(/symbolic link/);
  });

  it('judge overlap with a directory by where a path really lands', () => {
    const { parent, root, alias } = aliasedProject();
    const evidence = path.join(root, 'artifacts', 'runs', 'r1');
    fs.mkdirSync(path.join(evidence, 'deep'), { recursive: true });
    fs.symlinkSync(path.join(evidence, 'deep'), path.join(parent, 'into-deep'), 'dir');
    expect(realLocationWithin(evidence, path.join(alias, 'artifacts', 'runs', 'r1', 'out.zip'))).toBe(true);
    expect(realLocationWithin(evidence, path.join(parent, 'into-deep', 'out.zip'))).toBe(true);
    expect(realLocationWithin(evidence, evidence)).toBe(true);
    expect(realLocationWithin(evidence, path.join(alias, 'artifacts', 'runs', 'r1-sibling', 'out.zip'))).toBe(false);
    expect(realLocationWithin(evidence, path.join(root, 'artifacts', 'runs', '..r1', 'out.zip'))).toBe(false);
    expect(realLocationWithin(path.join(root, 'artifacts', 'runs', 'missing'), path.join(alias, 'artifacts', 'runs', 'missing', 'x'))).toBe(true);
  });
});
