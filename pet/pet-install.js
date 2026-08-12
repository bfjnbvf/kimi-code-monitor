/* Codex Pet 在线安装器（popup 侧）。
 *
 * 支持两种输入（直接粘贴画廊的安装命令即可）：
 * 1. awesome-codex-pet（GitHub 画廊）：
 *    curl -fsSL .../install-pet.sh | bash -s -- --raw-base <url> <pet-slug--author-slug>
 *    或只写 slug：tanjiro-kamado--wangfan002
 * 2. codex-pets.net（zip 画廊）：
 *    curl -L "https://codex-pets.net/api/pets/<name>/download?v=..." -o ...（只需其中的 URL）
 *
 * 只下载素材（pet.json + spritesheet.webp），绝不执行任何安装脚本。
 * zip 用浏览器原生 DecompressionStream 解压，无第三方依赖。
 *
 * 经典脚本，popup 加载，全局暴露 CodexPetInstall。
 */
(() => {
  'use strict';

  const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com/legeling/awesome-codex-pet/main';
  const SLUG_RE = /[a-z0-9][a-z0-9-]*--[a-z0-9][a-z0-9-]*/;
  const ZIP_URL_RE = /https:\/\/codex-pets\.net\/api\/pets\/[\w-]+\/download[^\s"'\\]*/;
  const RAW_BASE_RE = /--raw-base\s+(https:\/\/[^\s"'\\]+)/;

  /**
   * 解析用户输入，返回下载计划。
   * @returns {{kind:'slug', slug:string, rawBase:string} | {kind:'zip', url:string}}
   */
  function parseInput(text) {
    const input = (text || '').trim();
    if (!input) throw new Error('请粘贴安装命令或宠物 slug');
    const zipMatch = input.match(ZIP_URL_RE);
    if (zipMatch) return { kind: 'zip', url: zipMatch[0] };
    const slugMatch = input.match(SLUG_RE);
    if (slugMatch) {
      const baseMatch = input.match(RAW_BASE_RE);
      return { kind: 'slug', slug: slugMatch[0], rawBase: baseMatch ? baseMatch[1] : DEFAULT_RAW_BASE };
    }
    throw new Error('格式错误');
  }

  async function fetchBytes(url, maxBytes = 16 * 1024 * 1024) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`下载失败（${resp.status}）：${url}`);
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new Error('文件过大，已中止');
    return buf;
  }

  /* ---------- 最小 ZIP 读取器（local file header 顺序读取，支持 store/deflate） ---------- */

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
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
    let pos = 0;
    const decoder = new TextDecoder();
    while (pos + 30 <= bytes.length) {
      if (view.getUint32(pos, true) !== 0x04034b50) break; // local file header 签名
      const method = view.getUint16(pos + 8, true);
      const compressedSize = view.getUint32(pos + 18, true);
      const nameLen = view.getUint16(pos + 26, true);
      const extraLen = view.getUint16(pos + 28, true);
      const name = decoder.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
      const dataStart = pos + 30 + nameLen + extraLen;
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      if (name && !name.endsWith('/')) {
        if (method === 0) files.set(name, data.slice());
        else if (method === 8) files.set(name, await inflateRaw(data));
        else throw new Error(`不支持的 zip 压缩方式（method ${method}）`);
      }
      pos = dataStart + compressedSize;
    }
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

  /**
   * 按下载计划取回宠物素材。
   * @returns {Promise<{dataUrl:string, info:{id:string,name:string,author:string,source:string}}>}
   */
  async function fetchPet(plan) {
    let petJsonText = null;
    let webpBytes = null;
    let source = '';
    let author = '';

    if (plan.kind === 'slug') {
      source = 'awesome-codex-pet';
      author = plan.slug.split('--', 2)[1] || '';
      const base = `${plan.rawBase}/pets/${plan.slug}`;
      petJsonText = new TextDecoder().decode(await fetchBytes(`${base}/pet.json`, 64 * 1024));
      webpBytes = new Uint8Array(await fetchBytes(`${base}/spritesheet.webp`));
    } else {
      source = 'codex-pets.net';
      const files = await unzip(await fetchBytes(plan.url));
      const jsonName = [...files.keys()].find((n) => n.endsWith('pet.json'));
      const webpName = [...files.keys()].find((n) => n.endsWith('spritesheet.webp'));
      if (!jsonName || !webpName) throw new Error('zip 里缺少 pet.json 或 spritesheet.webp');
      petJsonText = new TextDecoder().decode(files.get(jsonName));
      webpBytes = files.get(webpName);
    }

    let petJson = {};
    try {
      petJson = JSON.parse(petJsonText);
    } catch (e) {
      throw new Error('pet.json 解析失败');
    }

    // 图集尺寸校验（官方契约：宽 1536，高为 208 的倍数且至少 9 行）
    const blobUrl = URL.createObjectURL(new Blob([webpBytes], { type: 'image/webp' }));
    try {
      const im = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('spritesheet.webp 不是有效图片'));
        i.src = blobUrl;
      });
      if (im.width !== 1536 || im.height % 208 !== 0 || im.height < 1872) {
        throw new Error(`图集尺寸 ${im.width}x${im.height} 不符合 Codex 契约（1536x1872 起）`);
      }
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    return {
      dataUrl: toDataUrl(webpBytes, 'image/webp'),
      info: {
        id: petJson.id || '',
        name: petJson.displayName || petJson.id || '未命名',
        author: author || '',
        source
      }
    };
  }

  globalThis.CodexPetInstall = { parseInput, fetchPet, unzip };
})();
