// AnyReach shared adapter utilities
// Import in adapters: import { sleep, downloadFile, scrollToLoad } from './_utils.mjs';

import fs from 'node:fs';
import path from 'node:path';

// --- Timing ---

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Media download ---

// Download a URL to local file. Skips blob: URLs.
export async function downloadFile(url, destPath) {
  if (!url || url.startsWith('blob:')) return { error: 'blob URL cannot be downloaded' };
  try {
    const res = await fetch(url);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    return { saved: destPath, size: buffer.length };
  } catch (e) {
    return { error: e.message };
  }
}

// Download multiple media files (images + videos) into a directory.
// mediaObj: { images?: string[], video?: string, videos?: string[] }
export async function downloadMedia(mediaObj, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const results = [];

  // single video
  if (mediaObj.video && !mediaObj.video.startsWith('blob:')) {
    results.push(await downloadFile(mediaObj.video, path.join(destDir, 'video.mp4')));
  }
  // multiple videos
  for (let i = 0; i < (mediaObj.videos || []).length; i++) {
    results.push(await downloadFile(mediaObj.videos[i], path.join(destDir, `video_${i + 1}.mp4`)));
  }
  // images
  for (let i = 0; i < (mediaObj.images || mediaObj.imgs || []).length; i++) {
    const url = (mediaObj.images || mediaObj.imgs)[i];
    const ext = url.includes('.png') ? 'png' : 'jpg';
    results.push(await downloadFile(url, path.join(destDir, `image_${i + 1}.${ext}`)));
  }

  return results;
}

// --- Scroll-to-load pattern ---

// Scroll a page to load N items, polling a card selector.
// Returns the final array of extracted cards.
// extractJS: JS string that returns an array of card objects from the DOM.
export async function scrollToLoad(proxy, targetId, {
  extractJS,
  limit = 20,
  maxScrollAttempts = 15,
  scrollDelay = 1500,
} = {}) {
  let cards = [];
  let scrollAttempts = 0;
  let staleCount = 0; // 连续无新增次数，连续 2 次才停止

  while (cards.length < limit && scrollAttempts < maxScrollAttempts) {
    const current = await proxy.eval(targetId, extractJS);
    if (!Array.isArray(current)) { staleCount++; if (staleCount >= 2) break; continue; }
    if (current.length > cards.length) { cards = current; staleCount = 0; }
    if (cards.length >= limit) break;

    await proxy.scroll(targetId, { direction: 'bottom' });
    await sleep(scrollDelay);
    scrollAttempts++;

    const after = await proxy.eval(targetId, extractJS);
    if (!Array.isArray(after)) { staleCount++; if (staleCount >= 2) break; continue; }
    if (after.length <= cards.length) {
      staleCount++;
      if (staleCount >= 2) break; // 连续 2 次无新增才认为到底
    } else {
      cards = after;
      staleCount = 0;
    }
  }

  return cards.slice(0, limit);
}
