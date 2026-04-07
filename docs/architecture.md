# AnyReach Architecture

## Design Philosophy

AnyReach is born from a simple observation: web-access proved that **the best browser tool for AI agents is the user's own browser**. But it left too much work to the LLM — every site visit requires the agent to write custom JS, explore DOM structures, and handle virtualized rendering from scratch. Tokens burn, results vary.

AnyReach keeps the core insight (connect to the user's daily Chrome via CDP, share login state, operate in background tabs) and adds two layers: **site adapters** (executable extraction code) and **prompt hints** (site-specific knowledge for the LLM), backed by a **remote registry** for on-demand download.

```
┌──────────────────────────────────────────────────────┐
│                     AI Agent                          │
│           (Claude Code / Codex / OpenClaw)            │
├──────────────────────────────────────────────────────┤
│                    SKILL.md                           │
│        Browsing philosophy + tool selection           │
├───────────────┬──────────────────────────────────────┤
│ Adapter       │          CDP Proxy                    │
│ Runner        │       (HTTP API server)               │
│               │                                      │
│ ┌──────────┐  │  /new /eval /click /scroll ...       │
│ │feishu.mjs│  │  /extractText /fill /waitFor         │
│ └──────────┘  │  /setCookie /getCookies /preScript   │
│ ┌──────────┐  │                                      │
│ │ scys.mjs │  │          WebSocket                   │
│ └──────────┘  │             │                        │
│ ┌──────────┐  │             ▼                        │
│ │  xhs.mjs │  │       User's Chrome                  │
│ └──────────┘  │     (background tabs)                │
│ ┌──────────┐  │                                      │
│ │  xhs.md  │  │  registry.json (remote index)        │
│ └──────────┘  │                                      │
│ ┌──────────┐  │                                      │
│ │_utils.mjs│  │                                      │
│ └──────────┘  │                                      │
└───────────────┴──────────────────────────────────────┘
```

### Four-layer design

**Layer 1 — Strategy (SKILL.md)**: Tells the agent *how to think* about web tasks. Tool selection matrix, browsing philosophy, failure handling. ~136 lines, no site-specific logic.

**Layer 2 — Infrastructure (CDP Proxy)**: Generic browser automation over HTTP. 24+ endpoints (including `/cdp` for arbitrary CDP commands, `/events/*` for event collection, `/wheel` for real scroll gestures), zero site-specific code. Any agent that can `curl` can use it.

**Layer 3 — Knowledge (Site Adapters + Hints)**: Per-domain extraction logic. Code adapters (`.mjs`) provide deterministic extraction. Prompt hints (`.md`) provide site patterns and pitfalls for LLM-guided exploration. Shared utilities (`_utils.mjs`) eliminate duplication.

**Layer 4 — Distribution (Remote Registry)**: `registry.json` indexes available adapters. The runner auto-downloads missing adapters on first use.

### Resolution order

```
Agent receives URL
  ├─ 1. Local .mjs adapter?  →  run adapter  →  structured content
  ├─ 2. Local .md hint?      →  return hint  →  LLM uses CDP with guidance
  ├─ 3. Remote registry?     →  download + run adapter
  └─ 4. None                 →  generic CDP mode (eval/click/scroll)
```

## CDP Proxy

Node.js HTTP server bridging `curl` commands to Chrome DevTools Protocol over WebSocket. Runs on `localhost:3456` as a persistent detached process.

**Important**: The proxy is a long-running process. After code changes to `cdp-proxy.mjs`, restart with `pkill -f cdp-proxy.mjs && node scripts/check-deps.mjs`.

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

Pages can detect automation by probing the Chrome debug port (`fetch('http://127.0.0.1:9222')`). The proxy intercepts these via `Fetch.requestPaused` and returns `ConnectionRefused`, making the debug port invisible to page JavaScript.

### Endpoints (24+ total)

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
| `/extractText?target=` | POST | `{ selector, scroll }` | Auto-scroll container, then walk DOM to extract visible text |
| `/screenshot?target=&file=` | GET | — | Capture page screenshot. Save to file or return binary |
| `/waitFor?target=&selector=&timeout=` | GET | — | MutationObserver-based wait for element. Returns 408 on timeout |

#### Cookie management

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/setCookie?target=` | POST | Cookie JSON | Inject cookie via `Network.setCookie`. Supports HttpOnly |
| `/getCookies?target=&domain=` | GET | — | Get cookies, optionally filtered by domain |

#### Advanced

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/preScript?target=` | POST | JS code | Inject script via `Page.addScriptToEvaluateOnNewDocument`. Runs before page JS on every navigation. Used for intercepting MediaSource, autoplay, etc. |
| `/adapter?url=` | POST | — | Match URL to site adapter and run extraction. Auto-downloads from registry if needed. Returns structured content or 404 |

#### CDP pass-through & event collection

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/cdp?target=` | POST | `{ method, params }` | Send arbitrary CDP command. Optional `session=` query param for Worker targets |
| `/wheel?target=&x=&y=&deltaY=` | GET | — | Real scroll gesture via `Input.synthesizeScrollGesture`. For virtual lists where `window.scrollBy` doesn't work |
| `/events/start?target=` | POST | `{ filter, maxEvents }` | Start collecting CDP events. Returns `{ collectorId }` |
| `/events/get?id=` | GET | — | Get collected events. Optional `clear=true` to drain |
| `/events/stop?id=` | GET | — | Stop and remove collector |

### Session management

Each tab is identified by `targetId`. The proxy maintains a `targetId → sessionId` mapping via `Target.attachToTarget`. Sessions are created lazily on first interaction and cleaned up on close.

Multiple agents (or sub-agents) can operate different tabs concurrently through the same proxy — each uses its own targetId, no contention.

## Site Adapter System

### Code adapters (.mjs)

Every adapter exports a default object:

```javascript
import { sleep, scrollToLoad, downloadMedia } from './_utils.mjs';

export default {
  name: 'example',
  domains: ['example.com'],
  description: '...',

  detect(url) { ... },                        // classify page type
  async extract(proxy, targetId, ctx) { ... }, // extract content
};
```

### Prompt hints (.md)

For sites where a full code adapter isn't worth the maintenance cost:

```markdown
---
domain: example.com
aliases: [ex, Example]
updated: 2026-04-06
---
## Platform characteristics
...
## Effective patterns
...
## Known pitfalls
...
```

### Shared utilities (_utils.mjs)

| Function | Description |
|----------|-------------|
| `sleep(ms)` | Promise-based delay |
| `downloadFile(url, destPath)` | Download URL to local file (skips blob:) |
| `downloadMedia(mediaObj, destDir)` | Batch download images + videos to directory |
| `scrollToLoad(proxy, targetId, opts)` | Scroll-to-load pattern with card extraction polling |

### ProxyClient

Adapters receive a `ProxyClient` instance wrapping CDP Proxy HTTP calls:

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
proxy.waitFor(targetId, sel, ms)
proxy.navigate(targetId, url)
proxy.info(targetId)                 → { title, url, ready }
proxy.setCookie(targetId, cookie)
proxy.getCookies(targetId, domain)
proxy.preScript(targetId, js)        → { identifier }
```

### Adapter Runner

CLI tool and importable module:

```bash
node adapter-runner.mjs list              # List local adapters and hints
node adapter-runner.mjs check <url>       # Check match level (adapter/hint/remote/none)
node adapter-runner.mjs run <url>         # Run adapter (auto-downloads if remote)
node adapter-runner.mjs hint <url>        # Get .md hint content
node adapter-runner.mjs download <url>    # Pre-fetch remote adapter
```

### Remote registry

`registry.json` at repo root indexes available adapters:

```json
{
  "version": 1,
  "adapters": {
    "feishu": {
      "domains": ["feishu.cn"],
      "files": ["adapters/feishu.mjs"],
      "updated": "2026-04-06"
    }
  },
  "shared": ["adapters/_utils.mjs"]
}
```

When `adapter-runner` finds no local match, it fetches the registry from GitHub, checks for a domain match, and downloads the adapter files + shared dependencies to `adapters/`. Subsequent calls use the local copy.

### Installed adapters

| Adapter | Domains | Capabilities |
|---------|---------|-------------|
| **feishu** | feishu.cn, larksuite.com | Wiki/docx full extraction via `window.DATA` block data + Worker CDP interception for long docs. Markdown output with all block types (headings, lists, images, native tables, callouts, quotes, code). See [adapter-feishu.md](adapter-feishu.md) |
| **xiaohongshu** | xiaohongshu.com, xhslink.com | Notes (image+text, video+text), profiles, feeds. Scroll-to-load, batch extraction |
| **x** | x.com, twitter.com | Home timeline, list timeline, tweet detail, and longform article detail. Video tweets recover `video.twimg.com` HLS URLs from CDP network events; longform articles are rendered to Markdown from Draft.js rich text. See [adapter-x.md](adapter-x.md) |
| **scys** | scys.com | Articles, opportunities (list/archive modes with pagination + bid filter), activity projects, course manuals (chapter-by-chapter Markdown via Feishu SDK DOM). See [adapter-scys.md](adapter-scys.md) |

## SKILL.md Design

The agent-facing prompt teaches thinking strategy, not procedures:

1. **Prerequisites** — environment check + user notice
2. **Browsing philosophy** — four-step loop: define success → choose entry → validate → confirm
3. **Tool selection** — WebSearch / WebFetch / Jina / curl / CDP decision matrix
4. **CDP Proxy API** — endpoint reference for constructing curl commands
5. **Site knowledge** — four-tier check / run / hint / download commands
6. **Parallel dispatch** — sub-agent guidelines (goals not methods)
7. **Technical facts** — virtual rendering, lazy loading, Shadow DOM boundaries

What's NOT in SKILL.md: site-specific instructions, step-by-step workflows, redundant API docs.

## Future Work

### Session management for multi-agent concurrency

Current model: each agent/sub-agent manages its own targetIds. Works for single-agent + sub-agent scenarios (Claude Code spawning parallel sub-agents). Breaks when multiple independent agent frameworks share one proxy — no ownership tracking, no crash cleanup.

Planned: lightweight `/session/create` + `/session/close` layer. Each agent framework gets a session, tabs are associated with sessions, one call cleans up all orphan tabs. Fully backward compatible — existing API works unchanged without sessions.

Not implemented yet. Will build when multi-agent usage becomes real.
