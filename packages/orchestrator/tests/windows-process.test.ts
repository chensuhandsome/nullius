import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpClient } from '../src/mcp-client.js';

describe.skipIf(process.platform !== 'win32')('native Windows MCP Job ownership', () => {
  const directories: string[] = [];
  const clients: McpClient[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });
  function fixture(source: string) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-mcp-中文 '));
    directories.push(directory);
    const script = path.join(directory, 'server.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs'; import { spawn } from 'node:child_process'; import readline from 'node:readline';
      const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
      readline.createInterface({input:process.stdin}).on('line', line => { const msg = JSON.parse(line); ${source} });`);
    return { directory, script };
  }
  function client() {
    const value = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20, maxReconnects: 1,
      reconnectPolicy: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 10, jitter: 0 } });
    clients.push(value);
    return value;
  }
  const initialized = `if (msg.method === 'initialize') reply(msg.id, {protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'native',version:'1'}});`;

  it('kills a timed-out target and its descendant before returning from close', async () => {
    const f = fixture(`${initialized}
      if (msg.method === 'tools/call') {
        spawn(process.execPath, ['-e', "setTimeout(()=>require('fs').writeFileSync(process.argv[1],'orphan'),600)", process.env.MARKER], {stdio:'ignore'});
      }`);
    const marker = path.join(f.directory, 'must-not-appear');
    const c = client();
    await c.start(process.execPath, [f.script], { cwd: f.directory, configEnv: { MARKER: marker } });
    await expect(c.callTool('hang', {}, 100)).rejects.toThrow('client is unusable');
    await c.close();
    await new Promise(resolve => setTimeout(resolve, 750));
    expect(fs.existsSync(marker)).toBe(false);
    await expect(c.callTool('again', {})).rejects.toThrow();
  });

  it('drains descendants from the previous Job before reconnecting', async () => {
    const f = fixture(`${initialized}
      if (msg.method === 'notifications/initialized' && !fs.existsSync(process.env.GENERATION)) {
        fs.writeFileSync(process.env.GENERATION, 'first');
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
        fs.writeFileSync(process.env.CHILD_PID, String(child.pid));
        setTimeout(()=>process.exit(0),50);
      }
      if (msg.method === 'tools/call') {
        let alive = true; try { process.kill(Number(fs.readFileSync(process.env.CHILD_PID)), 0); } catch { alive = false; }
        reply(msg.id, {content:[{type:'text',text:JSON.stringify({alive})}]});
      }`);
    const generation = path.join(f.directory, 'generation');
    const c = client();
    await c.start(process.execPath, [f.script], { cwd: f.directory,
      configEnv: { GENERATION: generation, CHILD_PID: path.join(f.directory, 'child-pid') } });
    await new Promise(resolve => setTimeout(resolve, 500));
    const deadline = Date.now() + 5000;
    while (!c.isConnected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(c.isConnected).toBe(true);
    const result = await c.callTool('probe', {});
    expect(result).toMatchObject({ json: { alive: false } });
  });
});
