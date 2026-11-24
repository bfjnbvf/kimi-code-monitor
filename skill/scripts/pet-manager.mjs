#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findClientApp, distDirOf } from '../../src/client-app.mjs';
import { fetchPetData, parseInput } from '../../src/pet/install.js';

const CELL_HEIGHT = 208;
const ATLAS_WIDTH = 1536;
const MIN_ATLAS_HEIGHT = 1872;

export function petHome(env = process.env) {
  const kimiHome = env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  return path.join(kimiHome, 'kcm', 'pets');
}

function defaultConfig() {
  return { enabled: false, activeId: '', scale: 100, revision: 0 };
}

function normalizeConfig(raw) {
  const scale = Number(raw?.scale);
  return {
    enabled: raw?.enabled === true,
    activeId: typeof raw?.activeId === 'string' ? raw.activeId : '',
    scale: Number.isFinite(scale) ? Math.min(150, Math.max(50, Math.round(scale))) : 100,
    revision: Number.isFinite(raw?.revision) ? raw.revision : 0
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function readLibrary(home) {
  const config = normalizeConfig(readJson(path.join(home, 'config.json'), {}));
  const rawPets = readJson(path.join(home, 'pets.json'), []);
  const pets = Array.isArray(rawPets) ? rawPets.filter((pet) =>
    pet && /^pet-[a-z0-9-]+$/.test(pet.id) && typeof pet.name === 'string'
  ) : [];
  if (config.activeId && !pets.some((pet) => pet.id === config.activeId)) config.activeId = '';
  if (!config.activeId) config.enabled = false;
  return { config, pets };
}

function saveLibrary(home, config, pets) {
  writeJson(path.join(home, 'config.json'), config);
  writeJson(path.join(home, 'pets.json'), pets);
}

function touch(config) {
  config.revision = Math.max(Date.now(), config.revision + 1);
}

function assetExtension(pet) {
  return pet?.assetExt === 'png' ? 'png' : 'webp';
}

function assetPath(home, pet) {
  return path.join(home, 'assets', `${pet.id}.${assetExtension(pet)}`);
}

export function webpDimensions(bytes) {
  const data = Uint8Array.from(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const text = (offset, length) => String.fromCharCode(...data.subarray(offset, offset + length));
  if (data.length < 20 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WEBP') {
    throw new Error('spritesheet.webp 不是有效 WebP 图片');
  }
  let offset = 12;
  while (offset + 8 <= data.length) {
    const type = text(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + size > data.length) break;
    if (type === 'VP8X' && size >= 10) {
      return {
        width: 1 + data[payload + 4] + (data[payload + 5] << 8) + (data[payload + 6] << 16),
        height: 1 + data[payload + 7] + (data[payload + 8] << 8) + (data[payload + 9] << 16)
      };
    }
    if (type === 'VP8 ' && size >= 10 && data[payload + 3] === 0x9d && data[payload + 4] === 0x01 && data[payload + 5] === 0x2a) {
      return {
        width: view.getUint16(payload + 6, true) & 0x3fff,
        height: view.getUint16(payload + 8, true) & 0x3fff
      };
    }
    if (type === 'VP8L' && size >= 5 && data[payload] === 0x2f) {
      const bits = data[payload + 1] + (data[payload + 2] << 8) + (data[payload + 3] << 16) + (data[payload + 4] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    offset = payload + size + (size % 2);
  }
  throw new Error('无法读取 WebP 图集尺寸');
}

export function pngDimensions(bytes) {
  const data = Uint8Array.from(bytes);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length < 24 || !signature.every((value, index) => data[index] === value) || String.fromCharCode(...data.subarray(12, 16)) !== 'IHDR') {
    throw new Error('spritesheet.png 不是有效 PNG 图片');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

function imageDimensions(bytes, mime) {
  return mime === 'image/png' ? pngDimensions(bytes) : webpDimensions(bytes);
}

function validateAtlas(bytes, mime) {
  const { width, height } = imageDimensions(bytes, mime);
  if (width !== ATLAS_WIDTH || height % CELL_HEIGHT !== 0 || height < MIN_ATLAS_HEIGHT) {
    throw new Error(`图集尺寸 ${width}x${height} 不符合 Codex 契约（${ATLAS_WIDTH}x${MIN_ATLAS_HEIGHT} 起）`);
  }
}

export function publishPet(home, config, pets, appArg = '') {
  const app = findClientApp({ app: appArg });
  if (!app) throw new Error('未找到 Kimi Code 客户端；可用 --app 指定客户端目录');
  const payload = path.join(distDirOf(app), 'kcm');
  if (!fs.existsSync(path.join(payload, 'loader.js'))) throw new Error('客户端尚未安装面板补丁，请先安装面板');
  const runtime = path.join(payload, 'pet');
  fs.mkdirSync(runtime, { recursive: true });
  const active = pets.find((pet) => pet.id === config.activeId);
  if (config.enabled && !active) throw new Error('当前宠物不存在，请先安装或切换宠物');
  const assetExt = active ? assetExtension(active) : 'webp';
  if (active) {
    const source = assetPath(home, active);
    if (!fs.existsSync(source)) throw new Error(`宠物素材缺失：${active.name}，请重新安装`);
    const temp = path.join(runtime, `active.tmp-${process.pid}.${assetExt}`);
    fs.copyFileSync(source, temp);
    fs.renameSync(temp, path.join(runtime, `active.${assetExt}`));
    const otherExt = assetExt === 'png' ? 'webp' : 'png';
    fs.rmSync(path.join(runtime, `active.${otherExt}`), { force: true });
  } else {
    fs.rmSync(path.join(runtime, 'active.webp'), { force: true });
    fs.rmSync(path.join(runtime, 'active.png'), { force: true });
  }
  const publicConfig = {
    enabled: config.enabled,
    activeId: config.activeId,
    scale: config.scale,
    revision: config.revision,
    assetExt
  };
  const target = path.join(runtime, 'config.js');
  const temp = path.join(runtime, `config.tmp-${process.pid}.js`);
  fs.writeFileSync(temp, `window.__kcmPetConfig = ${JSON.stringify(publicConfig)};\n`);
  fs.renameSync(temp, target);
  return { app, runtime, config: publicConfig };
}

async function downloadAndAdd(home, config, pets, input) {
  const { imageBytes, mime, info } = await fetchPetData(parseInput(input));
  validateAtlas(imageBytes, mime);
  const existing = pets.find((pet) => pet.sourceUrl && pet.sourceUrl === info.sourceUrl);
  const id = existing?.id || `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    originalId: String(info.id || '').slice(0, 200),
    name: String(info.name || '未命名').slice(0, 200),
    author: String(info.author || '').slice(0, 200),
    source: String(info.source || '').slice(0, 200),
    sourceUrl: String(info.sourceUrl || '').slice(0, 2000),
    addedAt: existing?.addedAt || Date.now(),
    assetExt: mime === 'image/png' ? 'png' : 'webp'
  };
  const previousTarget = existing ? assetPath(home, existing) : '';
  const target = assetPath(home, record);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, imageBytes);
  fs.renameSync(temp, target);
  if (previousTarget && previousTarget !== target) fs.rmSync(previousTarget, { force: true });
  const index = pets.findIndex((pet) => pet.id === id);
  if (index >= 0) pets[index] = record;
  else pets.push(record);
  config.activeId = id;
  touch(config);
  saveLibrary(home, config, pets);
  return record;
}

function findPet(pets, value) {
  const needle = String(value || '').trim().toLowerCase();
  const matches = pets.filter((pet) => pet.id.toLowerCase() === needle || pet.name.toLowerCase() === needle);
  if (!matches.length) throw new Error(`没有找到宠物：${value}`);
  if (matches.length > 1) throw new Error(`名称不唯一，请使用宠物 ID：${matches.map((pet) => pet.id).join(', ')}`);
  return matches[0];
}

export async function managePet(action, value, { home = petHome(), app = '', installer = downloadAndAdd } = {}) {
  const { config, pets } = readLibrary(home);
  if (action === 'status') return { config, pets };
  if (action === 'list') return { pets };
  if (action === 'enable') {
    if (!findClientApp({ app })) throw new Error('未找到 Kimi Code 客户端；可用 --app 指定客户端目录');
    if (!config.activeId && pets.length) config.activeId = pets[0].id;
    if (!config.activeId) return { config, pets, active: null, needsInstall: true };
    config.enabled = true;
  } else if (action === 'disable') config.enabled = false;
  else if (action === 'install') {
    if (!value) throw new Error('请提供宠物网页链接、安装命令或 slug');
    await installer(home, config, pets, value);
    config.enabled = true;
  } else if (action === 'switch') {
    config.activeId = findPet(pets, value).id;
  } else if (action === 'scale') {
    const scale = Number(value);
    if (!Number.isFinite(scale)) throw new Error('大小必须是 50–150 的数字');
    config.scale = Math.min(150, Math.max(50, Math.round(scale)));
  } else if (action === 'remove') {
    const pet = findPet(pets, value);
    pets.splice(pets.indexOf(pet), 1);
    fs.rmSync(assetPath(home, pet), { force: true });
    if (config.activeId === pet.id) config.activeId = pets[0]?.id || '';
    if (!config.activeId) config.enabled = false;
  } else if (action !== 'repair') throw new Error(`未知操作：${action}`);
  touch(config);
  saveLibrary(home, config, pets);
  const published = publishPet(home, config, pets, app);
  return { config, pets, active: pets.find((pet) => pet.id === config.activeId) || null, runtime: published.runtime };
}

function parseArgs(argv) {
  const positional = [];
  let app = '';
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app') app = argv[++i] || '';
    else if (argv[i].startsWith('--app=')) app = argv[i].slice(6);
    else if (argv[i] === '--json') json = true;
    else positional.push(argv[i]);
  }
  return { action: positional[0] || 'status', value: positional.slice(1).join(' '), app, json };
}

function printHuman(action, result) {
  if (action === 'list') {
    if (!result.pets.length) console.log('尚未安装宠物');
    for (const pet of result.pets) console.log(`${pet.id}\t${pet.name}${pet.author ? ` by ${pet.author}` : ''}`);
    return;
  }
  if (result.needsInstall) {
    console.log('尚未安装宠物，请先提供宠物网页链接；不会自动下载默认宠物。');
    return;
  }
  const active = result.active || result.pets.find((pet) => pet.id === result.config.activeId);
  console.log(`宠物功能：${result.config.enabled ? '已开启' : '已关闭'}`);
  console.log(`当前宠物：${active?.name || '无'}`);
  console.log(`大小：${result.config.scale}%`);
  console.log(`已安装：${result.pets.length} 只`);
  if (result.runtime) console.log('客户端配置已更新，宠物会在约 1 秒内生效');
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  managePet(args.action, args.value, { app: args.app }).then((result) => {
    if (args.json) console.log(JSON.stringify({ ok: true, action: args.action, ...result }, null, 2));
    else printHuman(args.action, result);
  }).catch((error) => {
    console.error(`FAIL  ${error.message}`);
    process.exitCode = 1;
  });
}
