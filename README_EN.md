[中文](README.md)

# AnyReach

Intelligent web access for AI agents. CDP browser automation with a site adapter system for deterministic content extraction.


## What it does

AnyReach connects your AI agent (Claude Code, Codex, OpenClaw) to your daily Chrome browser. The agent operates in background tabs — sharing your login state, invisible to anti-bot detection, and never stealing your browser focus.

Three-tier site knowledge:

| Tier | Mechanism | Token cost | When to use |
|------|-----------|------------|-------------|
| **Adapter** (.mjs) | Deterministic code extraction | Zero | Sites with known internal APIs (e.g., Feishu's `window.DATA`) |
| **Hint** (.md) | Prompt-based experience for the LLM | Low | Sites with known patterns but too complex for a fixed script |
| **Generic** | Agent writes JS on the fly via `/eval` | High | Unknown sites, one-off tasks |


## Install

**Let your agent install it:**

```
Install this skill: https://github.com/ayaoplus/anyreach
```

**Manual install (all agents):**

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


## Usage

Once installed, tell your agent to do web tasks:

- *"Read this page: [URL]"*
- *"Search for X on Xiaohongshu"*
- *"Extract content from this Feishu doc"*
- *"Research these 5 competitors in parallel"*

The agent loads SKILL.md, selects the right tool (WebSearch / WebFetch / Jina / CDP), and handles the rest.


## CDP Proxy API

All browser operations go through a local HTTP proxy at `localhost:3456`.

### Tab management

| Endpoint | Method | Parameters | Description |
|----------|--------|-----------|-------------|
| `/new` | GET | `url` — target URL | Open background tab, wait for load, return `{ targetId }` |
| `/close` | GET | `target` — tab ID | Close a tab |
| `/targets` | GET | none | List all open tabs |
| `/health` | GET | none | Connection status, session count, Chrome port |

```bash
# Open a page, get targetId
curl -s "http://localhost:3456/new?url=https://example.com"
# → {"targetId":"ABC123"}

# Close when done
curl -s "http://localhost:3456/close?target=ABC123"
```

### Page interaction

| Endpoint | Method | Parameters | Description |
|----------|--------|-----------|-------------|
| `/eval` | POST | `target`; body = JS expression | Execute arbitrary JavaScript, supports async/await |
| `/click` | POST | `target`; body = CSS selector | JS `el.click()`, covers most cases |
| `/clickAt` | POST | `target`; body = CSS selector | Real mouse event, triggers file dialogs |
| `/fill` | POST | `target`; body = `{ selector, value }` | Fill form fields, React/Vue reactivity compatible |
| `/scroll` | GET | `target`, `direction` (down/up/top/bottom), `y` | Scroll page, waits 800ms for lazy-load |

```bash
# Execute JS to get page title
curl -s -X POST "http://localhost:3456/eval?target=ABC123" -d 'document.title'

# Click a button
curl -s -X POST "http://localhost:3456/click?target=ABC123" -d '.submit-btn'

# Fill a search box
curl -s -X POST "http://localhost:3456/fill?target=ABC123" \
  -d '{"selector":"input[name=q]","value":"hello"}'

# Scroll to bottom
curl -s "http://localhost:3456/scroll?target=ABC123&direction=bottom"
```

### Content extraction

| Endpoint | Method | Parameters | Description |
|----------|--------|-----------|-------------|
| `/extractText` | POST | `target`; body = `{ selector, scroll }` | Auto-scroll container + walk DOM to extract text |
| `/screenshot` | GET | `target`, `file` — save path | Capture screenshot, save to file or return binary |
| `/waitFor` | GET | `target`, `selector`, `timeout` | Wait for element (MutationObserver), 408 on timeout |

```bash
# Scroll-load then extract article content
curl -s -X POST "http://localhost:3456/extractText?target=ABC123" \
  -d '{"selector":"article","scroll":true}'

# Save screenshot
curl -s "http://localhost:3456/screenshot?target=ABC123&file=/tmp/page.png"

# Wait for element (max 5s)
curl -s "http://localhost:3456/waitFor?target=ABC123&selector=.loaded&timeout=5000"
```

### Cookie management

| Endpoint | Method | Parameters | Description |
|----------|--------|-----------|-------------|
| `/setCookie` | POST | `target`; body = Cookie JSON | Inject cookie, supports HttpOnly |
| `/getCookies` | GET | `target`, `domain` (optional) | Get cookies, optionally filter by domain |

```bash
# Inject a cookie
curl -s -X POST "http://localhost:3456/setCookie?target=ABC123" \
  -d '{"name":"token","value":"xxx","domain":".example.com","httpOnly":true}'
```

### Advanced

| Endpoint | Method | Parameters | Description |
|----------|--------|-----------|-------------|
| `/cdp` | POST | `target`, `session` (optional); body = `{ method, params }` | Send arbitrary CDP command |
| `/wheel` | GET | `target`, `x`, `y`, `deltaY` | Real scroll gesture for virtual lists |
| `/preScript` | POST | `target`; body = JS code | Inject script before page JS on every navigation |
| `/adapter` | POST | `url` | Match URL to adapter and run extraction |
| `/events/start` | POST | `target`; body = `{ filter, maxEvents }` | Start collecting CDP events |
| `/events/get` | GET | `id`, `clear` (optional) | Get collected events |
| `/events/stop` | GET | `id` | Stop and remove collector |

```bash
# Send arbitrary CDP command
curl -s -X POST "http://localhost:3456/cdp?target=ABC123" \
  -d '{"method":"Network.enable","params":{}}'

# Collect network events
curl -s -X POST "http://localhost:3456/events/start?target=ABC123" \
  -d '{"filter":"Network","maxEvents":500}'
# → {"collectorId":"COL_1"}
curl -s "http://localhost:3456/events/get?id=COL_1&clear=true"
```

Full reference: [docs/architecture.md](docs/architecture.md)


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


## Installed adapters

| Adapter | Domains | Capabilities |
|---------|---------|-------------|
| **feishu** | feishu.cn, larksuite.com | Wiki/docx extraction. Full document via `window.DATA` block data + Worker interception for long docs. Supports all block types (headings, lists, images, tables, callouts, quotes) with Markdown output. [Technical docs](docs/adapter-feishu.md) |
| **xiaohongshu** | xiaohongshu.com, xhslink.com | Notes (image+text, video+text), profiles, feeds. Scroll-to-load, batch extraction |
| **scys** | scys.com | Articles, opportunities (list/archive modes with pagination + bid filter), activity projects, course manuals (chapter-by-chapter Markdown extraction). [Technical docs](docs/adapter-scys.md) |


## Credits

Architecture inspired by [web-access](https://github.com/eze-is/web-access) by 一泽 Eze. AnyReach diverges from web-access by adding the adapter system, enhanced CDP endpoints, and Worker-level data interception.


## License

MIT
