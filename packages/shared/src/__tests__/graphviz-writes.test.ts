/**
 * runDot writes the DOT source and the rendered images by staged rename, so a
 * link already at an output name is replaced, never written through. A stand-in
 * `dot` on PATH makes this independent of a real Graphviz installation.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDot } from '../graph-viz/graphviz.js';

// Renders "RENDERED <format>" to the file given by -o, or to stdout without it.
const FAKE_DOT = `#!/bin/sh
fmt=""
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -T*) fmt="\${1#-T}"; shift ;;
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat > /dev/null
if [ -n "$out" ]; then printf 'RENDERED %s' "$fmt" > "$out"; else printf 'RENDERED %s' "$fmt"; fi
`;

describe('runDot output writes', () => {
  const originalPath = process.env.PATH;
  let dir: string;
  let outside: string;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'graphviz-writes-')));
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'graphviz-writes-outside-')));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'dot'), FAKE_DOT, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('replaces links at the DOT, PNG and SVG names instead of writing through them', () => {
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const names = ['graph.dot', 'graph.png', 'graph.svg'];
    for (const name of names) {
      fs.writeFileSync(path.join(outside, name), 'ORIGINAL');
      fs.symlinkSync(path.join(outside, name), path.join(out, name));
    }

    runDot('digraph { a -> b }', {
      outDot: path.join(out, 'graph.dot'),
      outPng: path.join(out, 'graph.png'),
      outSvg: path.join(out, 'graph.svg'),
    });

    for (const name of names) {
      expect(fs.readFileSync(path.join(outside, name), 'utf-8')).toBe('ORIGINAL');
      expect(fs.lstatSync(path.join(out, name)).isFile()).toBe(true);
    }
    expect(fs.readFileSync(path.join(out, 'graph.dot'), 'utf-8')).toBe('digraph { a -> b }');
    expect(fs.readFileSync(path.join(out, 'graph.png'), 'utf-8')).toBe('RENDERED png');
    expect(fs.readFileSync(path.join(out, 'graph.svg'), 'utf-8')).toBe('RENDERED svg');
    expect(fs.readdirSync(out).sort()).toEqual(names.sort());
  });

  it('reports a failed image write as a warning, as it does a failed render', () => {
    // The image's parent path is a regular file, so the write cannot succeed.
    fs.writeFileSync(path.join(dir, 'not-a-dir'), 'x');
    const png = path.join(dir, 'not-a-dir', 'graph.png');

    expect(() => runDot('digraph { a -> b }', { outPng: png })).not.toThrow();

    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      '[graph-viz] writing PNG failed:',
      expect.stringMatching(/ENOTDIR|EEXIST/),
    );
  });

  it('leaves an existing image as it was when the render fails', () => {
    fs.writeFileSync(path.join(dir, 'bin', 'dot'), '#!/bin/sh\ncat > /dev/null\nexit 3\n', { mode: 0o755 });
    const png = path.join(dir, 'graph.png');
    fs.writeFileSync(png, 'previous');

    runDot('digraph { a -> b }', { outPng: png });

    expect(fs.readFileSync(png, 'utf-8')).toBe('previous');
    expect(fs.readdirSync(dir).filter(name => name.includes('.tmp.'))).toEqual([]);
  });
});
