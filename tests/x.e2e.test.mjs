import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import { runAdapter } from '../scripts/adapter-runner.mjs';

const execFileAsync = promisify(execFile);

await execFileAsync('node', ['scripts/check-deps.mjs'], {
  cwd: new URL('..', import.meta.url),
});

const HOME_URL = 'https://x.com/home';
const LIST_URL = 'https://x.com/i/lists/2007919886463582333';
const VIDEO_TWEET_URL = 'https://x.com/wangray/status/2041411785442710008';
const ARTICLE_URL = 'https://x.com/MinLiBuilds/status/2041178722230030384';

test('x adapter extracts home timeline', { timeout: 180000 }, async () => {
  const result = await runAdapter(HOME_URL, { limit: 3 });

  assert.equal(result.adapter, 'x');
  assert.equal(result.pageType, 'home');
  assert.equal(result.contentType, 'timeline');
  assert.equal(result.timelineType, 'home');
  assert.ok(result.selectedTab);
  assert.ok(Array.isArray(result.items));
  assert.ok(result.items.length >= 1);
  assert.ok(result.items[0].statusUrl);
  assert.ok(result.items[0].author.handle.startsWith('@'));
});

test('x adapter extracts list timeline and metadata', { timeout: 180000 }, async () => {
  const result = await runAdapter(LIST_URL, { limit: 3 });

  assert.equal(result.adapter, 'x');
  assert.equal(result.pageType, 'list');
  assert.equal(result.contentType, 'timeline');
  assert.equal(result.timelineType, 'list');
  assert.ok(result.list.name);
  assert.ok(result.list.ownerHandle.startsWith('@'));
  assert.ok(result.list.memberCount >= 0);
  assert.ok(result.items.length >= 1);
  assert.ok(result.items[0].statusUrl);
});

test('x adapter extracts video tweet and stream urls', { timeout: 180000 }, async () => {
  const result = await runAdapter(VIDEO_TWEET_URL);

  assert.equal(result.adapter, 'x');
  assert.equal(result.pageType, 'status');
  assert.equal(result.contentType, 'tweet');
  assert.ok(result.tweet.media.hasVideo);
  assert.ok(result.tweet.media.videos.length >= 1);
  assert.ok(result.tweet.media.videos[0].streamUrls.some(url => url.includes('video.twimg.com')));
  assert.ok(result.tweet.text.includes('MemPalace'));
});

test('x adapter extracts longform article markdown', { timeout: 180000 }, async () => {
  const result = await runAdapter(ARTICLE_URL);

  assert.equal(result.adapter, 'x');
  assert.equal(result.pageType, 'status');
  assert.equal(result.contentType, 'article');
  assert.equal(result.tweet.entryType, 'article');
  assert.ok(result.article.title.length > 0);
  assert.ok(result.article.markdown.includes('# 导读'));
  assert.ok(result.article.markdown.includes('```plaintext'));
  assert.ok(result.article.codeBlockCount >= 1);
});
