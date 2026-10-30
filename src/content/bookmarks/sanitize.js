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
      // <a href> 是普通导航链接，不能和会主动加载远程资源的 src 一样删除；
      // SVG <image>/<use> 等元素的 href 仍按远程资源处理。危险协议统一拦截。
      const isNavigationLink = ['href', 'xlink:href'].includes(attr.name) && el.localName === 'a';
      const mayLoadResource = ['src', 'poster', 'srcset'].includes(attr.name) ||
        (['href', 'xlink:href'].includes(attr.name) && !isNavigationLink);
      if (mayLoadResource) {
        if (attr.name === 'srcset') {
          isRemoteResource = true;
        } else {
          try {
            const baseUri = node.ownerDocument?.baseURI || globalThis.document?.baseURI;
            const url = new URL(attr.value.trim(), baseUri);
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
