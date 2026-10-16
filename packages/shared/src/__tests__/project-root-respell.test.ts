import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertExternalProjectRoot, respellUnderDirectory } from '../project-root.js';

// The alias is an explicit symlink, so these cases discriminate on hosts
// whose temp directory is not itself an alias.
describe('respellUnderDirectory', () => {
  let tmp: string;
  let dir: string;
  let alias: string;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'respell-under-dir-')));
    dir = path.join(tmp, 'dir');
    alias = path.join(tmp, 'alias');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('re-spells a path through an alias above the directory, keeping components below verbatim', () => {
    expect(respellUnderDirectory(dir, path.join(alias, 'sub', 'not-yet', 'f.json'))).toBe(path.join(dir, 'sub', 'not-yet', 'f.json'));
    expect(respellUnderDirectory(dir, alias)).toBe(dir);
    expect(respellUnderDirectory(dir, path.join(dir, 'sub'))).toBe(path.join(dir, 'sub'));
  });

  it('returns null for a path that does not reach the directory', () => {
    fs.mkdirSync(path.join(tmp, 'other'));
    expect(respellUnderDirectory(dir, path.join(tmp, 'other', 'f'))).toBeNull();
    expect(respellUnderDirectory(path.join(dir, 'sub'), path.join(alias, 'f'))).toBeNull();
  });

  it('returns null when the directory does not exist and so has no identity', () => {
    expect(respellUnderDirectory(path.join(dir, 'missing'), path.join(alias, 'missing', 'f'))).toBeNull();
  });

  it('refuses looping metadata beneath a canonical root before classifying a marker as absent', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"nullius"}');
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n');
    fs.symlinkSync(path.join(dir, 'packages'), path.join(dir, 'packages'), process.platform === 'win32' ? 'junction' : 'dir');
    const installation = path.join(tmp, 'installation');
    fs.mkdirSync(installation);
    for (const spelling of [dir, alias]) {
      expect(() => assertExternalProjectRoot(spelling, installation)).toThrow('ambiguous development-checkout metadata');
    }
    expect(fs.existsSync(path.join(dir, '.nullius'))).toBe(false);
  });

  it('retains admission for an external root reached through a top-level directory alias', () => {
    const installation = path.join(tmp, 'installation');
    fs.mkdirSync(installation);
    expect(assertExternalProjectRoot(alias, installation)).toBe(dir);
  });
});
