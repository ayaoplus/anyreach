# AnyReach

Intelligent web access for AI agents. CDP browser automation with a three-tier site knowledge system.

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

### Core endpoints

```bash
curl -s "http://localhost:3456/new?url=URL"                          # Open background tab
curl -s -X POST "http://localhost:3456/eval?target=ID" -d 'JS'      # Execute JavaScript
curl -s -X POST "http://localhost:3456/click?target=ID" -d '.btn'   # Click element
curl -s "http://localhost:3456/scroll?target=ID&direction=bottom"    # Scroll
curl -s "http://localhost:3456/screenshot?target=ID&file=/tmp/s.png" # Screenshot
curl -s "http://localhost:3456/close?target=ID"                      # Close tab
```

### Enhanced endpoints (beyond web-access)

```bash
curl -s -X POST "http://localhost:3456/extractText?target=ID" \
  -d '{"selector":".content","scroll":true}'                         # Auto-scroll + extract text
curl -s -X POST "http://localhost:3456/fill?target=ID" \
  -d '{"selector":"input","value":"text"}'                           # Fill form (React/Vue compatible)
curl -s "http://localhost:3456/waitFor?target=ID&selector=.loaded"   # Wait for element (MutationObserver)
curl -s -X POST "http://localhost:3456/setCookie?target=ID" \
  -d '{"name":"k","value":"v","domain":".x.com","httpOnly":true}'    # Inject HttpOnly cookie
```

Full reference: [docs/architecture.md](docs/architecture.md)

## Adapter system

Four-tier resolution: local adapter → local hint → remote registry → generic CDP.

When `run` encounters a URL with a remote adapter, it auto-downloads to `adapters/` and executes — no manual setup needed.

### Check what's available for a URL

```bash
node scripts/adapter-runner.mjs check "https://feishu.cn/wiki/xxx"
# {"level":"adapter","name":"feishu",...}

node scripts/adapter-runner.mjs check "https://xiaohongshu.com/explore/xxx"
# {"level":"adapter","name":"xiaohongshu",...}   (code adapter takes priority over hint)

node scripts/adapter-runner.mjs check "https://unknown-site.com"
# {"level":"remote","name":"...",...}   or   {"level":"none"}
```

### Run a code adapter

```bash
node scripts/adapter-runner.mjs run "https://feishu.cn/wiki/xxx"
# Returns structured JSON with title, content, metadata
```

### Get a hint

```bash
node scripts/adapter-runner.mjs hint "https://xiaohongshu.com/explore/xxx"
# Returns .md content with platform patterns, pitfalls, effective strategies
```

### Write your own adapter

**Code adapter** — copy `adapters/_template.mjs`:

```javascript
export default {
  name: 'mysite',
  domains: ['mysite.com'],
  description: 'Extract articles from mysite',

  detect(url) {
    if (url.includes('/post/')) return 'post';
    return 'default';
  },

  async extract(proxy, targetId, /* ctx */) {
    const title = await proxy.eval(targetId, 'document.title');
    const { text } = await proxy.extractText(targetId, { selector: 'article' });
    return { title, content: text, format: 'text' };
  },
};
```

**Hint file** — create `adapters/mysite.md`:

```markdown
---
domain: mysite.com
aliases: [ms, MySite]
updated: 2026-04-06
---

## Platform characteristics
...

## Effective patterns
...

## Known pitfalls
...
```

## Architecture

```
SKILL.md              Agent strategy prompt (browsing philosophy, tool selection)
registry.json         Remote adapter registry (auto-download index)
scripts/
  cdp-proxy.mjs       HTTP → Chrome CDP bridge (20 endpoints)
  check-deps.mjs      Environment check + proxy auto-start
  adapter-runner.mjs   Four-tier matcher + remote download
adapters/
  _utils.mjs          Shared utilities (sleep, downloadFile, scrollToLoad)
  _template.mjs       Adapter template
  feishu.mjs          Feishu docs (window.DATA extraction)
  xiaohongshu.mjs     Xiaohongshu notes, profiles, feeds (platform notes in header)
  scys.mjs            生财有术 articles, opportunities, courses
```

Design deep-dive: [docs/architecture.md](docs/architecture.md)

## Credits

Architecture inspired by [web-access](https://github.com/eze-is/web-access) by 一泽 Eze. AnyReach diverges from web-access by adding the adapter system and enhanced CDP endpoints.

## License

MIT
