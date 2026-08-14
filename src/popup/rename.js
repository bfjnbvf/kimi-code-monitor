/**
 * 新会话 AI 自动命名板块：模型选择、开关持久化、用量显示。
 */
import * as KimiMetrics from '../metrics.js';
import * as KimiSessionRename from '../session-rename/rename-shared.js';
import * as KimiSessionRenameModel from '../session-rename/rename-model.js';
import * as KimiExternalProviders from '../providers.js';
import { send, pageState } from './shared.js';
import { getExternalAccountsCache } from './external.js';

const { formatTokenCount } = KimiMetrics;

  /* ---------- 新会话 AI 自动命名：模型选择、开关持久化、用量显示 ---------- */

  const RENAME_SETTINGS_STORAGE_KEY = 'sessionRenameSettings';
  const RENAME_MODELS_STORAGE_KEY = 'sessionRenameModels';
  const RENAME_EXT_MODELS_STORAGE_KEY = 'sessionRenameExtModels';
  const renameShared = KimiSessionRename;
  const renameModelSelect = document.getElementById('rename-model-select');
  const renameEmojiToggle = document.getElementById('rename-emoji-toggle');
  const renameAutoToggle = document.getElementById('rename-auto-toggle');
  const renameSection = document.getElementById('rename-section');

  // 功能卡片展开状态 = 总开关状态
  function renameSectionSetOn(on) {
    renameAutoToggle.checked = on;
    renameSection.classList.toggle('on', on);
  }
  const renameUsage = document.getElementById('rename-usage');
  let renameSettings = {
    autoEnabled: false,
    emojiEnabled: true,
    modelSource: renameShared.defaultModelSource()
  };
  // Kimi Code 模型清单：先渲染缓存/硬编码兜底，弹窗打开时后台刷新
  let renameModelsCache = renameShared.KIMI_CODE_FALLBACK_MODELS;
  // 外部账户模型清单：{ accountId: [modelId...] }，同样先缓存后刷新
  let renameExternalModelsCache = {};

  // 命名 token 用量累计（每次模型调用的响应 usage 由 background 累加）
  export async function refreshRenameUsage() {
    try {
      const response = await send('rename.usage.get');
      const usage = response?.usage;
      renameUsage.textContent = usage?.calls > 0
        ? `累计命名 ${usage.calls} 次 · 输入 ${formatTokenCount(usage.input)} · 输出 ${formatTokenCount(usage.output)} tokens`
        : '';
    } catch (error) {
      renameUsage.textContent = '';
    }
  }

  function saveRenameSettings() {
    normalizeRenameModelSource();
    chrome.storage.local.set({ [RENAME_SETTINGS_STORAGE_KEY]: renameSettings }).catch(() => {});
  }

  // <select> 的字符串 value 与 modelSource 对象互转
  function modelSourceToValue(source) {
    return source.kind === 'external'
      ? `ext:${source.accountId}:${source.model || ''}`
      : `kimi-code:${source.model}`;
  }

  function valueToModelSource(value) {
    if (typeof value === 'string' && value.startsWith('kimi-code:')) {
      return { kind: 'kimi-code', model: value.slice('kimi-code:'.length) };
    }
    // ext:<accountId>:<model>（模型名为 provider 返回的真实 ID，可含点/短横线，不含冒号）
    if (typeof value === 'string' && value.startsWith('ext:')) {
      const rest = value.slice(4);
      const sep = rest.indexOf(':');
      const accountId = sep < 0 ? rest : rest.slice(0, sep);
      const model = sep < 0 ? '' : rest.slice(sep + 1);
      return renameShared.normalizeModelSource({ kind: 'external', accountId, model: model || undefined });
    }
    return renameShared.normalizeModelSource(value);
  }

  // 分组下拉：Kimi Code 一组；每个支持命名的外部账户一组，组内是 provider 实时返回的具体模型
  // 注意：本函数只负责渲染 <select>，不直接修改 renameSettings（状态回填在加载/保存时处理）。
  export function buildRenameModelOptions() {
    const previousValue = modelSourceToValue(renameSettings.modelSource);
    renameModelSelect.replaceChildren();
    const kimiGroup = document.createElement('optgroup');
    kimiGroup.label = 'Kimi Code';
    for (const entry of renameModelsCache) {
      const option = document.createElement('option');
      option.value = `kimi-code:${entry.model}`;
      option.textContent = entry.display_name;
      kimiGroup.append(option);
    }
    renameModelSelect.append(kimiGroup);
    const supported = KimiSessionRenameModel?.RENAME_MODEL_PROVIDERS || {};
    for (const account of getExternalAccountsCache()) {
      const target = supported[account.provider];
      if (!target) continue;
      const providerName =
        KimiExternalProviders?.PROVIDERS?.[account.provider]?.name || account.provider;
      const group = document.createElement('optgroup');
      // 「DeepSeek · 备注名」：未改名时只显示 provider 名
      group.label =
        account.name && account.name !== providerName
          ? `${providerName} · ${account.name}`
          : providerName;
      // 模型列表：实时拉取的缓存；拉不到时用该 provider 的兜底默认模型
      const cached = renameExternalModelsCache[account.id];
      const models = Array.isArray(cached) && cached.length ? cached : [target.model];
      for (const model of models) {
        const option = document.createElement('option');
        option.value = `ext:${account.id}:${model}`;
        option.textContent = model;
        group.append(option);
      }
      renameModelSelect.append(group);
    }
    // 选中项恢复：精确匹配 → 旧配置（无模型的外部账户）落到该账户第一项 → 兜底第一项
    const options = [...renameModelSelect.options];
    let nextValue = options.some((o) => o.value === previousValue) ? previousValue : '';
    if (!nextValue && renameSettings.modelSource?.kind === 'external') {
      const prefix = `ext:${renameSettings.modelSource.accountId}:`;
      nextValue = options.find((o) => o.value.startsWith(prefix))?.value || '';
    }
    if (!nextValue && options.length) nextValue = options[0].value;
    if (nextValue) renameModelSelect.value = nextValue;
    return nextValue;
  }

  // 若当前 settings.modelSource 不在可用选项中，回落到当前选中的第一项，避免保存无效值。
  function normalizeRenameModelSource() {
    const currentValue = modelSourceToValue(renameSettings.modelSource);
    const options = [...renameModelSelect.options];
    if (options.length && !options.some((o) => o.value === currentValue)) {
      const fallback = renameModelSelect.value || options[0].value;
      renameSettings.modelSource = valueToModelSource(fallback);
    }
  }

  export async function loadRenameSettings() {
    try {
      const stored = await chrome.storage.local.get(RENAME_SETTINGS_STORAGE_KEY);
      const raw = stored[RENAME_SETTINGS_STORAGE_KEY];
      renameSettings = { ...renameSettings, ...(raw || {}) };
      renameSettings.modelSource = renameShared.normalizeModelSource(renameSettings.modelSource);
      // 旧默认 Highspeed 一次性迁移到 K2.7 Coding（单价更低）；用户之后手选 Highspeed 不回退
      const migration = await chrome.storage.local.get('sessionRenameModelV2').catch(() => ({}));
      if (!migration.sessionRenameModelV2) {
        if (renameSettings.modelSource?.model === 'kimi-code/kimi-for-coding-highspeed') {
          renameSettings.modelSource = { kind: 'kimi-code', model: 'kimi-code/kimi-for-coding' };
          saveRenameSettings();
        }
        chrome.storage.local.set({ sessionRenameModelV2: true }).catch(() => {});
      }
      renameEmojiToggle.checked = renameSettings.emojiEnabled !== false;
      renameSectionSetOn(renameSettings.autoEnabled === true);
      buildRenameModelOptions();
      normalizeRenameModelSource();
      renameModelSelect.value = modelSourceToValue(renameSettings.modelSource);
      // 旧版字符串 modelSource（'kimi' / 'ext:<id>'）迁移为新结构后回写一次
      if (raw && JSON.stringify(raw.modelSource) !== JSON.stringify(renameSettings.modelSource)) {
        saveRenameSettings();
      }
    } catch (error) {
      // 读取失败用默认设置
    }
  }

  // 模型清单：先用缓存渲染，再经 background 中继向 Kimi Code Web 页面拉最新值；
  // 外部账户模型由 background 直接调各 provider 的 /models
  export async function loadRenameModels() {
    try {
      const stored = await chrome.storage.local.get([
        RENAME_MODELS_STORAGE_KEY, RENAME_EXT_MODELS_STORAGE_KEY
      ]);
      if (pageState.pageDestroyed) return;
      const cached = stored[RENAME_MODELS_STORAGE_KEY];
      if (Array.isArray(cached) && cached.length) renameModelsCache = cached;
      const extCached = stored[RENAME_EXT_MODELS_STORAGE_KEY];
      if (extCached && typeof extCached === 'object') renameExternalModelsCache = extCached;
    } catch (error) {
      // 读缓存失败用兜底
    }
    buildRenameModelOptions();
    try {
      const response = await send('rename.models.list');
      if (pageState.pageDestroyed) return;
      if (response?.ok && Array.isArray(response.models) && response.models.length) {
        renameModelsCache = response.models;
        chrome.storage.local.set({ [RENAME_MODELS_STORAGE_KEY]: response.models }).catch(() => {});
        buildRenameModelOptions();
      }
    } catch (error) {
      // 页面未打开/拉取失败：保持缓存或兜底
    }
    try {
      const extResponse = await send('rename.external.models.list');
      if (pageState.pageDestroyed) return;
      if (extResponse?.ok && Array.isArray(extResponse.accounts)) {
        const next = {};
        for (const account of extResponse.accounts) {
          if (Array.isArray(account.models) && account.models.length) next[account.accountId] = account.models;
        }
        renameExternalModelsCache = next;
        chrome.storage.local.set({ [RENAME_EXT_MODELS_STORAGE_KEY]: next }).catch(() => {});
        buildRenameModelOptions();
      }
    } catch (error) {
      // 拉取失败：保持缓存或兜底默认模型
    }
  }

  renameModelSelect.addEventListener('change', () => {
    renameSettings.modelSource = valueToModelSource(renameModelSelect.value);
    saveRenameSettings();
  });
  renameEmojiToggle.addEventListener('change', () => {
    renameSettings.emojiEnabled = renameEmojiToggle.checked;
    saveRenameSettings();
  });
  renameAutoToggle.addEventListener('change', () => {
    renameSettings.autoEnabled = renameAutoToggle.checked;
    renameSectionSetOn(renameAutoToggle.checked);
    saveRenameSettings();
  });

