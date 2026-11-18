import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const APP_NAME = 'Kimi Code';

export function appRootCandidates({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const out = [];
  if (env.KIMI_CODE_APP_DIR) out.push(env.KIMI_CODE_APP_DIR);
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) out.push(path.win32.join(env.LOCALAPPDATA, 'Programs', APP_NAME));
    out.push(path.win32.join('C:\\Program Files', APP_NAME));
    out.push(path.win32.join('D:\\kimi_code', APP_NAME));
  } else {
    out.push(path.posix.join('/Applications', `${APP_NAME}.app`));
    out.push(path.posix.join(home, 'Applications', `${APP_NAME}.app`));
  }
  return out;
}

export function distDirOf(appRoot, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (p.basename(appRoot) === 'desktop-dist') return appRoot;
  return platform === 'win32'
    ? p.join(appRoot, 'resources', 'desktop-dist')
    : p.join(appRoot, 'Contents', 'Resources', 'desktop-dist');
}

export function findClientApp({
  app = '',
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  const candidates = app ? [app] : appRootCandidates({ platform, env, home });
  const p = platform === 'win32' ? path.win32 : path.posix;
  return candidates.find((candidate) => existsSync(p.join(distDirOf(candidate, platform), 'index.html'))) || '';
}

export function readPanelVersion(appRoot, { platform = process.platform, fsImpl = fs } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const distDir = distDirOf(appRoot, platform);
  const panelDir = p.join(distDir, 'kcm');
  if (!fsImpl.existsSync(panelDir)) return { status: 'not-installed', version: '', distDir };

  const versionFile = p.join(panelDir, 'VERSION');
  if (!fsImpl.existsSync(versionFile)) return { status: 'unknown', version: '', distDir, reason: 'missing-version' };
  try {
    const version = fsImpl.readFileSync(versionFile, 'utf8').trim();
    if (!/^\d+(?:\.\d+)*$/.test(version)) return { status: 'unknown', version: '', distDir, reason: 'invalid-version' };
    return { status: 'installed', version, distDir };
  } catch {
    return { status: 'unknown', version: '', distDir, reason: 'unreadable-version' };
  }
}
