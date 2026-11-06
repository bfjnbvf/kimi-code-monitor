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
  return Boolean(usages?.limit7d || usages?.limit_7d || usages?.week || usages?.usage);
}

export function isMonthlyPlan(usages) {
  return Boolean(monthlyQuota(usages) && !hasWeekQuota(usages));
}
