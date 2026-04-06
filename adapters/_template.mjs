// AnyReach adapter template
// Copy to {domain}.mjs and implement. See _utils.mjs for shared helpers.
//
// Adapter interface:
//   name, domains[], description
//   detect(url) → pageType string
//   extract(proxy, targetId, ctx) → result object
//
// ProxyClient methods: eval, click, clickAt, scroll, screenshot,
//   extractText, fill, waitFor, navigate, info, close, setCookie,
//   getCookies, newTab, preScript
//
// Shared utils: import { sleep, downloadFile, downloadMedia, scrollToLoad } from './_utils.mjs';

import { sleep, scrollToLoad } from './_utils.mjs';

export default {
  name: 'example',
  domains: ['example.com'],
  description: 'Example adapter',

  detect(url) {
    if (url.includes('/article/')) return 'article';
    return 'default';
  },

  async extract(proxy, targetId, /* ctx */) {
    await proxy.waitFor(targetId, 'article', 10000);
    await sleep(500);
    const title = await proxy.eval(targetId, 'document.title');
    const cards = await scrollToLoad(proxy, targetId, {
      extractJS: `Array.from(document.querySelectorAll('.item')).map(el => el.innerText)`,
      limit: 10,
    });
    return { title, cards, format: 'json' };
  },
};
