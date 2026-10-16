import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

let accountSid: string | undefined;

/** Real access denial; Windows chmod only changes a file's read-only flag. */
export function denyFilesystemAccess(target: string, posixMode: number, windowsMask: string): () => void {
  if (process.platform !== 'win32') {
    const mode = fs.statSync(target).mode & 0o7777;
    fs.chmodSync(target, posixMode);
    return () => fs.chmodSync(target, mode);
  }
  accountSid ??= execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf-8' }).trim();
  const sid = accountSid;
  const restore = (): void => { execFileSync('icacls.exe', [target, '/remove:d', `*${sid}`, '/Q']); };
  try {
    // Use specific rights, avoiding GENERIC_WRITE's SYNCHRONIZE bit, which
    // would also deny directory enumeration and interfere with ACL cleanup.
    execFileSync('icacls.exe', [target, '/deny', `*${sid}:${windowsMask}`, '/Q']);
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
}
