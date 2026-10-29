export function markdownText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\b([a-z][a-z0-9+.-]*):/gi, (match, scheme) =>
      ['http', 'https', 'mailto'].includes(scheme.toLowerCase()) ? match : `${scheme}&#58;`);
}
