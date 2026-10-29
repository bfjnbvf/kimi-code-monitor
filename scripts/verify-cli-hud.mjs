// Use the same asynchronous spawn/timer boundary as the Kimi native runner.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { shellCommand } from './install-cli-hud.mjs';

const sessionAt = process.argv.indexOf('--session');
const payload = { model: 'Kimi HUD probe', cwd: process.cwd(), gitBranch: 'demo', permissionMode: 'manual',
  contextTokens: 42000, maxContextTokens: 100000,
  sessionId: sessionAt >= 0 ? process.argv[sessionAt + 1] : '', version: '2.2.0' };
const installed = process.argv.includes('--installed')
  ? JSON.parse(fs.readFileSync(path.join(process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'), 'hud', 'kimi-code-monitor', 'current.json'), 'utf8')) : null;
const command = installed?.command || shellCommand(process.execPath, path.resolve('dist/hud.cjs'), 120);
const samples = [];
for (let i = 0; i < 10; i++) {
  const result = await new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, KIMI_CODE_STATUS_LINE: '1' } });
    const start = performance.now();
    let stdout = '';
    let timeout = false;
    const timer = setTimeout(() => { timeout = true; child.kill(); }, 300);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, error: 'spawn' }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: !timeout && code === 0 && stdout.includes('Kimi HUD probe'), ms: Math.round(performance.now() - start), timeout, color: stdout.includes('\x1b[1;38;2;') });
    });
    child.stdin.end(JSON.stringify(payload));
  });
  samples.push(result);
}
console.log(JSON.stringify({ runtime: 'node', deadlineMs: 300, passed: samples.filter(s => s.ok).length, runs: samples.length, samples }, null, 2));
if (samples.some(s => !s.ok)) process.exitCode = 1;
