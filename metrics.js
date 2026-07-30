(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KimiMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SPEED_SAMPLE_WINDOW = 5;
  const MIN_SPEED_DURATION_MS = 100;

  function toNonNegativeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function firstDefined(source, keys) {
    for (const key of keys) {
      if (source?.[key] != null) return source[key];
    }
    return 0;
  }

  function normalizeUsage(raw) {
    const usage = raw && typeof raw === 'object' ? raw : {};
    return {
      inputTokens: toNonNegativeInteger(firstDefined(usage, [
        'inputOther', 'input_tokens', 'prompt_tokens'
      ])),
      outputTokens: toNonNegativeInteger(firstDefined(usage, [
        'output', 'output_tokens', 'completion_tokens'
      ])),
      cacheReadTokens: toNonNegativeInteger(firstDefined(usage, [
        'inputCacheRead', 'cache_read_input_tokens', 'cache_read_tokens'
      ])),
      cacheCreationTokens: toNonNegativeInteger(firstDefined(usage, [
        'inputCacheCreation', 'cache_creation_input_tokens', 'cache_creation_tokens'
      ]))
    };
  }

  function totalInputTokens(usage) {
    return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  }

  function cacheReadPercentage(usage) {
    const total = totalInputTokens(usage);
    return total > 0 ? Math.round((usage.cacheReadTokens / total) * 100) : null;
  }

  /* ---------- 按天消耗量累计（popup 消耗量板块数据源） ---------- */

  // 本地时区的 'YYYY-MM-DD'，字典序即时间序，可直接字符串比较
  function usageDayKey(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
  }

  // 桶结构：{ input, output, cacheRead, sub? }，input 为总输入（含缓存读/写）；
  // isSubagent 为 true 时同额累加进 sub 子桶，供主/子代理分维度展示
  function accumulateDailyUsage(daily, dayKey, usage, isSubagent = false) {
    const next = { ...(daily && typeof daily === 'object' ? daily : {}) };
    const bucket = { input: 0, output: 0, cacheRead: 0, ...(next[dayKey] || {}) };
    const input = totalInputTokens(usage);
    const output = toNonNegativeInteger(usage.outputTokens);
    const cacheRead = toNonNegativeInteger(usage.cacheReadTokens);
    bucket.input += input;
    bucket.output += output;
    bucket.cacheRead += cacheRead;
    if (isSubagent) {
      const sub = { input: 0, output: 0, cacheRead: 0, ...(bucket.sub || {}) };
      sub.input += input;
      sub.output += output;
      sub.cacheRead += cacheRead;
      bucket.sub = sub;
    }
    next[dayKey] = bucket;
    return next;
  }

  // 只保留最近 keepDays 个自然日（含今天）的桶，防止存储无限膨胀
  function pruneDailyUsage(daily, keepDays = 90, now = new Date()) {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - (keepDays - 1));
    const cutoffKey = usageDayKey(cutoff);
    const next = {};
    for (const [key, bucket] of Object.entries(daily || {})) {
      if (key >= cutoffKey) next[key] = bucket;
    }
    return next;
  }

  // 任意日期范围求和（含端点）；startKey/endKey 传 null 表示不限
  function sumUsageBetween(daily, startKey, endKey) {
    const total = { input: 0, output: 0, cacheRead: 0 };
    for (const [key, bucket] of Object.entries(daily || {})) {
      if (startKey && key < startKey) continue;
      if (endKey && key > endKey) continue;
      total.input += toNonNegativeInteger(bucket?.input);
      total.output += toNonNegativeInteger(bucket?.output);
      total.cacheRead += toNonNegativeInteger(bucket?.cacheRead);
    }
    total.totalTokens = total.input + total.output;
    total.cacheHitRate = total.input > 0 ? total.cacheRead / total.input : null;
    return total;
  }

  // 枚举范围内的每个自然日 key（含端点），无记录的日期也会列出，供图表补零
  function listDayKeysBetween(startKey, endKey) {
    const parse = (key) => {
      const [y, m, d] = String(key).split('-').map(Number);
      return new Date(y, (m || 1) - 1, d || 1);
    };
    const keys = [];
    const end = parse(endKey);
    for (let d = parse(startKey); d <= end; d.setDate(d.getDate() + 1)) {
      keys.push(usageDayKey(d));
    }
    return keys;
  }

  // 与 widget 的 fmtNum 同款缩写：k / M
  function formatTokenCount(value) {
    const number = toNonNegativeInteger(value);
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(number);
  }

  function decodeSpeed(outputTokens, durationMs) {
    const output = toNonNegativeInteger(outputTokens);
    const duration = Number(durationMs);
    if (!Number.isFinite(duration) || duration < MIN_SPEED_DURATION_MS || output === 0) return null;
    return Math.round(output / (duration / 1_000));
  }

  function appendSpeedSample(samples, speed) {
    if (!Number.isFinite(speed) || speed <= 0) return [...samples].slice(-SPEED_SAMPLE_WINDOW);
    return [...samples, speed].slice(-SPEED_SAMPLE_WINDOW);
  }

  function medianSpeed(samples) {
    if (!samples.length) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[middle]
      : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }

  function boosterBalanceYuan(wallet) {
    if (!wallet || typeof wallet !== 'object') return null;
    const status = String(wallet?.status || '').toUpperCase();
    if (status !== 'STATUS_ACTIVE' && status !== 'STATUS_ENABLED') return 0;
    const amountLeft = Number(wallet?.balance?.amountLeft);
    return Number.isFinite(amountLeft) ? Math.max(0, amountLeft / 100_000_000) : null;
  }

  return {
    accumulateDailyUsage,
    appendSpeedSample,
    boosterBalanceYuan,
    cacheReadPercentage,
    decodeSpeed,
    formatTokenCount,
    listDayKeysBetween,
    medianSpeed,
    normalizeUsage,
    pruneDailyUsage,
    sumUsageBetween,
    toNonNegativeInteger,
    totalInputTokens,
    usageDayKey
  };
});
