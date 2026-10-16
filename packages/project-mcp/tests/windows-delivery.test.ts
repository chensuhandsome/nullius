import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpClient } from '@nullius/orchestrator';

const server = fileURLToPath(new URL('../dist/index.js', import.meta.url));

describe.skipIf(process.platform !== 'win32')('Windows durable delivery ownership', () => {
  it('commits after immediate disconnect from a Job-contained MCP server', async () => {
    // Repeat the acceptance boundary: no sleep between accepted response and
    // disconnect, so an undetached bootstrap cannot borrow timing from a test.
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'windows-delivery-中文 ')));
      const connect = async () => {
        const client = new McpClient({ shutdownGraceMs: 10, killGraceMs: 10 });
        await client.start(process.execPath, [server], {
          cwd: root, configEnv: { NULLIUS_PROJECT_ROOT: root,
            ...(process.env.NULLIUS_PYTHON ? { NULLIUS_PYTHON: process.env.NULLIUS_PYTHON } : {}) },
        });
        return client;
      };
      let client = await connect();
      try {
        const accepted = await client.callTool('project_cli', { action: 'init', delivery_id: 'init' });
        expect(accepted.isError).toBe(false);
        expect((accepted.json as { state: string }).state).toBe('outcome_unknown');
        await client.close();
        client = await connect();
        let delivered: any;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          delivered = (await client.callTool('project_delivery_read', { delivery_id: 'init' })).json;
          if (delivered.state === 'committed') break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect(delivered.state).toBe('committed');
        expect(delivered.result.isError).not.toBe(true);
        expect(fs.existsSync(path.join(root, '.nullius/HARNESS'))).toBe(true);
        expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(false);
        const replay = (await client.callTool('project_cli', { action: 'init', delivery_id: 'init' })).json;
        expect(replay).toEqual(delivered);
      } finally {
        await client.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }, 45_000);
});
