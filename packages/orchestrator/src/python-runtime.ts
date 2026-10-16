import * as fs from 'node:fs';
import * as path from 'node:path';

/** Resolve administrative Python calls without invoking Windows batch shims. */
export function pythonExecutable(): string {
  const configured = process.env.NULLIUS_PYTHON;
  if (configured) {
    if (process.platform === 'win32' && (!path.isAbsolute(configured) || !configured.toLowerCase().endsWith('.exe'))) {
      throw new Error('NULLIUS_PYTHON must name an absolute native Python .exe on Windows');
    }
    return configured;
  }
  if (process.platform !== 'win32') return 'python3';
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)) {
    for (const name of ['python3.exe', 'python.exe']) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return fs.realpathSync.native(candidate);
    }
  }
  throw new Error('Native Python is unavailable; set NULLIUS_PYTHON to an absolute Python .exe');
}

/** Windows executable suffixes only; script/batch wrappers cannot be approved as native runtimes. */
export function nativeExecutableCandidates(token: string, directories: string[]): string[] {
  return directories.flatMap(directory => [path.join(directory, token),
    ...(process.platform === 'win32' && !/\.(?:exe|com)$/iu.test(token) ? [path.join(directory, `${token}.exe`)] : [])]);
}
