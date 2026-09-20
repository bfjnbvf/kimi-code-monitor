import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(__dirname, '..', 'content.css'), 'utf8');

test('保留原版色板，并由 Kimi Web 的主题设置选择亮暗模式', () => {
  assert.match(css, /--ksb-green:\s*#16c456/);
  assert.match(css, /--ksb-orange:\s*#ff9500/);
  assert.match(css, /--ksb-danger:\s*#ff3849/);
  assert.match(css, /html\[data-color-scheme="dark"\]\s+#ksb-widget/);
  assert.match(css, /html\[data-color-scheme="system"\]\s+#ksb-widget/);
  // 约束对象是面板本体（Widget 段）：不借用宿主色板变量，亮暗由 data-color-scheme 切换。
  // 文件开头的「宿主页面微调」段操作的是宿主自己的元素（如折叠阴影），
  // 复刻原生效果必须引用宿主变量（--color-text 等），不在此约束内。
  const widgetCss = css.slice(css.indexOf('===== Kimi Web Status Widget ====='));
  assert.doesNotMatch(widgetCss, /var\(--color-(?:text|success|warning|danger|selected|hover|surface-raised|line)/);
});
