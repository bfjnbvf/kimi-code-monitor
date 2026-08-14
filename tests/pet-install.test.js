import test from 'node:test';
import assert from 'node:assert/strict';

import { unzip } from '../src/pet/install.js';

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
}

function localFileHeader(name, method, compressedSize, uncompressedSize, data) {
  const nameBuf = Buffer.from(name, 'utf-8');
  return Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(method),
    u16(0),
    u16(0),
    u32(0),
    u32(compressedSize),
    u32(uncompressedSize),
    u16(nameBuf.length),
    u16(0),
    nameBuf,
    Buffer.from(data)
  ]);
}

function centralDirectoryHeader(name, method, compressedSize, uncompressedSize, offset) {
  const nameBuf = Buffer.from(name, 'utf-8');
  return Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(method),
    u16(0),
    u16(0),
    u32(0),
    u32(compressedSize),
    u32(uncompressedSize),
    u16(nameBuf.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(offset),
    nameBuf
  ]);
}

function eocd(cdOffset, cdSize, totalRecords) {
  return Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(totalRecords),
    u16(totalRecords),
    u32(cdSize),
    u32(cdOffset),
    u16(0)
  ]);
}

function toArrayBuffer(buf) {
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return ab;
}

async function deflateRaw(data) {
  const ds = new CompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function makeZip(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;
  for (const { name, method, data } of entries) {
    const raw = Buffer.from(data);
    let compressed = raw;
    if (method === 8) {
      compressed = Buffer.from(await deflateRaw(raw));
    }
    const lfh = localFileHeader(name, method, compressed.length, raw.length, compressed);
    localParts.push(lfh);
    cdParts.push(centralDirectoryHeader(name, method, compressed.length, raw.length, offset));
    offset += lfh.length;
  }
  const local = Buffer.concat(localParts);
  const cd = Buffer.concat(cdParts);
  return Buffer.concat([local, cd, eocd(local.length, cd.length, entries.length)]);
}

test('unzip：正常解析 store 与 deflate 条目，并按 basename 匹配', async () => {
  const zip = await makeZip([
    { name: 'pets/my-pet/pet.json', method: 8, data: '{"id":"test"}' },
    { name: 'pets/my-pet/spritesheet.webp', method: 0, data: 'RIFF....WEBP' }
  ]);
  const files = await unzip(toArrayBuffer(zip));
  assert.equal(files.size, 2);
  assert.ok(files.has('pets/my-pet/pet.json'));
  assert.ok(files.has('pets/my-pet/spritesheet.webp'));
  assert.equal(Buffer.from(files.get('pets/my-pet/pet.json')).toString(), '{"id":"test"}');
});

test('unzip：拒绝路径中含有 .. 的条目', async () => {
  const zip = await makeZip([
    { name: '../etc/passwd', method: 0, data: 'evil' },
    { name: 'pet.json', method: 0, data: '{}' }
  ]);
  await assert.rejects(async () => unzip(toArrayBuffer(zip)), /不合法/);
});

test('unzip：拒绝绝对路径条目', async () => {
  const zip = await makeZip([
    { name: '/etc/passwd', method: 0, data: 'evil' },
    { name: 'pet.json', method: 0, data: '{}' }
  ]);
  await assert.rejects(async () => unzip(toArrayBuffer(zip)), /不合法/);
});

test('unzip：拒绝含空字节的路径', async () => {
  const zip = await makeZip([
    { name: 'pet\0.json', method: 0, data: 'evil' },
    { name: 'pet.json', method: 0, data: '{}' }
  ]);
  await assert.rejects(async () => unzip(toArrayBuffer(zip)), /不合法/);
});

test('unzip：单文件解压大小超出上限时报错', async () => {
  const big = Buffer.alloc(17 * 1024 * 1024, 'a');
  const zip = await makeZip([
    { name: 'big.txt', method: 0, data: big }
  ]);
  await assert.rejects(async () => unzip(toArrayBuffer(zip)), /单文件/);
});

test('unzip：总解压大小超出上限时报错', async () => {
  const part = Buffer.alloc(12 * 1024 * 1024, 'a');
  const zip = await makeZip([
    { name: 'a.txt', method: 0, data: part },
    { name: 'b.txt', method: 0, data: part },
    { name: 'c.txt', method: 0, data: part }
  ]);
  await assert.rejects(async () => unzip(toArrayBuffer(zip)), /总解压/);
});

test('unzip：store 方式 compressed/uncompressed size 不一致时报错', async () => {
  const nameBuf = Buffer.from('bad.txt', 'utf-8');
  const zip = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(5),
    u32(10),
    u16(nameBuf.length),
    u16(0),
    nameBuf,
    Buffer.from('hello')
  ]);
  await assert.rejects(async () => unzip(toArrayBuffer(zip)), /不一致/);
});

test('unzip：deflate 解压长度与 header 声明不一致时报错', async () => {
  const name = 'bad.txt';
  const nameBuf = Buffer.from(name, 'utf-8');
  const compressed = Buffer.from(await deflateRaw(Buffer.from('hello')));
  const zip = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(0),
    u32(compressed.length),
    u32(1000),
    u16(nameBuf.length),
    u16(0),
    nameBuf,
    compressed
  ]);
  await assert.rejects(async () => unzip(toArrayBuffer(zip)), /解压长度/);
});

test('unzip：central directory 与 local header 不一致时报错', async () => {
  const name = 'pet.json';
  const nameBuf = Buffer.from(name, 'utf-8');
  const data = Buffer.from('{}');
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(data.length),
    u32(data.length),
    u16(nameBuf.length),
    u16(0),
    nameBuf,
    data
  ]);
  const cd = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(data.length),
    u32(999),
    u16(nameBuf.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    nameBuf
  ]);
  const zip = Buffer.concat([local, cd, eocd(local.length, cd.length, 1)]);
  await assert.rejects(async () => unzip(toArrayBuffer(zip)), /central directory/);
});
