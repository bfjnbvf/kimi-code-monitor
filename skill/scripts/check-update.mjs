#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findClientApp, readPanelVersion } from '../../src/client-app.mjs';

const REMOTE_MAINTENANCE = 'https://raw.githubusercontent.com/bfjnbvf/kimi-code-monitor/main/skill/MAINTENANCE.md';
const RELEASE_PATH = /^\/bfjnbvf\/kimi-code-monitor\/releases\/download\/[^/]+\/[^/]+$/;

export function compareVersions(left, right) {
  const parse = (value) => {
    const text = String(value).trim();
    if (!/^\d+(?:\.\d+)*$/.test(text)) throw new Error(`无效版本号：${value}`);
    return text.split('.').map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function isOfficialReleaseDownload(value) {
  if (/\\|%2f|%5c/i.test(value)) return false;
  let decoded;
  let url;
  try {
    decoded = decodeURIComponent(value);
    url = new URL(value);
  } catch {
    return false;
  }
  const dotSegment = /(?:^|\/)\.\.?(?:[/?#]|$)/;
  if (dotSegment.test(value) || dotSegment.test(decoded) || url.search || url.hash) return false;
  return url.protocol === 'https:' && url.host === 'github.com' && !url.username && !url.password && RELEASE_PATH.test(url.pathname);
}

export function parseMaintenance(text) {
  const field = (name) => text.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1].trim() || '';
  const result = {
    skillVersion: field('skill-version'),
    patchVersion: field('patch-version'),
    skillDownload: field('skill-download'),
    patchDownload: field('patch-download'),
  };
  for (const [key, value] of Object.entries(result)) {
    if (!value) throw new Error(`远端说明书缺少字段：${key}`);
  }
  compareVersions(result.skillVersion, result.skillVersion);
  compareVersions(result.patchVersion, result.patchVersion);
  if (!isOfficialReleaseDownload(result.skillDownload) || !isOfficialReleaseDownload(result.patchDownload)) {
    throw new Error('远端说明书包含非官方或无效下载地址');
  }
  return result;
}

export function decideUpdate({ localSkillVersion, remoteSkillVersion, remotePatchVersion, panel }) {
  const skillComparison = compareVersions(localSkillVersion, remoteSkillVersion);
  const skillStatus = skillComparison < 0 ? 'update' : skillComparison > 0 ? 'ahead' : 'up-to-date';
  let patchStatus;
  if (panel.status === 'not-installed') patchStatus = 'not-installed';
  else if (panel.status !== 'installed') patchStatus = 'unknown';
  else {
    const patchComparison = compareVersions(panel.version, remotePatchVersion);
    patchStatus = patchComparison < 0 ? 'update' : patchComparison > 0 ? 'ahead' : 'up-to-date';
  }

  const actions = [];
  if (skillStatus === 'update') actions.push('skill');
  if (patchStatus === 'update') actions.push('patch');
  else if (patchStatus === 'not-installed') actions.push('install');
  else if (patchStatus === 'unknown') actions.push('doctor');

  return {
    skill: { status: skillStatus, local: localSkillVersion, remote: remoteSkillVersion },
    patch: { status: patchStatus, local: panel.version || null, remote: remotePatchVersion },
    actions,
  };
}

function fetchText(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'kimi-code-monitor-update-check' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft === 0) {
          reject(new Error('远端说明书重定向次数过多'));
          return;
        }
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') {
          reject(new Error('远端说明书重定向到了非 HTTPS 地址'));
          return;
        }
        resolve(fetchText(next.href, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        const error = new Error(`远端说明书 HTTP ${res.statusCode}`);
        error.statusCode = res.statusCode;
        reject(error);
        return;
      }
      res.setEncoding('utf8');
      let text = '';
      res.on('data', (chunk) => {
        text += chunk;
        if (text.length > 1024 * 1024) req.destroy(new Error('远端说明书超过 1 MiB'));
      });
      res.on('end', () => resolve(text));
    });
    req.setTimeout(15000, () => req.destroy(new Error('远端说明书请求超时')));
    req.on('error', reject);
  });
}

function localSkillVersion() {
  const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const primary = path.join(skillRoot, 'MAINTENANCE.md');
  const file = fs.existsSync(primary) ? primary : path.join(skillRoot, 'MAINTENANCE');
  const text = fs.readFileSync(file, 'utf8');
  const version = text.match(/^skill-version:\s*(.+)$/m)?.[1].trim();
  if (!version) throw new Error('本地技能说明书缺少 skill-version');
  return version;
}

function printHuman(result) {
  console.log(`INFO  客户端：${result.app}`);
  console.log(`INFO  本地技能：${result.local.skillVersion}`);
  console.log(`INFO  本地面板：${result.local.patchVersion || (result.local.panelStatus === 'not-installed' ? '未安装' : '未知')}`);
  console.log(`INFO  远端技能：${result.remote.skillVersion}`);
  console.log(`INFO  远端面板：${result.remote.patchVersion}`);
  for (const [name, component] of [['SKILL', result.skill], ['PATCH', result.patch]]) {
    if (component.status === 'update') console.log(`${name}  需要更新（${component.local} → ${component.remote}）`);
    else if (component.status === 'up-to-date') console.log(`${name}  已是最新（${component.local}）`);
    else if (component.status === 'ahead') console.log(`${name}  本地版本高于远端（${component.local} > ${component.remote}），不降级`);
    else if (component.status === 'not-installed') console.log(`${name}  面板未安装，需要安装 ${component.remote}`);
    else console.log(`${name}  版本未知，请先运行 doctor.mjs`);
  }
  const labels = { skill: '更新技能', patch: '更新面板', install: '安装面板', doctor: '先自检面板' };
  const summary = result.actions.length ? result.actions.map((action) => labels[action]).join(' · ') : '无需更新';
  if (result.actions.length === 1 && result.actions[0] === 'patch') console.log('SUMMARY  仅更新面板');
  else
  console.log(`SUMMARY  ${summary}`);
}

async function main() {
  const args = process.argv.slice(2);
  let appArg = '';
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--app') appArg = args[(i += 1)] || '';
    else if (args[i].startsWith('--app=')) appArg = args[i].slice(6);
    else if (args[i] === '--json') json = true;
    else throw new Error(`未知参数：${args[i]}`);
  }

  const app = findClientApp({ app: appArg });
  if (!app) throw new Error('未找到 Kimi Code 桌面客户端；可用 --app 指定客户端目录');
  const panel = readPanelVersion(app);
  const local = localSkillVersion();
  const remote = parseMaintenance(await fetchText(REMOTE_MAINTENANCE));
  const plan = decideUpdate({
    localSkillVersion: local,
    remoteSkillVersion: remote.skillVersion,
    remotePatchVersion: remote.patchVersion,
    panel,
  });
  const result = {
    app,
    distDir: panel.distDir,
    local: { skillVersion: local, patchVersion: panel.version || null, panelStatus: panel.status },
    remote,
    ...plan,
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`FAIL  ${error.message}`);
    process.exitCode = 1;
  });
}
