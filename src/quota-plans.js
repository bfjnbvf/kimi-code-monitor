import { quotaPercentage } from './metrics.js';

export function monthlyQuota(usages) {
  const raw = usages?.monthTotal ?? usages?.monthCode;
  if (raw?.usedRatio == null || raw.usedRatio === '') return null;
  const usedRatio = Number(raw.usedRatio);
  if (!Number.isFinite(usedRatio) || usedRatio < 0) return null;
  return {
    usedRatio,
    resetAt: typeof raw?.resetAt === 'string' ? raw.resetAt : null
  };
}

export function hasWeekQuota(usages) {
  return Boolean(usages?.limit7d || usages?.limit_7d || usages?.limitWeek || usages?.week || usages?.usage);
}

export function isMonthlyPlan(usages) {
  return Boolean(monthlyQuota(usages) && !hasWeekQuota(usages));
}

export function weeklyQuota(usages) {
  for (const raw of [usages?.limit7d, usages?.limit_7d, usages?.limitWeek, usages?.week]) {
    if (raw?.usedRatio == null || raw.usedRatio === '') continue;
    const usedRatio = Number(raw.usedRatio);
    if (!Number.isFinite(usedRatio) || usedRatio < 0) continue;
    return {
      usedRatio,
      resetAt: typeof raw?.resetAt === 'string' ? raw.resetAt : null
    };
  }
  const legacy = usages?.usage;
  const percentage = quotaPercentage(legacy);
  if (percentage == null) return null;
  return {
    usedRatio: percentage / 100,
    resetAt: typeof legacy?.resetTime === 'string' ? legacy.resetTime : null
  };
}

export function selectQuotaPeriod(usages) {
  if (isMonthlyPlan(usages)) return { period: 'month', ...monthlyQuota(usages) };
  const week = weeklyQuota(usages);
  return week ? { period: 'week', ...week } : null;
}
