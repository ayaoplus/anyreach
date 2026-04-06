---
domain: xiaohongshu.com
aliases: [xhslink.com, 小红书]
updated: 2026-04-06
---

## Platform characteristics

- Heavy anti-scraping: static fetch/curl returns empty or blocked pages
- Content is JS-rendered, must use CDP browser mode
- Login state required for full content access (feed, comments, user profiles)
- User's Chrome typically already logged in

## Effective patterns

- Search: navigate to `https://www.xiaohongshu.com`, use the search bar via `/click` + `/fill`, do NOT construct search URLs manually (they require `xsec_token` which is session-bound)
- Note content: text is in `.note-content` or `#detail-desc`, images in `.note-slider img`
- User profile: navigate via clicking user avatar from a note, do NOT construct profile URLs directly
- Scroll to load: feed and comments are lazy-loaded, use `/scroll` with `direction=bottom` to trigger

## Known pitfalls

- Constructing URLs with missing `xsec_token` triggers anti-scraping and may return "content not found" even for valid notes
- Rapid tab opening (>5 tabs in quick succession) may trigger rate limiting
- The "content not found" page does NOT always mean the content is deleted — it may be an access method issue
- Creator platform (`creator.xiaohongshu.com`) has separate login state from main site
