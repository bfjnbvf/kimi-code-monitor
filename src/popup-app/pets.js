/**
 * 桌面宠物板块（popup 页，App 版）
 *
 * 与扩展 src/popup/pets.js 的差异：素材不在 IndexedDB，而是官方 Codex 宠物包
 * （~/.codex/pets/<id>/，Swift 侧安装/删除）；开关/换宠/大小写 App 的
 * UserDefaults（vibepal.petVisible / vibepal.petId / vibepal.petScale，
 * 与桌面桌宠即时联动）。全部动作经桥接请求/响应（shims.js 的 sendMessage）。
 *
 * DOM 契约与扩展 popup.html 的 roam-pet-section 一致。
 */

import { t } from '../i18n.js';

const roamPetToggle = document.getElementById('roam-pet-toggle');
const roamPetList = document.getElementById('roam-pet-list');
const roamPetAddRow = document.getElementById('roam-pet-add');
const roamPetAddBtn = document.getElementById('roam-pet-add-btn');
const roamPetInput = document.getElementById('roam-pet-input');
const roamPetInstallBtn = document.getElementById('roam-pet-install');
const roamPetStatus = document.getElementById('roam-pet-status');
const roamPetSection = document.getElementById('roam-pet-section');

function petSectionSetOn(on) {
  roamPetToggle.checked = on;
  roamPetSection.classList.toggle('on', on);
}

function petSetStatus(text, isError = false) {
  roamPetStatus.textContent = text;
  roamPetStatus.classList.toggle('err', isError);
  roamPetStatus.hidden = !text; // 无消息时不占行高
}

function ask(message) {
  return chrome.runtime.sendMessage(message);
}

/* ---------- 开关 / 大小：写 UserDefaults 并回读最新态 ---------- */

roamPetToggle.addEventListener('change', async () => {
  petSectionSetOn(roamPetToggle.checked);
  try {
    await ask({ type: 'pets.visible', payload: { visible: roamPetToggle.checked } });
  } catch (error) {
    petSetStatus(t('操作失败'), true);
  }
});

function bindScaleButton(id, delta) {
  document.getElementById(id).addEventListener('click', async () => {
    try {
      await ask({ type: 'pets.scale', payload: { delta } });
    } catch (error) {
      petSetStatus(t('操作失败'), true);
    }
  });
}
bindScaleButton('roam-pet-scale-up', 1);
bindScaleButton('roam-pet-scale-down', -1);
document.getElementById('roam-pet-scale-reset').addEventListener('click', async () => {
  try {
    await ask({ type: 'pets.scaleReset' });
  } catch (error) {
    petSetStatus(t('操作失败'), true);
  }
});

/* ---------- 宠物列表：一行一只（当前 / 切换 / 移除） ---------- */

async function renderPetLibrary() {
  let response;
  try {
    response = await ask({ type: 'pets.list' });
  } catch (error) {
    petSetStatus(t('状态读取失败'), true);
    return;
  }
  if (!response?.ok) {
    petSetStatus(t('状态读取失败'), true);
    return;
  }
  const pets = Array.isArray(response.pets) ? response.pets : [];
  petSectionSetOn(response.visible !== false);
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
    name.textContent = pet.name || pet.id;
    name.title = name.textContent;
    row.append(name);
    const actions = document.createElement('span');
    actions.className = 'status-actions';
    if (pet.current) {
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
        try {
          await ask({ type: 'pets.select', payload: { id: pet.id } });
          renderPetLibrary();
        } catch (error) {
          petSetStatus(t('切换失败'), true);
        }
      });
      actions.append(switchBtn);
    }
    if (pet.removable !== false) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'action';
      removeBtn.textContent = t('移除');
      removeBtn.addEventListener('click', async () => {
        removeBtn.disabled = true;
        try {
          await ask({ type: 'pets.remove', payload: { id: pet.id } });
          renderPetLibrary();
        } catch (error) {
          petSetStatus(t('移除失败'), true);
        }
      });
      actions.append(removeBtn);
    }
    row.append(actions);
    roamPetList.append(row);
  }
}

/* ---------- 安装：粘贴 bash 命令 → Swift 下载/解压/落盘 ---------- */

roamPetAddBtn.addEventListener('click', () => {
  roamPetAddRow.classList.remove('hidden');
  roamPetAddBtn.classList.add('hidden');
  roamPetInput.focus();
});

roamPetInstallBtn.addEventListener('click', async () => {
  roamPetInstallBtn.disabled = true;
  petSetStatus(t('下载中…'));
  try {
    const response = await ask({ type: 'pets.install', payload: { input: roamPetInput.value } });
    if (!response?.ok) throw new Error(response?.error || t('安装失败'));
    // 新装的自动切换为当前宠物（桌宠实时换装）
    petSetStatus(t('安装成功，已切换为新宠物'));
    roamPetInput.value = '';
    roamPetAddRow.classList.add('hidden');
    roamPetAddBtn.classList.remove('hidden');
    renderPetLibrary();
  } catch (error) {
    petSetStatus(t('安装失败：{msg}', { msg: error?.message || error }), true);
  } finally {
    roamPetInstallBtn.disabled = false;
  }
});

// 装配入口：popup-app 初始化期 await，保证开关就位
export async function loadPetSection() {
  await renderPetLibrary();
}
