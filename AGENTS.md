# AnyReach - AGENTS.md

## Scope

This file defines the commit workflow for agents working in this repository.
Follow the existing commit style already established in git history.

## Atomic Commit Policy

- One commit must contain exactly one logical change.
- Finish the change first, then commit immediately. Do not accumulate multiple unrelated edits before committing.
- Stage only the files required for that logical change.
- If multiple logical changes are completed in one session, split them into multiple commits.
- Documentation updates that only describe a code change should go into the same commit as that change. Unrelated docs changes should be committed separately.
- Refactor, bug fix, feature, and adapter changes must not be mixed in one commit unless they are inseparable parts of the same logical change.
- Before committing, run the minimal relevant verification for the change when feasible.
- If a committed change turns out to be wrong, rollback with `git revert <commit>` so the history stays explicit and recoverable.
- Do not rewrite shared history to undo mistakes. Prefer revert over destructive reset.

## Commit Workflow

1. Make one logical change.
2. Verify the change with the smallest effective check.
3. Stage only the relevant files.
4. Commit immediately using the convention below.
5. If a later issue is found, create a dedicated revert commit instead of folding the rollback into another change.

## Commit Convention

Format:

```text
<type>: <concise imperative summary>
```

Allowed types used by this repository:

- `feat`: new feature or capability
- `fix`: bug fix
- `refactor`: code restructuring without intended behavior change
- `adapter`: site adapter add/update/fix
- `docs`: documentation only
- `chore`: tooling, config, maintenance

Rules:

- Use English only.
- Use lowercase type.
- Use imperative mood, for example `add`, `fix`, `update`, `remove`.
- Keep the subject concise and preferably under 72 characters.
- Do not end the subject with a period.
- Body is optional. Add it only when context, constraint, or rollback guidance is useful.

## Commit Template

```text
<type>: <concise imperative summary>

Context: <optional background>
Why: <optional reason>
Validation: <optional verification>
Rollback: git revert <commit>
```

## Examples

```text
feat: add --user-data-dir param to crawler cli
fix: fetch webSocketDebuggerUrl from /json/version for headless chrome
docs: sync crawler design and architecture with v1 implementation
adapter: add feishu wiki/docx extraction via window.DATA
refactor: simplify adapter-runner module loading
chore: update agent commit instructions
```
