import test from 'node:test';
import assert from 'node:assert/strict';

function makeFakeIndexedDB() {
  const databases = new Map();

  class FakeStore {
    constructor(name, opts = {}) {
      this.name = name;
      this.opts = opts;
      this.records = [];
    }
    _req(result) {
      const req = { result };
      setTimeout(() => {
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    }
    put(record) {
      const idx = this.records.findIndex((r) => r.id === record.id);
      if (idx >= 0) this.records[idx] = record;
      else this.records.push(record);
      return this._req(record.id);
    }
    getAll() {
      return this._req(this.records.slice());
    }
    get(id) {
      return this._req(this.records.find((r) => r.id === id));
    }
    delete(id) {
      this.records = this.records.filter((r) => r.id !== id);
      return this._req(undefined);
    }
  }

  class FakeDb {
    constructor(name, version) {
      this.name = name;
      this.version = version;
      this._storeMap = new Map();
      this.objectStoreNames = {
        contains: (n) => this._storeMap.has(n)
      };
    }
    createObjectStore(name, opts) {
      const store = new FakeStore(name, opts);
      this._storeMap.set(name, store);
      return store;
    }
    transaction(stores, _mode) {
      return {
        objectStore: (name) => this._storeMap.get(name)
      };
    }
    close() {}
  }

  return {
    open(name, version) {
      const req = {};
      setTimeout(() => {
        let db = databases.get(name);
        let upgraded = false;
        if (!db) {
          db = new FakeDb(name, version || 1);
          databases.set(name, db);
          upgraded = true;
        }
        if (version && version > db.version) {
          db.version = version;
          upgraded = true;
        }
        req.result = db;
        if (upgraded && req.onupgradeneeded) {
          req.onupgradeneeded({ target: req });
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
    databases: async () => Array.from(databases.values()).map((d) => ({ name: d.name, version: d.version })),
    _clear: () => databases.clear()
  };
}

const storage = {};
let fakeIndexedDB;
let originalIndexedDB;
let originalChrome;

function installMocks() {
  fakeIndexedDB = makeFakeIndexedDB();
  originalIndexedDB = globalThis.indexedDB;
  originalChrome = globalThis.chrome;
  globalThis.indexedDB = fakeIndexedDB;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const result = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (Object.prototype.hasOwnProperty.call(storage, key)) result[key] = storage[key];
          }
          return result;
        },
        set: async (obj) => Object.assign(storage, obj),
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
        }
      }
    }
  };
}

function restoreMocks() {
  globalThis.indexedDB = originalIndexedDB;
  globalThis.chrome = originalChrome;
}

import * as store from '../src/pet/store.js';

test('ensureMigrated：按 dataUrl 去重，缺失时新增，并正确设置 activeId', async () => {
  installMocks();
  try {
    fakeIndexedDB._clear();
    for (const key of Object.keys(storage)) delete storage[key];

  // 首次迁移：storage 里有 legacy dataUrl A，DB 为空，应新增
  storage['kimi-statusbar.petData'] = 'data:image/webp;A';
  storage['kimi-statusbar.petInfo'] = { name: 'Legacy A', author: 'a', source: 'legacy' };

  await store.ensureMigrated();

  let list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Legacy A');
  const firstId = storage['kimi-statusbar.petActiveId'];
  assert.ok(firstId);

  // 模拟崩溃/未置位：READY_KEY 被清掉，再次遇到相同 dataUrl A，应跳过 add
  delete storage['kimi-statusbar.petStoreReady'];

  await store.ensureMigrated();

  list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(storage['kimi-statusbar.petActiveId'], firstId);

  // 换成新的 dataUrl B，应再新增一条
  delete storage['kimi-statusbar.petStoreReady'];
  storage['kimi-statusbar.petData'] = 'data:image/webp;B';
  storage['kimi-statusbar.petInfo'] = { name: 'Legacy B', author: 'b', source: 'legacy' };

  await store.ensureMigrated();

    list = await store.list();
    assert.equal(list.length, 2);
    // activeId 已在首次迁移时设置，后续新增不应覆盖用户当前选择
    assert.equal(storage['kimi-statusbar.petActiveId'], firstId);
  } finally {
    restoreMocks();
  }
});
