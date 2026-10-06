// Markdown + LaTeX -> sanitized HTML. Math ($…$, $$…$$) is pulled out before markdown so `_` and `*` inside it survive.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import katex from '/vendor/katex/katex.mjs';

marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});

const cache = new Map();
export function md(src = '') {
  if (cache.has(src)) return cache.get(src);
  const math = [];
  const text = src.replace(/\$\$([\s\S]+?)\$\$|\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (_, block, inline) => {
    math.push(katex.renderToString(block ?? inline, { displayMode: block != null, throwOnError: false }));
    return `@@KMATH${math.length - 1}@@`;
  });
  const html = DOMPurify.sanitize(marked.parse(text).replace(/@@KMATH(\d+)@@/g, (_, i) => math[i]));
  if (cache.size > 500) cache.clear();
  cache.set(src, html);
  return html;
}
