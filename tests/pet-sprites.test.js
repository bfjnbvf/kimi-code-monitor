import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { create } from '../src/pet/sprites.js';

function installDom() {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', {
    url: 'http://localhost/',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.Image = class {
    set src(_value) {
      this.width = 1536;
      this.height = 1872;
      window.setTimeout(() => this.onload?.(), 0);
    }
  };
  return { dom, window };
}

function resize(window, width, height) {
  window.innerWidth = width;
  window.innerHeight = height;
  window.dispatchEvent(new window.Event('resize'));
}

async function createAt(window, position) {
  return create({
    imageUrl: 'data:image/webp;base64,demo',
    position,
    look: { enabled: false }
  });
}

test('窗口缩放：按宠物中心所在象限保留对应边距', async () => {
  const { dom, window } = installDom();
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Image: globalThis.Image
  };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Image = window.Image;
  try {
    const cases = [
      { position: { x: 800, y: 600 }, expected: { x: 1176, y: 832 } },
      { position: { x: 40, y: 600 }, expected: { x: 40, y: 832 } },
      { position: { x: 800, y: 20 }, expected: { x: 1176, y: 20 } },
      { position: { x: 40, y: 20 }, expected: { x: 40, y: 20 } }
    ];
    for (const [index, item] of cases.entries()) {
      const pet = await createAt(window, item.position);
      resize(window, 1400, 1000);
      assert.equal(pet.el.style.left, `${item.expected.x}px`, `象限 ${index + 1} 的横向边距`);
      assert.equal(pet.el.style.top, `${item.expected.y}px`, `象限 ${index + 1} 的纵向边距`);
      resize(window, 1024, 768);
      assert.equal(pet.el.style.left, `${item.position.x}px`, `象限 ${index + 1} 缩回后横向位置`);
      assert.equal(pet.el.style.top, `${item.position.y}px`, `象限 ${index + 1} 缩回后纵向位置`);
      pet.destroy();
    }

    const untouched = await createAt(window, null);
    resize(window, 1400, 1000);
    assert.equal(untouched.el.style.right, '24px', '未拖动的宠物继续锚定右侧');
    assert.equal(untouched.el.style.bottom, '24px', '未拖动的宠物继续锚定下侧');
    untouched.destroy();
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.Image = previous.Image;
    window.close();
  }
});
