# X adapter

## Supported pages

- `https://x.com/home` - logged-in home timeline
- `https://x.com/search?q=<query>&src=typed_query[&f=live|media|user|list]` - search timeline
- `https://x.com/<user>` - user profile timeline
- `https://x.com/<user>/(with_replies|articles|media)` - user profile tab timeline
- `https://x.com/i/lists/<list-id>` - list timeline
- `https://x.com/<user>/status/<status-id>` - normal tweet detail
- `https://x.com/<user>/status/<status-id>` with longform article UI

## Extraction strategy

### Timeline pages

- Read from `main [data-testid="primaryColumn"] article[data-testid="tweet"]`
- Deduplicate entries by normalized status URL / status ID
- Extract author, time, text, metrics, views, media, quoted tweet preview, and external cards
- Home timeline also returns the current selected tab
- Search timelines return search metadata (query, mode, selected tab, tabs) and use X's internal `fetchSearchGraphQL` pagination for larger limits like `limit: 100`
- Profile timelines also return profile header metadata (name, handle, bio, website, join date, follower stats, relationship state, tabs)
- List timeline also returns list metadata (name, owner, members, followers)

### Video tweets

The DOM only exposes `blob:` video URLs. The adapter recovers playable stream URLs by:

1. Enabling CDP `Network`
2. Starting an event collector
3. Reloading the tweet page
4. Triggering `<video>.play()`
5. Reading `video.twimg.com/...m3u8` requests from collected events

Returned media keeps both:

- poster / blob URL from DOM
- HLS stream URLs from network events

### Longform articles

X longform articles render through Draft.js rich text. The adapter converts the rendered article view to Markdown by traversing:

- headings
- blockquotes
- lists
- fenced code blocks
- inline bold / italic / links

The result includes article title, Markdown, headings, links, and code block count.

## Runtime requirements

- Search pages usually work without login, but login improves result depth and rate-limit resilience
- `home` and many `list` pages require the current Chrome profile to be logged in to X
- Public profile pages usually work without login, but login still improves reliability and increases the visible timeline depth
- Public tweet / article pages usually work without login, but login still improves reliability

## Example

```bash
node -e "import { runAdapter } from './scripts/adapter-runner.mjs'; \
  const r = await runAdapter('https://x.com/search?q=AI&src=typed_query&f=live', { limit: 100 }); \
  console.log(JSON.stringify({ mode: r.search.mode, itemCount: r.itemCount }, null, 2));"
```

## E2E test

```bash
node --test tests/x.e2e.test.mjs
```

The test suite covers home timeline, search timeline, profile timeline, list timeline, tweet detail, and longform article detail against live X pages.
