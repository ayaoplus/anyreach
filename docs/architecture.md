# AnyReach Architecture

## Design Philosophy

AnyReach is born from a simple observation: web-access proved that **the best browser tool for AI agents is the user's own browser**. But it left too much work to the LLM — every site visit requires the agent to write custom JS, explore DOM structures, and handle virtualized rendering from scratch. Tokens burn, results vary.

AnyReach keeps the core insight (connect to the user's daily Chrome via CDP, share login state, operate in background tabs) and adds one layer: **site adapters** — executable knowledge that replaces LLM-driven DOM exploration with deterministic extraction code.

```
┌─────────────────────────────────────────────────┐
│                   AI Agent                       │
│         (Claude Code / Codex / OpenClaw)         │
├─────────────────────────────────────────────────┤
│                  SKILL.md                        │
│      Browsing philosophy + tool selection        │
├──────────────┬──────────────────────────────────┤
│ Adapter      │        CDP Proxy                  │
│ Runner       │     (HTTP API server)             │
│              │                                   │
│  ┌────────┐  │  /new /eval /click /scroll ...    │
│  │feishu  │  │  /extractText /fill /waitFor      │
│  │  .mjs  │──│  /setCookie /getCookies           │
│  └────────┘  │                                   │
│  ┌────────┐  │         WebSocket                 │
│  │ x.mjs  │  │            │                      │
│  └────────┘  │            ▼                      │
│     ...      │     User's Chrome                 │
│              │   (background tabs)               │
└──────────────┴──────────────────────────────────┘
```

### Three-layer design

**Layer 1 — Strategy (SKILL.md)**: Tells the agent *how to think* about web tasks. Tool selection matrix, browsing philosophy, failure handling. No site-specific logic. ~127 lines.

**Layer 2 — Infrastructure (CDP Proxy)**: Generic browser automation over HTTP. Any agent that can `curl` can use it. 19 endpoints, zero site-specific code.

**Layer 3 — Knowledge (Site Adapters)**: Per-domain extraction logic. When an adapter exists, the agent skips LLM exploration and gets structured content in one call. When it doesn't, the agent falls back to Layer 2 with raw eval/click/scroll.

## CDP Proxy

A Node.js HTTP server that bridges `curl` commands to Chrome DevTools Protocol over WebSocket. Runs on `localhost:3456` as a persistent background process.

### Connection flow

```
check-deps.mjs
  ├── Check Node.js >= 22
  ├── Discover Chrome debug port
  │     ├── Read DevToolsActivePort file (macOS/Linux/Windows paths)
  │     └── Fallback: probe ports 9222, 9229, 9333
  └── Start cdp-proxy.mjs (detached, logs to $TMPDIR/anyreach-proxy.log)
        ├── Connect to Chrome via WebSocket
        ├── Listen on localhost:3456
        └── Ready (health check passes)
```

### Anti-detection

Pages can detect automation by probing the Chrome debug port (`fetch('http://127.0.0.1:9222')`). The proxy intercepts these requests via `Fetch.requestPaused` and returns `ConnectionRefused`, making the debug port invisible to page JavaScript.

### Endpoints

#### Tab management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Connection status, session count, Chrome port |
| `/targets` | GET | List all open page tabs (targetId, title, url) |
| `/new?url=` | GET | Create background tab, wait for load. Returns `{ targetId }` |
| `/close?target=` | GET | Close a tab |

#### Navigation

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/navigate?target=&url=` | GET | Navigate existing tab to URL, wait for load |
| `/back?target=` | GET | Go back one page |
| `/info?target=` | GET | Get page title, URL, readyState |

#### Interaction

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/eval?target=` | POST | JS expression | Execute arbitrary JavaScript. Supports async/await. Returns `{ value }` or `{ error }` |
| `/click?target=` | POST | CSS selector | `el.click()` — fast, covers most cases |
| `/clickAt?target=` | POST | CSS selector | `Input.dispatchMouseEvent` — real mouse event, triggers file dialogs |
| `/setFiles?target=` | POST | `{ selector, files[] }` | Set local file paths on `<input type="file">` via `DOM.setFileInputFiles` |
| `/fill?target=` | POST | `{ selector, value }` or array | Fill form fields. Uses native setter to trigger React/Vue reactivity |
| `/scroll?target=&direction=&y=` | GET | — | Scroll page. direction: down/up/top/bottom. Waits 800ms for lazy-load |

#### Content extraction

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/extractText?target=` | POST | `{ selector, scroll }` | Auto-scroll container, then walk DOM to extract visible text. Returns `{ text, length }` |
| `/screenshot?target=&file=` | GET | — | Capture page screenshot. Save to file or return binary |
| `/waitFor?target=&selector=&timeout=` | GET | — | MutationObserver-based wait for element. Returns 408 on timeout |

#### Cookie management

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/setCookie?target=` | POST | Cookie JSON | Inject cookie via `Network.setCookie`. Supports HttpOnly |
| `/getCookies?target=&domain=` | GET | — | Get cookies, optionally filtered by domain |

#### Adapter dispatch

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/adapter?url=` | POST | Match URL to a site adapter and run extraction. Returns structured content or 404 if no adapter |

### Session management

Each tab is identified by `targetId`. The proxy maintains a `targetId → sessionId` mapping via `Target.attachToTarget`. Sessions are created lazily on first interaction with a tab and cleaned up on close.

Multiple agents (or sub-agents) can operate different tabs concurrently through the same proxy — each uses its own targetId, no contention.

## Site Adapter System

### Interface

Every adapter is a single `.mjs` file in `adapters/` exporting a default object:

```javascript
export default {
  name: 'example',           // Adapter identifier
  domains: ['example.com'],  // Matched against URL hostname
  description: '...',        // Human-readable description

  // Classify page type from URL (optional)
  detect(url) {
    if (url.includes('/article/')) return 'article';
    return 'default';
  },

  // Extract content. Receives ProxyClient + targetId for an already-loaded tab
  async extract(proxy, targetId, ctx) {
    // ctx: { url, pageType }
    const title = await proxy.eval(targetId, 'document.title');
    const { text } = await proxy.extractText(targetId, { selector: '.content' });
    return { title, content: text, format: 'text' };
  },
};
```

### ProxyClient

Adapters receive a `ProxyClient` instance that wraps CDP Proxy HTTP calls:

```
proxy.newTab(url)                    → targetId
proxy.close(targetId)
proxy.eval(targetId, js)             → value
proxy.click(targetId, selector)
proxy.clickAt(targetId, selector)
proxy.scroll(targetId, { direction })
proxy.screenshot(targetId, filePath)
proxy.extractText(targetId, opts)    → { text, length }
proxy.fill(targetId, fields)
proxy.waitFor(targetId, selector, timeout)
proxy.navigate(targetId, url)
proxy.info(targetId)                 → { title, url, ready }
proxy.setCookie(targetId, cookie)
proxy.getCookies(targetId, domain)
```

### Adapter Runner

`adapter-runner.mjs` serves as both CLI tool and importable module:

```bash
# CLI usage
node adapter-runner.mjs list              # List installed adapters
node adapter-runner.mjs check <url>       # Check if URL has an adapter
node adapter-runner.mjs run <url>         # Run adapter, output JSON

# Programmatic usage (from CDP Proxy /adapter endpoint)
import { runAdapter } from './adapter-runner.mjs';
const result = await runAdapter(url, { proxyPort: 3456 });
```

The runner handles the full lifecycle: load adapter → create tab → call extract → close tab → return result.

### Adapter vs generic mode

```
Agent receives URL
  │
  ├── adapter-runner check URL
  │     ├── has_adapter: true  →  adapter-runner run URL  →  structured content
  │     └── has_adapter: false →  generic CDP mode (eval/click/scroll by LLM)
  │
  └── (SKILL.md guides this decision)
```

When an adapter exists: one command, deterministic result, minimal tokens.
When it doesn't: the agent uses CDP Proxy endpoints directly, writing JS on the fly — same capability as web-access, just with more convenience endpoints.

## SKILL.md Design

The agent-facing prompt follows web-access's philosophy: **teach the agent how to think, not what to do**.

Structure:
1. **Prerequisites** — environment check command + user notice
2. **Browsing philosophy** — four-step loop: define success → choose entry point → validate each step → confirm completion
3. **Tool selection** — when to use WebSearch vs WebFetch vs Jina vs curl vs CDP
4. **CDP Proxy API** — endpoint reference (agent needs this to construct curl commands)
5. **Adapter system** — three commands: check / run / list
6. **Parallel dispatch** — sub-agent guidelines (describe goals, not methods)
7. **Technical facts** — things the LLM might not recall in context (virtual rendering, lazy loading, Shadow DOM boundaries)

What's NOT in SKILL.md:
- No site-specific instructions (that's what adapters are for)
- No step-by-step workflows (the agent decides its own path)
- No redundant API docs (detailed reference is in `references/cdp-api.md`, loaded on demand)
