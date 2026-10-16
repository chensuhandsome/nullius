import * as fs from 'node:fs';
import * as path from 'node:path';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

/** A real filesystem reparse point, without requiring Windows symlink privilege.
 * File-leaf rejection fixtures use a junction at that exact leaf on Windows;
 * assertions must still require the reparse guard, not merely a type error.
 * POSIX keeps the original file symlink, including dangling targets.
 */
export function createReparseFixture(target: string, link: string, type: 'file' | 'dir' = 'file'): void {
  if (process.platform !== 'win32') {
    fs.symlinkSync(target, link, type);
    return;
  }
  const absolute = path.resolve(path.dirname(link), target);
  const junctionTarget = type === 'file' && fs.existsSync(absolute) && fs.statSync(absolute).isFile()
    ? path.dirname(absolute) : absolute;
  fs.symlinkSync(junctionTarget, link, 'junction');
}

/** NTFS project paths cannot store a POSIX FIFO. Inject its metadata at the
 * same filesystem boundary on Windows, retaining real mkfifo on POSIX. */
export function nonRegularFileMetadataFixture(file: string): () => void {
  fs.writeFileSync(file, 'not a regular-file payload');
  const original = fsDefault.lstatSync;
  fsDefault.lstatSync = ((target: fs.PathLike, ...options: any[]) => {
    const metadata = original(target, ...options);
    if (path.resolve(String(target)) !== path.resolve(file)) return metadata;
    return Object.assign(Object.create(metadata), {
      isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false,
      isFIFO: () => true, isSocket: () => false,
    });
  }) as typeof fsDefault.lstatSync;
  syncBuiltinESMExports();
  return () => { fsDefault.lstatSync = original; syncBuiltinESMExports(); };
}
