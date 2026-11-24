import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { managePet, petHome, webpDimensions, pngDimensions } from '../skill/scripts/pet-manager.mjs';

function makeAtlas(width = 1536, height = 1872) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8);
  bytes.write('VP8X', 12);
  bytes.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 255;
  bytes[25] = (w >> 8) & 255;
  bytes[26] = (w >> 16) & 255;
  bytes[27] = h & 255;
  bytes[28] = (h >> 8) & 255;
  bytes[29] = (h >> 16) & 255;
  return bytes;
}

function makePngAtlas(width = 1536, height = 1872) {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function makeClient(root) {
  const dist = path.join(root, 'app', 'Contents', 'Resources', 'desktop-dist');
  fs.mkdirSync(path.join(dist, 'kcm'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(dist, 'kcm', 'loader.js'), '// loader');
  return { app: path.join(root, 'app'), runtime: path.join(dist, 'kcm', 'pet') };
}

test('WebP 尺寸读取：支持 VP8X 并拒绝非 WebP', () => {
  assert.deepEqual(webpDimensions(makeAtlas()), { width: 1536, height: 1872 });
  assert.throws(() => webpDimensions(Buffer.from('not an image')), /WebP/);
});

test('PNG 尺寸读取：支持 IHDR 并拒绝非 PNG', () => {
  assert.deepEqual(pngDimensions(makePngAtlas()), { width: 1536, height: 1872 });
  assert.throws(() => pngDimensions(Buffer.from('not an image')), /PNG/);
});

test('宠物管理：网页安装、持久化、启停、缩放、修复与删除', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-pet-manager-'));
  const atlas = makeAtlas();
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    if (req.url === '/gallery/demo') {
      res.setHeader('content-type', 'text/html');
      res.end('<a href="/meta/pet.json">资料</a><img src="/images/spritesheet.webp">');
    } else if (req.url === '/meta/pet.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'demo', display_name: 'Demo Pet' }));
    } else if (req.url === '/images/spritesheet.webp') {
      res.setHeader('content-type', 'image/webp');
      res.end(atlas);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const kimiHome = path.join(work, 'home');
  const home = petHome({ KIMI_CODE_HOME: kimiHome });
  const { app, runtime } = makeClient(work);
  try {
    const empty = await managePet('status', '', { home, app });
    assert.equal(empty.config.enabled, false);
    assert.equal(requests, 0, '默认状态查询不应下载任何内容');

    const emptyEnable = await managePet('enable', '', { home, app });
    assert.equal(emptyEnable.needsInstall, true);
    assert.equal(emptyEnable.config.enabled, false);
    assert.equal(emptyEnable.active, null);
    assert.equal(requests, 0, '空宠物库开启时不得自动下载默认宠物');

    const installed = await managePet('install', `http://127.0.0.1:${port}/gallery/demo`, { home, app });
    assert.equal(installed.active.name, 'Demo Pet');
    assert.equal(installed.config.enabled, true, '安装后应直接开启宠物');
    assert.ok(fs.existsSync(path.join(home, 'assets', `${installed.active.id}.webp`)));
    assert.match(fs.readFileSync(path.join(runtime, 'config.js'), 'utf8'), /"enabled":true/);

    const enabled = await managePet('enable', '', { home, app });
    assert.equal(enabled.config.enabled, true);
    assert.ok(fs.existsSync(path.join(runtime, 'active.webp')));

    const scaled = await managePet('scale', '140', { home, app });
    assert.equal(scaled.config.scale, 140);
    assert.match(fs.readFileSync(path.join(runtime, 'config.js'), 'utf8'), /"scale":140/);

    fs.rmSync(path.join(runtime, 'active.webp'));
    await managePet('repair', '', { home, app });
    assert.ok(fs.existsSync(path.join(runtime, 'active.webp')), 'repair 应从长期库恢复运行素材');

    const disabled = await managePet('disable', '', { home, app });
    assert.equal(disabled.config.enabled, false);
    assert.ok(fs.existsSync(path.join(runtime, 'active.webp')), '关闭保留素材');

    const removed = await managePet('remove', 'Demo Pet', { home, app });
    assert.equal(removed.pets.length, 0);
    assert.equal(removed.config.activeId, '');
    assert.ok(!fs.existsSync(path.join(runtime, 'active.webp')));
    assert.equal(home, path.join(kimiHome, 'kcm', 'pets'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('PNG 宠物：网页安装并发布对应格式的运行素材', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-pet-png-'));
  const atlas = makePngAtlas();
  const server = http.createServer((req, res) => {
    if (req.url === '/gallery/demo') {
      res.setHeader('content-type', 'text/html');
      res.end('<a href="/meta/pet.json">资料</a><img src="/images/spritesheet.png">');
    } else if (req.url === '/meta/pet.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'png-demo', display_name: 'PNG Pet' }));
    } else if (req.url === '/images/spritesheet.png') {
      res.setHeader('content-type', 'image/png');
      res.end(atlas);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const home = petHome({ KIMI_CODE_HOME: path.join(work, 'home') });
  const { app, runtime } = makeClient(work);
  try {
    const installed = await managePet('install', `http://127.0.0.1:${port}/gallery/demo`, { home, app });
    assert.equal(installed.active.assetExt, 'png');
    assert.ok(fs.existsSync(path.join(home, 'assets', `${installed.active.id}.png`)));
    assert.ok(fs.existsSync(path.join(runtime, 'active.png')));
    assert.ok(!fs.existsSync(path.join(runtime, 'active.webp')));
    assert.match(fs.readFileSync(path.join(runtime, 'config.js'), 'utf8'), /"assetExt":"png"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(work, { recursive: true, force: true });
  }
});
