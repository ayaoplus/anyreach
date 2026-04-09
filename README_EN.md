<div align="left">

[中文](README.md)

</div>

<div align="center">

<img src="docs/img/logo.png" alt="AnyReach" width="440" />

*Bring agents anywhere.*

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/ayaoplus/anyreach?style=social)](https://github.com/ayaoplus/anyreach)

[Quick Start](#install) · [CDP API](#cdp-proxy-api) · [Adapter System](#adapter-system) · [Installed Adapters](#installed-adapters)

</div>

---

## What it does

AnyReach connects your AI agent (Claude Code, Codex, OpenClaw) to your daily Chrome browser. The agent operates in background tabs — sharing your login state, invisible to anti-bot detection, and never stealing your browser focus.

Three-tier site knowledge:

| Tier | Mechanism | Token cost | When to use |
|------|-----------|------------|-------------|
| **Adapter** (.mjs) | Deterministic code extraction | Zero | Sites with known internal APIs (e.g., Feishu's `window.DATA`) |
| **Hint** (.md) | Prompt-based experience for the LLM | Low | Sites with known patterns but too complex for a fixed script |
| **Generic** | Agent writes JS on the fly via `/eval` | High | Unknown sites, one-off tasks |

---

## Install

**Let your agent install it:**

```
Install this skill: https://github.com/ayaoplus/anyreach
```

**Manual install:**

```bash
git clone https://github.com/ayaoplus/anyreach ~/anyreach
node ~/anyreach/scripts/install.mjs
```

This creates symlinks for all supported agents:
- `~/.claude/skills/anyreach` → Claude Code
- `~/.agents/skills/anyreach` → Codex + OpenClaw

One copy, shared `SKILL.md`, all three agents can load it.

### Prerequisites

- **Node.js 22+** (uses native WebSocket)
- **Chrome** with remote debugging enabled:
  1. Open `chrome://inspect/#remote-debugging`
  2. Check **"Allow remote debugging for this browser instance"**
  3. Restart Chrome if needed

### Verify

```bash
node ~/anyreach/scripts/check-deps.mjs
# Expected: node: ok, chrome: ok, proxy: ready
```

---

## Usage

Once installed, tell your agent to do web tasks:

- *"Read this page: [URL]"*
- *"Search for X on Xiaohongshu"*
- *"Extract content from this Feishu doc"*
- *"Research these 5 competitors in parallel"*

The agent loads SKILL.md, selects the right tool (WebSearch / WebFetch / Jina / CDP), and handles the rest.

---

## CDP Proxy API

All browser operations go through a local HTTP proxy at `localhost:3456`.

| Endpoint | Method | Category | Parameters | Description |
|----------|--------|----------|-----------|-------------|
| `/new` | GET | Tab | `url` — target URL | Open background tab, wait for load, return `{ targetId }` |
| `/close` | GET | Tab | `target` — tab ID | Close a tab |
| `/targets` | GET | Tab | none | List all open tabs |
| `/health` | GET | Tab | none | Connection status, session count, Chrome port |
| `/eval` | POST | Interact | `target`; body = JS expression | Execute arbitrary JavaScript, supports async/await |
| `/click` | POST | Interact | `target`; body = CSS selector | JS `el.click()`, covers most cases |
| `/clickAt` | POST | Interact | `target`; body = CSS selector | Real mouse event, triggers file dialogs |
| `/fill` | POST | Interact | `target`; body = `{ selector, value }` | Fill form fields, React/Vue reactivity compatible |
| `/scroll` | GET | Interact | `target`, `direction` (down/up/top/bottom), `y` | Scroll page, waits 800ms for lazy-load |
| `/wheel` | GET | Interact | `target`, `x`, `y`, `deltaY` | Real scroll gesture for virtual lists |
| `/extractText` | POST | Extract | `target`; body = `{ selector, scroll }` | Auto-scroll container + walk DOM to extract text |
| `/screenshot` | GET | Extract | `target`, `file` — save path | Capture screenshot, save to file or return binary |
| `/waitFor` | GET | Extract | `target`, `selector`, `timeout` | Wait for element (MutationObserver), 408 on timeout |
| `/setCookie` | POST | Cookie | `target`; body = Cookie JSON | Inject cookie, supports HttpOnly |
| `/getCookies` | GET | Cookie | `target`, `domain` (optional) | Get cookies, optionally filter by domain |
| `/cdp` | POST | Advanced | `target`, `session` (optional); body = `{ method, params }` | Send arbitrary CDP command |
| `/preScript` | POST | Advanced | `target`; body = JS code | Inject script before page JS on every navigation |
| `/adapter` | POST | Advanced | `url` | Match URL to adapter and run extraction |
| `/events/start` | POST | Advanced | `target`; body = `{ filter, maxEvents }` | Start collecting CDP events |
| `/events/get` | GET | Advanced | `id`, `clear` (optional) | Get collected events |
| `/events/stop` | GET | Advanced | `id` | Stop and remove collector |

**Examples**

```bash
# Open a page, get targetId
curl -s "http://localhost:3456/new?url=https://example.com"
# → {"targetId":"ABC123"}

# Execute JS to get page title
curl -s -X POST "http://localhost:3456/eval?target=ABC123" -d 'document.title'

# Fill a search box and submit
curl -s -X POST "http://localhost:3456/fill?target=ABC123" \
  -d '{"selector":"input[name=q]","value":"hello"}'
curl -s -X POST "http://localhost:3456/click?target=ABC123" -d '.submit-btn'

# Scroll-load then extract article content
curl -s -X POST "http://localhost:3456/extractText?target=ABC123" \
  -d '{"selector":"article","scroll":true}'

# Collect network events (useful for recovering API responses)
curl -s -X POST "http://localhost:3456/events/start?target=ABC123" \
  -d '{"filter":"Network","maxEvents":500}'
# → {"collectorId":"COL_1"}
curl -s "http://localhost:3456/events/get?id=COL_1&clear=true"

# Close when done
curl -s "http://localhost:3456/close?target=ABC123"
```

Full reference: [docs/architecture.md](docs/architecture.md)

---

## Adapter system

Four-tier resolution: local adapter → local hint → remote registry → generic CDP.

When `run` encounters a URL with a remote adapter, it auto-downloads to `adapters/` and executes — no manual setup needed.

### Check what's available for a URL

```bash
node scripts/adapter-runner.mjs check "https://feishu.cn/wiki/xxx"
# {"level":"adapter","name":"feishu",...}

node scripts/adapter-runner.mjs check "https://unknown-site.com"
# {"level":"none"}
```

### Run a code adapter

```bash
node scripts/adapter-runner.mjs run "https://feishu.cn/wiki/xxx"
# Returns structured JSON with title, content, metadata
```

### Write your own adapter

Copy `adapters/_template.mjs`:

```javascript
export default {
  name: 'mysite',
  domains: ['mysite.com'],
  description: 'Extract articles from mysite',

  detect(url) {
    if (url.includes('/post/')) return 'post';
    return 'default';
  },

  async extract(proxy, targetId, ctx) {
    const title = await proxy.eval(targetId, 'document.title');
    const { text } = await proxy.extractText(targetId, { selector: 'article' });
    return { title, content: text, format: 'text' };
  },
};
```

---

## Installed adapters

| Adapter | Domains | Capabilities |
|---------|---------|-------------|
| [**feishu**](docs/adapter-feishu.md) | feishu.cn, larksuite.com | Wiki/docx extraction. Full document via `window.DATA` block data + Worker interception for long docs. Supports all block types (headings, lists, images, tables, callouts, quotes) with Markdown output. |
| **xiaohongshu** | xiaohongshu.com, xhslink.com | Notes (image+text, video+text), profiles, feeds. Scroll-to-load, batch extraction. |
| [**x**](docs/adapter-x.md) | x.com, twitter.com | Home timeline, search timeline, profile timeline, list timeline, tweet detail, and longform article detail. Search uses internal pagination for larger tweet batches such as `limit: 100`; tweet videos recover `video.twimg.com` HLS URLs via CDP network events, and longform articles are converted to Markdown. |
| [**scys**](docs/adapter-scys.md) | scys.com | Articles, opportunities (list/archive modes with pagination + bid filter), activity projects, course manuals (chapter-by-chapter Markdown extraction). |

---

## Credits

Architecture inspired by [web-access](https://github.com/eze-is/web-access) by 一泽 Eze. AnyReach diverges from web-access by adding the adapter system, enhanced CDP endpoints, and Worker-level data interception.

---

## License

MIT
