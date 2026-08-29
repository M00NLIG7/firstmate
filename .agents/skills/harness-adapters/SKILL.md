---
name: harness-adapters
description: >-
  Agent-only reference for firstmate harness operations.
  Use before spawning or recovering a crewmate or secondmate, handling a trust dialog, sending a harness-specific skill invocation, interrupting or exiting an agent, resuming an exited agent, or verifying a new harness adapter.
  Contains verified facts for claude, codex, opencode, pi, pi-signed, grok, kimi, cursor, and muse.
user-invocable: false
metadata:
  internal: true
---

# harness-adapters

This is the one skill, trigger, and routing owner for harness-specific Firstmate operations.
Load this router first, then exactly the common reference and one harness reference selected below.
When an action spans rows, load the union once rather than every reference.
Files under `references/` are resources of this skill, not additional catalogued skills.

## Path contract

The skill directory is the directory containing this `SKILL.md`.
Resolve every relative path named anywhere in this skill against that directory, including paths named by a nested reference.
Never resolve a path relative to the nested file itself.

## Non-negotiable safety

Never dispatch a crewmate or secondmate on an unverified adapter.
If `config/crew-harness` or `config/secondmate-harness` names one, tell the captain under `AGENTS.md` section 9 that the requested worker runtime is not verified, use firstmate's own verified runtime for current work, and ask only whether to verify the requested runtime for future work.
Do not pause current work for that choice.

On `unknown`, ask the captain instead of guessing.
A current captain override beats detection, while a per-task override governs only that dispatch.
For recovery and control, use the exact `harness=` in `state/<id>.meta`; never infer it from a model or provider.

Deliver lifecycle actions only through `../../../bin/fm-control.sh <task-id> interrupt|exit|relaunch`.
Never type an interrupt key or exit command through `fm-send`, where routing-marked lifecycle text becomes chat.
Trust handling is complete only when inspection proves the target started processing its instructions; delivery success alone is not proof.
Muse is verified only for crewmate and scout work, never a secondmate or primary.

## Detection

`../../../bin/fm-harness.sh` prints firstmate's own harness from verified environment markers, then process ancestry.
Only `FM_PI_HARNESS=pi-signed` at the launch boundary together with `PI_CODING_AGENT=true` selects Pi-signed; shared unmarked launcher ancestry remains Pi.
`../../../bin/fm-harness.sh crew` resolves `config/crew-harness`, where absent or `default` means firstmate's own harness.
`../../../bin/fm-harness.sh secondmate` resolves `config/secondmate-harness` -> `config/crew-harness` -> firstmate's own harness.
`../../../bin/fm-spawn.sh` re-resolves on every spawn, and an explicit per-spawn argument wins for that spawn.
A new adapter's verified marker and command name must land in `../../../bin/fm-harness.sh`.

## Operation-to-reference matrix

Every row requires the selected or recorded tool file from the harness table after the named common file.

| Operation | Required common reference | Addition |
|---|---|---|
| Start a crewmate, scout, or secondmate | [dispatch](references/common/dispatch.md) | Add [model and effort](references/common/model-and-effort.md) when choosing either axis; switch to the trust row if a dialog appears. |
| Handle trust or first-run UI | [control and recovery](references/common/control-and-recovery.md) | None. |
| Invoke a harness skill | [control and recovery](references/common/control-and-recovery.md) | None. |
| Interrupt | [control and recovery](references/common/control-and-recovery.md) | None. |
| Exit | [control and recovery](references/common/control-and-recovery.md) | None. |
| Resume a native session | [control and recovery](references/common/control-and-recovery.md) | Use relaunch when the tool has no verified native resume. |
| Recover or relaunch | [control and recovery](references/common/control-and-recovery.md) | Add [dispatch](references/common/dispatch.md) and [model and effort](references/common/model-and-effort.md) only for a replacement profile; add [primary hooks](references/common/primary-hooks.md) for a secondmate. |
| Primary startup, hooks, watcher, or integration | [primary hooks](references/common/primary-hooks.md) | The selected Kimi or Muse reference establishes its unsupported boundary. |
| Select or validate model or effort | [model and effort](references/common/model-and-effort.md) | Add [dispatch](references/common/dispatch.md) for configured profile precedence. |
| Verify or re-verify an adapter | All four common references | Add the existing tool file when re-verifying; a new tool remains undispatchable until every named owner and live check lands. |

## Harness reference table

| Identity | Required tool reference |
|---|---|
| `claude` | [Claude](references/harness/claude.md) |
| `codex` | [Codex](references/harness/codex.md) |
| `opencode` | [OpenCode](references/harness/opencode.md) |
| `pi` or `pi-signed` | [Pi and Pi-signed](references/harness/pi.md) |
| `grok` | [Grok Build](references/harness/grok.md) |
| `kimi` | [Kimi Code](references/harness/kimi.md) |
| `cursor` | [Cursor Agent](references/harness/cursor.md) |
| `muse` | [Muse Code](references/harness/muse.md) |
