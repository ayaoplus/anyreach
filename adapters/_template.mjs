// AnyReach adapter template — copy to {domain}.mjs and fill in.
//
// Shared utils:
//   import { sleep, downloadFile, downloadMedia, scrollToLoad } from './_utils.mjs';
//
// ProxyClient (proxy.*):
//   eval, click, clickAt, scroll, screenshot, extractText, fill,
//   waitFor, navigate, info, close, newTab, setCookie, getCookies, preScript

// import { sleep, downloadFile, downloadMedia, scrollToLoad } from './_utils.mjs';

export default {
  // --- required ---
  name: 'TODO',
  domains: ['TODO.com'],
  description: 'TODO',

  // --- optional: classify URL into page type ---
  detect(url) {
    // return 'article', 'list', etc. based on URL pattern
    return 'default';
  },

  // --- required: extract content from a loaded page ---
  // proxy: ProxyClient instance
  // targetId: browser tab ID (already navigated to ctx.url)
  // ctx: { url, pageType, limit?, ...extra options }
  async extract(proxy, targetId, ctx) {
    // 1. wait for content to render
    // await proxy.waitFor(targetId, '.content', 10000);

    // 2. extract data
    // const data = await proxy.eval(targetId, `document.title`);

    // 3. return structured result
    return { error: 'not implemented' };
  },
};
