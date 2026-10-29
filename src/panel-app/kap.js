export function normalizeKapOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return '';
    if (!url.port || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function spaOrigin() {
  try {
    return normalizeKapOrigin(sessionStorage.getItem('kimi-desktop-server-origin'));
  } catch {
    return '';
  }
}

function learnKapOrigin() {
  try {
    for (const entry of performance.getEntriesByType('resource')) {
      const match = /^(https?:\/\/127\.0\.0\.1:\d+)\/api\//.exec(entry.name);
      if (match) return match[1];
    }
  } catch {}
  return '';
}

export function createKapContext() {
  const kapOrigin = () => normalizeKapOrigin(globalThis.__kcmKapOrigin) || spaOrigin() || learnKapOrigin() || '';
  const apiUrl = (path) => `${kapOrigin()}${path}`;
  const fetchJson = async (path) => {
    const response = await fetch(apiUrl(path), { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  return { kapOrigin, apiUrl, fetchJson };
}
