# X adapter

## Supported pages

- `https://x.com/home` - logged-in home timeline
- `https://x.com/i/lists/<list-id>` - list timeline
- `https://x.com/<user>/status/<status-id>` - normal tweet detail
- `https://x.com/<user>/status/<status-id>` with longform article UI

## Extraction strategy

### Timeline pages

- Read from `main [data-testid="primaryColumn"] article[data-testid="tweet"]`
- Deduplicate entries by normalized status URL / status ID
- Extract author, time, text, metrics, views, media, quoted tweet preview, and external cards
- Home timeline also returns the current selected tab
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

- `home` and many `list` pages require the current Chrome profile to be logged in to X
- Public tweet / article pages usually work without login, but login still improves reliability

## E2E test

```bash
node --test tests/x.e2e.test.mjs
```

The test suite covers the exact four page types above against live X pages.
