export function sanitizeHtml(node) {
  const clone = node.cloneNode(true);
  clone
    .querySelectorAll(
      'script, iframe, object, embed, link, meta, base, style, ' +
      'animate, set, animateTransform, animateMotion, ' +
      'img[src^="http:"], img[src^="https:"], ' +
      '.a-msg-ft, .kbm-star'
    )
    .forEach((el) => el.remove());
  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const isEvent = attr.name.startsWith('on');
      const isDangerousUrl = /^\s*(javascript:|data:text\/html)/i.test(attr.value);
      let isRemoteResource = false;
      if (['src', 'poster', 'href', 'xlink:href', 'srcset'].includes(attr.name)) {
        if (attr.name === 'srcset') {
          isRemoteResource = true;
        } else {
          try {
            const url = new URL(attr.value.trim(), document.baseURI);
            isRemoteResource = ['http:', 'https:'].includes(url.protocol);
          } catch {}
        }
      }
      if (isEvent || isDangerousUrl || isRemoteResource) el.removeAttribute(attr.name);
    }
  }
  stripComments(clone);
  return clone.innerHTML.replace(/>\s+</g, '><');
}

function stripComments(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 8) child.remove();
    else stripComments(child);
  }
}

export function sanitizeStoredHtml(html) {
  if (!html || typeof document === 'undefined') return '';
  const container = document.createElement('div');
  container.innerHTML = html;
  return sanitizeHtml(container);
}
