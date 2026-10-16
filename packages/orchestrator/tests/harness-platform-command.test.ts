import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ensureNulliusHarnessSentinel, readNulliusHarnessSentinelHealth } from '../src/nullius-harness-sentinel.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true, force:true}); });

it('writes the current platform command while retaining a moved project sentinel for reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-platform-sentinel-'));
  roots.push(root);
  const filename = ensureNulliusHarnessSentinel(root);
  const expected = process.platform === 'win32' ? '.nullius/bin/nullius.ps1 status --json' : '.nullius/bin/nullius status --json';
  expect(readNulliusHarnessSentinelHealth(root)).toMatchObject({valid:true, payload:{project_local_status_command:expected}});
  const sentinel = JSON.parse(fs.readFileSync(filename, 'utf8'));
  sentinel.project_local_status_command = '.nullius/bin/nullius status --json';
  fs.writeFileSync(filename, JSON.stringify(sentinel));
  expect(readNulliusHarnessSentinelHealth(root).valid).toBe(true);
  ensureNulliusHarnessSentinel(root);
  expect(readNulliusHarnessSentinelHealth(root).payload!.project_local_status_command).toBe(expected);
  sentinel.project_local_status_command = 'arbitrary executable --unsafe';
  fs.writeFileSync(filename, JSON.stringify(sentinel));
  expect(readNulliusHarnessSentinelHealth(root)).toMatchObject({valid:false, issue_code:'NULLIUS_HARNESS_SENTINEL_INVALID_CONTRACT'});
});
