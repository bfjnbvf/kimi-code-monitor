/**
 * 桌面宠物板块：开关、环视/大小设置、素材库（IndexedDB 存图，页面经 background 取图）。
 */
import * as CodexPetInstall from '../pet/install.js';
import * as CodexPetStore from '../pet/store.js';
import { t } from '../i18n.js';

  /* ---------- 桌面宠物：开关 + 素材库（IndexedDB 存图，页面经 background 取图） ---------- */
  const roamPetToggle = document.getElementById('roam-pet-toggle');
  const roamPetList = document.getElementById('roam-pet-list');
  const roamPetAddRow = document.getElementById('roam-pet-add');
  const roamPetAddBtn = document.getElementById('roam-pet-add-btn');
  const roamPetInput = document.getElementById('roam-pet-input');
  const roamPetInstallBtn = document.getElementById('roam-pet-install');
  const roamPetStatus = document.getElementById('roam-pet-status');
  const roamPetSection = document.getElementById('roam-pet-section');
  const ROAM_PET_STORAGE_KEY = 'kimi-statusbar.roamPet';

  function petSectionSetOn(on) {
    roamPetToggle.checked = on;
    roamPetSection.classList.toggle('on', on);
  }

  function petSetStatus(text, isError = false) {
    roamPetStatus.textContent = text;
    roamPetStatus.classList.toggle('err', isError);
    roamPetStatus.hidden = !text; // 无消息时不占行高
  }

  // 开关持久化：默认关闭（卡片收起），用户打开过才保持展开。
  // 存储读取完成前碰到开关只改 UI 不落盘（防竞态覆盖真实偏好）
  let petLoaded = false;
  roamPetToggle.addEventListener('change', () => {
    petSectionSetOn(roamPetToggle.checked);
    if (!petLoaded) return;
    chrome.storage.local.set({ [ROAM_PET_STORAGE_KEY]: roamPetToggle.checked }).catch(() => {});
  });

  // 素材库列表：一行一只（名称 + 当前/切换/移除），与账户行同款
  async function renderPetLibrary() {
    const store = CodexPetStore;
    if (!store) return;
    await store.ensureMigrated();
    const pets = await store.list();
    const stored = await chrome.storage.local.get(store.ACTIVE_ID_KEY).catch(() => ({}));
    const activeId = stored[store.ACTIVE_ID_KEY] || '';
    roamPetList.replaceChildren();
    if (!pets.length) {
      const empty = document.createElement('div');
      empty.className = 'pet-note';
      empty.textContent = t('尚未安装宠物');
      roamPetList.append(empty);
      return;
    }
    for (const pet of pets) {
      const row = document.createElement('div');
      row.className = 'ext-row';
      const name = document.createElement('span');
      name.className = 'ext-name';
      name.textContent = pet.author ? `${pet.name} by ${pet.author}` : pet.name;
      name.title = name.textContent;
      row.append(name);
      const actions = document.createElement('span');
      actions.className = 'status-actions';
      if (pet.id === activeId) {
        const badge = document.createElement('span');
        badge.className = 'account-badge';
        badge.textContent = t('当前');
        actions.append(badge);
      } else {
        const switchBtn = document.createElement('button');
        switchBtn.type = 'button';
        switchBtn.className = 'action';
        switchBtn.textContent = t('切换');
        switchBtn.addEventListener('click', async () => {
          await chrome.storage.local.set({ [store.ACTIVE_ID_KEY]: pet.id }).catch(() => {});
          renderPetLibrary();
        });
        actions.append(switchBtn);
      }
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'action';
      removeBtn.textContent = t('移除');
      removeBtn.addEventListener('click', async () => {
        await store.remove(pet.id).catch(() => {});
        if (pet.id === activeId) {
          // 删掉当前只：自动落到剩下的第一只（没有则清空，页面不再显示宠物）
          const rest = await store.list().catch(() => []);
          await chrome.storage.local
            .set({ [store.ACTIVE_ID_KEY]: rest[0]?.id || '' })
            .catch(() => {});
        }
        renderPetLibrary();
      });
      actions.append(removeBtn);
      row.append(actions);
      roamPetList.append(row);
    }
  }

  // 默认关闭（卡片收起）；用户打开过才保持展开
  chrome.storage.local.get(ROAM_PET_STORAGE_KEY).then((stored) => {
    petLoaded = true;
    petSectionSetOn(stored[ROAM_PET_STORAGE_KEY] === true);
  }).catch(() => {});


  // 安装输入框默认隐藏，点「+ 安装新宠物」才展开
  roamPetAddBtn.addEventListener('click', () => {
    roamPetAddRow.classList.remove('hidden');
    roamPetAddBtn.classList.add('hidden');
    roamPetInput.focus();
  });

  roamPetInstallBtn.addEventListener('click', async () => {
    const installer = CodexPetInstall;
    const store = CodexPetStore;
    if (!installer || !store) return;
    roamPetInstallBtn.disabled = true;
    petSetStatus(t('下载中…'));
    try {
      const plan = installer.parseInput(roamPetInput.value);
      const { dataUrl, info } = await installer.fetchPet(plan);
      const id = await store.add({
        name: info.name,
        author: info.author,
        source: info.source,
        dataUrl
      });
      // 新装的自动切换为当前宠物（页面实时换装）
      await chrome.storage.local.set({ [store.ACTIVE_ID_KEY]: id }).catch(() => {});
      petSetStatus(t('安装成功，已切换为新宠物'));
      roamPetInput.value = '';
      roamPetAddRow.classList.add('hidden');
      roamPetAddBtn.classList.remove('hidden');
      renderPetLibrary();
    } catch (error) {
      petSetStatus(t('安装失败：{msg}', { msg: error.message }), true);
    } finally {
      roamPetInstallBtn.disabled = false;
    }
  });

  // 环视（靠近时注视鼠标）常开：popup 不再提供开关，content 侧固定 enabled（仅 v2 图集生效）

  // 宠物大小：重置/放大/缩小三个文字按钮，步进 10%，钳制在 50–150
  const PET_SCALE_STORAGE_KEY = 'kimi-statusbar.petScale';
  const PET_SCALE_DEFAULT = 100;
  const PET_SCALE_STEP = 10;
  let petScale = PET_SCALE_DEFAULT;
  const clampPetScale = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(150, Math.max(50, Math.round(n))) : PET_SCALE_DEFAULT;
  };
  function setPetScale(value) {
    petScale = clampPetScale(value);
    chrome.storage.local.set({ [PET_SCALE_STORAGE_KEY]: petScale }).catch(() => {});
  }
  chrome.storage.local.get(PET_SCALE_STORAGE_KEY).then((stored) => {
    petScale = clampPetScale(stored[PET_SCALE_STORAGE_KEY]);
  }).catch(() => {});
  document.getElementById('roam-pet-scale-reset').addEventListener('click', () => setPetScale(PET_SCALE_DEFAULT));
  document.getElementById('roam-pet-scale-up').addEventListener('click', () => setPetScale(petScale + PET_SCALE_STEP));
  document.getElementById('roam-pet-scale-down').addEventListener('click', () => setPetScale(petScale - PET_SCALE_STEP));

  renderPetLibrary().catch((error) => console.warn('[Kimi Popup] 宠物素材库加载失败', error));
