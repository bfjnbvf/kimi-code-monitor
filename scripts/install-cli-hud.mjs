#!/usr/bin/env node
/**
 * 可恢复安装：独立 release + 状态栏命令，保留旧文件和备份。
 * Reversible install: isolated releases + status-line command, preserving old files and backups.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function compatibleVersion(version) {
  const m = String(version).trim().match(/^(?:kimi(?:-code)?\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\s|$|\+)/i);
  return !!m && (Number(m[1]) > 2 || Number(m[1]) === 2 && Number(m[2]) >= 2);
}

function sectionInfo(text) {
  const lines = text.split(/\r?\n/);
  // Deliberately handle the documented table form; refuse exotic dotted/inline TOML.
  const headers = lines.map((line, i) => /^\s*\[\s*status_line\s*\]\s*(?:#.*)?$/.test(line) ? i : -1).filter(i => i >= 0);
  if (headers.length > 1 || lines.some(line => /^\s*(?:["']?status_line["']?\s*[.=]|\[\s*["']status_line)/.test(line))) {
    throw new Error('Unsupported status_line TOML form; use a single [status_line] table. No config was changed.');
  }
  const start = headers[0] ?? -1;
  let end = lines.length;
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const commands = [];
  for (let i = start + 1; start >= 0 && i < end; i++) if (/^\s*(?:command|"command"|'command')\s*=/.test(lines[i])) commands.push(i);
  if (commands.length > 1) throw new Error('Duplicate status_line.command; no config was changed.');
  const index = commands[0] ?? -1;
  if (index >= 0 && /=\s*(?:"""|''')/.test(lines[index])) throw new Error('Multiline status_line.command is not supported by the demo installer.');
  return { lines, start, end, index, newline: text.includes('\r\n') ? '\r\n' : '\n' };
}

export function configure(text, command) {
  // 仅改命令行，保留其他配置。 / Change only the command line; preserve other settings.
  const s = sectionInfo(text);
  const originalLine = s.index >= 0 ? s.lines[s.index] : null;
  const line = `command = ${JSON.stringify(command)}`;
  if (s.index >= 0) s.lines[s.index] = line;
  else if (s.start >= 0) s.lines.splice(s.start + 1, 0, line);
  else {
    if (s.lines.at(-1) !== '') s.lines.push('');
    s.lines.push('[status_line]', line, '');
  }
  return { text: s.lines.join(s.newline), originalLine, createdSection: s.start < 0, line };
}

export function restore(text, receipt) {
  // 校验归属后恢复原命令。 / Verify ownership before restoring the original command.
  const s = sectionInfo(text);
  if (s.index < 0 || s.lines[s.index].trim() !== receipt.line.trim()) {
    throw new Error('status_line.command has changed since installation; leaving it untouched.');
  }
  if (receipt.originalLine !== null) s.lines[s.index] = receipt.originalLine;
  else s.lines.splice(s.index, 1);
  // Only remove our table if no other settings have since been added to it.
  if (receipt.createdSection) {
    const again = sectionInfo(s.lines.join(s.newline));
    if (again.lines.slice(again.start + 1, again.end).every(line => /^\s*(?:#.*)?$/.test(line))) {
      s.lines.splice(again.start, 1);
    }
  }
  return s.lines.join(s.newline);
}

export function findPython(executable = process.platform === 'win32' ? 'python' : 'python3') {
  try {
    const info = JSON.parse(execFileSync(executable, ['-I', '-S', '-c', 'import sys,json; print(json.dumps([sys.executable, list(sys.version_info[:2])]))'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }));
    if (info[1][0] < 3 || info[1][0] === 3 && info[1][1] < 10) throw new Error('unsupported');
    return info[0];
  } catch { throw new Error('Python 3.10+ required. Use --python to select an existing executable.'); }
}

export function shellCommand(pythonPath, scriptPath, width = 120, platform = process.platform, modules = '', order = '') {
  if (!Number.isInteger(width) || width < 40 || width > 300) throw new Error('--width must be 40..300');
  const flags = [`--width ${width}`, '--color always'];
  for (const [flag, value] of [['--modules', modules], ['--order', order]]) {
    if (!value) continue;
    if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/.test(value)) {
      throw new Error(`${flag} must be a comma-separated module list`);
    }
    flags.push(`${flag} ${value}`);
  }
  const suffix = flags.join(' ');
  if (platform === 'win32') {
    // Kimi 2.2 的 cmd 包装会破坏双引号；路径编码保留空格和中文。
    // Kimi 2.2's cmd wrapper mangles quotes; encoding preserves spaces and Unicode paths.
    const runtime = /^[a-zA-Z]:[\\/][\w.\\/:-]+$/.test(pythonPath) ? pythonPath : 'python';
    if (/^[a-zA-Z]:[\\/][\w.\\/:-]+$/.test(scriptPath)) return `${runtime} -I -S ${scriptPath} ${suffix}`;
    const encoded = Buffer.from(scriptPath).toString('base64');
    return `${runtime} -I -S -c __import__('runpy').run_path(__import__('base64').b64decode('${encoded}').decode(),run_name='__main__') ${suffix}`;
  }
  const quote = value => {
    return `'${value.replaceAll("'", "'\\''")}'`;
  };
  return `${quote(pythonPath)} -I -S ${quote(scriptPath)} ${suffix}`;
}

export function probe(command, timeoutMs = 300) {
  // 与原生异步计时边界一致，不触发网络。 / Match the native async deadline without network refresh.
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', `${command} --no-quota`] : ['-c', `${command} --no-quota`],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, KIMI_CODE_STATUS_LINE: '1' } });
    const start = performance.now();
    let stdout = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut || code !== 0 || !stdout.includes('Kimi HUD')) {
        reject(new Error(`Status-line probe failed within ${timeoutMs}ms (${timedOut ? 'ETIMEDOUT' : code}). Config unchanged.`));
      } else resolve(Math.round(performance.now() - start));
    });
    child.stdin.end(JSON.stringify({ model: 'Kimi HUD', permissionMode: 'manual', contextUsage: 0.42 }));
  });
}

export async function install({ home, kimi = 'kimi', width = 120, uninstall = false, python, modules = '', order = '' }) {
  const root = path.resolve(home);
  const config = path.join(root, 'tui.toml');
  const installRoot = path.join(root, 'hud', 'kimi-code-monitor');
  const receiptFile = path.join(installRoot, 'current.json');
  const before = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
  let previous = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  if (uninstall) {
    if (!previous || previous.uninstalled) throw new Error('No active Kimi HUD installation found.');
    const after = restore(before, previous);
    fs.copyFileSync(config, path.join(installRoot, `tui-before-uninstall-${stamp}.toml`));
    fs.writeFileSync(config, after);
    fs.writeFileSync(receiptFile, JSON.stringify({ ...previous, uninstalled: true }, null, 2));
    return { uninstalled: true, config, retainedFiles: installRoot };
  }
  const version = execFileSync(kimi, ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();
  if (!compatibleVersion(version)) throw new Error(`Kimi Code >= 2.2.0 stable required; found ${version}`);
  if (previous?.uninstalled) previous = null;
  // Validate prior ownership before allocating a new release or touching config.
  if (previous) restore(before, previous);
  sectionInfo(before);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runtime = { kind: 'python', executable: findPython(python) };
  const bundle = path.join(repo, 'dist', 'quota-worker.cjs');
  if (!fs.existsSync(bundle)) throw new Error('Run npm run hud:build before installing.');
  const release = path.join(installRoot, 'releases', stamp);
  fs.mkdirSync(release, { recursive: true });
  fs.copyFileSync(path.join(repo, 'src', 'cli-hud', 'hud.py'), path.join(release, 'hud.py'));
  fs.copyFileSync(bundle, path.join(release, 'quota-worker.cjs'));
  fs.writeFileSync(path.join(release, 'quota-worker.json'), JSON.stringify({ node: process.execPath, script: path.join(release, 'quota-worker.cjs') }));
  fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(release, 'LICENSE'));
  const command = shellCommand(runtime.executable, path.join(release, 'hud.py'), width, process.platform, modules, order);
  const elapsedMs = await probe(command);
  const next = configure(before, command);
  const backup = path.join(installRoot, `tui-before-install-${stamp}.toml`);
  fs.writeFileSync(backup, before, { flag: 'wx' });
  // 更新保留最初设置。 / Keep the pre-install setting across repeated updates.
  const receipt = { schema: 1, installedAt: new Date().toISOString(), kimiVersion: version, runtime, command,
    line: next.line, originalLine: previous ? previous.originalLine : next.originalLine,
    createdSection: previous ? previous.createdSection : next.createdSection, config, backup, release, elapsedMs };
  const current = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
  if (current !== before) throw new Error('tui.toml changed during installation; no config was written. Retry.');
  // Save a recovery receipt before enabling the command; no old files are deleted.
  fs.writeFileSync(path.join(release, 'install-receipt.json'), JSON.stringify(receipt, null, 2));
  fs.writeFileSync(config, next.text);
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  try {
    if (args.includes('--help')) console.log('node scripts/install-cli-hud.mjs [--home DIR] [--kimi EXE] [--python EXE] [--width 120] [--modules LIST] [--order LIST] [--uninstall]\nBacks up tui.toml; installs using the public status_line.command interface.');
    else console.log(JSON.stringify(await install({ home: option('--home', process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code')),
      kimi: option('--kimi', 'kimi'), width: Number(option('--width', 120)), python: option('--python'),
      modules: option('--modules', ''), order: option('--order', ''), uninstall: args.includes('--uninstall') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
