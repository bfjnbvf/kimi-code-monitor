/* Codex Pet 在线安装器（Web popup 与 Skill 共用）。
 *
 * 支持画廊网页链接、安装命令、slug 与 zip：
 * 1. awesome-codex-pet（GitHub 画廊）：
 *    curl -fsSL .../install-pet.sh | bash -s -- --raw-base <url> <pet-slug--author-slug>
 *    或只写 slug：tanjiro-kamado--wangfan002
 * 2. codex-pets.net（zip 画廊）：
 *    curl -L "https://codex-pets.net/api/pets/<name>/download?v=..." -o ...（只需其中的 URL）
 * 3. petdex.dev（脚本画廊）：
 *    curl -sSf https://petdex.dev/install/<slug> | sh
 *    安装脚本本身只是从 assets.petdex.dev 下载 pet.json + spritesheet.webp，
 *    这里只解析脚本里的素材地址，绝不执行脚本。
 *
 * 只下载素材（pet.json + spritesheet.webp），绝不执行任何安装脚本。
 * zip 用浏览器原生 DecompressionStream 解压，无第三方依赖。
 *
 * 经典脚本，popup 加载，全局暴露 CodexPetInstall。
 */
'use strict';

const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com/legeling/awesome-codex-pet/main';
const SLUG_RE = /[a-z0-9][a-z0-9-]*--[a-z0-9][a-z0-9-]*/;
const ZIP_URL_RE = /https:\/\/codex-pets\.net\/api\/pets\/[\w-]+\/download[^\s"'\\]*/;
const RAW_BASE_RE = /--raw-base\s+(https:\/\/[^\s"'\\]+)/;
const PETDEX_INSTALL_RE = /https:\/\/petdex\.dev\/install\/([a-z0-9][a-z0-9-]*)/;
// petdex 安装脚本里的素材地址（petjson.json / sprite.webp 都在 assets.petdex.dev 上）
const PETDEX_ASSET_RE = /https:\/\/assets\.petdex\.dev\/[^\s"'\\]+/g;
const PAGE_LIMIT = 2 * 1024 * 1024;
const HTTP_URL_RE = /https?:\/\/[^\s"'<>\\]+/g;

// zip 解压安全限制
const ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;

// 图集尺寸契约（与 pet-sprites.js 的 CELL_W/CELL_H 保持一致）
const CELL_W = 192;
const CELL_H = 208;
const COLS = 8;
const MIN_ROWS = 9;

/**
 * 解析用户输入，返回下载计划。
 * @returns {{kind:'slug', slug:string, rawBase:string} | {kind:'zip', url:string} | {kind:'petdex', url:string}}
 */
function parseInput(text) {
  const input = (text || '').trim();
  if (!input) throw new Error('请粘贴安装命令或宠物 slug');
  const zipMatch = input.match(ZIP_URL_RE);
  if (zipMatch) return { kind: 'zip', url: zipMatch[0] };
  const petdexMatch = input.match(PETDEX_INSTALL_RE);
  if (petdexMatch) return { kind: 'petdex', url: petdexMatch[0] };
  const slugMatch = input.match(SLUG_RE);
  if (slugMatch) {
    const baseMatch = input.match(RAW_BASE_RE);
    return { kind: 'slug', slug: slugMatch[0], rawBase: baseMatch ? baseMatch[1] : DEFAULT_RAW_BASE };
  }
  try {
    const url = new URL(input);
    if (['http:', 'https:'].includes(url.protocol)) {
      return { kind: url.pathname.toLowerCase().endsWith('.zip') ? 'zip' : 'page', url: url.href };
    }
  } catch {}
  throw new Error('格式错误');
}

/**
 * 解析 petdex 安装脚本，取出 pet.json 与 spritesheet.webp 的素材地址。
 * 脚本里文件名固定为 petjson.json / sprite.webp（与官方命名不同，注意区分）。
 * @returns {{petJsonUrl:string, spriteUrl:string}}
 */
function parsePetdexScript(scriptText) {
  const text = String(scriptText || '');
  const urls = text.match(PETDEX_ASSET_RE) || [];
  const petJsonUrl = urls.find((u) => u.endsWith('/petjson.json'));
  const spriteUrl = urls.find((u) => u.endsWith('/sprite.webp'));
  if (!petJsonUrl || !spriteUrl) throw new Error('petdex 安装脚本里没找到素材地址');
  return { petJsonUrl, spriteUrl };
}

function parsePage(html, pageUrl) {
  const text = String(html || '');
  const petdexInstall = text.match(PETDEX_INSTALL_RE);
  if (petdexInstall) return { kind: 'petdex', url: petdexInstall[0] };
  const rawBase = text.match(RAW_BASE_RE);
  const slug = text.match(SLUG_RE);
  if (rawBase && slug) return { kind: 'slug', slug: slug[0], rawBase: rawBase[1] };
  const knownZip = text.match(ZIP_URL_RE);
  if (knownZip) return { kind: 'zip', url: knownZip[0] };
  try {
    const pair = parsePetdexScript(text);
    if (pair) return { kind: 'pair', ...pair };
  } catch {}

  const urls = [];
  for (const match of text.matchAll(HTTP_URL_RE)) urls.push(match[0]);
  for (const match of text.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) urls.push(match[1]);
  const absolute = [...new Set(urls.map((value) => {
    try { return new URL(value.replace(/&amp;/g, '&'), pageUrl).href; } catch { return ''; }
  }).filter(Boolean))];
  const petJsonUrl = absolute.find((url) => /\/(?:petjson\.json|pet\.json)(?:[?#]|$)/i.test(url));
  const spriteUrl = absolute.find((url) => /\/(?:sprite|spritesheet)\.(?:webp|png)(?:[?#]|$)/i.test(url));
  if (petJsonUrl && spriteUrl) return { kind: 'pair', petJsonUrl, spriteUrl };
  const zip = absolute.find((url) => new URL(url).pathname.toLowerCase().endsWith('.zip'));
  if (zip) return { kind: 'zip', url: zip };
  throw new Error('网页里未找到宠物素材或安装入口');
}

async function readStreamWithLimit(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel(new Error('文件过大，已中止')).catch(() => {});
        throw new Error('文件过大，已中止');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function fetchBytes(url, maxBytes = 16 * 1024 * 1024) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败（${resp.status}）：${url}`);
  // Content-Length 只做预检；实际字节必须在流式读取过程中限量。
  const declared = Number(resp.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await resp.body?.cancel().catch(() => {});
    throw new Error('文件过大，已中止');
  }
  if (!resp.body) {
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new Error('文件过大，已中止');
    return buf;
  }
  return (await readStreamWithLimit(resp.body, maxBytes)).buffer;
}

/* ---------- 最小 ZIP 读取器（local file header 顺序读取，支持 store/deflate） ---------- */

async function inflateRaw(bytes, maxBytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return readStreamWithLimit(stream, maxBytes);
}

function basename(name) {
  const idx = String(name || '').lastIndexOf('/');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

function isDangerousPath(name) {
  if (!name || typeof name !== 'string') return true;
  if (name.includes('\0')) return true;
  if (name.startsWith('/') || name.startsWith('\\')) return true;
  for (const part of name.split('/')) {
    if (part === '..') return true;
  }
  return false;
}

// 从末尾找 EOCD，返回 central directory 偏移与记录数；找不到返回 null
function findCentralDirectory(bytes, view) {
  // EOCD 签名 0x06054b50，comment 最长 65535，从后往前扫
  const maxCommentLen = 65535;
  const start = Math.max(0, bytes.length - 22 - maxCommentLen);
  for (let pos = bytes.length - 22; pos >= start; pos -= 1) {
    if (view.getUint32(pos, true) === 0x06054b50) {
      const totalRecords = view.getUint16(pos + 10, true);
      const cdSize = view.getUint32(pos + 12, true);
      const cdOffset = view.getUint32(pos + 16, true);
      return { totalRecords, cdSize, cdOffset };
    }
  }
  return null;
}

// 解析 central directory，校验文件名与 size 字段和 local header 一致
function validateCentralDirectory(bytes, view, localEntries) {
  const cd = findCentralDirectory(bytes, view);
  if (!cd) return; // 无 CD 的 zip 不强制校验
  let pos = cd.cdOffset;
  const decoder = new TextDecoder();
  const cdEntries = new Map();
  for (let i = 0; i < cd.totalRecords && pos + 46 <= bytes.length; i += 1) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    cdEntries.set(name, { method, compressedSize, uncompressedSize });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  for (const [name, local] of localEntries) {
    const cdEntry = cdEntries.get(name);
    if (!cdEntry) continue; // CD 可能不含某些条目（如目录）
    if (cdEntry.method !== local.method ||
        cdEntry.compressedSize !== local.compressedSize ||
        cdEntry.uncompressedSize !== local.uncompressedSize) {
      throw new Error(`zip central directory 与 local header 不一致：${name}`);
    }
  }
}

/**
 * 解出 zip 里的全部文件。
 * @param {ArrayBuffer} buf
 * @returns {Promise<Map<string, Uint8Array>>} 文件名 → 内容
 */
async function unzip(buf) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const files = new Map();
  const localEntries = new Map();
  let pos = 0;
  let totalUncompressed = 0;
  const decoder = new TextDecoder();
  while (pos + 30 <= bytes.length) {
    if (view.getUint32(pos, true) !== 0x04034b50) break; // local file header 签名
    const method = view.getUint16(pos + 8, true);
    const compressedSize = view.getUint32(pos + 18, true);
    const uncompressedSize = view.getUint32(pos + 22, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const name = decoder.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    const dataStart = pos + 30 + nameLen + extraLen;

    if (dataStart + compressedSize > bytes.length) {
      throw new Error('zip local header 声明尺寸超出文件范围');
    }
    if (isDangerousPath(name)) {
      throw new Error(`zip 条目路径不合法：${name}`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`不支持的 zip 压缩方式（method ${method}）`);
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new Error(`zip store 方式大小不一致：${name}`);
    }

    const remainingTotal = ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES - totalUncompressed;
    const maxOutput = Math.min(ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES, remainingTotal);
    // header 只做提前拒绝；deflate 实际输出仍由 inflateRaw 流式限量。
    if (uncompressedSize > ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error('zip 单文件解压后大小超出安全限制');
    }
    if (uncompressedSize > remainingTotal) {
      throw new Error('zip 总解压大小超出安全限制');
    }

    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    let output;
    if (method === 0) {
      output = data.slice();
    } else {
      output = await inflateRaw(data, maxOutput);
      if (output.length !== uncompressedSize) {
        throw new Error(`zip 解压长度与 header 声明不一致：${name}`);
      }
    }

    totalUncompressed += output.length;

    if (name && !name.endsWith('/')) {
      files.set(name, output);
      localEntries.set(name, { method, compressedSize, uncompressedSize });
    }
    pos = dataStart + compressedSize;
  }

  validateCentralDirectory(bytes, view, localEntries);

  if (files.size === 0) throw new Error('zip 里没有可读文件');
  return files;
}

function toDataUrl(bytes, mime) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function imageMime(bytes) {
  const data = Uint8Array.from(bytes);
  const text = (offset, length) => String.fromCharCode(...data.subarray(offset, offset + length));
  if (data.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return 'image/webp';
  if (data.length >= 8 && data[0] === 0x89 && text(1, 3) === 'PNG' && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return 'image/png';
  }
  throw new Error('宠物图集必须是 WebP 或 PNG');
}

async function fetchPetData(plan, sourceUrl = '') {
  let petJsonText = null;
  let imageBytes = null;
  let source = '';
  let author = '';

  if (plan.kind === 'page') {
    const html = new TextDecoder().decode(await fetchBytes(plan.url, PAGE_LIMIT));
    return fetchPetData(parsePage(html, plan.url), plan.url);
  }
  if (plan.kind === 'slug') {
    source = 'awesome-codex-pet';
    author = plan.slug.split('--', 2)[1] || '';
    const base = `${plan.rawBase}/pets/${plan.slug}`;
    petJsonText = new TextDecoder().decode(await fetchBytes(`${base}/pet.json`, 64 * 1024));
    imageBytes = new Uint8Array(await fetchBytes(`${base}/spritesheet.webp`));
  } else if (plan.kind === 'petdex') {
    source = 'petdex.dev';
    const scriptText = new TextDecoder().decode(await fetchBytes(plan.url, PAGE_LIMIT));
    const { petJsonUrl, spriteUrl } = parsePetdexScript(scriptText);
    petJsonText = new TextDecoder().decode(await fetchBytes(petJsonUrl, 64 * 1024));
    imageBytes = new Uint8Array(await fetchBytes(spriteUrl));
  } else if (plan.kind === 'pair') {
    source = new URL(plan.petJsonUrl).hostname;
    petJsonText = new TextDecoder().decode(await fetchBytes(plan.petJsonUrl, 64 * 1024));
    imageBytes = new Uint8Array(await fetchBytes(plan.spriteUrl));
  } else {
    source = new URL(plan.url).hostname;
    const files = await unzip(await fetchBytes(plan.url));
    const jsonName = [...files.keys()].find((n) => basename(n) === 'pet.json');
    const imageName = [...files.keys()].find((n) => basename(n) === 'spritesheet.webp')
      || [...files.keys()].find((n) => basename(n) === 'spritesheet.png');
    if (!jsonName || !imageName) throw new Error('zip 里缺少 pet.json 或 spritesheet.webp/png');
    petJsonText = new TextDecoder().decode(files.get(jsonName));
    imageBytes = files.get(imageName);
  }

  let petJson = {};
  try {
    petJson = JSON.parse(petJsonText);
  } catch {
    throw new Error('pet.json 解析失败');
  }
  return {
    imageBytes,
    mime: imageMime(imageBytes),
    info: {
      id: petJson.id || petJson.pet_id || '',
      name: petJson.displayName || petJson.display_name || petJson.id || petJson.pet_id || '未命名',
      author,
      source,
      sourceUrl: sourceUrl || plan.url || source
    }
  };
}

/**
 * 按下载计划取回宠物素材。
 * @returns {Promise<{dataUrl:string, info:{id:string,name:string,author:string,source:string}}>}
 */
async function fetchPet(plan) {
  const { imageBytes, mime, info } = await fetchPetData(plan);
  const blobUrl = URL.createObjectURL(new Blob([imageBytes], { type: mime }));
  try {
    const im = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('宠物图集不是有效图片'));
      i.src = blobUrl;
    });
    if (im.width !== CELL_W * COLS || im.height % CELL_H !== 0 || im.height < CELL_H * MIN_ROWS) {
      throw new Error(`图集尺寸 ${im.width}x${im.height} 不符合 Codex 契约（${CELL_W * COLS}x${CELL_H * MIN_ROWS} 起）`);
    }
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  return { dataUrl: toDataUrl(imageBytes, mime), info };
}

const CodexPetInstall = { parseInput, parsePetdexScript, parsePage, fetchPetData, fetchPet, unzip };

export { parseInput, parsePetdexScript, parsePage, fetchPetData, fetchPet, fetchBytes, unzip, CodexPetInstall };
