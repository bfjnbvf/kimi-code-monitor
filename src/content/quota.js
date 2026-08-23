/**
 * 额度与授权域
 *
 * 职责边界：
 * - 经 background 拉取 5h/本周额度与加油包余额，驱动渲染层更新。
 * - 未授权状态的横幅与状态灯联动；设备授权流程的启动。
 * - 状态读 panel-state.js，DOM 写渲染层/结构层，不直接碰 WS 与会话。
 */

import { quotaPercentage } from '../metrics.js';
import { panel, quotaPollingWanted } from './panel-state.js';
import { toNumber, parseResetTime } from './utils.js';
import {
  updateBalance,
  updateProgress,
  updateResetText,
  setAgentStatus
} from './render.js';
import { setConnectionHint, maybeShowGuide } from './widget-structure.js';
import { t } from '../i18n.js';

let oauthStarting = false;

// 生命周期钩子（content.js 装配）
let deps = {
  isDisposed: () => false,
  onContextInvalidated: () => {}
};

export function initQuota(nextDeps) {
  deps = { ...deps, ...nextDeps };
}

export async function fetchQuota(force = false, { allowStale = false } = {}) {
  if (deps.isDisposed() || !panel.els?.widget || !chrome?.runtime?.sendMessage) return;
  // 手动强制刷新（点标题）跳过 wanted 检查：全隐藏时也要真的拉
  if (!force && !quotaPollingWanted()) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'quota.fetch',
      payload: { force, allowStale }
    });
    if (!response?.ok) {
      if (response?.code === 'AUTH_REQUIRED') {
        setQuotaAuthRequired(true);
        return;
      }
      throw new Error(response?.error || '额度请求失败');
    }

    setQuotaAuthRequired(false);
    updateBalance(response.data?.boosterWallet);

    const weeklyPercentage = quotaPercentage(response.data?.usage);
    if (weeklyPercentage != null) updateProgress('week', weeklyPercentage);
    updateResetText('week', parseResetTime(response.data?.usage?.resetTime));

    const fiveHour = response.data?.limits?.find(
      (item) => toNumber(item?.window?.duration) === 300
    );
    const fiveHourPercentage = quotaPercentage(fiveHour?.detail);
    if (fiveHourPercentage != null) updateProgress('5h', fiveHourPercentage);
    updateResetText('5h', parseResetTime(fiveHour?.detail?.resetTime));

    // 月额度暂时下线（background 返回 monthly=null）；模块与拉取逻辑保留备用
  } catch (error) {
    if (String(error?.message || error).includes('Extension context invalidated')) {
      // 扩展已重载，这个残留脚本立即停止所有活动，不再刷错误
      deps.onContextInvalidated();
      return;
    }
    console.warn('[Kimi Status] 额度更新失败', error);
    setConnectionHint(t('额度更新失败：{msg}', { msg: error.message || error }));
  }
}

export function setQuotaAuthRequired(required) {
  panel.quotaAuthRequired = required;
  if (!panel.els?.widget) return;

  panel.els.widget.classList.toggle('ksb-auth-required', required);
  panel.els.widget.tabIndex = required ? 0 : -1;
  panel.els.widget.setAttribute('role', required ? 'button' : 'status');
  if (panel.els.authBanner) {
    panel.els.authBanner.hidden = !required;
    if (required && panel.els.authBannerText) panel.els.authBannerText.textContent = t('点击完成 Kimi 授权');
  }
  // 授权状态变化会改变状态灯的显示（未授权恒红 / 恢复后回到真实状态）
  setAgentStatus(panel.metrics.agentStatus);
  setConnectionHint(required ? t('点击授权 Kimi 额度查询') : t('Kimi Status 已连接'));
  // 授权完成后补一次新手引导（未授权期间引导被推迟）
  if (!required) maybeShowGuide();
}

export async function beginOAuth() {
  if (!panel.quotaAuthRequired || oauthStarting) return;
  oauthStarting = true;
  try {
    setConnectionHint(t('正在打开 Kimi 授权页…'));
    const response = await chrome.runtime.sendMessage({ type: 'oauth.start' });
    if (!response?.ok) throw new Error(response?.error || t('无法开始授权'));
    // 轮询由后台 service worker 驱动，授权页完成后自动关闭，面板自动恢复
    if (panel.els.authBannerText) {
      panel.els.authBannerText.textContent = '授权中，完成后自动恢复';
    }
    setConnectionHint('请在新打开的页面完成授权');
  } catch (error) {
    console.warn('[Kimi Status] 授权启动失败', error);
    setConnectionHint(`授权启动失败：${error.message || error}`);
  } finally {
    oauthStarting = false;
  }
}
