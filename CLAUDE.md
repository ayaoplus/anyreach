# AnyReach - CLAUDE.md

## Project Overview

AnyReach is an intelligent web access skill for AI agents. It provides CDP browser automation with a site adapter system, forked from web-access's design philosophy but with a fundamentally different architecture.

## Development Philosophy

**Vibe Coding + Atomic Commits**: Ship fast, iterate fast, rollback fast.
- Every commit should be atomic: one logical change per commit
- If something breaks, `git revert` should cleanly undo exactly one thing
- Don't batch unrelated changes into a single commit
- **Auto-commit rule**: After completing a code change and communicating the result to the user, immediately `git add` the changed files, commit following the convention below, and `git push`. Do not ask for confirmation — just do it. If multiple logical changes were made, split into multiple atomic commits before pushing.

## Commit Convention

Format: `type: concise description`

Types:
- `feat:` new feature or capability
- `fix:` bug fix
- `refactor:` code restructuring without behavior change
- `adapter:` site adapter changes (add/update/fix)
- `docs:` documentation only
- `chore:` build, config, tooling changes

Rules:
- English only, lowercase, no period at end
- Under 72 characters
- Imperative mood ("add X" not "added X")
- Body optional, use for context when the diff isn't self-explanatory

Examples:
```
feat: add extractText endpoint to CDP proxy
adapter: add feishu wiki/docx extraction via window.DATA
fix: handle background tab focus issue in selection API
refactor: simplify adapter-runner module loading
chore: update .gitignore
```

## Architecture

```
scripts/          → CDP Proxy + environment check + adapter runner + crawler
lib/              → Shared modules (browser-provider)
adapters/         → Site-specific extraction logic (one .mjs per domain)
references/       → API docs, loaded on demand
docs/             → Technical deep-dives (feishu parsing, crawler design, etc.)
.claude-plugin/   → Claude Code skill packaging
SKILL.md          → Agent-facing strategy prompt
```

## Key Technical Decisions

- **window.DATA extraction for Feishu**: DOM/innerText/Selection API all fail due to canvas-level virtualized rendering. Feishu exposes full document data in `window.DATA.clientVars.data.block_map`. This is the only reliable extraction path.
- **CDP Proxy over Playwright**: Direct connection to user's daily Chrome preserves login state, avoids detection, supports parallel background tabs.
- **Adapter pattern**: Site-specific code is executable knowledge, not text hints. When an adapter exists, skip LLM-driven DOM exploration entirely.

## Coding Rules

- Comments in English, code is self-documenting
- Keep adapters self-contained: one file per domain, no cross-adapter dependencies
- CDP Proxy endpoints should be generic (not site-specific)
- SKILL.md changes require careful consideration — every token costs

## Future Work

### Multi-Agent Session Management

When multiple agent frameworks (Claude Code, Codex, OpenClaw) share one CDP Proxy
concurrently, orphan tabs and cross-agent interference become real risks. Current
design relies on callers managing their own targetIds — no agent ownership tracking.

Planned solution: lightweight session layer on top of existing API.

```
POST /session/create                → { sessionId }
GET  /session/tabs?session=xxx      → tabs owned by this session
POST /session/close?session=xxx     → close all tabs in session
```

- `/new` gains optional `session` param — if set, tab is associated with session
- Original API stays fully backward compatible (no session = current behavior)
- Each agent framework creates a session on startup, sub-agents inherit sessionId
- Crash recovery: `/session/close` cleans up all orphan tabs in one call

Do NOT implement until we actually run multiple agents against one proxy.
The existing targetId-based isolation is sufficient for single-agent + sub-agent use.
